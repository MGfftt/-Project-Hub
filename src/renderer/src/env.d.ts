/// <reference types="vite/client" />

/**
 * The renderer's only door to the outside world.
 *
 * `window.hub` is installed by `src/preload/index.ts` through `contextBridge`.
 * The type is re-declared here (rather than imported from `src/preload`) so the
 * renderer bundle never pulls in a file that imports `electron`.
 *
 * The shapes mirror `src/shared/types.ts`; if you change one, change the other.
 */

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
  ScanProgress,
  ScanResult,
  SearchHit,
  TrayState,
  TreeNode
} from '../../shared/types'
import type { IconDef } from '../../shared/icons'

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

export interface BackgroundImage {
  filename: string | null
  origin: string | null
  bytes: number | null
  /* §9.11 — a `hub-media://` URL for the stored copy; absent when the file is
     gone, which is exactly when the renderer must stop painting it. */
  url?: string
  /* §9.11 — the picture's average colour as `#rrggbb`, computed in the main
     process. It tints every sub-interface and decides light versus dark. */
  tint?: string | null
}

export interface ThumbReply {
  ok: boolean
  /** A `hub-media://` URL ready for `<img src>`, or null. */
  dataUrl?: string | null
  error?: string
}

export type BroadcastChannel =
  | 'tree:updated'
  | 'events:appended'
  | 'scan:progress'
  | 'task:status'
  | 'window:visibility'
  | 'window:maximized'
  | 'tray:state'

export interface HubApi {
  roots: {
    add(path: string): Promise<Root>
    list(): Promise<Root[]>
    remove(id: number): Promise<void>
    rescan(id: number, incremental?: boolean): Promise<ScanResult>
    pick(): Promise<string | null>
    setEnabled(id: number, enabled: boolean): Promise<void>
  }
  nodes: {
    tree(): Promise<TreeNode[]>
    update(id: number, patch: NodePatch): Promise<void>
    move(id: number, parentId: number | null, index: number): Promise<void>
    createGroup(name: string, parentId: number | null): Promise<number>
    createNote(parentId: number | null, text?: string): Promise<number>
    setNote(id: number, text: string): Promise<void>
    remove(id: number): Promise<void>
    detail(id: number): Promise<NodeDetail | null>
    stats(nodeId: number): Promise<NodeStats>
    setDisplayName(nodeId: number, name: string | null): Promise<void>
    setIcon(nodeId: number, type: IconType, value: string | null): Promise<void>
    importIcon(nodeId: number): Promise<{ ok: boolean; filename?: string; error?: string }>
    relocate(nodeId: number): Promise<{ ok: boolean; path?: string }>
    thumb(payload: { nodeId: number; edge?: number }): Promise<ThumbReply>
    listChildren(parentId: number | null): Promise<TreeNode[]>
  }
  shell: {
    openFolder(nodeId: number): Promise<{ ok: boolean; error?: string }>
    revealFolder(nodeId: number): Promise<void>
    copyPath(nodeId: number): Promise<void>
    openFile(nodeId: number, relPath: string): Promise<void>
  }
  events: {
    list(filter: EventFilter): Promise<HubEvent[]>
    syncAllGit(): Promise<{ synced: number; newEvents: number }>
    heatmap(from: number, to: number): Promise<DayCount[]>
  }
  icons: {
    listBuiltin(): Promise<string[]>
    listCustom(): Promise<IconAsset[]>
    removeCustom(filename: string): Promise<void>
    gcUnused(): Promise<{ removed: number }>
    store(): Promise<{ dir: string; assets: IconAsset[] }>
    defs(): Promise<IconDef[]>
  }
  search: {
    query(q: string): Promise<SearchHit[]>
  }
  settings: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    all(): Promise<Record<string, string>>
    background: {
      current(): Promise<BackgroundImage>
      choose(): Promise<{ ok: boolean; image?: BackgroundImage; error?: string }>
      clear(): Promise<void>
    }
  }
  appearance: {
    /** §9.11 — Windows: draw the desktop through the window while glass is on. */
    setMaterial(state: { glass: boolean; picture: boolean }): Promise<void>
  }
  window: {
    /** §9.11 — a frameless window has no native buttons. */
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    state(): Promise<{ maximized: boolean }>
  }
  background: {
    pause(): Promise<void>
    resume(): Promise<void>
    status(): Promise<BackgroundStatus>
    runNow(task: 'rescan' | 'git-sync' | 'snapshot' | 'prune' | 'size-sweep'): Promise<void>
  }
  export: {
    json(): Promise<string>
    writeFile(kind: 'json' | 'markdown', content: string): Promise<{ ok: boolean; path?: string; error?: string }>
  }
  app: {
    info(): Promise<AppInfo>
    quit(): Promise<void>
    hideWindow(): Promise<void>
    showWindow(): Promise<void>
    setAutoLaunch(enabled: boolean): Promise<boolean>
  }
  /** Subscribe to a main-process push channel; returns an unsubscribe function. */
  on(channel: BroadcastChannel, cb: (payload: unknown) => void): () => void
}

declare global {
  interface Window {
    hub: HubApi
  }
}

export type { ScanProgress, TrayState }
