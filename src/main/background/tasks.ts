/**
 * Concrete background tasks wired into the `Scheduler` (§7.3).
 *
 * The tasks are intentionally thin: all real work lives in `scanner/`,
 * `services/git.ts` and `db/repo.ts`, so this file only decides *when* and *for
 * which nodes* that work happens.
 */
import { watch, type FSWatcher } from 'chokidar'
import { basename } from 'node:path'
import { repo } from '../db/repo'
import { getDb } from '../db'
import { scanRoot, diffDirectorySnapshot, snapshotEvents } from '../scanner'
import { syncRepo } from '../services/git'
import { headHash } from '../services/git'
import { createLogger } from '../utils/logger'
import { isSubPath, pathKey } from '../utils/path'
import type { Scheduler } from './scheduler'
import type { HubEvent, ScanProgress } from '../../shared/types'
import { SETTING_KEYS } from '../../shared/types'

const log = createLogger('tasks')

export const GIT_SYNC_INTERVAL = 10 * 60_000
export const RESCAN_INTERVAL = 30 * 60_000
export const SNAPSHOT_INTERVAL = 5 * 60_000
export const PRUNE_INTERVAL = 24 * 60 * 60_000
export const SIZE_SWEEP_INTERVAL = 24 * 60 * 60_000
export const GIT_WINDOW_DAYS = 90

export interface TaskContext {
  scheduler: Scheduler
  broadcast: {
    treeUpdated(): void
    eventsAppended(events: HubEvent[]): void
    scanProgress(progress: ScanProgress): void
  }
  /** True while the app considers itself in "first run" (no scan completed yet). */
  isFirstRun(): boolean
}

/* ------------------------------------------------------------------ */
/* 1. Incremental rescan                                               */
/* ------------------------------------------------------------------ */

export function makeRescanTask(ctx: TaskContext): {
  name: 'rescan'
  intervalMs: number
  hiddenMultiplier: number
  acOnly: boolean
  run: () => Promise<void>
} {
  return {
    name: 'rescan',
    intervalMs: RESCAN_INTERVAL,
    hiddenMultiplier: 4,
    acOnly: false,
    run: async () => {
      const roots = repo.listEnabledRoots()
      for (const root of roots) {
        try {
          const result = await scanRoot({
            rootId: root.id,
            rootPath: root.path,
            maxDepth: root.max_depth,
            incremental: true,
            onProgress: (p) => ctx.broadcast.scanProgress(p)
          })
          if (result.projects > 0 || result.missing > 0) {
            log.debug('rescan changed tree', {
              rootId: root.id,
              projects: result.projects,
              missing: result.missing
            })
          }
        } catch (err) {
          log.warn('rescan failed for root', { rootId: root.id, err: (err as Error).message })
        }
      }
      ctx.broadcast.treeUpdated()
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. Git sync                                                         */
/* ------------------------------------------------------------------ */

export function makeGitSyncTask(ctx: TaskContext): {
  name: 'git-sync'
  intervalMs: number
  hiddenMultiplier: number
  acOnly: boolean
  run: () => Promise<void>
} {
  return {
    name: 'git-sync',
    intervalMs: GIT_SYNC_INTERVAL,
    hiddenMultiplier: 3,
    acOnly: false,
    run: async () => {
      const outcome = await syncAllGit()
      if (outcome.newEvents > 0) {
        const fresh = repo.listEvents({ limit: outcome.newEvents })
        ctx.broadcast.eventsAppended(fresh)
      }
      if (outcome.synced > 0) {
        repo.setSetting(SETTING_KEYS.lastGitSyncAt, String(Date.now()))
      }
      void getDb()
    }
  }
}

export interface SyncAllResult {
  synced: number
  newEvents: number
}

/**
 * Walk every git-backed project node and import commits newer than its cursor.
 * Used both by the scheduler and by the manual "立即同步 Git" action in the UI.
 */
export async function syncAllGit(limit = 200): Promise<SyncAllResult> {
  const projects = repo.gitProjects()
  let synced = 0
  let newEvents = 0
  const since = new Date(Date.now() - GIT_WINDOW_DAYS * 24 * 60 * 60_000).toISOString()

  for (const node of projects) {
    if (!node.path || node.path_missing === 1) continue
    const cursor = repo.getCursor(node.id)
    const outcome = await syncRepo({
      repo: { nodeId: node.id, path: node.path, lastHash: cursor },
      limit,
      sinceIso: since
    })
    if (outcome.error) continue
    synced += 1

    const known = new Set<string>()
    if (cursor) known.add(cursor)

    const inserts = outcome.newEvents
      .filter((e) => !known.has(e.hash))
      .map((e) => ({
        node_id: node.id,
        source: 'git' as const,
        ref: e.hash,
        message: e.subject,
        author: e.author,
        occurred_at: Date.parse(e.date) || Date.now(),
        file_count: e.files,
        insertions: e.insertions,
        deletions: e.deletions,
        files_json: JSON.stringify(e.fileList)
      }))

    if (inserts.length > 0) {
      newEvents += repo.insertEvents(inserts)
    }
    const head = outcome.headHash ?? (await headHash(node.path))
    if (head) repo.setCursor(node.id, head)
  }

  log.info('git sync done', { repos: projects.length, synced, newEvents })
  return { synced, newEvents }
}

/* ------------------------------------------------------------------ */
/* 3. Filesystem watcher + snapshot refresh                            */
/* ------------------------------------------------------------------ */

export interface WatcherHandle {
  watchers: FSWatcher[]
  close(): Promise<void>
  watchedRoots(): string[]
}

/**
 * Watch the indexed roots (not every project individually — chokidar fans out
 * internally) and coalesce bursts into one event per folder per 30 s.
 *
 * `ignoreInitial: true` and `depth: 1` matter: we only need to know *that* a
 * folder changed, then the snapshot diff decides *what* changed.
 */
export async function startWatchers(
  onFolderChanged: (folder: string) => void,
  options: { debounceMs?: number; depth?: number } = {}
): Promise<WatcherHandle> {
  const debounceMs = options.debounceMs ?? 30_000
  const roots = repo.listEnabledRoots().map((r) => r.path)
  const watchers: FSWatcher[] = []
  const pending = new Map<string, NodeJS.Timeout>()

  for (const root of roots) {
    try {
      const w = watch(root, {
        ignoreInitial: true,
        depth: options.depth ?? 3,
        persistent: true,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 2_000, pollInterval: 500 },
        ignored: (p: string) =>
          /(^|[\\/])(node_modules|\.git|dist|build|out|release|\.next|__pycache__|\.cache)([\\/]|$)/.test(p)
      })
      w.on('all', (_event, changed) => {
        const folder = dirOf(String(changed))
        const key = pathKey(folder)
        const existing = pending.get(key)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          pending.delete(key)
          onFolderChanged(folder)
        }, debounceMs)
        timer.unref?.()
        pending.set(key, timer)
      })
      w.on('error', (err) => log.debug('watcher error', { root, err: String(err) }))
      watchers.push(w)
    } catch (err) {
      log.warn('cannot watch root', { root, err: (err as Error).message })
    }
  }
  log.info('watchers started', { roots: roots.length })

  return {
    watchers,
    watchedRoots: () => roots,
    async close() {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      await Promise.all(watchers.map((w) => w.close().catch(() => undefined)))
    }
  }
}

function dirOf(file: string): string {
  const idx = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'))
  return idx > 0 ? file.slice(0, idx) : file
}

/**
 * Turn "this folder changed" into an `events` row, by diffing against the
 * `snapshots` table (§7.3 rule 1: git is the source of truth where available, the
 * snapshot fills the gaps).
 */
export async function recordFolderChange(folder: string): Promise<HubEvent[]> {
  const node = repo.getNodeByPath(folder)
  if (!node) return []
  const outcome = await diffDirectorySnapshot(node.id, folder, true)
  if (outcome.changes.length === 0) return []
  const events = snapshotEvents(node.id, outcome.changes)
  if (events.length === 0) return []
  repo.insertEvents(events)
  return repo
    .listEvents({ nodeIds: [node.id], limit: 1 })
    .filter((e) => e.source === 'fs')
    .slice(0, 1)
}

export function makeSnapshotTask(ctx: TaskContext, watcher: WatcherHandle | null): {
  name: 'snapshot'
  intervalMs: number
  hiddenMultiplier: number
  acOnly: boolean
  run: () => Promise<void>
} {
  return {
    name: 'snapshot',
    intervalMs: SNAPSHOT_INTERVAL,
    hiddenMultiplier: 4,
    acOnly: false,
    run: async () => {
      const roots = repo.listEnabledRoots().map((r) => r.path)
      if (roots.length === 0) return
      // Safety net for events chokidar can miss (network drives, editors that
      // swap files atomically): diff the root's own snapshot once per cycle.
      for (const root of roots) {
        const node = repo.getNodeByPath(root)
        if (!node) continue
        const outcome = await diffDirectorySnapshot(node.id, root, false)
        if (outcome.changes.length > 0) {
          const events = snapshotEvents(node.id, outcome.changes)
          repo.insertEvents(events)
          ctx.broadcast.eventsAppended(repo.listEvents({ nodeIds: [node.id], limit: 20 }))
        }
      }
      void watcher
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. Retention / pruning                                              */
/* ------------------------------------------------------------------ */

export function makePruneTask(): {
  name: 'prune'
  intervalMs: number
  hiddenMultiplier: number
  acOnly: boolean
  run: () => Promise<void>
} {
  return {
    name: 'prune',
    intervalMs: PRUNE_INTERVAL,
    hiddenMultiplier: 1,
    acOnly: true,
    run: async () => {
      const db = getDb()
      const removed = repo.pruneSnapshots()
      // Keep the DB from growing without bound on very long-lived installations.
      db.exec(`
        DELETE FROM events
         WHERE id IN (
           SELECT id FROM events
            WHERE occurred_at < (strftime('%s','now') * 1000 - 730 * 86400000)
            ORDER BY occurred_at ASC
            LIMIT 50000
         )
      `)
      log.info('prune done', { snapshotsRemoved: removed })
    }
  }
}

/* ------------------------------------------------------------------ */
/* 5. Size sweep (kept in a utility process where available)           */
/* ------------------------------------------------------------------ */

export function makeSizeSweepTask(): {
  name: 'size-sweep'
  intervalMs: number
  hiddenMultiplier: number
  acOnly: boolean
  run: () => Promise<void>
} {
  return {
    name: 'size-sweep',
    intervalMs: SIZE_SWEEP_INTERVAL,
    hiddenMultiplier: 1,
    acOnly: true,
    run: async () => {
      // Deliberately a no-op here: sizes are computed lazily by
      // `nodes.stats()` on demand and cached in `meta.diskSizeBytes`, because a
      // nightly full sweep of every root is exactly the "runaway background
      // process" NFR-06 forbids. The hook is kept so the task shows up in the
      // settings panel and can be triggered manually.
      log.debug('size sweep tick (lazy mode)')
    }
  }
}

/** Register every task with the scheduler and return the watcher handle. */
export async function registerAllTasks(ctx: TaskContext): Promise<WatcherHandle | null> {
  ctx.scheduler.register(makeRescanTask(ctx))
  ctx.scheduler.register(makeGitSyncTask(ctx))
  ctx.scheduler.register(makePruneTask())
  ctx.scheduler.register(makeSizeSweepTask())

  let watcher: WatcherHandle | null = null
  if (!ctx.isFirstRun()) {
    watcher = await startWatchers((folder) => {
      void recordFolderChange(folder).then((events) => {
        if (events.length > 0) ctx.broadcast.eventsAppended(events)
      })
    })
  }
  ctx.scheduler.register(makeSnapshotTask(ctx, watcher))
  return watcher
}

/** Exposed for tests / the settings panel: which root owns a given path? */
export function rootForPath(path: string): number | null {
  for (const root of repo.listEnabledRoots()) {
    if (isSubPath(root.path, path)) return root.id
  }
  return null
}

export function labelForPath(path: string): string {
  try {
    return basename(path)
  } catch {
    return path
  }
}
