/**
 * Shared domain types — imported by main, preload, renderer and tests.
 * This file must stay free of Node and DOM APIs so both sides can use it.
 */

export type NodeKind = 'group' | 'project' | 'folder' | 'note'
export type NodeStatus = 'active' | 'paused' | 'done' | 'archived'
export type IconType = 'auto' | 'lucide' | 'emoji' | 'image'
export type EventSource = 'git' | 'fs' | 'manual'

export interface Root {
  id: number
  path: string
  enabled: number
  max_depth: number
  added_at: number
}

/** A row of the `nodes` table, as stored. */
export interface NodeRecord {
  id: number
  root_id: number | null
  parent_id: number | null
  name: string
  display_name: string | null
  path: string | null
  kind: NodeKind
  status: NodeStatus
  color: string | null
  priority: number
  sort_order: number
  note_md: string
  tags: string
  meta: string
  icon_type: IconType
  icon_value: string | null
  path_missing: number
  created_at: number
  updated_at: number
}

/** Wire shape for the tree: parsed tags/meta, no heavy note body. */
export interface TreeNode {
  id: number
  root_id: number | null
  parent_id: number | null
  name: string
  display_name: string | null
  path: string | null
  kind: NodeKind
  status: NodeStatus
  color: string | null
  priority: number
  sort_order: number
  tags: string[]
  icon_type: IconType
  icon_value: string | null
  path_missing: number
  /**
   * Scanner fingerprint (`marker`, `projectKind`, `isGit`, `depth`, `mtime`).
   * Carried on the tree so an `auto` icon can be chosen from the marker (§9.3)
   * and the workspace map can tell a Git project from a plain folder without a
   * second round-trip. Groups and hand-made nodes have `{}`.
   */
  meta?: Record<string, unknown>
  created_at: number
  updated_at: number
  children?: TreeNode[]
}

export interface NodeDetail extends TreeNode {
  note_md: string
  meta: Record<string, unknown>
}

export interface NodePatch {
  display_name?: string | null
  status?: NodeStatus
  color?: string | null
  priority?: number
  sort_order?: number
  note_md?: string
  tags?: string[]
  icon_type?: IconType
  icon_value?: string | null
  name?: string
}

export interface EventRecord {
  id: number
  node_id: number
  source: EventSource
  ref: string | null
  message: string | null
  author: string | null
  occurred_at: number
  file_count: number
  insertions: number
  deletions: number
  files_json: string
}

export interface HubEvent {
  id: number
  node_id: number
  source: EventSource
  ref: string | null
  message: string | null
  author: string | null
  occurred_at: number
  file_count: number
  insertions: number
  deletions: number
  files: string[]
}

export interface EventFilter {
  nodeIds?: number[]
  sources?: EventSource[]
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export interface DayCount {
  day: string // YYYY-MM-DD
  count: number
  insertions: number
  deletions: number
}

export interface ScanResult {
  rootId: number
  scanned: number
  projects: number
  folders: number
  skipped: number
  elapsedMs: number
  missing: number
}

export interface ScanProgress {
  rootId: number
  scanned: number
  current: string
}

export interface NodeStats {
  nodeId: number
  name: string
  displayName: string | null
  path: string | null
  kind: NodeKind
  isGitRepo: boolean
  gitRemote: string | null
  gitBranch: string | null
  diskSizeBytes: number | null // null === still computing
  fileCount: number | null
  childCount: number
  createdAt: number
  modifiedAt: number
  lastEventAt: number | null
  firstEventAt: number | null
  eventCount: number
  totalInsertions: number
  totalDeletions: number
  status: string
  tags: string[]
}

export interface SearchHit {
  nodeId: number
  kind: NodeKind
  name: string
  displayName: string | null
  path: string | null
  matchedOn: string
  snippet: string
}

export interface IconAsset {
  id: number
  filename: string
  origin: string | null
  bytes: number | null
  added_at: number
}

export interface BackgroundStatus {
  paused: boolean
  running: string[]
  lastRun: Record<string, number>
  nextRun: Record<string, number>
  onBattery: boolean
  windowHidden: boolean
}

export interface TrayState {
  paused: boolean
  unreadEvents: number
  lastGitSync: number | null
  watching: number
}

export interface TaskStateRow {
  task: string
  last_run: number | null
  next_run: number | null
  meta: string
}

/** Frozen IPC surface (§7.7). */
export interface Api {
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
    /** A virtual note node: `kind === 'note'`, no disk path, body stored in `meta.text`. */
    createNote(parentId: number | null, text?: string): Promise<number>
    setNote(id: number, text: string): Promise<void>
    remove(id: number): Promise<void>
    detail(id: number): Promise<NodeDetail | null>
    stats(nodeId: number): Promise<NodeStats>
    setDisplayName(nodeId: number, name: string | null): Promise<void>
    setIcon(nodeId: number, type: IconType, value: string | null): Promise<void>
    importIcon(nodeId: number): Promise<{ ok: boolean; filename?: string; error?: string }>
    relocate(nodeId: number): Promise<{ ok: boolean; path?: string }>
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
  }
  search: {
    query(q: string): Promise<SearchHit[]>
  }
  settings: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    all(): Promise<Record<string, string>>
  }
  appearance: {
    /**
     * §9.11 — Windows only: acrylic draws the desktop behind the window, which
     * is what makes the frosted-glass switch mean something. `picture` wins over
     * `glass`: a chosen picture is the window's own backdrop.
     */
    setMaterial(state: { glass: boolean; picture: boolean }): Promise<void>
  }
  window: {
    /** §9.11 — a frameless window has no native buttons; the tab strip draws them. */
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    state(): Promise<{ maximized: boolean }>
  }
  background: {
    pause(): Promise<void>
    resume(): Promise<void>
    status(): Promise<BackgroundStatus>
  }
  export: {
    json(): Promise<string>
  }
  on(
    channel: 'tree:updated' | 'events:appended' | 'scan:progress' | 'task:status' | 'window:visibility' | 'tray:state',
    cb: (payload: unknown) => void
  ): () => void
}

export type BroadcastChannel =
  | 'tree:updated'
  | 'events:appended'
  | 'scan:progress'
  | 'task:status'
  | 'window:visibility'
  | 'tray:state'

/** Raw git log entry produced by the git worker. */
export interface RawGitEvent {
  hash: string
  author: string
  date: string
  subject: string
  files: number
  insertions: number
  deletions: number
  fileList: string[]
}

export interface ScanWorkerRequest {
  type: 'scan'
  rootId: number
  rootPath: string
  maxDepth: number
  incremental: boolean
  dbPath: string
}

export interface GitWorkerRequest {
  type: 'sync'
  dbPath: string
  repos: Array<{ nodeId: number; path: string; lastHash: string | null; limit: number }>
}

export interface SizeWorkerRequest {
  type: 'size'
  nodeId: number
  path: string
}

export const SETTING_KEYS = {
  clickToOpen: 'clickToOpen',
  compactMode: 'compactMode',
  theme: 'theme',
  /** Frosted glass is an independent effect layered over any theme (§9.11). */
  glass: 'glass',
  /** Interface language: 'zh' or 'en' (§9.10). */
  language: 'language',
  firstHideTip: 'firstHideTip',
  autoLaunch: 'autoLaunch',
  pauseOnBattery: 'pauseOnBattery',
  hideToTray: 'hideToTray',
  lastGitSyncAt: 'lastGitSyncAt'
} as const

export const DEFAULT_SETTINGS: Record<string, string> = {
  [SETTING_KEYS.clickToOpen]: 'true',
  [SETTING_KEYS.compactMode]: 'false',
  [SETTING_KEYS.theme]: 'system',
  [SETTING_KEYS.glass]: 'false',
  [SETTING_KEYS.language]: 'zh',
  [SETTING_KEYS.firstHideTip]: '',
  [SETTING_KEYS.autoLaunch]: 'false',
  [SETTING_KEYS.pauseOnBattery]: 'true',
  [SETTING_KEYS.hideToTray]: 'true'
}
