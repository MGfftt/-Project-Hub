# Renderer contract (frozen — do not change without updating every consumer)

Everything below is already implemented in `src/shared`, `src/preload` and `src/main`.
The renderer must **only** talk to the main process through `window.hub`. It must
never import from `node:*`, `electron` or `src/main/**`.

## 1. `window.hub` — the complete surface

`src/preload/index.ts` exposes `window.hub: HubApi extends Api`. Types come from
`src/shared/types.ts`; channels from `src/shared/channels.ts`.

```
hub.roots:   add(path) Root | list() Root[] | remove(id) | rescan(id, incremental?) ScanResult
             pick() string|null | setEnabled(id, enabled)
hub.nodes:   tree() TreeNode[]
             update(id, patch: NodePatch)          // note_md, tags, status, meta, sort_order
             move(id, parentId|null, index)
             createGroup(name, parentId|null) number
             remove(id)
             detail(id) NodeDetail|null
             stats(nodeId) NodeStats
             setDisplayName(nodeId, name|null)
             setIcon(nodeId, type: IconType, value: string|null)
             importIcon(nodeId) { ok, filename?, error? }
             relocate(nodeId) { ok, path? }
             thumb({ nodeId, edge? }) { ok, dataUrl?, error? }   // dataUrl is a hub-media:// URL
             listChildren(parentId|null) TreeNode[]
hub.shell:   openFolder(nodeId) { ok, error? } | revealFolder(nodeId) | copyPath(nodeId)
             openFile(nodeId, relPath)
hub.events:  list(filter: EventFilter) HubEvent[]
             syncAllGit() { synced, newEvents }
             heatmap(from, to) DayCount[]
hub.icons:   listBuiltin() string[] | listCustom() IconAsset[] | removeCustom(filename)
             gcUnused() { removed } | store() { dir, assets } | defs() IconDef[]
hub.search:  query(q) SearchHit[]
hub.settings: get(key) string|null | set(key, value) | all() Record<string,string>
             background.current() BackgroundImage
             background.choose() { ok, image?, error? }
             background.clear()
hub.background: pause() | resume() | status() BackgroundStatus | runNow(task)
hub.export:  json() string | writeFile('json'|'markdown', content) { ok, path?, error? }
hub.app:     info() AppInfo | quit() | hideWindow() | showWindow() | setAutoLaunch(b) boolean
hub.on(channel, cb) => unsubscribe
             channel: 'tree:updated'|'events:appended'|'scan:progress'|'task:status'
                      |'window:visibility'|'tray:state'
```

`AppInfo = { version, name, node, chrome, platform, userData, dbPath, driver,
schemaVersion, roots, nodes, events }`.

### Payloads pushed from main

```
'tree:updated'      { reason: string }
'events:appended'   HubEvent[] | { count: number }
'scan:progress'     ScanProgress = { rootId: number; scanned: number; current: string }
'task:status'       BackgroundStatus = { paused, running: string[], lastRun: Record<string,number>,
                                        nextRun: Record<string,number>, onBattery, windowHidden }
'window:visibility' { visible: boolean }
'tray:state'        TrayState = { paused, unreadEvents, lastGitSync: number|null, watching: number }
```

## 2. Data shapes (`src/shared/types.ts`)

```ts
type NodeKind   = 'group' | 'project' | 'folder'
type NodeStatus = 'active' | 'paused' | 'done' | 'archived'
type IconType   = 'auto' | 'lucide' | 'emoji' | 'image'

interface TreeNode {
  id: number
  root_id: number | null
  parent_id: number | null
  kind: NodeKind
  name: string
  display_name: string | null
  path: string | null
  tags: string[]            // already parsed
  status: NodeStatus
  icon_type: IconType
  icon_value: string | null
  sort_order: number
  depth: number
  path_missing: 0 | 1
  created_at: number
  updated_at: number
  children: TreeNode[]
}

interface NodeDetail extends TreeNode { note_md: string; meta: Record<string, unknown> }

interface NodeStats {
  // 基本
  nodeId: number; name: string; displayName: string | null; path: string | null
  kind: NodeKind; status: string
  // 磁盘
  diskSizeBytes: number | null   // null === 仍在计算
  fileCount: number | null; childCount: number
  createdAt: number; modifiedAt: number
  // Git
  isGitRepo: boolean; gitRemote: string | null; gitBranch: string | null
  // 改动
  firstEventAt: number | null; lastEventAt: number | null; eventCount: number
  totalInsertions: number; totalDeletions: number
  // 标注
  tags: string[]
}

interface HubEvent {
  id: number; node_id: number; source: 'git'|'fs'|'manual'
  ref: string | null; message: string; author: string | null
  occurred_at: number; file_count: number; insertions: number; deletions: number
  files: string[]
}

interface EventFilter { nodeIds?: number[]; sources?: EventSource[]
                        from?: number; to?: number; limit?: number; offset?: number }
interface DayCount  { day: string /* YYYY-MM-DD local */; count: number; insertions: number; deletions: number }
interface SearchHit { nodeId: number; kind: NodeKind; name: string; displayName: string | null
                      path: string | null; matchedOn: 'display_name'|'name'|'path'|'tag'|'note'; snippet: string }

interface IconDef  { name: string; group: string; keywords: string[] }   // from src/shared/icons.ts
interface IconAsset{ id: number; filename: string; origin: string | null
                     bytes: number | null; added_at: number }
interface BackgroundImage { filename: string | null; origin: string | null; bytes: number | null }
interface Root { id: number; path: string; enabled: number; max_depth: number; added_at: number }
interface ScanResult { rootId: number; scanned: number; projects: number; folders: number
                       skipped: number; elapsedMs: number; missing: number }
```

`AppInfo` is exported from `src/preload/index.ts`, not from `shared/types.ts`; the
renderer declares it locally in `src/renderer/src/types/hub.d.ts`.

`SETTING_KEYS` / `DEFAULT_SETTINGS` also live in `src/shared/types.ts`; always read
settings through those keys, never with a string literal.
`src/shared/icons.ts` exports `BUILTIN_ICONS: IconDef[]` (the frozen 60) and
`ICON_NAMES: string[]`.

## 3. Stores (zustand, `src/renderer/src/stores/`)

Four stores, each a `create<...>()` hook. Keep actions thin: they call `window.hub`
or `ipc/` wrappers and set state. No store imports another store at module scope
(use `useX.getState()` inside actions to avoid cycles).

```ts
// ui.ts
interface UiState {
  mainView: 'tree' | 'timeline' | 'settings'
  setMainView(v: UiState['mainView']): void
  selectedId: number | null
  select(id: number | null): void
  expanded: Record<number, boolean>       // arborist open state is separate; this is for "expand all"
  detailOpen: boolean
  setDetailOpen(open: boolean): void
  leftWidth: number; rightWidth: number   // px, persisted through settings
  setLeftWidth(w: number): void; setRightWidth(w: number): void
  compactMode: boolean; setCompactMode(v: boolean): void
  clickToOpen: boolean; setClickToOpen(v: boolean): void
  theme: 'light' | 'dark' | 'system'; setTheme(t: UiState['theme']): void
  dialog: null | 'stats' | 'icon' | 'settings' | 'confirm'
  dialogNodeId: number | null
  openDialog(d: UiState['dialog'], nodeId?: number | null): void
  closeDialog(): void
  status: { text: string; tone: 'info' | 'warn' | 'error'; at: number } | null
  setStatus(text: string, tone?: 'info' | 'warn' | 'error'): void
}

// tree.ts
interface TreeState {
  nodes: TreeNode[]                        // forest from hub.nodes.tree()
  byId: Map<number, TreeNode>
  loading: boolean
  error: string | null
  scanProgress: ScanProgress | null
  open: Record<number, boolean>            // react-arborist open map
  focusId: number | null
  load(): Promise<void>
  setOpen(id: number, open: boolean): void
  toggleOpen(id: number): void
  expandAll(): void
  collapseAll(): void
  statsCache: Record<number, NodeStats>
  loadStats(id: number): Promise<NodeStats>
  bump(): void                             // marks the tree stale after a mutation
}

// events.ts
interface EventsState {
  events: HubEvent[]
  loading: boolean
  error: string | null
  filter: EventFilter                      // nodeIds undefined = all
  setFilter(f: EventFilter): void
  clearFilter(): void
  load(): Promise<void>
  heatmap: DayCount[]
  loadHeatmap(from: number, to: number): Promise<void>
  zoom: 'day' | 'week' | 'month' | 'quarter' | 'year'
  setZoom(z: EventsState['zoom']): void
  sync(): Promise<{ synced: number; newEvents: number }>
}
```

Also a `settings.ts` store holding `Record<string, string>` with `load()`,
`set(key, value)` (writes through `hub.settings.set`) and `get(key, fallback)`.

## 4. Component contract (`src/renderer/src/components/`)

| File | Export | Responsibility |
| --- | --- | --- |
| `AppShell.tsx` | `AppShell` | three-column grid, title/StatusBar, global keyboard, IPC subscriptions, dialogs |
| `TreePanel.tsx` | `TreePanel` | toolbar (+ root / group / rescan) + search box + `NodeTree` + root manager |
| `NodeTree.tsx` | `NodeTree` | react-arborist `<Tree>` with `NodeRow` |
| `NodeRow.tsx` | `NodeRow` | one row: caret, `NodeIcon`, name, tags, relative time, status dot |
| `NodeIcon.tsx` | `NodeIcon` | `auto`/`lucide`/`emoji`/`image` rendering; `auto` inference |
| `ContextMenu.tsx` | `ContextMenu` | the frozen §8.2 menu, with availability rules |
| `DetailPanel.tsx` | `DetailPanel` | tabs 概览 / 改动 / 标注 |
| `Timeline.tsx` | `Timeline` | §9.4 timeline + zoom + breadcrumb |
| `Heatmap.tsx` | `Heatmap` | year grid from `hub.events.heatmap` |
| `SearchBox.tsx` | `SearchBox` | debounced `hub.search.query`, results dropdown |
| `StatusBar.tsx` | `StatusBar` | scan progress, counts, background status, path-missing warnings |
| `dialogs/StatsDialog.tsx` | `StatsDialog` | §8.2 属性 field groups |
| `dialogs/IconPicker.tsx` | `IconPicker` | three tabs: 自动 / 内置 / 自定义 |
| `dialogs/SettingsDialog.tsx` | `SettingsDialog` | theme, compact, clickToOpen, hideToTray, autoLaunch, pause, background image, export, data isolation note |
| `dialogs/ConfirmDialog.tsx` | `ConfirmDialog` | generic confirm |
| `EmptyState.tsx` | `EmptyState` | centered illustration + primary action |
| `Skeleton.tsx` | `Skeleton` | skeleton rows (never a spinner — §9.6) |

`App.tsx` renders `<AppShell />`. `main.tsx` is the React root and sets the theme
class on `<html>`.

## 5. Rules

1. **No React re-render storms.** `NodeRow` is memoised; tag colours come from a
   `stringToHue`-equivalent local helper, not a random value per render.
2. **`hub-media://` URLs** may be used directly in `<img src>`.
3. **Keyboard**: the handlers live in `AppShell` in one `useEffect`; `NodeTree`
   owns arrows/space/enter while focused.
4. **Isolation copy**: whenever a dialog mentions user paths, state that the app
   only reads them and stores the library under `userData`.
5. **All user-visible copy is Chinese**, matching `项目书.md`. Keep it short.
6. **Dark mode** through Tailwind `dark:` classes plus CSS variables defined in
   `src/renderer/src/styles.css`.
7. Every component must typecheck under `tsconfig.web.json` (strict, `noUnusedLocals`).
