import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderInput,
  FolderPlus,
  Plus,
  RefreshCw,
  ScanLine,
  Trash2
} from 'lucide-react'
import type { Root, TreeNode } from '@shared/types'
import SearchBox from '@renderer/components/SearchBox'
import NodeTree from '@renderer/components/NodeTree'
import Heatmap from '@renderer/components/Heatmap'
import ContextMenu from '@renderer/components/ContextMenu'
import ConfirmDialog from '@renderer/components/dialogs/ConfirmDialog'
import EmptyState from '@renderer/components/EmptyState'
import Skeleton from '@renderer/components/Skeleton'
import { useTree } from '@renderer/stores/tree'
import { useUi } from '@renderer/stores/ui'
import { useEvents } from '@renderer/stores/events'
import { formatRelativeTime } from '@renderer/lib/format'
import { t, tCount } from '@renderer/lib/i18n'
import { descendantIds, findParent, kindLabel, ungroupTarget } from '@renderer/lib/tree'

/* ---------------------------------------------------------------------------
 * TreePanel — the left column (§9.1).
 *
 *   toolbar   + 根目录 / 新建分组 / 展开全部 / 折叠全部 / 重新扫描
 *   search    <SearchBox/> (Ctrl/Cmd+F focuses it, §8.5)
 *   tree      <NodeTree/>
 *   footer    根目录管理（启用、深度、移除）+ 改动热力图
 *
 * Every mutation goes through `window.hub`; the panel never guesses at state it
 * could read back, so a failed IPC call surfaces in the StatusBar instead of
 * leaving the UI out of sync.
 * ------------------------------------------------------------------------ */

/* §9.1 — the toolbar row drops its two button labels below this column width.
 * The full row (添加根目录 + 分组 + three icon buttons) needs 277px, while the column
 * can be dragged down to LEFT_WIDTH_MIN (240px). The labelled buttons are
 * `whitespace-nowrap`, so they cannot shrink and the row used to spill over the
 * middle column's tab strip. 300 clears 277 with slack and stays under the 320px
 * default, so the labels only go away when the column is genuinely narrow. */
const TOOLBAR_LABEL_MIN_WIDTH = 300

/** One confirmation dialog serves every destructive action in this panel. */
interface PendingConfirm {
  title: string
  message: string
  confirmLabel: string
  run: () => void
}

export function TreePanel(): JSX.Element {
  const nodes = useTree((s) => s.nodes)
  const byId = useTree((s) => s.byId)
  const loading = useTree((s) => s.loading)
  const scanProgress = useTree((s) => s.scanProgress)
  const setScanProgress = useTree((s) => s.setScanProgress)
  const selectedId = useUi((s) => s.selectedId)
  const select = useUi((s) => s.select)
  const setStatus = useUi((s) => s.setStatus)
  const leftWidth = useUi((s) => s.leftWidth)

  /** §9.1 — narrow columns render the two labelled toolbar buttons as icons only,
   *  keeping their title/aria-label tooltip (see TOOLBAR_LABEL_MIN_WIDTH). */
  const showToolbarLabels = leftWidth >= TOOLBAR_LABEL_MIN_WIDTH

  const [roots, setRoots] = useState<Root[]>([])
  const [showRoots, setShowRoots] = useState(false)
  const [showHeatmap, setShowHeatmap] = useState(false)
  const [busy, setBusy] = useState(false)
  const [scrollToId, setScrollToId] = useState<number | null>(null)
  /** The §8.2 context menu, owned here because every action needs `hub`. */
  const [menu, setMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null)
  /** One dialog serves both "remove node" and "remove root". */
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  /** The picker-free way in: paste a path instead of browsing for it. */
  const [manualOpen, setManualOpen] = useState(false)
  const [manualPath, setManualPath] = useState('')

  const refreshRoots = useCallback(async () => {
    try {
      setRoots(await window.hub.roots.list())
    } catch (err) {
      setStatus(t('tree.rootsLoadFailed', { error: String(err) }), 'error')
    }
  }, [setStatus])

  useEffect(() => {
    void refreshRoots()
  }, [refreshRoots])

  const selectedNode: TreeNode | undefined = useMemo(
    () => (selectedId == null ? undefined : byId.get(selectedId)),
    [byId, selectedId]
  )

  /* Keep a panel-local mirror of the open map, so the toolbar can drive it. */
  const toggleAll = useCallback(
    (open: boolean) => {
      const store = useTree.getState()
      if (open) store.expandAll()
      else store.collapseAll()
    },
    []
  )

  const addRoot = useCallback(
    async (picked: string) => {
      const clean = picked.trim().replace(/[\\/]+$/, '')
      if (clean === '') {
        setStatus(t('tree.needPath'), 'warn')
        return
      }
      setBusy(true)
      try {
        /* `roots.add` is idempotent: adding a folder that is already a root
         * returns the existing row without scanning. Say so instead of leaving
         * the user staring at a tree that did not change. */
        const already = roots.some(
          (r) => r.path.replace(/[\\/]+$/, '').toLowerCase() === clean.toLowerCase()
        )
        const root = await window.hub.roots.add(clean)
        await refreshRoots()
        await useTree.getState().load()
        setStatus(
          already
            ? t('tree.rootAlready', { path: root.path })
            : t('tree.rootAdded', { path: root.path }),
          already ? 'warn' : 'info'
        )
      } catch (err) {
        setStatus(t('tree.rootAddFailed', { error: String(err) }), 'error')
      } finally {
        setBusy(false)
        setScanProgress(null)
      }
    },
    [refreshRoots, roots, setScanProgress, setStatus]
  )

  /**
   * The system folder picker is a native dialog: on a locked-down Windows
   * session it can fail to appear, and the promise then never settles. The
   * manual path box below is the way in that never depends on it, so the click
   * only has to hand the result over.
   */
  const pickRoot = useCallback(async () => {
    try {
      setStatus(t('tree.pickPrompt'), 'info')
      const picked = await window.hub.roots.pick()
      if (!picked) {
        setStatus(t('tree.pickCancelled'), 'warn')
        return
      }
      await addRoot(picked)
    } catch (err) {
      setStatus(t('tree.pickFailed', { error: String(err) }), 'error')
    }
  }, [addRoot, setStatus])

  const rescan = useCallback(
    async (rootId?: number) => {
      const target = rootId ?? roots[0]?.id
      if (target == null) {
        setStatus(t('tree.needRoot'), 'warn')
        return
      }
      try {
        setBusy(true)
        const result = await window.hub.roots.rescan(target, false)
        await refreshRoots()
        setStatus(
          t('tree.scanDone', {
            projects: result.projects,
            folders: result.folders,
            ms: result.elapsedMs
          }),
          'info'
        )
      } catch (err) {
        setStatus(t('tree.scanFailed', { error: String(err) }), 'error')
      } finally {
        setBusy(false)
        setScanProgress(null)
      }
    },
    [refreshRoots, roots, setScanProgress, setStatus]
  )

  const newGroup = useCallback(async () => {
    const parent = selectedNode && selectedNode.kind === 'group' ? selectedNode.id : null
    try {
      const name = t('tree.newGroupName', {
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      })
      const id = await window.hub.nodes.createGroup(name, parent)
      await useTree.getState().load()
      const store = useTree.getState()
      if (parent != null) store.setOpen(parent, true)
      select(id)
      setScrollToId(id)
      setStatus(t('tree.groupCreated'), 'info')
    } catch (err) {
      setStatus(t('tree.groupCreateFailed', { error: String(err) }), 'error')
    }
  }, [select, selectedNode, setStatus])

  const removeRoot = useCallback(
    async (root: Root) => {
      try {
        await window.hub.roots.remove(root.id)
        await refreshRoots()
        await useTree.getState().load()
        setStatus(t('tree.rootRemoved', { path: root.path }), 'info')
      } catch (err) {
        setStatus(t('tree.rootRemoveFailed', { error: String(err) }), 'error')
      }
    },
    [refreshRoots, setStatus]
  )

  const toggleRoot = useCallback(
    async (root: Root) => {
      try {
        await window.hub.roots.setEnabled(root.id, root.enabled !== 1)
        await refreshRoots()
        await useTree.getState().load()
      } catch (err) {
        setStatus(t('tree.rootToggleFailed', { error: String(err) }), 'error')
      }
    },
    [refreshRoots, setStatus]
  )

  /* --- §8.2 context menu ------------------------------------------- */

  const removeNode = useCallback(
    async (id: number) => {
      try {
        await window.hub.nodes.remove(id)
        await useTree.getState().load()
        setStatus(t('tree.nodeRemoved'), 'info')
      } catch (err) {
        setStatus(t('tree.removeFailed', { error: String(err) }), 'error')
      }
    },
    [setStatus]
  )

  /**
   * Removal is confirmed here, not inside the menu: ContextMenu is presentation
   * only, so 从库中移除 dispatches `hub:confirm-remove` (the contract's
   * alternative to ui.openDialog('confirm')) and this panel — which owns the
   * app's shared ConfirmDialog — answers it.
   */
  useEffect(() => {
    function onConfirmRemove(event: Event): void {
      const id = (event as CustomEvent<number | undefined>).detail
      if (typeof id !== 'number') return
      setPending({
        title: t('tree.removeFromLibrary'),
        message: t('tree.removeNodeConfirm'),
        confirmLabel: t('tree.remove'),
        run: () => void removeNode(id)
      })
    }
    window.addEventListener('hub:confirm-remove', onConfirmRemove as EventListener)
    return () => window.removeEventListener('hub:confirm-remove', onConfirmRemove as EventListener)
  }, [removeNode])

  const createChildGroup = useCallback(
    async (parent: TreeNode) => {
      try {
        const id = await window.hub.nodes.createGroup(t('tree.newGroup'), parent.id)
        await useTree.getState().load()
        /* Reveal the new child, then start the §8.3 inline rename in place. */
        useTree.getState().setOpen(parent.id, true)
        select(id)
        setScrollToId(id)
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('hub:rename', { detail: id }))
        }, 0)
      } catch (err) {
        setStatus(t('tree.newGroupFailed', { error: String(err) }), 'error')
      }
    },
    [select, setStatus]
  )

  /**
   * §7.8 — 移出分组. Only the virtual membership is undone: the node keeps its
   * path, its children and its place on disk, and lands one level above the
   * group it was in, right behind it.
   */
  const removeFromGroup = useCallback(
    async (node: TreeNode) => {
      const target = ungroupTarget(useTree.getState().nodes, node.id)
      if (!target) return
      try {
        await window.hub.nodes.move(node.id, target.parentId, target.index)
        await useTree.getState().load()
        setStatus(t('tree.ungrouped'), 'info')
      } catch (err) {
        setStatus(t('tree.ungroupFailed', { error: String(err) }), 'error')
      }
    },
    [setStatus]
  )

  const viewChanges = useCallback((node: TreeNode) => {
    useUi.getState().setMainView('timeline')
    /* descendantIds starts with the node itself, which is exactly the filter. */
    useEvents.getState().setFilter({ nodeIds: descendantIds(node, useTree.getState().byId) })
  }, [])

  const annotate = useCallback(
    (node: TreeNode) => {
      select(node.id)
      useUi.getState().setDetailOpen(true)
      /* The panel mounts on the next tick, so the focus request is deferred. */
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('hub:focus-note', { detail: node.id }))
      }, 0)
    },
    [select]
  )

  const openFolder = useCallback(
    (node: TreeNode) => {
      void window.hub.shell
        .openFolder(node.id)
        .then((result) => {
          if (!result.ok) setStatus(result.error ?? t('tree.cannotOpenFolder'), 'error')
        })
        .catch((err: unknown) => setStatus(t('tree.openFailed', { error: String(err) }), 'error'))
    },
    [setStatus]
  )

  const revealFolder = useCallback(
    (node: TreeNode) => {
      void window.hub.shell
        .revealFolder(node.id)
        .catch((err: unknown) => setStatus(t('tree.revealFailed', { error: String(err) }), 'error'))
    },
    [setStatus]
  )

  const copyPath = useCallback(
    (node: TreeNode) => {
      void window.hub.shell
        .copyPath(node.id)
        .then(() => setStatus(t('tree.pathCopied'), 'info'))
        .catch((err: unknown) =>
          setStatus(t('tree.copyPathFailed', { error: String(err) }), 'error')
        )
    },
    [setStatus]
  )

  const closeMenu = useCallback(() => setMenu(null), [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* toolbar */}
      <div
        className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5"
        style={{ borderColor: 'var(--border)' }}
      >
        <button
          type="button"
          className="btn btn-ghost focus-ring"
          title={t('tree.addRootTitle')}
          aria-label={showToolbarLabels ? undefined : t('tree.addRoot')}
          disabled={busy}
          onClick={() => void pickRoot()}
        >
          <Plus size={14} aria-hidden />
          {showToolbarLabels ? t('tree.root') : null}
        </button>
        <button
          type="button"
          className="btn btn-ghost focus-ring"
          title={t('tree.newGroupTitle')}
          aria-label={showToolbarLabels ? undefined : t('tree.newGroup')}
          onClick={() => void newGroup()}
        >
          <FolderPlus size={14} aria-hidden />
          {showToolbarLabels ? t('kind.group') : null}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className="btn btn-ghost focus-ring"
          title={t('tree.expandAll')}
          aria-label={t('tree.expandAll')}
          onClick={() => toggleAll(true)}
        >
          <ChevronsUpDown size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="btn btn-ghost focus-ring"
          title={t('tree.collapseAll')}
          aria-label={t('tree.collapseAll')}
          onClick={() => toggleAll(false)}
        >
          <ChevronsDownUp size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="btn btn-ghost focus-ring"
          title={t('tree.rescanTitle')}
          aria-label={t('tree.rescan')}
          disabled={busy}
          onClick={() => void rescan()}
        >
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} aria-hidden />
        </button>
      </div>

      {/* search */}
      <div className="shrink-0 border-b px-2 py-1.5" style={{ borderColor: 'var(--border)' }}>
        <SearchBox />
      </div>

      {/* scan progress (also mirrored in the StatusBar, §9.6) */}
      {scanProgress ? (
        <div className="shrink-0 px-2 py-1 text-[var(--font-tag)] text-[var(--text-dim)]">
          <div className="flex items-center gap-1.5">
            <ScanLine size={12} aria-hidden />
            {tCount('tree.scannedCountOne', 'tree.scannedCount', scanProgress.scanned)}
            <span className="truncate">{scanProgress.current}</span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--hover)]">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--accent)]" />
          </div>
        </div>
      ) : null}

      {/* tree */}
      {loading && nodes.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-hidden px-2 py-2">
          <Skeleton rows={8} />
        </div>
      ) : nodes.length === 0 && !scanProgress ? (
        <EmptyState
          className="min-h-0 flex-1"
          title={t('tree.emptyTitle')}
          description={t('tree.emptyDescription')}
          actionLabel={t('tree.addRoot')}
          onAction={() => void pickRoot()}
        />
      ) : (
        <NodeTree
          scrollToId={scrollToId}
          onContextMenu={(node, x, y) => setMenu({ node, x, y })}
        />
      )}

      {/* footer: 根目录管理 */}
      <div className="shrink-0 border-t" style={{ borderColor: 'var(--border)' }}>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[var(--font-minor)] text-[var(--text-dim)] hover:bg-[var(--hover)]"
          aria-expanded={showRoots}
          onClick={() => setShowRoots((v) => !v)}
        >
          <FolderInput size={13} aria-hidden />
          {t('tree.rootManage', { n: roots.length })}
          <span className="flex-1" />
          <ChevronDown
            size={13}
            className={'transition-transform ' + (showRoots ? 'rotate-180' : '')}
            aria-hidden
          />
        </button>

        {showRoots ? (
          <ul className="max-h-48 overflow-auto px-2 pb-2">
            {roots.map((root) => (
              <li
                key={root.id}
                className="flex items-center gap-1.5 rounded px-1 py-1 text-[var(--font-minor)] hover:bg-[var(--hover)]"
              >
                <input
                  type="checkbox"
                  className="focus-ring"
                  aria-label={t('tree.enableRoot', { path: root.path })}
                  checked={root.enabled === 1}
                  onChange={() => void toggleRoot(root)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate" title={root.path}>
                    {root.path}
                  </span>
                  <span className="text-[var(--font-tag)] text-[var(--text-dim)]">
                    {t('tree.rootDepthAdded', {
                      depth: root.max_depth,
                      time: formatRelativeTime(root.added_at)
                    })}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-ghost focus-ring"
                  title={t('tree.rescanRoot')}
                  aria-label={t('tree.rescanRootLabel', { path: root.path })}
                  onClick={() => void rescan(root.id)}
                >
                  <RefreshCw size={12} aria-hidden />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost focus-ring"
                  title={t('tree.removeRootHint')}
                  aria-label={t('tree.removeLabel', { path: root.path })}
                  onClick={() =>
                    setPending({
                      title: t('tree.removeRoot'),
                      message: t('tree.removeRootConfirm', { path: root.path }),
                      confirmLabel: t('tree.remove'),
                      run: () => void removeRoot(root)
                    })
                  }
                >
                  <Trash2 size={12} aria-hidden />
                </button>
              </li>
            ))}
            {roots.length === 0 ? (
              <li className="px-1 py-1 text-[var(--font-minor)] text-[var(--text-dim)]">
                {t('tree.noRoots')}
              </li>
            ) : null}
          </ul>
        ) : null}

        {/* The picker-free way to add a root. The native folder dialog is not
            always available, and a path can simply be pasted. */}
        <div className="px-2 pb-2">
          <button
            type="button"
            className="text-[var(--font-tag)] text-[var(--text-dim)] underline-offset-2 hover:underline"
            aria-expanded={manualOpen}
            onClick={() => setManualOpen((v) => !v)}
          >
            {manualOpen ? t('tree.manualCollapse') : t('tree.manualExpand')}
          </button>
          {manualOpen ? (
            <form
              className="mt-1 flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault()
                const value = manualPath
                setManualPath('')
                void addRoot(value)
              }}
            >
              <input
                className="input focus-ring min-w-0 flex-1 text-[var(--font-minor)]"
                type="text"
                value={manualPath}
                placeholder={t('tree.pathPlaceholder')}
                aria-label={t('tree.rootPathLabel')}
                spellCheck={false}
                onChange={(e) => setManualPath(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-primary focus-ring"
                disabled={busy || manualPath.trim() === ''}
              >
                {t('tree.add')}
              </button>
            </form>
          ) : null}
        </div>
      </div>

      {/* footer: 改动热力图 */}
      <div className="shrink-0 border-t" style={{ borderColor: 'var(--border)' }}>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[var(--font-minor)] text-[var(--text-dim)] hover:bg-[var(--hover)]"
          aria-expanded={showHeatmap}
          onClick={() => setShowHeatmap((v) => !v)}
        >
          {t('tree.heatmap')}
          <span className="flex-1" />
          <ChevronDown
            size={13}
            className={'transition-transform ' + (showHeatmap ? 'rotate-180' : '')}
            aria-hidden
          />
        </button>
        {showHeatmap ? (
          <div className="px-2 pb-2">
            <Heatmap />
          </div>
        ) : null}
      </div>

      {/* Selected node summary keeps the tree column self-explanatory. */}
      {selectedNode ? (
        <div
          className="shrink-0 truncate border-t px-2 py-1 text-[var(--font-tag)] text-[var(--text-dim)]"
          style={{ borderColor: 'var(--border)' }}
          title={selectedNode.path ?? undefined}
        >
          {t('tree.selected', {
            kind: kindLabel(selectedNode.kind),
            name: selectedNode.display_name || selectedNode.name
          })}
        </div>
      ) : null}

      {/* §8.2 menu: a portal-positioned popup, closed by click-outside/Escape/scroll. */}
      {menu ? (
        <ContextMenu
          node={menu.node}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          onOpenFolder={openFolder}
          onReveal={revealFolder}
          onCopyPath={copyPath}
          onViewChanges={viewChanges}
          onProperties={(node) => useUi.getState().openDialog('stats', node.id)}
          onAnnotate={annotate}
          onRename={(node) => {
            window.dispatchEvent(new CustomEvent('hub:rename', { detail: node.id }))
          }}
          onChangeIcon={(node) => useUi.getState().openDialog('icon', node.id)}
          onChangeColor={(node, color) => {
            void window.hub?.nodes.update(node.id, { color }).then(() => {
              useTree.getState().bump()
            })
          }}
          onNewGroup={(node) => void createChildGroup(node)}
          insideGroup={menu.node ? findParent(nodes, menu.node.id)?.kind === 'group' : false}
          onRemoveFromGroup={(node) => void removeFromGroup(node)}
          onRemove={(node) => {
            window.dispatchEvent(new CustomEvent('hub:confirm-remove', { detail: node.id }))
          }}
        />
      ) : null}

      {pending ? (
        <ConfirmDialog
          title={pending.title}
          message={pending.message}
          confirmLabel={pending.confirmLabel}
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const action = pending
            setPending(null)
            action.run()
          }}
        />
      ) : null}
    </div>
  )
}

export default TreePanel
