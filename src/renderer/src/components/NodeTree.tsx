import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from 'react-arborist'
import type { TreeNode } from '@shared/types'
import { NodeRow } from '@renderer/components/NodeRow'
import { t } from '@renderer/lib/i18n'
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

/** §7.8 — the outer fraction of a *group* row that still counts as "insert
 *  beside it" instead of "insert into it". react-arborist's own band is the
 *  outer quarter of the row (see the group-drop note inside the component);
 *  this shrinks it to the hairline at the row's very edge. */
const GROUP_EDGE_BAND = 0.08

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
    // Groups and notes are virtual: there is no directory to open.
    if (!node.path) return
    void window.hub.shell.openFolder(node.id).catch((err: unknown) => {
      useUi.getState().setStatus(t('tree.openFailed', { error: String(err) }), 'error')
    })
  }, [])

  const canOpenFolder = useCallback(
    (node: TreeNode): boolean => clickToOpen && Boolean(node.path) && node.path_missing !== 1,
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
   *
   * A single click only selects — it never opens a folder. Opening is an
   * explicit action: the overview names it 打开目录, and the double click below
   * is the shortcut for it.
   */
  const handleActivate = useCallback(
    (node: NodeApi<TreeNode>, source: 'click' | 'key') => {
      const data = node.data
      if (source === 'key') {
        if (!node.isLeaf) {
          node.toggle()
          if (!node.isOpen) requestStats(data.id)
        } else if (canOpenFolder(data)) {
          openFolder(data)
        }
        return
      }

      /* A second activation inside the double-click window means the user wants
         the branch toggled, or — on a leaf — the folder opened. */
      if (clickTimer.current != null) {
        cancelPendingOpen()
        if (!node.isLeaf) node.toggle()
        else if (canOpenFolder(data)) openFolder(data)
        return
      }
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = null
      }, CLICK_OPEN_DELAY_MS)
    },
    [canOpenFolder, cancelPendingOpen, openFolder, requestStats]
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

  /* -------------------------------------------------------------------------
   * Group drops (§7.8) — "dragging a project onto a group does not always add
   * it to the group".
   *
   * react-arborist decides "drop inside" from the pointer's y inside the row
   * it hovers, and only the *middle half* of an internal row means that: its
   * dnd/compute-drop.js measures `pad = height / 4`, calls the outer quarters
   * `atTop` / `atBottom`, and returns those as a sibling insert. On a 32px row
   * that leaves 16px of nestable height, so a user aiming at a group row and
   * landing a few pixels high gets the node dropped *beside* the group — the
   * row highlights as a line instead of a target. `pad` is hardcoded in the
   * library, so the band has to be corrected from the outside.
   *
   * This capture-phase listener intercepts dragover/drop over an internal row
   * inside that band and re-dispatches the very same DragEvent on the same row
   * aimed at the row's centre. react-dnd's HTML5 backend resolves the drop
   * target from `event.target` and takes clientOffset straight off the event,
   * so the replay reaches react-arborist's own maths — and therefore `onMove` —
   * exactly as a middle-of-the-row drop would. Both events need it: the backend
   * hovers again on every dragover *and* once more inside its own drop handler,
   * so intercepting only one still lets the drop decide from the real y.
   *
   * Left alone are all non-group rows — a project, a note, a plain folder and
   * a folder that holds subfolders all keep the library's top-half / bottom-half
   * split, which is what makes deliberate insertion between two rows possible.
   * A group row keeps the same split in the hairline at its very edge, so a node
   * can still be dropped directly above or below a group on purpose.
   * ---------------------------------------------------------------------- */
  const replayingDrop = useRef(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    /** The element react-arborist connects the drop target to — the library's
     *  own `role="treeitem"` row, which is also what it measures y against. */
    function rowElement(target: EventTarget | null): HTMLElement | null {
      return target instanceof Element ? target.closest<HTMLElement>('[role="treeitem"]') : null
    }

    function handleGroupDrag(event: DragEvent): void {
      /* Our own replay arrives here too — let it through untouched. */
      if (replayingDrop.current) return
      const row = rowElement(event.target)
      if (!row) return
      const id = row.querySelector('[data-node-id]')?.getAttribute('data-node-id')
      const node = id == null ? null : treeRef.current?.get(id)
      /* Only a group row is a drop-into target here. `isInternal` on its own
       * would also catch a folder that happens to hold subfolders (and a root
       * row), and those keep the library's split — a node must still be
       * insertable deliberately above or below them, and only a group is the
       * virtual container this report is about. */
      if (!node?.isInternal || node.data.kind !== 'group') return
      const rect = row.getBoundingClientRect()
      if (rect.height <= 0) return
      const y = event.clientY - rect.top
      const edge = rect.height * GROUP_EDGE_BAND
      if (y <= edge || y >= rect.height - edge) return

      /* Hand the event to the library's own listeners with a corrected y. The
       * original must still have its default prevented, otherwise the browser
       * never lets go of the drop at all. */
      event.preventDefault()
      event.stopPropagation()
      replayingDrop.current = true
      try {
        row.dispatchEvent(
          new DragEvent(event.type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: event.dataTransfer,
            clientX: event.clientX,
            clientY: rect.top + rect.height / 2
          })
        )
      } finally {
        replayingDrop.current = false
      }
    }

    container.addEventListener('dragover', handleGroupDrag, true)
    container.addEventListener('drop', handleGroupDrag, true)
    return () => {
      container.removeEventListener('dragover', handleGroupDrag, true)
      container.removeEventListener('drop', handleGroupDrag, true)
    }
    /* `error` swaps this container for the failure notice, so the listener has
     * to move to the element that replaces it. */
  }, [error])

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
        useUi.getState().setStatus(t('tree.moveIntoSelf'), 'warn')
        // arborist already moved its own copy of the data; reload to undo it.
        void useTree.getState().load()
        return
      }
      const parentId = args.parentId == null ? null : Number(args.parentId)
      void window.hub.nodes
        .move(Number(dragged.id), parentId, args.index)
        .then(() => {
          useUi.getState().setStatus(t('tree.nodeMoved'), 'info')
          return useTree.getState().load()
        })
        .catch((err: unknown) => {
          useUi.getState().setStatus(t('tree.moveFailed', { error: String(err) }), 'error')
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
        {t('tree.loadFailed', { error })}
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
          aria-label={t('tree.treeLabel')}
          onMove={handleMove}
          onSelect={(selection) => {
            const first = selection[0]
            if (first == null) {
              select(null)
              return
            }
            /* A click must always show something. On the timeline tab the
             * events on screen belong to whatever 查看改动 filtered, which is
             * not necessarily what was just clicked, so land on the overview
             * instead of leaving a stale list under a fresh selection. */
            select(Number(first.id))
            useUi.getState().setMainView('overview')
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
                useUi.getState().setStatus(t('tree.renameFailed', { error: String(err) }), 'error')
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
