/**
 * Indexer — turns `ScanBatch` values from the walker into database rows.
 *
 * Design notes
 * ------------
 * Data isolation (§8): this module only ever *reads* the user's filesystem and
 * *writes* the app's own SQLite file. It never writes into a scanned folder, and
 * the only place it can write outside the userData directory is
 * `userData/thumbnails/` (icon copies, D-007).
 *
 * Parent resolution: batches are produced in traversal order (parent always
 * before child), so a node's `parent_id` is found by looking up the path of its
 * directory in the map we are building. That keeps the whole scan O(n) in map
 * lookups instead of one `getNodeByPath` query per directory.
 */
import { extname } from 'node:path'
import type { DB } from '../db'
import { getDb } from '../db'
import { repo, type EventInsert } from '../db/repo'
import type { ScanProgress, ScanResult } from '../../shared/types'
import { normalizePath, pathKey, safeRelative } from '../utils/path'
import { walkProjectTree, type ScanBatch, type ScanDirectory } from './walk'
import { createLogger } from '../utils/logger'

export interface IndexOptions {
  rootId: number
  rootPath: string
  maxDepth: number
  /**
   * `true` refreshes the cheap columns of known nodes instead of re-inserting
   * them. Optional so a caller can run a plain first scan without spelling it
   * out; the default (`false`) is the full path, which is also the safe one.
   */
  incremental?: boolean
  signal?: { aborted: boolean }
  onProgress?: (p: ScanProgress) => void
  /** Injected by the fs-watcher so a background scan can be coalesced. */
  batchSize?: number
}

const log = createLogger('scanner')

/** Walk + index one root. Returns the frozen `ScanResult` shape (§7.1). */
export async function scanRoot(options: IndexOptions): Promise<ScanResult> {
  const started = Date.now()
  const { rootId, rootPath, maxDepth, signal, onProgress } = options
  // §7.1: a scan is incremental by default — nodes that vanished are flagged
  // `path_missing` instead of silently staying "present". A first scan has no
  // candidate rows, so this is a no-op there.
  const incremental = options.incremental ?? true
  const db: DB = getDb()

  const root = normalizePath(rootPath)
  // Path -> nodeId for every node under this root, loaded once (WAL snapshot).
  const byPath = repo.pathIndex(rootId)
  const seen = new Set<string>()

  let projects = 0
  let folders = 0
  let scanned = 0
  let skipped = 0
  let truncated = false
  let cancelled = false

  const progressEvery = 400
  let sinceProgress = 0

  const walk = walkProjectTree({
    rootPath: root,
    maxDepth,
    signal,
    batchSize: options.batchSize ?? 250,
    onDirectory: (p, n) => {
      sinceProgress += 1
      if (sinceProgress >= progressEvery) {
        sinceProgress = 0
        onProgress?.({ rootId, scanned: n, current: p })
      }
    }
  })

  for await (const batch of walk) {
    scanned = batch.scanned
    if (batch.cancelled) cancelled = true
    if (batch.truncated) truncated = true
    skipped += batch.skipped.length

    const applied = applyBatch(db, rootId, root, byPath, batch)
    projects += applied.projects
    folders += applied.folders
    seen.add(pathKey(root))
    for (const d of batch.dirs) seen.add(pathKey(d.path))
  }

  // Incremental mode: mark anything under this root that we did not see.
  let missing = 0
  if (incremental && !cancelled) {
    missing = markMissing(db, rootId, seen)
  }

  onProgress?.({ rootId, scanned, current: '' })
  log.info('scan finished', {
    rootId,
    scanned,
    projects,
    folders,
    skipped,
    truncated,
    cancelled,
    missing,
    ms: Date.now() - started
  })

  return {
    rootId,
    scanned,
    projects,
    folders,
    skipped,
    elapsedMs: Date.now() - started,
    missing
  }
}

interface BatchOutcome {
  projects: number
  folders: number
}

function applyBatch(
  db: DB,
  rootId: number,
  root: string,
  byPath: Map<string, number>,
  batch: ScanBatch
): BatchOutcome {
  let projects = 0
  let folders = 0

  const write = (): void => {
    for (const dir of batch.dirs) {
      const parentId = dir.parentPath === null ? null : (byPath.get(pathKey(dir.parentPath)) ?? null)
      const key = pathKey(dir.path)
      const existingId = byPath.get(key)

      if (existingId !== undefined) {
        // Already indexed: refresh the cheap fields only. Annotations
        // (note/display_name/icon/tags/color) are never touched by a rescan.
        try {
          db.prepare(
            `UPDATE nodes
                SET parent_id = @parent_id,
                    kind      = CASE WHEN nodes.kind = 'project' THEN nodes.kind ELSE @kind END,
                    path_missing = 0,
                    updated_at = @updated_at
              WHERE id = @id`
          ).run({
            id: existingId,
            parent_id: parentId,
            kind: dir.kind,
            updated_at: Date.now()
          })
        } catch (err) {
          log.warn('update during scan failed', { path: dir.path, err: (err as Error).message })
        }
      } else {
        const id = repo.upsertNode({
          root_id: rootId,
          parent_id: parentId,
          name: dir.name,
          path: dir.path,
          kind: dir.kind
        })
        // `meta` carries the marker/project-kind so the renderer can pick an icon
        // without re-reading the filesystem (§9.3 `auto` icon type).
        repo.setMeta(id, {
          marker: dir.marker,
          projectKind: dir.projectKind,
          isGit: dir.isGit,
          depth: dir.depth,
          mtime: Math.round(dir.mtime)
        })
        byPath.set(key, id)
      }

      if (dir.kind === 'project') projects += 1
      else folders += 1
    }
  }

  if (batch.dirs.length === 0) return { projects, folders }

  // One transaction per batch: a crash mid-scan leaves the tree consistent.
  try {
    const tx = db.transaction(write)
    tx()
  } catch (err) {
    log.warn('batch transaction failed, retrying row by row', { err: (err as Error).message })
    write()
  }

  void root
  return { projects, folders }
}

/**
 * Mark nodes whose paths are gone. Returns how many rows changed.
 * A node is only marked when its own path is missing from the walk AND it is not
 * an ancestor-style group node (groups have `path === null`).
 */
function markMissing(db: DB, rootId: number, seen: Set<string>): number {
  const candidates = repo.missingCandidates(rootId)
  let changed = 0
  const stmt = db.prepare(
    `UPDATE nodes SET path_missing = 1, updated_at = @updated_at WHERE id = @id`
  )
  const clear = db.prepare(`UPDATE nodes SET path_missing = 0 WHERE id = @id`)
  const tx = db.transaction(() => {
    for (const node of candidates) {
      if (!node.path) continue
      const present = seen.has(pathKey(node.path))
      if (!present && node.path_missing === 0) {
        stmt.run({ id: node.id, updated_at: Date.now() })
        changed += 1
      } else if (present && node.path_missing === 1) {
        clear.run({ id: node.id })
      }
    }
  })
  tx()
  return changed
}

/* ------------------------------------------------------------------ */
/* File-change snapshots (§7.3)                                        */
/* ------------------------------------------------------------------ */

export interface SnapshotChange {
  relPath: string
  change: 'created' | 'modified' | 'deleted'
}

export interface SnapshotOutcome {
  changes: SnapshotChange[]
  truncated: boolean
}

/**
 * Compare a directory's files against `fs_snapshots` and return the deltas.
 * Only the immediate directory is compared (configurable depth is handled by the
 * watcher calling this per changed folder), which keeps "git catches the big
 * changes, the snapshot catches the rest" cheap.
 */
export async function diffDirectorySnapshot(
  nodeId: number,
  dir: string,
  singleDepth = true
): Promise<SnapshotOutcome> {
  const { readdir, stat } = await import('node:fs/promises')
  const previous = new Map(repo.snapshots(nodeId).map((s) => [s.rel_path, s]))
  const changes: SnapshotChange[] = []
  const seenRel = new Set<string>()
  let truncated = false

  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: dir, rel: '', depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()!
    let entries
    try {
      entries = await readdir(current.abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!singleDepth && current.depth < 1) {
          const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name
          queue.push({ abs: `${current.abs}/${entry.name}`, rel, depth: current.depth + 1 })
        }
        continue
      }
      if (!entry.isFile()) continue
      // Ignore the same noise the walker ignores, plus our own temp files.
      if (entry.name.startsWith('~$') || entry.name.endsWith('.tmp')) continue
      if (isNoisyExtension(entry.name)) continue

      const abs = `${current.abs}/${entry.name}`
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name
      seenRel.add(rel)
      let st
      try {
        st = await stat(abs)
      } catch {
        continue
      }
      const prev = previous.get(rel)
      if (!prev) {
        changes.push({ relPath: rel, change: 'created' })
      } else if (Math.abs(prev.mtime - st.mtimeMs) > 1 || prev.size !== st.size) {
        changes.push({ relPath: rel, change: 'modified' })
      }
      repo.putSnapshotEntry(nodeId, rel, Math.round(st.mtimeMs), st.size)
    }
  }

  for (const [rel] of previous) {
    if (!seenRel.has(rel)) {
      changes.push({ relPath: rel, change: 'deleted' })
      repo.removeSnapshotEntry(nodeId, rel)
    }
  }

  if (changes.length > 500) {
    truncated = true
    changes.length = 500
  }
  return { changes, truncated }
}

const NOISY_EXT = new Set([
  '.log',
  '.tmp',
  '.temp',
  '.lock',
  '.swp',
  '.pyc',
  '.pyo',
  '.DS_Store',
  '.crdownload',
  '.part'
])

function isNoisyExtension(name: string): boolean {
  if (name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini') return true
  const ext = extname(name).toLowerCase()
  return NOISY_EXT.has(ext)
}

/** Build `events` rows from a snapshot diff (source = 'fs'). */
export function snapshotEvents(nodeId: number, changes: SnapshotChange[], at = Date.now()): EventInsert[] {
  if (changes.length === 0) return []
  const created = changes.filter((c) => c.change === 'created').length
  const modified = changes.filter((c) => c.change === 'modified').length
  const deleted = changes.filter((c) => c.change === 'deleted').length
  const parts: string[] = []
  if (created) parts.push(`新建 ${created}`)
  if (modified) parts.push(`修改 ${modified}`)
  if (deleted) parts.push(`删除 ${deleted}`)

  return [
    {
      node_id: nodeId,
      source: 'fs',
      ref: null,
      message: parts.join(' · ') || '文件变化',
      author: null,
      occurred_at: at,
      file_count: changes.length,
      insertions: 0,
      deletions: deleted,
      files_json: JSON.stringify(changes.slice(0, 50).map((c) => `${prefixOf(c.change)} ${c.relPath}`))
    }
  ]
}

function prefixOf(change: SnapshotChange['change']): string {
  return change === 'created' ? '+' : change === 'modified' ? '~' : '-'
}

/** Exposed for tests: the repos a scan would have produced, without a DB. */
export function describeProject(dir: ScanDirectory): string {
  const rel = safeRelative(dir.path, dir.path) ?? ''
  return dir.marker ? `${dir.name} [${dir.marker}]${rel}` : dir.name
}
