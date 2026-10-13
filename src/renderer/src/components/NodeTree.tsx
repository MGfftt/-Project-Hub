import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from 'react-arborist'
import type { TreeNode } from '@shared/types'
import { NodeRow } from '@renderer/components/NodeRow'
import { useTree } from '@renderer/stores/tree'
import { useUi } from '@renderer/stores/ui'

/* ---------------------------------------------------------------------------
 * NodeTree — the react-arborist host (§7.8 / §9.3).
 *
 * Interaction contract (react-arborist 3.16 routing is pinned by reading its
 * own build, because the frozen spec disagrees with the library defaults):
 *
 *   click        the library selects, then calls `onActivate`; we schedule the
 *                open there and cancel it when a second activation arrives, so
 *                a double click expands instead of opening the folder (§8.1)
 *   dblclick     toggles a branch (both clicks call onActivate → cancel+expand)
 *   Enter        open the focused node — routed through the row's own handler
 *   Space        toggle the focused branch — same route
 *   F2           inline rename of the in-app alias only (§8.3)
 *   right click  the §8.2 context menu, reported to the parent
 *
 * The store's `open` map is the single source of truth for expansion, so the
 * 展开全部 / 折叠全部 buttons and this component can never disagree.
 * ------------------------------------------------------------------------ */

export interface NodeTreeProps {
  /** Called with the node under the pointer when the context menu should open. */
  onContextMenu?: (node: TreeNode, x: number, y: number) => void
  /** Overrides the store's `open` map (the tree panel owns the real one). */
  openState?: Record<string, boolean>
  /** Node the tree should reveal and scroll to, whenever this value changes. */
  scrollToId?: number | null
}

/** §8.1 — delayed just past the double-click window so a dblclick never opens. */
const CLICK_OPEN_DELAY_MS = 260

function useElementSize<T extends HTMLElement>(): [
  React.RefObject<T>,
  { width: number; height: number }
] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (): void => {
      const rect = el.getBoundingClientRect()
      setSize((prev) =>
        Math.abs(prev.width - rect.width) < 1 && Math.abs(prev.height - rect.height) < 1
          ? prev
          : { width: Math.round(rect.width), height: Math.round(rect.height) }
      )
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return [ref, size]
}

export function NodeTree({
  onContextMenu,
  openState,
  scrollToId = null
}: NodeTreeProps): JSX.Element {
  const nodes = useTree((s) => s.nodes)
  const error = useTree((s) => s.error)
  const open = useTree((s) => s.open)
  const compactMode = useUi((s) => s.compactMode)
  const clickToOpen = useUi((s) => s.clickToOpen)
  const selectedId = useUi((s) => s.selectedId)
  const select = useUi((s) => s.select)

  const [containerRef, size] = useElementSize<HTMLDivElement>()
  const treeRef = useRef<TreeApi<TreeNode> | null>(null)
  const clickTimer = useRef<number | null>(null)
  const statsRequested = useRef<Set<number>>(new Set())

  const rowHeight = compactMode ? 26 : 32

  /* The store keeps numeric ids; arborist keys everything by string. */
  const arboristOpen = useMemo(() => {
    const source = openState ?? open
    const next: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(source)) {
      if (value) next[key] = true
    }
    return next
  }, [open, openState])

  useEffect(() => {
    return () => {
      if (clickTimer.current != null) window.clearTimeout(clickTimer.current)
    }
  }, [])

  /** §8.1 — the click contract, with the double-click guard. */
  const openFolder = useCallback((node: TreeNode) => {
    if (node.kind === 'group' && !node.path) return
    void window.hub.shell.openFolder(node.id).catch((err: unknown) => {
      useUi.getState().setStatus(`打开失败：${String(err)}`, 'error')
    })
  }, [])

  const canOpen = useCallback(
    (node: TreeNode): boolean =>
      clickToOpen && !(node.kind === 'group' && !node.path) && node.path_missing !== 1,
    [clickToOpen]
  )

  /** Lazily fetch disk statistics for nodes the user actually looks at. */
  const requestStats = useCallback((id: number) => {
    if (statsRequested.current.has(id)) return
    statsRequested.current.add(id)
    void useTree.getState().loadStats(id)
  }, [])

  const cancelPendingOpen = useCallback(() => {
    if (clickTimer.current != null) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
  }, [])

  /**
   * Every click and every Space/Enter activation lands here (NodeRow stops the
   * library's own key handling so the two cannot both act on one key press).
   */
  const handleActivate = useCallback(
    (node: NodeApi<TreeNode>, source: 'click' | 'key') => {
      const data = node.data
      if (source === 'key') {
        if (node.isLeaf) {
          if (canOpen(data)) openFolder(data)
        } else {
          node.toggle()
          if (!node.isOpen) requestStats(data.id)
        }
        return
      }

      /* click: a second activation within the double-click window means the user
         is opening a branch, so the pending folder-open is dropped. */
      if (clickTimer.current != null) {
        cancelPendingOpen()
        if (!node.isLeaf) node.toggle()
        return
      }
      if (!canOpen(data)) return
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = null
        openFolder(data)
      }, CLICK_OPEN_DELAY_MS)
    },
    [canOpen, cancelPendingOpen, openFolder, requestStats]
  )

  /* True while the sync effect below is replaying the store onto the library.
   * react-arborist routes *every* open/close through `onToggle`, including the
   * ones this component asks for, so without this guard the two would chase
   * each other: replay opens a row → onToggle writes the store back → the store
   * changes → the effect replays again. React counts those nested updates and
   * aborts the whole tree with "Maximum update depth exceeded", which is what
   * used to blank the window. */
  const syncing = useRef(false)

  const handleToggle = useCallback(
    (id: string) => {
      if (syncing.current) return
      const numeric = Number(id)
      /* The library has already applied the change by the time it calls us, so
       * its own state — not the inverse of the store — is what we record. */
      const api = treeRef.current
      const nowOpen = api ? api.isOpen(id) : !useTree.getState().open[numeric]
      useTree.getState().setOpen(numeric, nowOpen)
      if (nowOpen) requestStats(numeric)
    },
    [requestStats]
  )

  /* The store owns expansion, but react-arborist reads `initialOpenState` only
   * when it builds the tree, so 展开全部 / 折叠全部 (and every other writer of
   * the store's `open` map) have to be replayed onto the live tree — in both
   * directions, because 折叠全部 empties the map and the rows that are open in
   * the library have to be closed from its side. `syncing` keeps that replay
   * one-way, so it converges instead of oscillating. */
  useEffect(() => {
    const api = treeRef.current
    if (!api) return
    syncing.current = true
    try {
      for (const [key, value] of Object.entries(arboristOpen)) {
        if (value && !api.isOpen(key)) api.open(key)
        else if (!value && api.isOpen(key)) api.close(key)
      }
      const live = api.openState ?? {}
      for (const key of Object.keys(live)) {
        if (live[key] && !arboristOpen[key] && api.isOpen(key)) api.close(key)
      }
    } finally {
      syncing.current = false
    }
  }, [arboristOpen, nodes])

  /** Drops are only legal when the target is not inside the dragged subtree. */
  const isDescendant = useCallback(
    (dragged: NodeApi<TreeNode>, target: NodeApi<TreeNode> | null): boolean => {
      let current: NodeApi<TreeNode> | null = target
      while (current) {
        if (current.id === dragged.id) return true
        current = current.parent
      }
      return false
    },
    []
  )

  const handleMove = useCallback(
    (args: {
      dragIds: string[]
      dragNodes: NodeApi<TreeNode>[]
      parentId: string | null
      parentNode: NodeApi<TreeNode> | null
      index: number
    }) => {
      const dragged = args.dragNodes[0]
      if (!dragged) return
      if (isDescendant(dragged, args.parentNode)) {
        useUi.getState().setStatus('不能把节点移动到它自己的子节点中', 'warn')
        // arborist already moved its own copy of the data; reload to undo it.
        void useTree.getState().load()
        return
      }
      const parentId = args.parentId == null ? null : Number(args.parentId)
      void window.hub.nodes
        .move(Number(dragged.id), parentId, args.index)
        .then(() => {
          useUi.getState().setStatus('已移动节点', 'info')
          return useTree.getState().load()
        })
        .catch((err: unknown) => {
          useUi.getState().setStatus(`移动失败：${String(err)}`, 'error')
          void useTree.getState().load()
        })
    },
    [isDescendant]
  )

  /* F2 from the global keymap lands here as a CustomEvent (§8.5). */
  useEffect(() => {
    function onRenameEvent(event: Event): void {
      const detail = (event as CustomEvent<number | undefined>).detail
      const id = typeof detail === 'number' ? detail : useUi.getState().selectedId
      if (id == null) return
      const api = treeRef.current
      if (!api) return
      const node = api.get(String(id))
      if (node) void node.edit()
    }
    window.addEventListener('hub:rename', onRenameEvent as EventListener)
    return () => window.removeEventListener('hub:rename', onRenameEvent as EventListener)
  }, [])

  /** Reveal and scroll to a node when something else drives the selection. */
  useEffect(() => {
    if (scrollToId == null) return
    const api = treeRef.current
    if (!api) return
    const id = String(scrollToId)
    const visible = api.visibleNodes.some((node) => node.id === id)
    if (!visible) {
      const ancestors: string[] = []
      let current = api.get(id)?.parent ?? null
      while (current) {
        ancestors.unshift(String(current.id))
        current = current.parent
      }
      for (const ancestor of ancestors) api.open(ancestor)
    }
    void api.scrollTo(id)
  }, [scrollToId, nodes])

  const renderRow = useCallback(
    (props: NodeRendererProps<TreeNode>) => (
      <NodeRow
        node={props.node}
        style={props.style}
        dragHandle={props.dragHandle}
        compact={compactMode}
        selected={props.node.isSelected}
        onContextMenu={(data, event) => {
          const api = treeRef.current
          if (api && !api.isSelected(String(data.id))) api.select(String(data.id))
          onContextMenu?.(data, event.clientX, event.clientY)
        }}
        onActivate={(source) => handleActivate(props.node, source)}
      />
    ),
    [compactMode, handleActivate, onContextMenu]
  )

  if (error) {
    return (
      <div className="p-3 text-[var(--font-minor)] text-[var(--tone-error)]" role="alert">
        项目树加载失败：{error}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" data-testid="node-tree">
      {size.height > 0 ? (
        <Tree<TreeNode>
          ref={treeRef}
          data={nodes}
          /* The store keys nodes by integer id, but react-arborist only ever
           * round-trips *string* identities: its `identify()` passes a string
           * straight through and reads `.id` off a NodeApi, and for anything
           * else it runs the accessor again. With a plain `idAccessor="id"` the
           * ids stay numbers, so a click's `select()` → `setSelection({ ids:
           * [4] })` → `identify(4)` re-runs the accessor on the *number* and
           * stores `undefined` — the row paints as selected while
           * `onSelect` reports an empty list, which is exactly the "clicking a
           * node does nothing" failure. Stringifying here keeps every identity
           * inside the tree a string (docs: "idAccessor must return a string"). */
          idAccessor={(node) => String(node.id)}
          childrenAccessor="children"
          openByDefault={false}
          width={size.width || 320}
          height={size.height || 480}
          indent={16}
          rowHeight={rowHeight}
          overscanCount={8}
          disableMultiSelection
          selection={selectedId == null ? undefined : String(selectedId)}
          initialOpenState={arboristOpen}
          aria-label="项目树"
          onMove={handleMove}
          onSelect={(selection) => {
            const first = selection[0]
            select(first == null ? null : Number(first.id))
          }}
          onActivate={(node) => handleActivate(node, 'click')}
          onToggle={handleToggle}
          onRename={(args) => {
            const id = Number(args.id)
            const value = args.name.trim().slice(0, 64)
            void window.hub.nodes
              .setDisplayName(id, value || null)
              .then(() => useTree.getState().load())
              .catch((err: unknown) => {
                useUi.getState().setStatus(`重命名失败：${String(err)}`, 'error')
              })
          }}
        >
          {renderRow}
        </Tree>
      ) : null}
    </div>
  )
}

export default NodeTree
