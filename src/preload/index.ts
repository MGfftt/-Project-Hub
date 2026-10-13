/**
 * Preload bridge (§7.7).
 *
 * The renderer runs with `contextIsolation: true`, `nodeIntegration: false` and
 * `sandbox: true`, so this file is the *entire* surface it can reach. Two rules
 * hold here and are checked by `tests/unit/ipc-surface.test.ts`:
 *   1. every exposed method maps to exactly one channel in `@shared/channels`;
 *   2. nothing exposes a raw `ipcRenderer`, a `require`, or an absolute path
 *      parser — the renderer cannot construct a filesystem path of its own.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/channels'
import type {
  Api,
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
} from '../shared/types'
import type { IconDef } from '../shared/icons'

export interface BackgroundImage {
  filename: string | null
  origin: string | null
  bytes: number | null
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  chrome: string
  platform: string
  userData: string
  dbPath: string
  driver: string
  schemaVersion: number
  roots: number
  nodes: number
  events: number
}

export interface ThumbPayload {
  file: string
  edge?: number
  modifiedMs?: number
  size?: number
}

export interface ThumbReply {
  ok: boolean
  /** `file://` URL ready for an `<img src>`, or null. */
  dataUrl?: string | null
  error?: string
}

export interface HubApi extends Api {
  nodes: Api['nodes'] & {
    thumb(payload: ThumbPayload): Promise<ThumbReply>
    listChildren(parentId: number | null): Promise<TreeNode[]>
  }
  icons: Api['icons'] & {
    store(): Promise<{ dir: string; assets: IconAsset[] }>
    defs(): Promise<IconDef[]>
  }
  settings: Api['settings'] & {
    background: {
      current(): Promise<BackgroundImage>
      choose(): Promise<{ ok: boolean; image?: BackgroundImage; error?: string }>
      clear(): Promise<void>
    }
  }
  background: Api['background'] & {
    runNow(task: 'rescan' | 'git-sync' | 'snapshot' | 'prune' | 'size-sweep'): Promise<void>
  }
  export: Api['export'] & {
    writeFile(kind: 'json' | 'markdown', content: string): Promise<{ ok: boolean; path?: string; error?: string }>
  }
  app: {
    info(): Promise<AppInfo>
    quit(): Promise<void>
    hideWindow(): Promise<void>
    showWindow(): Promise<void>
    setAutoLaunch(enabled: boolean): Promise<boolean>
  }
  on(channel: Parameters<Api['on']>[0], cb: (payload: unknown) => void): () => void
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: HubApi = {
  roots: {
    add: (path: string) => invoke<Root>(CH.roots.add, path),
    list: () => invoke<Root[]>(CH.roots.list),
    remove: (id: number) => invoke<void>(CH.roots.remove, id),
    rescan: (id: number, incremental?: boolean) => invoke<ScanResult>(CH.roots.rescan, id, incremental ?? false),
    pick: () => invoke<string | null>(CH.roots.pick),
    setEnabled: (id: number, enabled: boolean) => invoke<void>(CH.roots.setEnabled, id, enabled)
  },
  nodes: {
    tree: () => invoke<TreeNode[]>(CH.nodes.tree),
    update: (id: number, patch: NodePatch) => invoke<void>(CH.nodes.update, id, patch),
    move: (id: number, parentId: number | null, index: number) =>
      invoke<void>(CH.nodes.move, id, parentId, index),
    createGroup: (name: string, parentId: number | null) =>
      invoke<number>(CH.nodes.createGroup, name, parentId),
    createNote: (parentId: number | null, text?: string) =>
      invoke<number>(CH.nodes.createNote, parentId, text),
    setNote: (id: number, text: string) => invoke<void>(CH.nodes.setNote, id, text),
    remove: (id: number) => invoke<void>(CH.nodes.remove, id),
    detail: (id: number) => invoke<NodeDetail | null>(CH.nodes.detail, id),
    stats: (nodeId: number) => invoke<NodeStats>(CH.nodes.stats, nodeId),
    setDisplayName: (nodeId: number, name: string | null) =>
      invoke<void>(CH.nodes.setDisplayName, nodeId, name),
    setIcon: (nodeId: number, type: IconType, value: string | null) =>
      invoke<void>(CH.nodes.setIcon, nodeId, type, value),
    importIcon: (nodeId: number) => invoke<{ ok: boolean; filename?: string; error?: string }>(CH.nodes.importIcon, nodeId),
    relocate: (nodeId: number) => invoke<{ ok: boolean; path?: string }>(CH.nodes.relocate, nodeId),
    thumb: (payload: ThumbPayload) => invoke<ThumbReply>(CH.nodes.thumb, payload),
    listChildren: (parentId: number | null) => invoke<TreeNode[]>(CH.nodes.listChildren, parentId)
  },
  shell: {
    openFolder: (nodeId: number) => invoke<{ ok: boolean; error?: string }>(CH.shell.openFolder, nodeId),
    revealFolder: (nodeId: number) => invoke<void>(CH.shell.revealFolder, nodeId),
    copyPath: (nodeId: number) => invoke<void>(CH.shell.copyPath, nodeId),
    openFile: (nodeId: number, relPath: string) => invoke<void>(CH.shell.openFile, nodeId, relPath)
  },
  events: {
    list: (filter: EventFilter) => invoke<HubEvent[]>(CH.events.list, filter),
    syncAllGit: () => invoke<{ synced: number; newEvents: number }>(CH.events.syncAllGit),
    heatmap: (from: number, to: number) => invoke<DayCount[]>(CH.events.heatmap, from, to)
  },
  icons: {
    listBuiltin: () => invoke<string[]>(CH.icons.listBuiltin),
    listCustom: () => invoke<IconAsset[]>(CH.icons.listCustom),
    removeCustom: (filename: string) => invoke<void>(CH.icons.removeCustom, filename),
    gcUnused: () => invoke<{ removed: number }>(CH.icons.gcUnused),
    store: () => invoke<{ dir: string; assets: IconAsset[] }>(CH.icons.store),
    defs: () => invoke<IconDef[]>(CH.icons.defs)
  },
  search: {
    query: (q: string) => invoke<SearchHit[]>(CH.search.query, q)
  },
  settings: {
    get: (key: string) => invoke<string | null>(CH.settings.get, key),
    set: (key: string, value: string) => invoke<void>(CH.settings.set, key, value),
    all: () => invoke<Record<string, string>>(CH.settings.all),
    background: {
      current: () => invoke<BackgroundImage>(CH.settings.background.current),
      choose: () => invoke<{ ok: boolean; image?: BackgroundImage; error?: string }>(CH.settings.background.choose),
      clear: () => invoke<void>(CH.settings.background.clear)
    }
  },
  background: {
    pause: () => invoke<void>(CH.background.pause),
    resume: () => invoke<void>(CH.background.resume),
    status: () => invoke<BackgroundStatus>(CH.background.status),
    runNow: (task) => invoke<void>(CH.background.runNow, task)
  },
  export: {
    json: () => invoke<string>(CH.export.json),
    writeFile: (kind, content) =>
      invoke<{ ok: boolean; path?: string; error?: string }>(CH.export.writeFile, kind, content)
  },
  app: {
    info: () => invoke<AppInfo>(CH.app.info),
    quit: () => invoke<void>(CH.app.quit),
    hideWindow: () => invoke<void>(CH.app.hideWindow),
    showWindow: () => invoke<void>(CH.app.showWindow),
    setAutoLaunch: (enabled: boolean) => invoke<boolean>(CH.app.setAutoLaunch, enabled)
  },
  on: (channel, cb) => {
    const allowed = new Set<string>(Object.values(CH.broadcast))
    if (!allowed.has(channel)) return () => undefined
    const listener = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('hub', api)

export type { HubApi as DefaultApi }
