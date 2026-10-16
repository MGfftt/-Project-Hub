import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { HubEvent, NodeDetail, NodeStats, NodeStatus, TreeNode } from '@shared/types'
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDelta,
  formatEventMessage,
  formatNoteLength,
  formatRelativeTime
} from '@renderer/lib/format'
import {
  eventColor,
  nodeColorKey,
  nodeColorLabel,
  nodeColorValue,
  NODE_COLORS,
  statusColor,
  tagStyle
} from '@renderer/lib/colors'
import { t, tCount } from '@renderer/lib/i18n'
import { descendantIds, diskMetric, findParent, kindLabel, statusLabel, ungroupTarget } from '@renderer/lib/tree'
import { useEvents } from '@renderer/stores/events'
import { useTree } from '@renderer/stores/tree'
import { useUi } from '@renderer/stores/ui'
import EmptyState from '@renderer/components/EmptyState'
import Heatmap from '@renderer/components/Heatmap'
import NodeIcon from '@renderer/components/NodeIcon'

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
  labelKey: string
}

const TABS: readonly TabDef[] = [
  { id: 'overview', labelKey: 'detail.overview' },
  { id: 'changes', labelKey: 'detail.changes' },
  { id: 'annotations', labelKey: 'detail.annotations' }
]

const STATUS_OPTIONS: readonly NodeStatus[] = ['active', 'paused', 'done', 'archived']

const ICON_TYPE_KEYS: Record<TreeNode['icon_type'], string> = {
  auto: 'detail.iconAuto',
  lucide: 'detail.iconLucide',
  emoji: 'detail.iconEmoji',
  image: 'detail.iconImage'
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
      <p className="text-sm text-[var(--text-dim)]">{t('detail.noSelection')}</p>
      <p className="text-xs text-[var(--text-dim)]">{t('detail.noSelectionHint')}</p>
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
  const nodes = useTree((s) => s.nodes)
  /* §7.8 — only a node held by a *group* has a membership this panel can undo;
   * anything inside a real folder keeps the structure the disk already has. */
  const insideGroup = useMemo(() => findParent(nodes, id)?.kind === 'group', [nodes, id])

  const [tab, setTab] = useState<TabId>('overview')
  const [stats, setStats] = useState<NodeStats | null>(null)
  const [detail, setDetail] = useState<NodeDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [displayName, setDisplayName] = useState(node.display_name ?? '')
  const [status, setNodeStatus] = useState<NodeStatus>(node.status)
  const [tags, setTags] = useState<string[]>(node.tags)
  const [tagDraft, setTagDraft] = useState('')
  const [note, setNote] = useState('')
  /* §9.8 — the colour is a display property like the icon, so it lives here and
   * is seeded from the tree row. `bump()` reloads the tree, which is what makes
   * every other view (row, map card) pick the new colour up. */
  const [color, setColor] = useState<string | null>(nodeColorValue(node.color))

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
        setLoadError(err instanceof Error ? err.message : t('detail.detailLoadFailed'))
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
        .catch(() => setStatus(t('detail.noteSaveFailed'), 'error'))
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
      .catch(() => setStatus(t('detail.tagSaveFailed'), 'error'))
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
        setStatus(value === null ? t('detail.nameRestored') : t('detail.nameUpdated'), 'info')
      })
      .catch(() => setStatus(t('detail.nameUpdateFailed'), 'error'))
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
        setStatus(t('detail.statusChanged', { status: statusLabel(next) }), 'info')
      })
      .catch(() => {
        setNodeStatus(previous)
        setStatus(t('detail.statusUpdateFailed'), 'error')
      })
  }

  /* --- §9.8 颜色 ---------------------------------------------------- */

  const changeColor = (next: string | null): void => {
    if (next === color) return
    const hub = window.hub
    if (!hub) return
    const previous = color
    setColor(next)
    void hub.nodes
      .update(id, { color: next })
      .then(() => {
        useTree.getState().bump()
        const label = nodeColorLabel(next)
        setStatus(
          label === null ? t('detail.colorReset') : t('detail.colorChanged', { color: label }),
          'info'
        )
      })
      .catch(() => {
        setColor(previous)
        setStatus(t('detail.colorUpdateFailed'), 'error')
      })
  }

  /* --- 概览: path actions ------------------------------------------- */

  const path = stats?.path ?? null

  const onCopyPath = (): void => {
    const hub = window.hub
    if (!hub) return
    void hub.shell
      .copyPath(id)
      .then(() => setStatus(t('detail.pathCopied'), 'info'))
      .catch(() => setStatus(t('detail.pathCopyFailed'), 'error'))
  }

  const onRevealFolder = (): void => {
    const hub = window.hub
    if (!hub) return
    void hub.shell
      .revealFolder(id)
      .then(() => setStatus(t('detail.revealed'), 'info'))
      .catch(() => setStatus(t('detail.revealFailed'), 'error'))
  }

  /* §7.8 — 移出分组: the panel is the second place the membership can be undone,
   * next to the row's context menu. The node moves one level above its group and
   * the disk is not touched. */
  const onRemoveFromGroup = (): void => {
    const hub = window.hub
    if (!hub) return
    const target = ungroupTarget(nodes, id)
    if (!target) return
    void hub.nodes
      .move(id, target.parentId, target.index)
      .then(() => {
        useTree.getState().bump()
        setStatus(t('tree.ungrouped'), 'info')
      })
      .catch((err: unknown) => setStatus(t('tree.ungroupFailed', { error: String(err) }), 'error'))
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
        setEventsError(err instanceof Error ? err.message : t('error.eventsLoad'))
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
        setStatus(
          result.newEvents > 0
            ? t('detail.syncDone', { n: result.newEvents })
            : t('detail.syncDoneEmpty'),
          'info'
        )
        useTree.getState().bump()
      })
      .catch(() => setStatus(t('error.gitSync'), 'error'))
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
          aria-label={t('detail.tablistLabel')}
          onKeyDown={onTabKeyDown}
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              data-tab={item.id}
              id={`detail-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`detail-panel-${item.id}`}
              className={`btn h-6 px-2.5 py-0 text-[11px] focus-ring ${tab === item.id ? 'btn-primary' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {t(item.labelKey)}
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
          <section aria-label={t('detail.overview')}>
            <Group title={t('detail.basic')}>
              <Field label={t('detail.name')}>{node.name}</Field>
              <Field label={t('detail.displayName')}>
                <input
                  className="input focus-ring h-6 text-xs"
                  value={displayName}
                  placeholder={node.name}
                  aria-label={t('detail.displayName')}
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
              <Field label={t('detail.type')}>{kindLabel(node.kind)}</Field>
              <Field label={t('detail.status')}>
                <span className="flex flex-wrap gap-1" role="group" aria-label={t('detail.status')}>
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
              <Field label={t('detail.actions')}>
                <span className="flex flex-wrap items-center gap-1">
                  {path === null ? (
                    <span className="text-[11px] text-[var(--text-dim)]">
                      {t('detail.virtualNode')}
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn focus-ring h-5 shrink-0 px-1.5 py-0 text-[11px]"
                        onClick={onCopyPath}
                      >
                        {t('detail.copyPath')}
                      </button>
                      <button
                        type="button"
                        className="btn focus-ring h-5 shrink-0 px-1.5 py-0 text-[11px]"
                        onClick={onRevealFolder}
                      >
                        {t('detail.revealInManager')}
                      </button>
                    </>
                  )}
                  {/* §7.8 — a node (or a whole subgroup) held by a group can be
                      lifted out of it from here, where the membership is
                      visible, as well as from the row's context menu. */}
                  {insideGroup ? (
                    <button
                      type="button"
                      className="btn focus-ring h-5 shrink-0 px-1.5 py-0 text-[11px]"
                      title={t('tree.removeFromGroupHint')}
                      onClick={onRemoveFromGroup}
                    >
                      {t('tree.removeFromGroup')}
                    </button>
                  ) : null}
                </span>
              </Field>
            </Group>

            <Group title={t('detail.disk')}>
              <Field label={t('detail.size')}>{diskMetric(path, stats?.diskSizeBytes ?? null, formatBytes)}</Field>
              <Field label={t('detail.fileCount')}>
                {diskMetric(path, stats?.fileCount ?? null, formatCount)}
              </Field>
              <Field label={t('detail.createdAt')}>
                {stats === null ? '—' : formatDateTime(stats.createdAt)}
              </Field>
              <Field label={t('detail.modifiedAt')}>
                {stats === null ? '—' : formatDateTime(stats.modifiedAt)}
              </Field>
            </Group>

            {stats !== null && stats.isGitRepo ? (
              <Group title="Git">
                <Field label={t('detail.gitRemote')}>{stats.gitRemote || '—'}</Field>
                <Field label={t('detail.gitBranch')}>{stats.gitBranch || '—'}</Field>
              </Group>
            ) : null}

            <Group title={t('detail.icon')}>
              <Field label={t('detail.icon')}>
                <span className="flex items-center gap-2">
                  {/* §8.3 — the preview is the node's real icon, drawn by the same
                      component the tree uses, so it can never be a clipped
                      character stand-in. */}
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border"
                    style={{ borderColor: 'var(--border)' }}
                    aria-hidden
                  >
                    <NodeIcon node={node} size={14} />
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-dim)]"
                    title={node.icon_value ?? t(ICON_TYPE_KEYS[node.icon_type])}
                  >
                    {node.icon_value ?? t(ICON_TYPE_KEYS[node.icon_type])}
                  </span>
                  <button
                    type="button"
                    className="btn focus-ring h-6 shrink-0 px-2 py-0 text-[11px]"
                    onClick={() => useUi.getState().openDialog('icon', id)}
                  >
                    {t('detail.changeIcon')}
                  </button>
                </span>
              </Field>
            </Group>

            <Group title={t('detail.color')}>
              <Field label={t('detail.color')}>
                <span
                  className="flex flex-wrap items-center gap-1.5"
                  role="group"
                  aria-label={t('detail.nodeColor')}
                >
                  {NODE_COLORS.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      data-color={entry.id}
                      aria-pressed={color === entry.value}
                      aria-label={t(nodeColorKey(entry.id))}
                      title={t(nodeColorKey(entry.id))}
                      className="focus-ring h-5 w-5 shrink-0 rounded-full border-2"
                      style={{
                        background: entry.value,
                        borderColor: color === entry.value ? 'var(--text)' : 'transparent'
                      }}
                      onClick={() => changeColor(entry.value)}
                    />
                  ))}
                  <button
                    type="button"
                    data-color="none"
                    aria-pressed={color === null}
                    className={`btn h-5 shrink-0 px-1.5 py-0 text-[11px] focus-ring ${
                      color === null ? 'btn-primary' : ''
                    }`}
                    title={t('detail.noCustomColor')}
                    onClick={() => changeColor(null)}
                  >
                    {t('color.none')}
                  </button>
                </span>
              </Field>
            </Group>

            <Group title={t('detail.tags')}>
              <Field label={t('detail.tags')}>
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
          <section aria-label={t('detail.changes')} className="flex flex-col gap-3">
            <Heatmap />

            {/* 全部 / 仅 Git / 仅 文件 */}
            <div className="flex items-center gap-1" role="group" aria-label={t('detail.sourceFilter')}>
              <button
                type="button"
                className={sourceTabClass('all')}
                aria-pressed={sourceFilter === 'all'}
                onClick={() => setSourceFilter('all')}
              >
                {t('detail.sourceAll')}
              </button>
              <button
                type="button"
                className={sourceTabClass('git')}
                aria-pressed={sourceFilter === 'git'}
                onClick={() => setSourceFilter('git')}
              >
                {t('detail.sourceGitOnly')}
              </button>
              <button
                type="button"
                className={sourceTabClass('fs')}
                aria-pressed={sourceFilter === 'fs'}
                onClick={() => setSourceFilter('fs')}
              >
                {t('detail.sourceFilesOnly')}
              </button>
            </div>

            {eventsError ? <p className="text-xs text-[var(--tone-error)]">{eventsError}</p> : null}

            {showChangesEmpty ? (
              <EmptyState
                title={t('detail.noChangesTitle')}
                description={t('detail.noChangesHint')}
                actionLabel={t('detail.syncNow')}
                onAction={onSyncGit}
              />
            ) : visibleEvents.length === 0 ? (
              stats === null ? null : (
                <p className="px-1 text-xs text-[var(--text-dim)]">{t('detail.noChanges')}</p>
              )
            ) : (
              <ul className="flex flex-col" aria-label={t('detail.recentChanges')}>
                {visibleEvents.map((event) => (
                  <li key={event.id}>
                    <button
                      type="button"
                      className="focus-ring flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--hover)]"
                      title={formatEventMessage(event.message, event.source) || t('detail.noCommitMessage')}
                      onClick={openInTimeline}
                    >
                      <span
                        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: eventColor(event.source) }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-[var(--text)]">
                          {formatEventMessage(event.message, event.source) ||
                            t('detail.noCommitMessage')}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--text-dim)]">
                          <span>{formatRelativeTime(event.occurred_at)}</span>
                          <span>{formatDelta(event.insertions, event.deletions)}</span>
                          <span>
                            {tCount('detail.eventFilesOne', 'detail.eventFiles', event.file_count, {
                              n: formatCount(event.file_count)
                            })}
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {syncing ? (
              <p className="px-1 text-[11px] text-[var(--text-dim)]">{t('detail.syncing')}</p>
            ) : null}
          </section>
        ) : null}

        {tab === 'annotations' ? (
          <section aria-label={t('detail.annotations')} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] font-semibold text-[var(--text-dim)]">
                  {t('detail.note')}
                </span>
                <span className="ml-auto text-[11px] text-[var(--text-dim)]">{formatNoteLength(note)}</span>
              </div>
              <textarea
                ref={noteRef}
                className="input focus-ring min-h-[9rem] resize-y leading-5"
                value={note}
                placeholder={t('detail.notePlaceholder')}
                aria-label={t('detail.note')}
                spellCheck={false}
                onChange={(e) => onNoteChange(e.target.value)}
                onBlur={flushNote}
              />
              <div className="flex items-start gap-2">
                <p className="flex-1 text-[11px] leading-4 text-[var(--text-dim)]">
                  {t('detail.noteLocalOnly')}
                </p>
                {/* Autosave is debounced; this is for a deliberate save. */}
                <button
                  type="button"
                  className="btn focus-ring h-6 shrink-0 px-2 py-0 text-[11px]"
                  onClick={flushNote}
                >
                  {t('detail.save')}
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-[var(--text-dim)]">
                {t('detail.tags')}
              </span>
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
                      aria-label={t('detail.removeTag', { tag })}
                      onClick={() => removeTag(tag)}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <input
                  className="input focus-ring h-6 min-w-[6rem] flex-1"
                  value={tagDraft}
                  placeholder={t('detail.addTagPlaceholder')}
                  aria-label={t('detail.addTag')}
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
                {t('detail.tagHint')}
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

export default DetailPanel
