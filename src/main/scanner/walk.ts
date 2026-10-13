/**
 * Depth-limited directory walker (§7.1).
 *
 * The walker is deliberately a pure async generator of `ScanBatch` values so
 * that:
 *   - it never touches SQLite (the worker writes the batches), and
 *   - `tests/unit/scanner.test.ts` can drive it against a temp fixture with no
 *     database and no Electron runtime.
 *
 * Stop conditions, in order of evaluation:
 *   1. depth >= maxDepth            -> do not descend
 *   2. project marker found         -> index the project, do NOT descend into it
 *   3. ignored directory name       -> skip entirely
 *   4. MAX_FILES_PER_ROOT exceeded  -> abort with `truncated: true`
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { detectMarker, shouldIgnoreDir, MAX_FILES_PER_ROOT, type MarkerHit } from './markers'

export interface ScanDirectory {
  /** Absolute path. */
  path: string
  parentPath: string | null
  depth: number
  name: string
  kind: 'group' | 'project' | 'folder'
  marker: string | null
  projectKind: string | null
  mtime: number
  isGit: boolean
}

export interface ScanBatch {
  dirs: ScanDirectory[]
  /** Absolute paths that were skipped and why (for the progress log). */
  skipped: Array<{ path: string; reason: string }>
  scanned: number
  /** True when the walker stopped because MAX_FILES_PER_ROOT was reached. */
  truncated: boolean
  /** True when the caller cancelled via `signal`. */
  cancelled: boolean
}

export interface WalkOptions {
  rootPath: string
  maxDepth: number
  signal?: { aborted: boolean }
  onDirectory?: (path: string, scanned: number) => void
  batchSize?: number
}

export interface WalkTotals {
  scanned: number
  projects: number
  folders: number
  skipped: number
  truncated: boolean
  cancelled: boolean
}

async function safeStat(p: string): Promise<{ mtimeMs: number; isDirectory: boolean } | null> {
  try {
    const s = await stat(p)
    if (!s.isDirectory()) return null
    return { mtimeMs: s.mtimeMs, isDirectory: true }
  } catch {
    return null
  }
}

/**
 * Walk `rootPath` breadth-first-ish (depth-first, natural name order) and yield
 * batches. The caller must consume the whole iterator for `truncated`/`cancelled`
 * to be meaningful; both are also reported on the final batch.
 */
export async function* walkProjectTree(options: WalkOptions): AsyncGenerator<ScanBatch, WalkTotals> {
  const { rootPath, maxDepth, signal, onDirectory, batchSize = 250 } = options

  const totals: WalkTotals = {
    scanned: 0,
    projects: 0,
    folders: 0,
    skipped: 0,
    truncated: false,
    cancelled: false
  }

  const rootStat = await safeStat(rootPath)
  if (!rootStat) {
    return totals
  }

  // Explicit stack keeps memory flat on deep trees (no recursion, no promise fan-out).
  const stack: Array<{ path: string; parentPath: string | null; depth: number; name: string }> = [
    { path: rootPath, parentPath: null, depth: 0, name: baseName(rootPath) }
  ]

  let pending: ScanDirectory[] = []
  let pendingSkipped: ScanBatch['skipped'] = []

  const flush = async function* (): AsyncGenerator<ScanBatch, void> {
    if (pending.length === 0 && pendingSkipped.length === 0) return
    yield {
      dirs: pending,
      skipped: pendingSkipped,
      scanned: totals.scanned,
      truncated: totals.truncated,
      cancelled: totals.cancelled
    }
    pending = []
    pendingSkipped = []
  }

  while (stack.length > 0) {
    if (signal?.aborted) {
      totals.cancelled = true
      yield* flush()
      return totals
    }
    if (totals.scanned >= MAX_FILES_PER_ROOT) {
      totals.truncated = true
      yield* flush()
      return totals
    }

    const current = stack.pop()!
    const st = await safeStat(current.path)
    if (!st) {
      totals.skipped += 1
      continue
    }
    totals.scanned += 1
    onDirectory?.(current.path, totals.scanned)

    // 2. project marker wins: index it, never descend.
    let marker: MarkerHit | null = null
    try {
      marker = detectMarker(current.path)
    } catch {
      marker = null
    }

    if (marker) {
      totals.projects += 1
      pending.push({
        path: current.path,
        parentPath: current.parentPath,
        depth: current.depth,
        name: current.name,
        kind: 'project',
        marker: marker.marker,
        projectKind: marker.kind,
        mtime: st.mtimeMs,
        isGit: marker.kind === 'git' || marker.marker === '.git'
      })
    } else {
      if (current.depth > 0) {
        totals.folders += 1
        pending.push({
          path: current.path,
          parentPath: current.parentPath,
          depth: current.depth,
          name: current.name,
          kind: 'folder',
          marker: null,
          projectKind: null,
          mtime: st.mtimeMs,
          isGit: false
        })
      }
      // 1. depth guard.
      if (current.depth < maxDepth) {
        let entries: Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>
        try {
          const raw = await readdir(current.path, { withFileTypes: true })
          entries = raw.map((e) => ({
            name: e.name,
            isDirectory: e.isDirectory(),
            isSymbolicLink: e.isSymbolicLink()
          }))
        } catch (err) {
          totals.skipped += 1
          pendingSkipped.push({ path: current.path, reason: (err as Error).message })
          entries = []
        }

        // Sort so the traversal order is deterministic across runs/platforms.
        entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))

        for (const entry of entries) {
          // 3. ignore rules (cheap ones first).
          if (!entry.isDirectory) continue
          if (entry.name.startsWith('.') && entry.name !== '.git') {
            // Hidden directories are skipped except VCS markers, which the
            // marker check at the child level would have caught anyway.
            continue
          }
          if (shouldIgnoreDir(entry.name)) {
            totals.skipped += 1
            pendingSkipped.push({ path: join(current.path, entry.name), reason: 'ignored-dir' })
            continue
          }
          if (entry.isSymbolicLink) {
            // Symlink loops are the classic infinite-scan bug (§14.3):
            // never follow one, just record it.
            totals.skipped += 1
            pendingSkipped.push({ path: join(current.path, entry.name), reason: 'symlink' })
            continue
          }
          stack.push({
            path: join(current.path, entry.name),
            parentPath: current.path,
            depth: current.depth + 1,
            name: entry.name
          })
        }
      }
    }

    if (pending.length >= batchSize) {
      yield* flush()
    }
  }

  yield* flush()
  return totals
}

function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}
