import { useEffect, useRef, useState } from 'react'
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  FolderTree,
  Layers,
  Link as LinkIcon,
  Pencil,
  StickyNote
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
import { t } from '@renderer/lib/i18n'
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
              title={open ? t('detail.collapseBranch') : t('detail.expandBranch')}
              aria-label={open ? t('detail.collapseBranch') : t('detail.expandBranch')}
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

  const isNote = live.kind === 'note'
  const children = childrenOf(live)
  /** Everything the member list renders, i.e. the deep count (§ header). */
  const memberTotal = descendantIds(live, byId).length - 1

  /* Note bodies live in `meta.text` and are edited here. The draft is local so
     typing never waits for the broadcast round trip; `savedRef` keeps the
     background `treeUpdated` reload from stomping on what is being typed. */
  const [noteText, setNoteText] = useState(() => String((live.meta?.text as string) ?? ''))
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const savedRef = useRef(noteText)
  const noteTimer = useRef<number | null>(null)

  useEffect(() => {
    const stored = String((live.meta?.text as string) ?? '')
    if (stored !== savedRef.current) {
      savedRef.current = stored
      setNoteText(stored)
    }
    // Only react to the node identity: `live` changes on every tree broadcast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  /* Auto-save on a short idle, plus an explicit flush on blur. */
  useEffect(() => {
    if (!isNote) return
    if (noteText === savedRef.current) return
    if (noteTimer.current != null) window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => {
      noteTimer.current = null
      if (noteText === savedRef.current) return
      savedRef.current = noteText
      setNoteState('saving')
      void window.hub?.nodes
        .setNote(node.id, noteText)
        .then(() => setNoteState('saved'))
        .catch(() => setNoteState('idle'))
    }, 600)
    return () => {
      if (noteTimer.current != null) window.clearTimeout(noteTimer.current)
      noteTimer.current = null
    }
  }, [isNote, noteText, node.id])

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
        setStatus(value ? t('detail.renamed', { name: value }) : t('detail.renameReset'), 'info')
        return useTree.getState().load()
      })
      .catch(() => undefined)
  }

  function addChildGroup(): void {
    const name = t('detail.newGroupName', {
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    })
    void window.hub?.nodes
      .createGroup(name, node.id)
      .then((id) => {
        setStatus(t('detail.groupCreated', { name }), 'info')
        return useTree.getState().load().then(() => {
          useTree.getState().setOpen(node.id, true)
          select(id)
        })
      })
      .catch((err: unknown) => setStatus(t('detail.groupCreateFailed', { error: String(err) }), 'error'))
  }

  /** Notes hang off any node; they are how the map gets annotated. */
  function addChildNote(): void {
    void window.hub?.nodes
      .createNote(node.id, '')
      .then((id) => {
        setStatus(t('detail.noteAdded'), 'info')
        return useTree.getState().load().then(() => {
          useTree.getState().setOpen(node.id, true)
          select(id)
        })
      })
      .catch((err: unknown) => setStatus(t('detail.noteAddFailed', { error: String(err) }), 'error'))
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
                aria-label={t('detail.renameDisplayName')}
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
              {live.display_name ? (
                <span className="truncate">{t('detail.diskName', { name: live.name })}</span>
              ) : null}
              {live.path_missing === 1 ? (
                <span className="tag tag-warn">{t('detail.pathMissing')}</span>
              ) : null}
            </div>
          </div>
        </div>

        <p className="truncate text-xs text-[var(--text-dim)]" title={live.path ?? undefined}>
          {live.path ??
            (isNote ? t('detail.noteNodePath') : t('detail.virtualGroupPath'))}
        </p>

        {/* --- note body ---------------------------------------------------- */}
        {isNote ? (
          <section>
            <h2 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
              <StickyNote size={14} aria-hidden />
              {t('detail.noteBody')}
              <span className="text-[var(--font-minor)] text-[var(--text-dim)]">
                {noteState === 'saving'
                  ? t('detail.saving')
                  : noteState === 'saved'
                    ? t('detail.saved')
                    : t('detail.autosave')}
              </span>
            </h2>
            <textarea
              className="input h-40 w-full resize-y font-mono text-xs leading-relaxed"
              aria-label={t('detail.noteBody')}
              placeholder={t('detail.noteEmptyPlaceholder')}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onBlur={() => {
                if (noteText === savedRef.current) return
                savedRef.current = noteText
                setNoteState('saving')
                void window.hub?.nodes
                  .setNote(node.id, noteText)
                  .then(() => setNoteState('saved'))
                  .catch(() => setNoteState('idle'))
              }}
            />
          </section>
        ) : null}

        {/* --- actions ----------------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!live.path || live.path_missing === 1}
            title={
              !live.path ? t('detail.noDiskFolder') : t('detail.openInFileManager')
            }
            onClick={() => {
              void window.hub?.shell
                .openFolder(node.id)
                .then((res) => {
                  if (!res.ok) setStatus(res.error ?? t('detail.openFolderFailed'), 'error')
                })
                .catch(() => setStatus(t('detail.openFolderFailed'), 'error'))
            }}
          >
            <FolderOpen size={14} aria-hidden />
            {t('detail.openFolder')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!live.path}
            onClick={() => void window.hub?.shell.revealFolder(node.id).catch(() => undefined)}
          >
            <ExternalLink size={14} aria-hidden />
            {t('detail.showInFolder')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!live.path}
            onClick={() =>
              void window.hub?.shell
                .copyPath(node.id)
                .then(() => setStatus(t('detail.pathCopiedHere'), 'info'))
                .catch(() => undefined)
            }
          >
            <LinkIcon size={14} aria-hidden />
            {t('detail.copyPath')}
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
            {t('detail.rename')}
          </button>
          {live.kind === 'group' ? (
            <button type="button" className="btn" onClick={addChildGroup}>
              <FolderTree size={14} aria-hidden />
              {t('detail.newSubgroup')}
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            title={t('detail.addNoteHint')}
            onClick={addChildNote}
          >
            <StickyNote size={14} aria-hidden />
            {t('detail.addNote')}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => openDialog('stats', node.id)}>
            <BarChart3 size={14} aria-hidden />
            {t('detail.stats')}
          </button>
        </div>
      </header>

      {/* --- numbers ------------------------------------------------------- */}
      <section className="grid grid-cols-2 gap-3 border-b p-4 sm:grid-cols-4" style={{ borderColor: 'var(--border)' }}>
        <Stat label={t('detail.children')} value={formatCount(children.length)} />
        <Stat
          label={t('detail.fileCount')}
          value={formatCount(stats?.fileCount ?? null)}
          hint={t('detail.diskScanHint')}
        />
        <Stat
          label={t('detail.diskUsage')}
          value={stats ? formatBytes(stats.diskSizeBytes) : t('detail.counting')}
          hint={t('detail.diskUsageHint')}
        />
        <Stat label={t('detail.eventCount')} value={formatCount(stats?.eventCount ?? null)} />
        <Stat
          label={t('detail.lastChange')}
          value={formatRelativeTime(stats?.lastEventAt ?? live.updated_at)}
          hint={stats?.lastEventAt ? formatDateTime(stats.lastEventAt) : undefined}
        />
        <Stat
          label={t('detail.totalChanges')}
          value={formatDelta(stats?.totalInsertions, stats?.totalDeletions)}
        />
        <Stat
          label={t('detail.gitBranchStat')}
          value={stats?.gitBranch || '—'}
          hint={stats?.gitRemote ?? undefined}
        />
        <Stat label={t('detail.addedAt')} value={formatDateTime(live.created_at)} />
      </section>

      {/* --- members ------------------------------------------------------- */}
      <section className="flex min-h-0 flex-1 flex-col p-4">
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          <Layers size={14} aria-hidden />
          {live.kind === 'group' ? t('detail.groupContents') : t('detail.children')}
          <span className="text-[var(--font-minor)] text-[var(--text-dim)]">
            {/* The list below is the whole subtree, so a two-level folder must
                not read as "1" next to two visible rows. */}
            {children.length === memberTotal
              ? t('detail.memberCountOnly', { n: children.length })
              : t('detail.memberCountDirect', {
                  direct: children.length,
                  total: memberTotal
                })}
          </span>
        </h2>

        {children.length === 0 ? (
          <p className="text-xs text-[var(--text-dim)]">
            {live.kind === 'group' ? t('detail.groupEmpty') : t('detail.noChildren')}
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
