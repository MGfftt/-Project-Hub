/**
 * Main-process IPC router (§7.7).
 *
 * Every handler follows the same three rules:
 *   1. the renderer sends ids, not paths (`anchor.paths.node(id)`);
 *   2. anything that can be slow is either awaited off the event loop or queued on
 *      the scheduler, so the window never blocks (NFR-04);
 *   3. a handler never throws at the renderer — failures come back as
 *      `{ok:false, error}` so a bad node cannot wedge the UI.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { basename, join } from 'node:path'
import { promises as fsp, readFileSync } from 'node:fs'
import { CH } from '../../shared/channels'
import { BUILTIN_ICONS, ICON_NAMES, type IconDef } from '../../shared/icons'
import { DEFAULT_SETTINGS, SETTING_KEYS } from '../../shared/types'
import type {
  BackgroundStatus,
  DayCount,
  EventFilter,
  HubEvent,
  IconAsset,
  IconType,
  NodeDetail,
  NodePatch,
  NodeStats,
  Root,
  ScanResult,
  SearchHit,
  TreeNode
} from '../../shared/types'
import { repo } from '../db/repo'
import { getDb, getUserVersion } from '../db'
import { createLogger } from '../utils/logger'
import { driverName } from '../db/sqlite'
import { directorySize, copyIntoStore, listFiles, removeFileQuiet, isImageFile } from '../utils/fsops'
import { normalizePath, pathExists, safeRelative } from '../utils/path'
import { rankByMatch } from '../../shared/match'
import { setLang, t } from '../i18n'
import { scanRoot } from '../scanner'
import { syncAllGit, recordFolderChange } from '../background/tasks'
import { SerialQueue, spawnWorker, runJob } from '../worker/pool'
import { toMarkdown } from '../services/markdown'
import type { Scheduler } from '../background/scheduler'
import type { Anchor } from './anchor'
import type { Thumbnailer } from '../services/thumbnailer'

const log = createLogger('ipc')

export interface IpcContext {
  anchor: Anchor
  thumbnailer: Thumbnailer
  scheduler: Scheduler
  userData: string
  /**
   * Absolute path of the SQLite file the app already has open.
   *
   * Required rather than derived: `join(userData, 'data.db')` was hard-coded here
   * once and silently disagreed with `src/main/index.ts`, which meant the scan
   * worker was handed a path to a *different*, empty database.
   */
  dbPath: string
  thumbsDir: string
  backgroundsDir: string
  getWindow: () => BrowserWindow | null
  broadcast: (channel: string, payload: unknown) => void
  scanQueue: SerialQueue
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/** `file://` URL for a path we have already validated to live in userData. */
function toMediaUrl(abs: string): string {
  return `hub-media://local/${encodeURIComponent(abs.replace(/\\/g, '/'))}`
}

/**
 * §9.11 — the average colour of a stored picture, as `#rrggbb`.
 *
 * The interface is tinted with the picture's own colour, so it has to be
 * measured here rather than in the renderer: `nativeImage` is a main-process
 * class, and the value must travel in the same payload as the URL, or the first
 * paint after a restart would flash the previous tint.
 */
function tintOf(abs: string): string | null {
  try {
    const image = nativeImage.createFromPath(abs)
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    if (width <= 0 || height <= 0) return null
    // 8x8 is plenty: a mean over 64 samples cannot differ visibly from one over
    // four million, and it keeps the decode off the critical path.
    const bitmap = image.resize({ width: 8, height: 8, quality: 'good' }).toBitmap()
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    // BGRA, four bytes per pixel — the same order `createFromBitmap` reads back.
    for (let i = 0; i + 3 < bitmap.length; i += 4) {
      const alpha = bitmap[i + 3] ?? 255
      if (alpha < 8) continue
      b += bitmap[i] ?? 0
      g += bitmap[i + 1] ?? 0
      r += bitmap[i + 2] ?? 0
      n += 1
    }
    if (n === 0) return null
    const channel = (sum: number): string => Math.round(sum / n).toString(16).padStart(2, '0')
    return `#${channel(r)}${channel(g)}${channel(b)}`
  } catch {
    return null
  }
}

/** Flat `NodeDetail[]` for the exporters: one row read + one JSON parse each. */
function detailedNodes(): NodeDetail[] {
  return repo.listNodes().map((tree) => {
    const row = repo.getNode(tree.id)
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(row?.meta ?? '{}') as Record<string, unknown>
    } catch {
      meta = {}
    }
    return { ...tree, note_md: row?.note_md ?? '', meta }
  })
}

async function pickDirectory(win: BrowserWindow | null, title: string): Promise<string | null> {
  const res = win
    ? await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] })
    : await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
}

async function pickImage(win: BrowserWindow | null, title: string): Promise<string | null> {
  const filters = [
    { name: t('dialog.images'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'svg'] },
    { name: t('dialog.allFiles'), extensions: ['*'] }
  ]
  const res = win
    ? await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters })
    : await dialog.showOpenDialog({ title, properties: ['openFile'], filters })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

export function registerIpcHandlers(ctx: IpcContext): void {
  const { anchor, thumbnailer } = ctx

  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await (fn as unknown as (...a: unknown[]) => unknown)(...args)
      } catch (err) {
        log.warn('handler failed', { channel, err: (err as Error).message })
        throw err
      }
    })
  }

  /* ---------------------------------------------------------------- roots */

  handle(CH.roots.pick, async () => {
    const picked = await pickDirectory(ctx.getWindow(), t('dialog.addRoot'))
    if (!picked) return null
    return normalizePath(picked)
  })

  handle(CH.roots.list, () => repo.listRoots())

  handle(CH.roots.add, async (path: string) => {
    const normalized = normalizePath(String(path ?? ''))
    if (!normalized) throw new Error(t('ipc.emptyPath'))
    if (!pathExists(normalized)) throw new Error(t('ipc.pathMissing'))
    const existing = repo.getRootByPath(normalized)
    if (existing) return existing
    const root = repo.addRoot(normalized, 4)
    // First scan runs through the serial queue so a double-click cannot start two.
    void ctx.scanQueue.enqueue(`scan:${root.id}`, () => runScan(ctx, root.id, false))
    return root
  })

  handle(CH.roots.remove, (id: number) => {
    repo.removeRoot(Number(id))
    ctx.broadcast(CH.broadcast.treeUpdated, null)
  })

  handle(CH.roots.setEnabled, (id: number, enabled: boolean) => {
    repo.setRootEnabled(Number(id), Boolean(enabled))
    ctx.broadcast(CH.broadcast.treeUpdated, null)
  })

  handle(CH.roots.rescan, async (id: number, incremental?: boolean): Promise<ScanResult> => {
    const rootId = Number(id)
    return ctx.scanQueue.enqueue(`scan:${rootId}`, () => runScan(ctx, rootId, incremental !== false))
  })

  /* ---------------------------------------------------------------- nodes */

  handle(CH.nodes.tree, (): TreeNode[] => repo.tree())

  handle(CH.nodes.listChildren, (parentId: number | null): TreeNode[] => {
    if (parentId === null || parentId === undefined) {
      return repo.tree().filter((n) => n.parent_id === null)
    }
    return repo.tree().filter((n) => n.parent_id === Number(parentId))
  })

  handle(CH.nodes.detail, (id: number): NodeDetail | null => {
    const node = repo.getNode(Number(id))
    if (!node) return null
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(node.meta || '{}') as Record<string, unknown>
    } catch {
      meta = {}
    }
    return { ...repo.listNodes().find((n) => n.id === node.id)!, note_md: node.note_md, meta }
  })

  handle(CH.nodes.update, (id: number, patch: NodePatch) => {
    // `NodePatch` is the wire shape (`tags: string[]`); `repo.updateNode` takes
    // the same wire shape and JSON-encodes once, so no conversion is needed here.
    repo.updateNode(Number(id), patch ?? {})
    ctx.broadcast(CH.broadcast.treeUpdated, null)
  })

  handle(CH.nodes.setDisplayName, (nodeId: number, name: string | null) => {
    const node = repo.getNode(Number(nodeId))
    if (!node) throw new Error(t('ipc.nodeMissing'))
    repo.setIdentity(node.id, name === null || String(name).trim() === '' ? null : String(name).trim(), node.icon_type, node.icon_value)
    ctx.broadcast(CH.broadcast.treeUpdated, null)
  })

  // The frozen `Api` (src/shared/types.ts) types this `Promise<void>`, so the two
  // refusals below REJECT rather than returning a result. The picker only ever
  // sends values it obtained from `icons.store()`, so a rejection here means a
  // hostile or buggy caller — a thrown error is the honest signal.
  handle(CH.nodes.setIcon, (nodeId: number, type: IconType, value: string | null): void => {
    const node = repo.getNode(Number(nodeId))
    if (!node) throw new Error(t('ipc.nodeMissing'))
    const allowed: IconType[] = ['auto', 'lucide', 'emoji', 'image']
    const iconType = allowed.includes(type) ? type : 'auto'
    let iconValue = value
    if (iconType === 'image' && iconValue) {
      // Only stored assets may be referenced — never a raw user path.
      const safe = anchor.paths.icon(String(iconValue))
      if (!safe) throw new Error(t('ipc.iconOutsideData'))
      iconValue = basename(safe)
    }
    repo.setIdentity(node.id, node.display_name, iconType, iconValue ?? null)
    ctx.broadcast(CH.broadcast.treeUpdated, null)
  })

  handle(CH.nodes.importIcon, async (nodeId: number) => {
    const id = Number(nodeId)
    const node = repo.getNode(id)
    if (!node) return { ok: false, error: t('ipc.nodeMissing') }
    const picked = await pickImage(ctx.getWindow(), t('dialog.pickIcon'))
    if (!picked) return { ok: false, error: 'cancelled' }
    if (!isImageFile(picked)) return { ok: false, error: t('ipc.notAnImage') }
    try {
      // copyIntoStore writes ONLY into userData/thumbnails (§8).
      const { filename, bytes } = await copyIntoStore(picked, ctx.thumbsDir)
      repo.addIconAsset(filename, basename(picked), bytes)
      repo.setIdentity(id, node.display_name, 'image', filename)
      ctx.broadcast(CH.broadcast.treeUpdated, null)
      return { ok: true, filename }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  handle(CH.nodes.thumb, async (payload: { nodeId: number; edge?: number }) => {
    // The renderer sends a node id, never a path. The main process decides which
    // file (if any) inside that node is worth showing as its icon, and returns a
    // `hub-media://` URL for the cached thumbnail (§7.10, §9.3).
    const nodeId = Number((payload as { nodeId?: number })?.nodeId ?? 0)
    const edge = Math.min(Math.max(Number((payload as { edge?: number })?.edge ?? 64), 16), 512)
    const dir = anchor.paths.node(nodeId)
    if (!dir) return { ok: false, dataUrl: null, error: 'no path' }

    const candidates: string[] = []
    try {
      // A folder's own icon convention first, then anything that looks like a
      // project logo. `withFileTypes` keeps this to a single readdir per node.
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      const exact = new Set(['favicon.ico', 'favicon.png', 'icon.png', 'logo.png', 'app.ico'])
      for (const entry of entries) {
        if (entry.isFile() && exact.has(entry.name.toLowerCase())) candidates.push(join(dir, entry.name))
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const lower = entry.name.toLowerCase()
        if (lower !== 'assets' && lower !== 'public' && lower !== 'static' && lower !== 'resources') continue
        try {
          for (const inner of await fsp.readdir(join(dir, entry.name), { withFileTypes: true })) {
            const name = inner.name.toLowerCase()
            if (inner.isFile() && (exact.has(name) || name === 'icon.svg' || name === 'logo.svg')) {
              candidates.push(join(dir, entry.name, inner.name))
            }
          }
        } catch {
          /* unreadable subfolder */
        }
      }
      const rootFiles = entries.filter(
        (e) => e.isFile() && /\.(png|svg|webp|jpg|jpeg)$/i.test(e.name) && /icon|logo|cover|avatar/i.test(e.name)
      )
      for (const entry of rootFiles.slice(0, 3)) candidates.push(join(dir, entry.name))
    } catch {
      return { ok: false, dataUrl: null, error: 'unreadable' }
    }

    for (const file of candidates.slice(0, 4)) {
      try {
        const st = await fsp.stat(file)
        const res = await thumbnailer.get({ file, edge, modifiedMs: st.mtimeMs, size: st.size })
        if (res.ok && res.cachePath) return { ok: true, dataUrl: toMediaUrl(res.cachePath) }
      } catch {
        /* try the next candidate */
      }
    }
    return { ok: false, dataUrl: null, error: 'no image' }
  })

  handle(CH.nodes.createGroup, (name: string, parentId: number | null) => {
    const id = repo.createGroup(String(name || t('ipc.newGroup')).slice(0, 80), parentId === null ? null : Number(parentId))
    ctx.broadcast(CH.broadcast.treeUpdated, null)
    return id
  })

  handle(CH.nodes.createNote, (parentId: number | null, text?: string) => {
    const id = repo.createNote(parentId === null ? null : Number(parentId), String(text ?? '').slice(0, 4000))
    ctx.broadcast(CH.broadcast.treeUpdated, null)
    return id
  })

  handle(CH.nodes.setNote, (id: number, text: string) => {
    repo.setNoteText(Number(id), String(text ?? '').slice(0, 4000))
    ctx.broadcast(CH.broadcast.treeUpdated, null)
  })

  handle(CH.nodes.remove, (id: number) => {
    repo.deleteNode(Number(id))
    ctx.broadcast(CH.broadcast.treeUpdated, null)
  })

  handle(CH.nodes.move, (id: number, parentId: number | null, index: number) => {
    repo.moveNode(Number(id), parentId === null ? null : Number(parentId), Number(index) || 0)
    ctx.broadcast(CH.broadcast.treeUpdated, null)
  })

  handle(CH.nodes.relocate, async (nodeId: number) => {
    const id = Number(nodeId)
    const node = repo.getNode(id)
    if (!node) return { ok: false }
    const picked = await pickDirectory(ctx.getWindow(), t('dialog.pickRelocate'))
    if (!picked) return { ok: false }
    const target = normalizePath(picked)
    const clash = repo.getNodeByPath(target)
    if (clash && clash.id !== id) return { ok: false }

    const before = node.path
    // A relocation is a *manual* event: the user told us, git did not (§7.3).
    repo.moveNode(id, node.parent_id, node.sort_order)
    const db = getDb()
    db.prepare(`UPDATE nodes SET path = ?, path_missing = 0, root_id = COALESCE(root_id, ?) WHERE id = ?`).run(
      target,
      repo.getRootByPath(target)?.id ?? null,
      id
    )
    repo.setCursor(id, null)
    db.prepare(`DELETE FROM snapshots WHERE node_id = ?`).run(id)
    if (before !== target) {
      repo.insertEvents([
        {
          node_id: id,
          source: 'manual',
          ref: null,
          message: t('ipc.relocated', { from: before ?? '(none)', to: target }),
          author: 'user',
          occurred_at: Date.now(),
          file_count: 0,
          insertions: 0,
          deletions: 0,
          files_json: '[]'
        }
      ])
    }
    ctx.broadcast(CH.broadcast.treeUpdated, null)
    return { ok: true, path: target }
  })

  handle(CH.nodes.stats, async (nodeId: number): Promise<NodeStats> => {
    const node = repo.getNode(Number(nodeId))
    if (!node) throw new Error(t('ipc.nodeMissing'))
    const tree = repo.listNodes().find((n) => n.id === node.id)
    const children = repo.descendantIds(node.id)
    const eventStats = repo.eventStats([node.id, ...children])
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(node.meta || '{}') as Record<string, unknown>
    } catch {
      meta = {}
    }

    let disk: number | null = typeof meta.diskSizeBytes === 'number' ? (meta.diskSizeBytes as number) : null
    let fileCount: number | null = typeof meta.fileCount === 'number' ? (meta.fileCount as number) : null

    if (node.path && pathExists(node.path) && disk === null) {
      try {
        const size = await directorySize(node.path, {
          maxEntries: 50_000,
          skip: (name) => name === 'node_modules' || name === '.git'
        })
        disk = size.bytes
        fileCount = size.files
        repo.setMeta(node.id, { ...meta, diskSizeBytes: size.bytes, fileCount: size.files })
      } catch {
        disk = null
      }
    }

    let isGit = Boolean(meta.isGit)
    let gitRemote: string | null = null
    let gitBranch: string | null = null
    if (node.path && String(meta.projectKind) === 'git') {
      isGit = true
      try {
        const { probeRepo } = await import('../services/git')
        const probe = await probeRepo(node.path)
        gitRemote = probe.remote
        gitBranch = probe.branch
        isGit = probe.isRepo
      } catch {
        /* git unavailable */
      }
    }

    return {
      nodeId: node.id,
      name: node.name,
      displayName: node.display_name,
      path: node.path,
      kind: node.kind,
      isGitRepo: isGit,
      gitRemote,
      gitBranch,
      diskSizeBytes: disk,
      fileCount,
      childCount: tree?.children?.length ?? repo.tree().filter((n) => n.parent_id === node.id).length,
      createdAt: node.created_at,
      modifiedAt: node.updated_at,
      lastEventAt: eventStats.last ?? null,
      firstEventAt: eventStats.first ?? null,
      eventCount: eventStats.count,
      totalInsertions: eventStats.insertions,
      totalDeletions: eventStats.deletions,
      status: node.status,
      tags: (() => {
        try {
          const v = JSON.parse(node.tags || '[]')
          return Array.isArray(v) ? v.map(String) : []
        } catch {
          return []
        }
      })()
    }
  })

  /* ---------------------------------------------------------------- shell */

  handle(CH.shell.openFolder, async (nodeId: number) => {
    const target = anchor.paths.node(Number(nodeId))
    if (!target) return { ok: false, error: t('ipc.noFolder') }
    if (!pathExists(target)) return { ok: false, error: t('ipc.folderMissing') }
    const err = await shell.openPath(target)
    return err ? { ok: false, error: err } : { ok: true }
  })

  handle(CH.shell.revealFolder, async (nodeId: number) => {
    const target = anchor.paths.node(Number(nodeId))
    if (!target || !pathExists(target)) return
    shell.showItemInFolder(target)
  })

  handle(CH.shell.copyPath, (nodeId: number) => {
    const target = anchor.paths.node(Number(nodeId))
    if (target) clipboard.writeText(target)
  })

  // The frozen `Api` types this `Promise<void>`: a refused path simply opens
  // nothing, and the renderer's only job is to have sent a safe relative path.
  handle(CH.shell.openFile, async (nodeId: number, relPath: string): Promise<void> => {
    const base = anchor.paths.node(Number(nodeId))
    if (!base) return
    const rel = String(relPath ?? '')
    // `safeRelative` rejects `..` and absolute inputs, so a hostile relPath from
    // the renderer cannot escape the folder the user already trusted.
    if (rel.includes('..') || rel.startsWith('/') || rel.startsWith('\\')) return
    const abs = join(base, rel)
    const inside = safeRelative(base, abs)
    if (inside === null) return
    if (!pathExists(abs)) return
    const err = await shell.openPath(abs)
    if (err) log.debug('openFile failed', { err })
  })

  /* --------------------------------------------------------------- events */

  handle(CH.events.list, (filter: EventFilter): HubEvent[] => repo.listEvents(filter ?? {}))

  handle(CH.events.syncAllGit, () => ctx.scanQueue.enqueue('git-sync', async () => {
    const result = await syncAllGit(200)
    if (result.newEvents > 0) ctx.broadcast(CH.broadcast.eventsAppended, repo.listEvents({ limit: result.newEvents }))
    return result
  }))

  handle(CH.events.heatmap, (from: number, to: number): DayCount[] => repo.dailyCounts(Number(from), Number(to), []))

  /* ---------------------------------------------------------------- icons */

  handle(CH.icons.listBuiltin, () => ICON_NAMES)
  handle(CH.icons.defs, () => BUILTIN_ICONS)
  handle(CH.icons.listCustom, (): IconAsset[] => repo.listIconAssets().filter((a) => a.filename))
  handle(CH.icons.store, async () => ({ dir: ctx.thumbsDir, assets: repo.listIconAssets() }))
  handle(CH.icons.removeCustom, async (filename: string) => {
    const safe = anchor.paths.icon(String(filename))
    if (!safe) return
    await removeFileQuiet(safe)
    repo.removeIconAsset(String(filename))
    ctx.broadcast(CH.broadcast.treeUpdated, null)
  })
  handle(CH.icons.gcUnused, async () => {
    const used = new Set(repo.usedIconFilenames())
    let removed = 0
    for (const asset of repo.listIconAssets()) {
      if (used.has(asset.filename)) continue
      const safe = anchor.paths.icon(asset.filename)
      if (safe && (await removeFileQuiet(safe))) {
        repo.removeIconAsset(asset.filename)
        removed += 1
      }
    }
    // Plus the generation cache for edges the UI no longer asks for.
    const gc = await thumbnailer.gc([64, 128, 256])
    return { removed: removed + gc.removed }
  })

  /* --------------------------------------------------------------- search */

  handle(CH.search.query, async (q: string): Promise<SearchHit[]> => {
    const query = String(q ?? '').trim()
    if (query === '') return []
    const raw = repo.searchNodes(`%${query}%`, 300)
    const ranked = rankByMatch(raw, query, (hit) => [hit.name, hit.displayName, hit.path, hit.snippet])
    const order = new Map<number, { score: number; snippet: string }>()
    for (const r of ranked) order.set(r.item.nodeId, { score: r.score, snippet: r.on })
    const merged = ranked.map((r) => ({ ...r.item, snippet: r.on }))
    // Anything the SQL pass found but the fuzzy pass did not still belongs in the
    // list (e.g. a tag-only hit); append it after the ranked rows.
    for (const hit of raw) {
      if (!order.has(hit.nodeId)) merged.push(hit)
    }
    return merged.slice(0, 100)
  })

  /* ------------------------------------------------------------- settings */

  handle(CH.settings.get, (key: string) => repo.getSetting(String(key)) ?? DEFAULT_SETTINGS[String(key)] ?? null)
  handle(CH.settings.set, async (key: string, value: string) => {
    repo.setSetting(String(key), String(value))
    if (String(key) === SETTING_KEYS.autoLaunch) {
      app.setLoginItemSettings({ openAtLogin: String(value) === 'true', args: ['--hidden'] })
    }
    // §9.10 — the tray menu and the next native dialog follow immediately.
    if (String(key) === SETTING_KEYS.language) setLang(String(value))
    ctx.broadcast(CH.broadcast.taskStatus, ctx.scheduler.status())
  })
  handle(CH.settings.all, () => ({ ...DEFAULT_SETTINGS, ...repo.allSettings() }))

  handle(CH.settings.background.current, async () => {
    const meta = readBackgroundMeta()
    if (!meta.filename) return { filename: null, origin: null, bytes: null, url: null, tint: null }
    const safe = anchor.paths.background(meta.filename)
    if (!safe || !pathExists(safe)) return { filename: null, origin: null, bytes: null, url: null, tint: null }
    return { ...meta, url: toMediaUrl(safe), tint: tintOf(safe) }
  })

  handle(CH.settings.background.choose, async () => {
    const picked = await pickImage(ctx.getWindow(), t('dialog.pickBackground'))
    if (!picked) return { ok: false, error: 'cancelled' }
    try {
      const { filename, bytes } = await copyIntoStore(picked, ctx.backgroundsDir)
      const meta = { filename, origin: basename(picked), bytes }
      const stored = join(ctx.backgroundsDir, filename)
      await fsp.mkdir(ctx.userData, { recursive: true })
      await fsp.writeFile(join(ctx.userData, 'background.json'), JSON.stringify(meta, null, 2), 'utf8')
      return { ok: true, image: { ...meta, url: toMediaUrl(stored), tint: tintOf(stored) } as never }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  handle(CH.settings.background.clear, async () => {
    const meta = readBackgroundMeta()
    if (meta.filename) {
      const safe = anchor.paths.background(meta.filename)
      if (safe) await removeFileQuiet(safe)
    }
    await fsp.writeFile(join(ctx.userData, 'background.json'), JSON.stringify({ filename: null }), 'utf8')
  })

  function readBackgroundMeta(): { filename: string | null; origin: string | null; bytes: number | null } {
    try {
      const raw = readFileSync(join(ctx.userData, 'background.json'), 'utf8')
      const parsed = JSON.parse(raw) as { filename?: string; origin?: string; bytes?: number }
      return { filename: parsed.filename ?? null, origin: parsed.origin ?? null, bytes: parsed.bytes ?? null }
    } catch {
      return { filename: null, origin: null, bytes: null }
    }
  }

  /* ----------------------------------------------------------- background */

  handle(CH.background.pause, () => {
    ctx.scheduler.setPaused(true)
    ctx.broadcast(CH.broadcast.taskStatus, ctx.scheduler.status())
  })
  handle(CH.background.resume, () => {
    ctx.scheduler.setPaused(false)
    ctx.broadcast(CH.broadcast.taskStatus, ctx.scheduler.status())
  })
  handle(CH.background.status, (): BackgroundStatus => ctx.scheduler.status())
  handle(CH.background.runNow, async (task: string) => {
    // The whitelist is a security boundary, not a hint: a renderer-supplied
    // string must never reach the scheduler as a task name. Rejecting loudly
    // beats returning silently, which would look like success in the UI.
    const allowed = ['rescan', 'git-sync', 'snapshot', 'prune', 'size-sweep'] as const
    if (!allowed.includes(task as (typeof allowed)[number])) {
      throw new Error(t('ipc.unknownTask', { task: String(task) }))
    }
    await ctx.scheduler.runNow(task as (typeof allowed)[number])
  })

  /* --------------------------------------------------------------- export */

  handle(CH.export.json, () => {
    const roots = repo.listRoots()
    const nodes = repo.listNodes()
    const events = repo.listEventsForExport(50_000)
    const settings = repo.allSettings()
    const payload = {
      app: 'project-hub',
      version: app.getVersion(),
      exportedAt: new Date().toISOString(),
      // Paths ARE included here on purpose: this is the user's own export, opened
      // by them, and it never leaves userData unless they choose a destination.
      roots,
      nodes,
      events,
      settings
    }
    return JSON.stringify(payload, null, 2)
  })

  handle(CH.export.writeFile, async (kind: 'json' | 'markdown', content?: string) => {
    const win = ctx.getWindow()
    const defaultName = `project-hub-export-${new Date().toISOString().slice(0, 10)}.${kind === 'json' ? 'json' : 'md'}`
    const res = win
      ? await dialog.showSaveDialog(win, { defaultPath: defaultName })
      : await dialog.showSaveDialog({ defaultPath: defaultName })
    if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' }
    // Markdown is rendered main-side so the file is byte-identical no matter what
    // the renderer sent; JSON is passed through (it came from `export:json`).
    if (kind === 'markdown') {
      const md = toMarkdown({
        roots: repo.listRoots(),
        nodes: detailedNodes(),
        events: repo.listEvents({ limit: 500 }),
        appVersion: app.getVersion()
      })
      await fsp.writeFile(res.filePath, md, 'utf8')
      return { ok: true, path: res.filePath }
    }
    await fsp.writeFile(res.filePath, String(content ?? ''), 'utf8')
    return { ok: true, path: res.filePath }
  })

  /* ------------------------------------------------------------------ app */

  handle(CH.app.info, () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    userData: ctx.userData,
    dbPath: ctx.dbPath,
    driver: driverName,
    schemaVersion: getUserVersion(getDb()),
    roots: repo.listRoots().length,
    nodes: repo.counts().nodes,
    events: repo.counts().events
  }))

  handle(CH.app.quit, () => {
    app.quit()
  })
  handle(CH.app.hideWindow, () => {
    ctx.getWindow()?.hide()
  })
  handle(CH.app.showWindow, () => {
    const win = ctx.getWindow()
    if (!win) return
    win.show()
    win.focus()
  })
  handle(CH.app.setAutoLaunch, (enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] })
    repo.setSetting(SETTING_KEYS.autoLaunch, String(Boolean(enabled)))
    return Boolean(enabled)
  })

  log.info('ipc handlers registered')
}

/* ------------------------------------------------------------------ */
/* shared scan runner                                                  */
/* ------------------------------------------------------------------ */

export async function runScan(ctx: IpcContext, rootId: number, incremental: boolean): Promise<ScanResult> {
  const root = repo.getRoot(rootId)
  if (!root) throw new Error(t('ipc.rootMissing'))
  // The scan worker opens its own connection to the SAME file the main process
  // has open — never a path derived here, or the worker would scan into a
  // different database and the tree would appear to stay empty.
  const dbPath = ctx.dbPath

  // Tier 1: a Worker thread. The walk never touches this event loop, which is
  // what §0.2 demands. The worker opens its own sqlite connection to the same
  // file; WAL mode makes that safe and the serial queue means only one scanner
  // ever writes at a time.
  const worker = await spawnWorker('scan')
  if (worker) {
    try {
      const result = await runJob<ScanResult>({
        kind: 'scan',
        name: `scan:${root.id}`,
        isolated: true,
        run: async () => {
          worker.onProgress((msg) => {
            const m = msg as { type?: string; rootId?: number; scanned?: number; current?: string }
            if (m.type === 'progress') {
              ctx.broadcast(CH.broadcast.scanProgress, {
                rootId: root.id,
                scanned: Number(m.scanned ?? 0),
                current: String(m.current ?? '')
              })
            }
          })
          return worker.request<ScanResult>({
            type: 'scan',
            rootId: root.id,
            rootPath: root.path,
            maxDepth: root.max_depth,
            incremental,
            dbPath
          })
        }
      })
      if (result.ok && result.value) {
        ctx.broadcast(CH.broadcast.treeUpdated, null)
        return result.value
      }
      log.warn('scan worker failed, falling back in-process', { err: result.error })
    } catch (err) {
      log.warn('scan worker unusable, falling back in-process', { err: (err as Error).message })
    } finally {
      worker.kill()
    }
  }

  // Tier 2: in-process walk with cooperative yields between batches.
  const result = await scanRoot({
    rootId: root.id,
    rootPath: root.path,
    maxDepth: root.max_depth,
    incremental,
    onProgress: (p) => ctx.broadcast(CH.broadcast.scanProgress, p)
  })
  ctx.broadcast(CH.broadcast.treeUpdated, null)
  return result
}

/** Exported for the watcher: turn a changed folder into timeline rows. */
export async function onFolderChanged(ctx: IpcContext, folder: string): Promise<void> {
  const events = await recordFolderChange(folder)
  if (events.length > 0) ctx.broadcast(CH.broadcast.eventsAppended, events)
  void ctx
}

/** Kept for the tray menu: cheap summary of what is in the store. */
export async function storeSummary(dirs: string[]): Promise<Array<{ dir: string; files: number }>> {
  const out: Array<{ dir: string; files: number }> = []
  for (const dir of dirs) {
    const files = await listFiles(dir)
    out.push({ dir, files: files.length })
  }
  return out
}
