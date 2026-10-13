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
import { descendantIds } from '@renderer/lib/tree'

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

const KIND_LABEL: Record<string, string> = {
  group: '分组',
  project: '项目',
  folder: '文件夹',
  note: '备注'
}

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
      setStatus(`读取根目录失败：${String(err)}`, 'error')
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
        setStatus('请输入一个文件夹路径', 'warn')
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
            ? `这个文件夹已经是根目录了：${root.path}`
            : `已添加根目录：${root.path}，正在扫描…`,
          already ? 'warn' : 'info'
        )
      } catch (err) {
        setStatus(`添加根目录失败：${String(err)}`, 'error')
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
      setStatus('请在系统窗口里选择一个文件夹…', 'info')
      const picked = await window.hub.roots.pick()
      if (!picked) {
        setStatus('没有选择文件夹。如果系统窗口没有出现，请用「手动输入路径」添加。', 'warn')
        return
      }
      await addRoot(picked)
    } catch (err) {
      setStatus(`打开文件夹选择框失败：${String(err)}。可以改用「手动输入路径」。`, 'error')
    }
  }, [addRoot, setStatus])

  const rescan = useCallback(
    async (rootId?: number) => {
      const target = rootId ?? roots[0]?.id
      if (target == null) {
        setStatus('请先添加一个根目录', 'warn')
        return
      }
      try {
        setBusy(true)
        const result = await window.hub.roots.rescan(target, false)
        await refreshRoots()
        setStatus(
          `扫描完成：${result.projects} 个项目、${result.folders} 个文件夹，用时 ${result.elapsedMs} ms`,
          'info'
        )
      } catch (err) {
        setStatus(`扫描失败：${String(err)}`, 'error')
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
      const name = `新分组 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
      const id = await window.hub.nodes.createGroup(name, parent)
      await useTree.getState().load()
      const store = useTree.getState()
      if (parent != null) store.setOpen(parent, true)
      select(id)
      setScrollToId(id)
      setStatus('已创建分组，可在右侧「属性」里改名称与标注', 'info')
    } catch (err) {
      setStatus(`创建分组失败：${String(err)}`, 'error')
    }
  }, [select, selectedNode, setStatus])

  const removeRoot = useCallback(
    async (root: Root) => {
      try {
        await window.hub.roots.remove(root.id)
        await refreshRoots()
        await useTree.getState().load()
        setStatus(`已移除根目录：${root.path}（磁盘文件未做任何改动）`, 'info')
      } catch (err) {
        setStatus(`移除根目录失败：${String(err)}`, 'error')
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
        setStatus(`切换根目录启用状态失败：${String(err)}`, 'error')
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
        setStatus('已从库中移除（磁盘文件未做任何改动）', 'info')
      } catch (err) {
        setStatus(`移除失败：${String(err)}`, 'error')
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
        title: '从库中移除',
        message: '这只会删除本程序中的记录，磁盘上的文件不会被修改。确认移除？',
        confirmLabel: '移除',
        run: () => void removeNode(id)
      })
    }
    window.addEventListener('hub:confirm-remove', onConfirmRemove as EventListener)
    return () => window.removeEventListener('hub:confirm-remove', onConfirmRemove as EventListener)
  }, [removeNode])

  const createChildGroup = useCallback(
    async (parent: TreeNode) => {
      try {
        const id = await window.hub.nodes.createGroup('新建分组', parent.id)
        await useTree.getState().load()
        /* Reveal the new child, then start the §8.3 inline rename in place. */
        useTree.getState().setOpen(parent.id, true)
        select(id)
        setScrollToId(id)
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('hub:rename', { detail: id }))
        }, 0)
      } catch (err) {
        setStatus(`新建分组失败：${String(err)}`, 'error')
      }
    },
    [select, setStatus]
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
          if (!result.ok) setStatus(result.error ?? '无法打开该文件夹', 'error')
        })
        .catch((err: unknown) => setStatus(`打开失败：${String(err)}`, 'error'))
    },
    [setStatus]
  )

  const revealFolder = useCallback(
    (node: TreeNode) => {
      void window.hub.shell
        .revealFolder(node.id)
        .catch((err: unknown) => setStatus(`无法在文件管理器中显示：${String(err)}`, 'error'))
    },
    [setStatus]
  )

  const copyPath = useCallback(
    (node: TreeNode) => {
      void window.hub.shell
        .copyPath(node.id)
        .then(() => setStatus('已复制路径到剪贴板', 'info'))
        .catch((err: unknown) => setStatus(`复制路径失败：${String(err)}`, 'error'))
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
          title="添加根目录（扫描其中的项目）"
          disabled={busy}
          onClick={() => void pickRoot()}
        >
          <Plus size={14} aria-hidden />
          根目录
        </button>
        <button
          type="button"
          className="btn btn-ghost focus-ring"
          title="在当前选中项下新建虚拟分组"
          onClick={() => void newGroup()}
        >
          <FolderPlus size={14} aria-hidden />
          分组
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className="btn btn-ghost focus-ring"
          title="展开全部"
          aria-label="展开全部"
          onClick={() => toggleAll(true)}
        >
          <ChevronsUpDown size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="btn btn-ghost focus-ring"
          title="折叠全部"
          aria-label="折叠全部"
          onClick={() => toggleAll(false)}
        >
          <ChevronsDownUp size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="btn btn-ghost focus-ring"
          title="重新扫描根目录（Ctrl/Cmd + R）"
          aria-label="重新扫描"
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
            已扫描 {scanProgress.scanned} 个目录
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
          title="还没有索引任何项目"
          description="添加一个根目录，程序会扫描其中的项目与文件夹。程序只读取磁盘，不会写入被索引的目录。"
          actionLabel="添加根目录"
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
          根目录管理（{roots.length}）
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
                  aria-label={`启用 ${root.path}`}
                  checked={root.enabled === 1}
                  onChange={() => void toggleRoot(root)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate" title={root.path}>
                    {root.path}
                  </span>
                  <span className="text-[var(--font-tag)] text-[var(--text-dim)]">
                    深度 {root.max_depth} · 添加于 {formatRelativeTime(root.added_at)}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-ghost focus-ring"
                  title="重新扫描此根目录"
                  aria-label={`重新扫描 ${root.path}`}
                  onClick={() => void rescan(root.id)}
                >
                  <RefreshCw size={12} aria-hidden />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost focus-ring"
                  title="从库中移除（不会删除磁盘文件）"
                  aria-label={`移除 ${root.path}`}
                  onClick={() =>
                    setPending({
                      title: '移除根目录',
                      message: `移除「${root.path}」只会删除本程序中的索引记录，磁盘上的文件不会被修改。确认移除？`,
                      confirmLabel: '移除',
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
                尚未添加根目录
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
            {manualOpen ? '收起手动输入' : '手动输入路径…'}
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
                placeholder="C:\Users\你\Desktop\项目"
                aria-label="根目录路径"
                spellCheck={false}
                onChange={(e) => setManualPath(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-primary focus-ring"
                disabled={busy || manualPath.trim() === ''}
              >
                添加
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
          改动热力图
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
          已选：{KIND_LABEL[selectedNode.kind] ?? selectedNode.kind} ·{' '}
          {selectedNode.display_name || selectedNode.name}
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
