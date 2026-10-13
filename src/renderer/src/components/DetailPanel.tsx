import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { HubEvent, NodeDetail, NodeStats, NodeStatus, TreeNode } from '@shared/types'
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDelta,
  formatNoteLength,
  formatRelativeTime
} from '@renderer/lib/format'
import { eventColor, statusColor, tagStyle } from '@renderer/lib/colors'
import { descendantIds, kindLabel, statusLabel } from '@renderer/lib/tree'
import { useEvents } from '@renderer/stores/events'
import { useTree } from '@renderer/stores/tree'
import { useUi } from '@renderer/stores/ui'
import EmptyState from '@renderer/components/EmptyState'
import Heatmap from '@renderer/components/Heatmap'

/* ---------------------------------------------------------------------------
 * DetailPanel — the right-hand detail column (§4) with the three frozen tabs
 * 概览 / 改动 / 标注.
 *
 * Data flow: the shell owns the selection (`useUi.selectedId`); this file reads
 * it, resolves the node from the tree store and then talks to the main process
 * only through `window.hub`. Every call is guarded (the API is absent when the
 * preload failed) and carries a `.catch`, so a rejected promise can never
 * escape from a render path. The renderer never builds a filesystem path: the
 * full path comes from `hub.nodes.stats()` and the two shell actions take a
 * node id, not a string.
 *
 * Drafts (显示名 / 笔记 / 标签) live in local state because the tree store is a
 * read model. `NodeDetailView` is keyed by node id, so switching nodes resets
 * every draft instead of carrying one node's text into another.
 * ------------------------------------------------------------------------ */

type TabId = 'overview' | 'changes' | 'annotations'

interface TabDef {
  id: TabId
  label: string
}

const TABS: readonly TabDef[] = [
  { id: 'overview', label: '概览' },
  { id: 'changes', label: '改动' },
  { id: 'annotations', label: '标注' }
]

const STATUS_OPTIONS: readonly NodeStatus[] = ['active', 'paused', 'done', 'archived']

const ICON_TYPE_LABELS: Record<TreeNode['icon_type'], string> = {
  auto: '自动',
  lucide: '内置',
  emoji: '表情',
  image: '图片'
}

/** §4: the 改动 tab shows the twenty most recent events. */
const EVENT_LIMIT = 20
/** Autosave debounce for the Markdown note. */
const NOTE_SAVE_DELAY_MS = 600

export function DetailPanel(): JSX.Element {
  const selectedId = useUi((s) => s.selectedId)
  const byId = useTree((s) => s.byId)

  // The node can vanish (removed / root rescanned away) while still selected —
  // degrade to the placeholder instead of throwing on a stale id.
  const node = selectedId === null ? null : byId.get(selectedId) ?? null

  return node ? <NodeDetailView key={node.id} node={node} byId={byId} /> : <NoSelection />
}

/* ------------------------------------------------------------------ */
/* Placeholder                                                         */
/* ------------------------------------------------------------------ */

function NoSelection(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm text-[var(--text-dim)]">未选择节点</p>
      <p className="text-xs text-[var(--text-dim)]">在左侧项目树中选择一个节点</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* One node                                                            */
/* ------------------------------------------------------------------ */

interface NodeDetailViewProps {
  node: TreeNode
  byId: Map<number, TreeNode>
}

function NodeDetailView({ node, byId }: NodeDetailViewProps): JSX.Element {
  const id = node.id
  const setStatus = useUi((s) => s.setStatus)
  const revision = useTree((s) => s.revision)

  const [tab, setTab] = useState<TabId>('overview')
  const [stats, setStats] = useState<NodeStats | null>(null)
  const [detail, setDetail] = useState<NodeDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [displayName, setDisplayName] = useState(node.display_name ?? '')
  const [status, setNodeStatus] = useState<NodeStatus>(node.status)
  const [tags, setTags] = useState<string[]>(node.tags)
  const [tagDraft, setTagDraft] = useState('')
  const [note, setNote] = useState('')

  const [events, setEvents] = useState<HubEvent[]>([])
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [sourceFilter, setSourceFilter] = useState<'all' | 'git' | 'fs'>('all')

  const tablistRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const [focusNoteTick, setFocusNoteTick] = useState(0)

  /* §8.2 标注 — the context menu asks this panel for the note editor. The event
   * carries the node id, so a stale request for another node is ignored. */
  useEffect(() => {
    function onFocusNote(event: Event): void {
      const requested = (event as CustomEvent<number | undefined>).detail
      if (typeof requested !== 'number' || requested !== id) return
      setTab('annotations')
      setFocusNoteTick((tick) => tick + 1)
    }
    window.addEventListener('hub:focus-note', onFocusNote as EventListener)
    return () => window.removeEventListener('hub:focus-note', onFocusNote as EventListener)
  }, [id])

  /* Focus once the tab switch has committed and the textarea exists. */
  useEffect(() => {
    if (focusNoteTick === 0 || tab !== 'annotations') return
    const el = noteRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [focusNoteTick, tab])

  /* --- 属性 + 笔记正文 ---------------------------------------------- */

  useEffect(() => {
    let alive = true
    const hub = window.hub
    if (!hub) return
    setLoadError(null)
    void Promise.all([hub.nodes.stats(id), hub.nodes.detail(id)])
      .then(([nextStats, nextDetail]) => {
        if (!alive) return
        setStats(nextStats)
        setDetail(nextDetail)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setLoadError(err instanceof Error ? err.message : '读取节点详情失败')
      })
    return () => {
      alive = false
    }
  }, [id, revision])

  /* Seed the note buffer once per mount (the view is keyed by node id), so a
   * background refetch can never overwrite what is being typed. */
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current || !detail) return
    seededRef.current = true
    setNote(detail.note_md)
    setTags(detail.tags)
  }, [detail])

  /* --- note autosave (debounced, flushed on unmount) ---------------- */

  const noteTimer = useRef<number | null>(null)
  const pendingNote = useRef<string | null>(null)

  const saveNote = useCallback(
    (value: string): void => {
      const hub = window.hub
      if (!hub) return
      // No `useTree.getState().bump()` here: the note is not part of the tree
      // payload, so a bump would only force a pointless stats refetch per burst.
      void hub.nodes
        .update(id, { note_md: value })
        .catch(() => setStatus('保存笔记失败', 'error'))
    },
    [id, setStatus]
  )

  const flushNote = useCallback((): void => {
    if (noteTimer.current !== null) {
      window.clearTimeout(noteTimer.current)
      noteTimer.current = null
    }
    const value = pendingNote.current
    pendingNote.current = null
    if (value === null) return
    saveNote(value)
  }, [saveNote])

  const onNoteChange = (value: string): void => {
    setNote(value)
    pendingNote.current = value
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => {
      noteTimer.current = null
      const pending = pendingNote.current
      pendingNote.current = null
      if (pending !== null) saveNote(pending)
    }, NOTE_SAVE_DELAY_MS)
  }

  useEffect(() => () => flushNote(), [flushNote])

  /* --- annotations: tags ------------------------------------------- */

  const persistTags = (next: string[]): void => {
    const hub = window.hub
    if (!hub) return
    setTags(next)
    void hub.nodes
      .update(id, { tags: next })
      .then(() => useTree.getState().bump())
      .catch(() => setStatus('保存标签失败', 'error'))
  }

  const addTag = (): void => {
    const value = tagDraft.trim()
    if (value === '') return
    setTagDraft('')
    if (tags.includes(value)) return
    persistTags([...tags, value])
  }

  const removeTag = (tag: string): void => {
    persistTags(tags.filter((t) => t !== tag))
  }

  /* --- 显示名 / 状态 ------------------------------------------------ */

  const commitDisplayName = (): void => {
    const hub = window.hub
    if (!hub) return
    const trimmed = displayName.trim()
    setDisplayName(trimmed)
    const value = trimmed === '' ? null : trimmed
    if (value === node.display_name) return
    void hub.nodes
      .setDisplayName(id, value)
      .then(() => {
        useTree.getState().bump()
        setStatus(value === null ? '已恢复磁盘名称' : '已更新显示名', 'info')
      })
      .catch(() => setStatus('更新显示名失败', 'error'))
  }

  const changeStatus = (next: NodeStatus): void => {
    if (next === status) return
    const hub = window.hub
    if (!hub) return
    const previous = status
    setNodeStatus(next)
    void hub.nodes
      .update(id, { status: next })
      .then(() => {
        useTree.getState().bump()
        setStatus(`状态已改为${statusLabel(next)}`, 'info')
      })
      .catch(() => {
        setNodeStatus(previous)
        setStatus('更新状态失败', 'error')
      })
  }

  /* --- 概览: path actions ------------------------------------------- */

  const path = stats?.path ?? null

  const onCopyPath = (): void => {
    const hub = window.hub
    if (!hub) return
    void hub.shell
      .copyPath(id)
      .then(() => setStatus('已复制路径', 'info'))
      .catch(() => setStatus('复制路径失败', 'error'))
  }

  const onRevealFolder = (): void => {
    const hub = window.hub
    if (!hub) return
    void hub.shell
      .revealFolder(id)
      .then(() => setStatus('已在文件管理器中打开', 'info'))
      .catch(() => setStatus('打开文件管理器失败', 'error'))
  }

  /* --- 改动: this node plus every descendant ------------------------ */

  const nodeIds = useMemo(() => descendantIds(node, byId), [node, byId])
  // A primitive dependency keeps the fetch from re-running on every render
  // while `byId` (a fresh Map after each tree load) changes identity.
  const nodeIdKey = nodeIds.join(',')

  useEffect(() => {
    let alive = true
    const hub = window.hub
    if (!hub) return
    const ids = nodeIdKey === '' ? [] : nodeIdKey.split(',').map((part) => Number(part))
    setEventsError(null)
    void hub.events
      .list({ nodeIds: ids, limit: EVENT_LIMIT })
      .then((list) => {
        if (alive) setEvents(list)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setEvents([])
        setEventsError(err instanceof Error ? err.message : '读取改动记录失败')
      })
    return () => {
      alive = false
    }
  }, [nodeIdKey, revision])

  /* 全部 / 仅 Git / 仅 文件 — this node's own 改动 list (§9.4 source filter). */
  const visibleEvents = useMemo(
    () => (sourceFilter === 'all' ? events : events.filter((event) => event.source === sourceFilter)),
    [events, sourceFilter]
  )

  /** Segmented-control styling for the 改动 source filter. */
  const sourceTabClass = (value: 'all' | 'git' | 'fs'): string =>
    'btn focus-ring h-6 px-2 py-0 text-[11px]' + (sourceFilter === value ? '' : ' btn-ghost')

  const openInTimeline = (): void => {
    useUi.getState().setMainView('timeline')
    useEvents.getState().setFilter({ nodeIds })
  }

  const onSyncGit = (): void => {
    setSyncing(true)
    void useEvents
      .getState()
      .sync()
      .then((result) => {
        setStatus(result.newEvents > 0 ? `同步完成，新增 ${result.newEvents} 条改动` : '同步完成，无新增改动', 'info')
        useTree.getState().bump()
      })
      .catch(() => setStatus('同步 Git 失败', 'error'))
      .finally(() => setSyncing(false))
  }

  /* --- tabs (§9.7) -------------------------------------------------- */

  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
    const index = TABS.findIndex((t) => t.id === tab)
    if (index < 0) return
    e.preventDefault()
    const next =
      e.key === 'Home'
        ? TABS[0]
        : e.key === 'End'
          ? TABS[TABS.length - 1]
          : TABS[(index + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length]
    setTab(next.id)
    tablistRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus()
  }

  const showChangesEmpty = stats !== null && !stats.isGitRepo && events.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b px-2 py-1.5" style={{ borderColor: 'var(--border)' }}>
        <div
          ref={tablistRef}
          className="flex items-center gap-1"
          role="tablist"
          aria-label="节点详情"
          onKeyDown={onTabKeyDown}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              data-tab={t.id}
              id={`detail-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`detail-panel-${t.id}`}
              className={`btn h-6 px-2.5 py-0 text-[11px] focus-ring ${tab === t.id ? 'btn-primary' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <div
        role="tabpanel"
        id={`detail-panel-${tab}`}
        aria-labelledby={`detail-tab-${tab}`}
        className="min-h-0 flex-1 overflow-auto px-3 py-2"
      >
        {loadError ? <p className="mb-2 text-xs text-[var(--tone-error)]">{loadError}</p> : null}

        {tab === 'overview' ? (
          <section aria-label="概览">
            <Group title="基本">
              <Field label="名称">{node.name}</Field>
              <Field label="显示名">
                <input
                  className="input focus-ring h-6 text-xs"
                  value={displayName}
                  placeholder={node.name}
                  aria-label="显示名"
                  onChange={(e) => setDisplayName(e.target.value)}
                  onBlur={commitDisplayName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      e.currentTarget.blur()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setDisplayName(node.display_name ?? '')
                      e.currentTarget.blur()
                    }
                  }}
                />
              </Field>
              <Field label="类型">{kindLabel(node.kind)}</Field>
              <Field label="状态">
                <span className="flex flex-wrap gap-1" role="group" aria-label="状态">
                  {STATUS_OPTIONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={status === option}
                      className={`btn h-6 px-2 py-0 text-[11px] focus-ring ${
                        status === option ? 'btn-primary' : ''
                      }`}
                      onClick={() => changeStatus(option)}
                    >
                      <span
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: statusColor(option) }}
                        aria-hidden
                      />
                      {statusLabel(option)}
                    </button>
                  ))}
                </span>
              </Field>
              <Field label="路径">
                <span className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 break-all font-mono text-[11px]" title={path ?? ''}>
                    {stats === null ? '…' : path ?? '—'}
                  </span>
                  <button
                    type="button"
                    className="btn focus-ring h-5 shrink-0 px-1.5 py-0 text-[11px]"
                    disabled={path === null}
                    onClick={onCopyPath}
                  >
                    复制路径
                  </button>
                  <button
                    type="button"
                    className="btn focus-ring h-5 shrink-0 px-1.5 py-0 text-[11px]"
                    disabled={path === null}
                    onClick={onRevealFolder}
                  >
                    在文件管理器中显示
                  </button>
                </span>
              </Field>
            </Group>

            <Group title="磁盘">
              <Field label="大小">
                {stats === null || stats.diskSizeBytes === null ? '计算中…' : formatBytes(stats.diskSizeBytes)}
              </Field>
              <Field label="文件数">
                {stats === null || stats.fileCount === null ? '计算中…' : formatCount(stats.fileCount)}
              </Field>
              <Field label="创建时间">{stats === null ? '—' : formatDateTime(stats.createdAt)}</Field>
              <Field label="修改时间">{stats === null ? '—' : formatDateTime(stats.modifiedAt)}</Field>
            </Group>

            {stats !== null && stats.isGitRepo ? (
              <Group title="Git">
                <Field label="远程">{stats.gitRemote || '—'}</Field>
                <Field label="分支">{stats.gitBranch || '—'}</Field>
              </Group>
            ) : null}

            <Group title="图标">
              <Field label="图标">
                <span className="flex items-center gap-2">
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-[11px]"
                    style={{ borderColor: 'var(--border)' }}
                    aria-hidden
                  >
                    {iconToken(node)}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-dim)]"
                    title={node.icon_value ?? ICON_TYPE_LABELS[node.icon_type]}
                  >
                    {node.icon_value ?? ICON_TYPE_LABELS[node.icon_type]}
                  </span>
                  <button
                    type="button"
                    className="btn focus-ring h-6 shrink-0 px-2 py-0 text-[11px]"
                    onClick={() => useUi.getState().openDialog('icon', id)}
                  >
                    更改图标
                  </button>
                </span>
              </Field>
            </Group>

            <Group title="标签">
              <Field label="标签">
                {tags.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {tags.map((tag) => (
                      <span key={tag} className="tag" style={tagStyle(tag)} title={tag}>
                        {tag}
                      </span>
                    ))}
                  </span>
                ) : (
                  '—'
                )}
              </Field>
            </Group>
          </section>
        ) : null}

        {tab === 'changes' ? (
          <section aria-label="改动" className="flex flex-col gap-3">
            <Heatmap />

            {/* 全部 / 仅 Git / 仅 文件 */}
            <div className="flex items-center gap-1" role="group" aria-label="改动来源筛选">
              <button
                type="button"
                className={sourceTabClass('all')}
                aria-pressed={sourceFilter === 'all'}
                onClick={() => setSourceFilter('all')}
              >
                全部
              </button>
              <button
                type="button"
                className={sourceTabClass('git')}
                aria-pressed={sourceFilter === 'git'}
                onClick={() => setSourceFilter('git')}
              >
                仅 Git
              </button>
              <button
                type="button"
                className={sourceTabClass('fs')}
                aria-pressed={sourceFilter === 'fs'}
                onClick={() => setSourceFilter('fs')}
              >
                仅 文件
              </button>
            </div>

            {eventsError ? <p className="text-xs text-[var(--tone-error)]">{eventsError}</p> : null}

            {showChangesEmpty ? (
              <EmptyState
                title="该项目暂无改动记录"
                description="先同步 Git 历史，或用文件监视记录之后的改动"
                actionLabel="立即同步 Git"
                onAction={onSyncGit}
              />
            ) : visibleEvents.length === 0 ? (
              stats === null ? null : (
                <p className="px-1 text-xs text-[var(--text-dim)]">暂无改动记录</p>
              )
            ) : (
              <ul className="flex flex-col" aria-label="最近的改动">
                {visibleEvents.map((event) => (
                  <li key={event.id}>
                    <button
                      type="button"
                      className="focus-ring flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--hover)]"
                      title={event.message || '无提交信息'}
                      onClick={openInTimeline}
                    >
                      <span
                        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: eventColor(event.source) }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-[var(--text)]">
                          {event.message || '无提交信息'}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--text-dim)]">
                          <span>{formatRelativeTime(event.occurred_at)}</span>
                          <span>{formatDelta(event.insertions, event.deletions)}</span>
                          <span>{formatCount(event.file_count)} 个文件</span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {syncing ? (
              <p className="px-1 text-[11px] text-[var(--text-dim)]">正在同步 Git…</p>
            ) : null}
          </section>
        ) : null}

        {tab === 'annotations' ? (
          <section aria-label="标注" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] font-semibold text-[var(--text-dim)]">笔记</span>
                <span className="ml-auto text-[11px] text-[var(--text-dim)]">{formatNoteLength(note)}</span>
              </div>
              <textarea
                ref={noteRef}
                className="input focus-ring min-h-[9rem] resize-y leading-5"
                value={note}
                placeholder="支持 Markdown，输入后自动保存…"
                aria-label="笔记"
                spellCheck={false}
                onChange={(e) => onNoteChange(e.target.value)}
                onBlur={flushNote}
              />
              <div className="flex items-start gap-2">
                <p className="flex-1 text-[11px] leading-4 text-[var(--text-dim)]">
                  标注只保存在本程序的数据库中，不会写入项目目录
                </p>
                {/* Autosave is debounced; this is for a deliberate save. */}
                <button
                  type="button"
                  className="btn focus-ring h-6 shrink-0 px-2 py-0 text-[11px]"
                  onClick={flushNote}
                >
                  保存
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-[var(--text-dim)]">标签</span>
              <div
                className="flex flex-wrap items-center gap-1 rounded-md border px-1.5 py-1"
                style={{ borderColor: 'var(--border)' }}
              >
                {tags.map((tag) => (
                  <span key={tag} className="tag gap-1 py-0.5 pr-0.5" style={tagStyle(tag)} title={tag}>
                    <span className="min-w-0 truncate">{tag}</span>
                    <button
                      type="button"
                      className="focus-ring shrink-0 rounded-full px-0.5 leading-none"
                      aria-label={`移除标签 ${tag}`}
                      onClick={() => removeTag(tag)}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <input
                  className="input focus-ring h-6 min-w-[6rem] flex-1"
                  value={tagDraft}
                  placeholder="添加标签…"
                  aria-label="添加标签"
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addTag()
                    } else if (e.key === 'Backspace' && tagDraft === '' && tags.length > 0) {
                      e.preventDefault()
                      removeTag(tags[tags.length - 1])
                    }
                  }}
                  onBlur={() => {
                    if (tagDraft.trim() !== '') addTag()
                  }}
                />
              </div>
              <p className="text-[11px] leading-4 text-[var(--text-dim)]">
                按 Enter 添加标签，按 Backspace 删除最后一个标签
              </p>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Small presentational helpers (same field grammar as StatsDialog)     */
/* ------------------------------------------------------------------ */

function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="mb-3 last:mb-0">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-dim)]">
        {title}
      </h3>
      <dl className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--border)' }}>
        {children}
      </dl>
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div
      className="flex items-start gap-3 border-b px-2.5 py-1.5 last:border-b-0"
      style={{ borderColor: 'var(--border)' }}
    >
      <dt className="w-16 shrink-0 text-[11px] leading-5 text-[var(--text-dim)]">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-xs leading-5 text-[var(--text)]">{children}</dd>
    </div>
  )
}

/** A one-character stand-in for the icon: emoji verbatim, otherwise its kind. */
function iconToken(node: TreeNode): string {
  if (node.icon_type === 'emoji' && node.icon_value) return node.icon_value
  return ICON_TYPE_LABELS[node.icon_type].slice(0, 1)
}

export default DetailPanel
