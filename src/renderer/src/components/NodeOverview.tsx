import { useEffect, useState } from 'react'
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  FolderTree,
  Layers,
  Link as LinkIcon,
  Pencil
} from 'lucide-react'
import type { TreeNode } from '@shared/types'
import { NodeIcon } from '@renderer/components/NodeIcon'
import { childrenOf, descendantIds, kindLabel, statusLabel } from '@renderer/lib/tree'
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDelta,
  formatRelativeTime
} from '@renderer/lib/format'
import { useTree } from '@renderer/stores/tree'
import { useUi } from '@renderer/stores/ui'

/* ---------------------------------------------------------------------------
 * NodeOverview — what the middle column shows for the selected node.
 *
 * Before this existed, picking a node only tinted its row: the middle column
 * kept its "选择一个项目" placeholder until 查看改动 was used from the context
 * menu, which is why a plain click looked like it did nothing. Every selection
 * now lands on a real page — identity, quick actions, the numbers the main
 * process already computed, and the node's members, each of which can be
 * opened in place.
 * ------------------------------------------------------------------------ */

export interface NodeOverviewProps {
  node: TreeNode
}

/** A labelled figure in the stat strip. */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <div className="flex min-w-[7rem] flex-col gap-0.5" title={hint}>
      <span className="text-[var(--font-minor)] text-[var(--text-dim)]">{label}</span>
      <span className="truncate text-sm font-medium">{value}</span>
    </div>
  )
}

/** One indent step of the member tree, kept in step with the left panel's rows. */
const MEMBER_INDENT = 14
/** Guards against a malformed tree turning the recursive render into a runaway. */
const MEMBER_MAX_DEPTH = 24

/**
 * One row of the member tree plus its subtree. The left panel already renders
 * the whole forest; this is the branch rooted at the selected node, so the same
 * shape is available without leaving the page (§ the user's "显示应该以树状
 * 结构" note). Rows are keyboard reachable buttons, so Tab walks the subtree.
 */
function MemberBranch({
  node,
  depth,
  byId,
  collapsed,
  onToggle,
  onSelect
}: {
  node: TreeNode
  depth: number
  byId: Map<number, TreeNode>
  collapsed: Set<number>
  onToggle: (id: number) => void
  onSelect: (id: number) => void
}): JSX.Element {
  const live = byId.get(node.id) ?? node
  const kids = childrenOf(live)
  const expandable = kids.length > 0 && depth < MEMBER_MAX_DEPTH
  const open = expandable && !collapsed.has(live.id)
  const label = live.display_name || live.name
  const stats = useTree.getState().statsCache[live.id]

  return (
    <li>
      <div className="relative">
        {Array.from({ length: depth }, (_, i) => (
          <span
            key={i}
            aria-hidden
            className="pointer-events-none absolute bottom-0 top-0 border-l"
            style={{ left: MEMBER_INDENT * i + MEMBER_INDENT / 2, borderColor: 'var(--border)' }}
          />
        ))}
        <div
          className="row-hover flex w-full items-center gap-1 rounded py-1 pr-2"
          style={{ paddingLeft: MEMBER_INDENT * depth }}
        >
          {expandable ? (
            <button
              type="button"
              className="focus-ring grid h-4 w-4 shrink-0 place-items-center rounded text-[var(--text-dim)]"
              title={open ? '折叠这一支' : '展开这一支'}
              aria-label={open ? '折叠这一支' : '展开这一支'}
              aria-expanded={open}
              onClick={(event) => {
                event.stopPropagation()
                onToggle(live.id)
              }}
            >
              {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            </button>
          ) : (
            <span aria-hidden className="h-4 w-4 shrink-0" />
          )}
          <button
            type="button"
            className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded text-left"
            title={live.path ?? label}
            onClick={() => onSelect(live.id)}
          >
            <NodeIcon node={live} size={16} withStatus />
            <span className="truncate text-[var(--font-main)]">{label}</span>
            <span className="tag bg-[var(--hover)] text-[var(--text-dim)]">
              {kindLabel(live.kind)}
            </span>
            {expandable && !open ? (
              <span className="shrink-0 rounded-full bg-[var(--hover)] px-1.5 text-[10px] leading-4 text-[var(--text-dim)]">
                {kids.length}
              </span>
            ) : null}
          </button>
          <span className="shrink-0 text-[var(--font-minor)] text-[var(--text-dim)]">
            {formatRelativeTime(stats?.lastEventAt ?? live.updated_at)}
          </span>
        </div>
      </div>
      {open ? (
        <ul className="flex flex-col">
          {kids.map((kid) => (
            <MemberBranch
              key={kid.id}
              node={kid}
              depth={depth + 1}
              byId={byId}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function NodeOverview({ node }: NodeOverviewProps): JSX.Element {
  const live = useTree((s) => s.byId.get(node.id)) ?? node
  const stats = useTree((s) => s.statsCache[node.id])
  const byId = useTree((s) => s.byId)
  const select = useUi((s) => s.select)
  const setStatus = useUi((s) => s.setStatus)
  const openDialog = useUi((s) => s.openDialog)

  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(live.display_name ?? '')
  /** Member-tree branches the user folded shut; everything else stays open. */
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())

  function toggleCollapsed(id: number): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const isVirtualGroup = live.kind === 'group' && !live.path
  const children = childrenOf(live)
  /** Everything the member list renders, i.e. the deep count (§ header). */
  const memberTotal = descendantIds(live, byId).length - 1

  /* The middle column is the only place that always shows the node, so it is
     also the natural place to ask for the on-disk numbers. */
  useEffect(() => {
    void useTree
      .getState()
      .loadStats(node.id)
      .catch(() => undefined)
  }, [node.id])

  useEffect(() => {
    setRenaming(false)
    setDraft(live.display_name ?? '')
  }, [node.id, live.display_name])

  function commitRename(): void {
    const value = draft.trim().slice(0, 64)
    setRenaming(false)
    void window.hub?.nodes
      .setDisplayName(node.id, value || null)
      .then(() => {
        setStatus(value ? `已重命名为「${value}」` : '已恢复磁盘目录名', 'info')
        return useTree.getState().load()
      })
      .catch(() => undefined)
  }

  function addChildGroup(): void {
    const name = `新分组 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
    void window.hub?.nodes
      .createGroup(name, node.id)
      .then((id) => {
        setStatus(`已创建「${name}」`, 'info')
        return useTree.getState().load().then(() => {
          useTree.getState().setOpen(node.id, true)
          select(id)
        })
      })
      .catch((err: unknown) => setStatus(`新建分组失败：${String(err)}`, 'error'))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {/* --- identity ------------------------------------------------------ */}
      <header className="flex flex-col gap-3 border-b p-4" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border" style={{ borderColor: 'var(--border)' }}>
            <NodeIcon node={live} size={22} />
          </span>

          <div className="min-w-0 flex-1">
            {renaming ? (
              <input
                autoFocus
                className="input h-7 max-w-[24rem] text-sm"
                value={draft}
                maxLength={64}
                aria-label="重命名显示名称"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitRename()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setRenaming(false)
                    setDraft(live.display_name ?? '')
                  }
                }}
              />
            ) : (
              <h1 className="truncate text-lg font-semibold" title={live.display_name || live.name}>
                {live.display_name || live.name}
              </h1>
            )}

            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[var(--font-minor)] text-[var(--text-dim)]">
              <span className="tag bg-[var(--hover)]">{kindLabel(live.kind)}</span>
              <span className="tag bg-[var(--hover)]">{statusLabel(live.status)}</span>
              {live.display_name ? <span className="truncate">磁盘名：{live.name}</span> : null}
              {live.path_missing === 1 ? (
                <span className="tag tag-warn">路径不存在</span>
              ) : null}
            </div>
          </div>
        </div>

        <p className="truncate text-xs text-[var(--text-dim)]" title={live.path ?? undefined}>
          {live.path ?? '虚拟分组（没有对应的磁盘目录，只用来归类其它节点）'}
        </p>

        {/* --- actions ----------------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="btn btn-primary"
            disabled={isVirtualGroup || live.path_missing === 1}
            title={isVirtualGroup ? '分组没有对应的磁盘目录' : '在系统文件管理器中打开'}
            onClick={() => {
              void window.hub?.shell
                .openFolder(node.id)
                .then((res) => {
                  if (!res.ok) setStatus(res.error ?? '打开文件夹失败', 'error')
                })
                .catch(() => setStatus('打开文件夹失败', 'error'))
            }}
          >
            <FolderOpen size={14} aria-hidden />
            打开目录
          </button>
          <button
            type="button"
            className="btn"
            disabled={!live.path}
            onClick={() => void window.hub?.shell.revealFolder(node.id).catch(() => undefined)}
          >
            <ExternalLink size={14} aria-hidden />
            在文件夹中显示
          </button>
          <button
            type="button"
            className="btn"
            disabled={!live.path}
            onClick={() =>
              void window.hub?.shell
                .copyPath(node.id)
                .then(() => setStatus('路径已复制', 'info'))
                .catch(() => undefined)
            }
          >
            <LinkIcon size={14} aria-hidden />
            复制路径
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setDraft(live.display_name ?? '')
              setRenaming(true)
            }}
          >
            <Pencil size={14} aria-hidden />
            重命名
          </button>
          {live.kind === 'group' ? (
            <button type="button" className="btn" onClick={addChildGroup}>
              <FolderTree size={14} aria-hidden />
              新建子分组
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost" onClick={() => openDialog('stats', node.id)}>
            <BarChart3 size={14} aria-hidden />
            统计
          </button>
        </div>
      </header>

      {/* --- numbers ------------------------------------------------------- */}
      <section className="grid grid-cols-2 gap-3 border-b p-4 sm:grid-cols-4" style={{ borderColor: 'var(--border)' }}>
        <Stat label="子节点" value={formatCount(children.length)} />
        <Stat label="文件数" value={formatCount(stats?.fileCount ?? null)} hint="磁盘扫描统计" />
        <Stat
          label="占用空间"
          value={stats ? formatBytes(stats.diskSizeBytes) : '统计中…'}
          hint="磁盘占用由后台任务计算"
        />
        <Stat label="改动次数" value={formatCount(stats?.eventCount ?? null)} />
        <Stat
          label="最近改动"
          value={formatRelativeTime(stats?.lastEventAt ?? live.updated_at)}
          hint={stats?.lastEventAt ? formatDateTime(stats.lastEventAt) : undefined}
        />
        <Stat label="累计变更" value={formatDelta(stats?.totalInsertions, stats?.totalDeletions)} />
        <Stat label="Git 分支" value={stats?.gitBranch || '—'} hint={stats?.gitRemote ?? undefined} />
        <Stat label="加入时间" value={formatDateTime(live.created_at)} />
      </section>

      {/* --- members ------------------------------------------------------- */}
      <section className="flex min-h-0 flex-1 flex-col p-4">
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          <Layers size={14} aria-hidden />
          {live.kind === 'group' ? '分组内容' : '子节点'}
          <span className="text-[var(--font-minor)] text-[var(--text-dim)]">
            {/* The list below is the whole subtree, so a two-level folder must
                not read as "1" next to two visible rows. */}
            （{children.length === memberTotal ? children.length : `${children.length} 直接 · 共 ${memberTotal}`}）
          </span>
        </h2>

        {children.length === 0 ? (
          <p className="text-xs text-[var(--text-dim)]">
            {live.kind === 'group'
              ? '这个分组还是空的。把项目树里的节点拖到分组上方，就会归入这里。'
              : '没有子节点。'}
          </p>
        ) : (
          <ul className="flex flex-col overflow-y-auto">
            {children.map((child) => (
              <MemberBranch
                key={child.id}
                node={child}
                depth={0}
                byId={byId}
                collapsed={collapsed}
                onToggle={toggleCollapsed}
                onSelect={select}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export default NodeOverview
