/**
 * Timeline (R3 / §9.4) — the change-history view.
 *
 * Swimlanes: one lane per node that has events in the visible range. Dots are
 * coloured by `source`; a zoom bucket inside one lane that holds more than
 * {@link CLUSTER_THRESHOLD} events collapses into a cluster marker.
 *
 * The event list always comes from the `events` store — this component never
 * calls `hub.events.list` itself.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HubEvent, TreeNode } from '@shared/types'
import { useEvents } from '@renderer/stores/events'
import { useTree } from '@renderer/stores/tree'
import { formatRelative } from '@renderer/lib/format'
import { EmptyState } from '@renderer/components/EmptyState'
import { Skeleton } from '@renderer/components/Skeleton'

/* ------------------------------------------------------------------ */
/* Constants (§9.4)                                                    */
/* ------------------------------------------------------------------ */

const ZOOM_ORDER = ['day', 'week', 'month', 'quarter', 'year'] as const
type Zoom = (typeof ZOOM_ORDER)[number]

/** Axis bucket width in px per zoom step — keeps the labels readable. */
const BUCKET_PX: Record<Zoom, number> = { day: 120, week: 64, month: 40, quarter: 28, year: 18 }

const ZOOM_LABEL: Record<Zoom, string> = { day: '日', week: '周', month: '月', quarter: '季', year: '年' }

/** The axis label pattern produced at each zoom step. */
const ZOOM_PATTERN: Record<Zoom, string> = {
  day: 'YYYY-MM-DD',
  week: 'YYYY-Www',
  month: 'YYYY-MM',
  quarter: 'YYYY-Qn',
  year: 'YYYY'
}

/**
 * §9.4 event colours. These are the very values `styles.css` binds to
 * `--ev-git` / `--ev-fs` / `--ev-manual`, so dots keep their identity in both
 * themes; `lib/colors.eventColor` exposes the same palette as CSS variables.
 */
const SOURCE_COLOR: Record<HubEvent['source'], string> = {
  git: '#8b5cf6',
  fs: '#06b6d4',
  manual: '#f59e0b'
}

const SOURCE_LABEL: Record<HubEvent['source'], string> = { git: 'Git', fs: '文件', manual: '手动' }

const LANE_LABEL_PX = 180
const LANE_HEIGHT = 32
const LIST_WIDTH = 340
const DOT = 6
const DOT_HOVER = 10
const CLUSTER_THRESHOLD = 10
const MAX_RENDERED = 1500
const MAX_FILES_SHOWN = 20
const DAY_MS = 86_400_000

const RANGE_PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '最近 7 天', days: 7 },
  { label: '最近 30 天', days: 30 },
  { label: '最近 90 天', days: 90 },
  { label: '全部', days: 0 }
]

/* ------------------------------------------------------------------ */
/* Local-time bucket helpers (align with DayCount.day = YYYY-MM-DD)     */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function startOfWeek(ts: number): number {
  const d = new Date(startOfDay(ts))
  const shift = (d.getDay() + 6) % 7 // Monday-anchored, but any anchor buckets stably
  return d.getTime() - shift * DAY_MS
}

function startOfMonth(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

function startOfQuarter(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1).getTime()
}

function startOfYear(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), 0, 1).getTime()
}

function bucketStart(ts: number, zoom: Zoom): number {
  switch (zoom) {
    case 'week':
      return startOfWeek(ts)
    case 'month':
      return startOfMonth(ts)
    case 'quarter':
      return startOfQuarter(ts)
    case 'year':
      return startOfYear(ts)
    case 'day':
    default:
      return startOfDay(ts)
  }
}

/** First bucket boundary strictly after `ts` at the given granularity. */
function nextBucket(ts: number, zoom: Zoom): number {
  switch (zoom) {
    case 'week':
      return startOfWeek(ts) + 7 * DAY_MS
    case 'month': {
      const d = new Date(ts)
      return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
    }
    case 'quarter': {
      const d = new Date(ts)
      return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3 + 3, 1).getTime()
    }
    case 'year': {
      const d = new Date(ts)
      return new Date(d.getFullYear() + 1, 0, 1).getTime()
    }
    case 'day':
    default:
      return startOfDay(ts) + DAY_MS
  }
}

function isoWeek(date: Date): number {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const dayNum = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - dayNum + 3)
  const firstThursday = new Date(d.getFullYear(), 0, 4)
  const firstDayNum = (firstThursday.getDay() + 6) % 7
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3)
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * DAY_MS))
}

function bucketLabel(bucketTs: number, zoom: Zoom): string {
  const d = new Date(bucketTs)
  const y = d.getFullYear()
  switch (zoom) {
    case 'week':
      return `${y}-W${pad2(isoWeek(d))}`
    case 'month':
      return `${y}-${pad2(d.getMonth() + 1)}`
    case 'quarter':
      return `${y}-Q${Math.floor(d.getMonth() / 3) + 1}`
    case 'year':
      return String(y)
    case 'day':
    default:
      return `${y}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  }
}

function stamp(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}

function dotTitle(ev: HubEvent, zoom: Zoom): string {
  const head = ev.message && ev.message.trim() ? ev.message.trim() : '（无提交信息）'
  return [
    head,
    `${bucketLabel(bucketStart(ev.occurred_at, zoom), zoom)} · ${stamp(ev.occurred_at)}`,
    `${SOURCE_LABEL[ev.source]} · ${ev.file_count} 个文件 · +${ev.insertions} / -${ev.deletions}`
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/* Model types                                                         */
/* ------------------------------------------------------------------ */

interface Cluster {
  key: string
  /** Horizontal centre, px from the lane's content origin. */
  x: number
  count: number
  bucket: number
  /** Newest event of the cluster, used as the selection after zooming in. */
  newest: HubEvent | null
}

interface Dot {
  key: string
  x: number
  event: HubEvent
}

interface Lane {
  nodeId: number
  label: string
  events: HubEvent[]
  clusters: Cluster[]
  dots: Dot[]
}

function nodeLabel(node: TreeNode | undefined, nodeId: number): string {
  if (!node) return `#${nodeId}`
  return node.display_name || node.name || `#${nodeId}`
}

function truncateLabel(label: string, max = 24): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`
}

/** Flattens a `TreeNode` forest into an id → node map. */
function indexNodes(roots: TreeNode[]): Map<number, TreeNode> {
  const map = new Map<number, TreeNode>()
  const walk = (list: TreeNode[]): void => {
    for (const n of list) {
      map.set(n.id, n)
      if (n.children && n.children.length > 0) walk(n.children)
    }
  }
  walk(roots)
  return map
}

/* ------------------------------------------------------------------ */
/* Leaf components (memoised — no re-render per mouse move)            */
/* ------------------------------------------------------------------ */

interface DotProps {
  dot: Dot
  zoom: Zoom
  active: boolean
  onPick: (ev: HubEvent) => void
}

const EventDot = memo(function EventDot({ dot, zoom, active, onPick }: DotProps) {
  const [hovered, setHovered] = useState(false)
  const size = hovered ? DOT_HOVER : DOT
  const color = SOURCE_COLOR[dot.event.source]
  return (
    <button
      type="button"
      title={dotTitle(dot.event, zoom)}
      aria-label={dotTitle(dot.event, zoom).replace(/\n/g, '，')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onPick(dot.event)}
      className="absolute rounded-full border border-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] dark:border-black/40"
      style={{
        left: dot.x,
        top: '50%',
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        backgroundColor: color,
        boxShadow: active
          ? '0 0 0 2px var(--panel), 0 0 0 4px var(--accent)'
          : hovered
            ? '0 0 0 3px rgba(59,130,246,0.28)'
            : 'none',
        zIndex: hovered || active ? 20 : 1,
        transition: 'width 90ms linear, height 90ms linear'
      }}
    />
  )
})

const ClusterMarker = memo(function ClusterMarker({
  cluster,
  onOpen
}: {
  cluster: Cluster
  onOpen: (c: Cluster) => void
}) {
  const size = 18
  return (
    <button
      type="button"
      title={`${cluster.count} 次改动 · 点击放大`}
      aria-label={`${cluster.count} 次改动，点击放大查看`}
      onClick={() => onOpen(cluster)}
      className="absolute flex items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] text-[10px] font-medium leading-none text-[var(--text)] shadow-sm hover:ring-2 hover:ring-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{ left: cluster.x, top: '50%', width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2 }}
    >
      {cluster.count}
    </button>
  )
})

const AxisStrip = memo(function AxisStrip({
  buckets,
  zoom,
  width
}: {
  buckets: number[]
  zoom: Zoom
  width: number
}) {
  const px = BUCKET_PX[zoom]
  return (
    <div
      className="flex h-8 border-b border-[var(--border)] bg-[var(--panel)]"
      style={{ width, minWidth: width }}
    >
      {buckets.map((b) => (
        <div
          key={b}
          className="flex shrink-0 items-center border-r border-[var(--border)]/50 px-1 text-[10px] text-[var(--text-dim)]"
          style={{ width: px }}
        >
          <span className="truncate">{bucketLabel(b, zoom)}</span>
        </div>
      ))}
    </div>
  )
})

interface LaneBodyProps {
  lane: Lane
  zoom: Zoom
  selectedId: number | null
  onPick: (ev: HubEvent) => void
  onCluster: (lane: Lane, c: Cluster) => void
}

const LaneBody = memo(function LaneBody({ lane, zoom, selectedId, onPick, onCluster }: LaneBodyProps) {
  return (
    <div className="relative border-b border-[var(--border)]/60" style={{ height: LANE_HEIGHT }}>
      <div className="absolute left-0 right-0 top-1/2 h-px bg-[var(--border)]/60" />
      {lane.clusters.map((c) => (
        <ClusterMarker key={c.key} cluster={c} onOpen={() => onCluster(lane, c)} />
      ))}
      {lane.dots.map((d) => (
        <EventDot
          key={d.key}
          dot={d}
          zoom={zoom}
          active={selectedId === d.event.id}
          onPick={onPick}
        />
      ))}
    </div>
  )
})

/* ------------------------------------------------------------------ */
/* Right-hand event list                                               */
/* ------------------------------------------------------------------ */

interface EventListProps {
  events: HubEvent[]
  total: number
  labelOf: (nodeId: number) => string
  selectedId: number | null
  onSelect: (ev: HubEvent) => void
}

function EventList({ events, total, labelOf, selectedId, onSelect }: EventListProps) {
  const [openFilesFor, setOpenFilesFor] = useState<number | null>(null)

  useEffect(() => {
    if (openFilesFor !== null && !events.some((e) => e.id === openFilesFor)) setOpenFilesFor(null)
  }, [events, openFilesFor])

  if (events.length === 0) {
    return <p className="p-4 text-xs text-[var(--text-dim)]">当前筛选条件下没有改动记录</p>
  }

  return (
    <ul className="divide-y divide-[var(--border)]/60">
      {events.map((ev) => {
        const isActive = selectedId === ev.id
        const filesOpen = openFilesFor === ev.id
        const head = ev.message && ev.message.trim() ? ev.message.trim() : '（无提交信息）'
        return (
          <li key={ev.id} className={isActive ? 'bg-[var(--accent)]/10' : undefined}>
            <button
              type="button"
              aria-expanded={filesOpen}
              onClick={() => {
                onSelect(ev)
                setOpenFilesFor((cur) => (cur === ev.id ? null : ev.id))
              }}
              className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-[var(--border)]/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
            >
              <span className="flex items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: SOURCE_COLOR[ev.source] }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--text)]" title={head}>
                  {head}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--text-dim)]">
                <span title={stamp(ev.occurred_at)}>{formatRelative(ev.occurred_at)}</span>
                <span className="max-w-[9rem] truncate">{labelOf(ev.node_id)}</span>
                <span className="text-emerald-600 dark:text-emerald-400">+{ev.insertions}</span>
                <span className="text-rose-600 dark:text-rose-400">-{ev.deletions}</span>
                <span>{ev.file_count} 个文件</span>
              </span>
            </button>

            {filesOpen ? (
              ev.files.length === 0 ? (
                <p className="px-6 pb-2 text-[11px] text-[var(--text-dim)]">—</p>
              ) : (
                <ul className="px-6 pb-2">
                  {ev.files.slice(0, MAX_FILES_SHOWN).map((f) => (
                    <li key={f}>
                      <button
                        type="button"
                        title={f}
                        onClick={() => {
                          void window.hub.shell.openFile(ev.node_id, f)
                        }}
                        className="block w-full truncate text-left text-[11px] text-[var(--text-dim)] hover:text-[var(--accent)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        {f}
                      </button>
                    </li>
                  ))}
                  {ev.files.length > MAX_FILES_SHOWN ? (
                    <li className="pt-1 text-[11px] text-[var(--text-dim)]">
                      +{ev.files.length - MAX_FILES_SHOWN} 个文件
                    </li>
                  ) : null}
                </ul>
              )
            ) : null}
          </li>
        )
      })}
      {total > events.length ? (
        <li className="px-3 py-2 text-[11px] text-[var(--text-dim)]">仅显示最近 {events.length} 条</li>
      ) : null}
    </ul>
  )
}

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

export default function Timeline() {
  const events = useEvents((s) => s.events)
  const loading = useEvents((s) => s.loading)
  const error = useEvents((s) => s.error)
  const zoom = useEvents((s) => s.zoom)
  const setZoom = useEvents((s) => s.setZoom)
  const filter = useEvents((s) => s.filter)
  const setFilter = useEvents((s) => s.setFilter)
  const clearFilter = useEvents((s) => s.clearFilter)
  const sync = useEvents((s) => s.sync)

  const treeNodes = useTree((s) => s.nodes)
  const statsCache = useTree((s) => s.statsCache)

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [query, setQuery] = useState('')
  const [rangeDays, setRangeDays] = useState(30)
  const [focusedBucket, setFocusedBucket] = useState<{ lane: number; bucket: number } | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const laneRefs = useRef(new Map<number, HTMLDivElement>())

  const nodeMap = useMemo(() => indexNodes(treeNodes), [treeNodes])
  const labelOf = useCallback(
    (nodeId: number): string => nodeLabel(nodeMap.get(nodeId), nodeId),
    [nodeMap]
  )

  /* --- the visible window ------------------------------------------ */
  const windowEnd = filter.to ?? Date.now()
  const windowStart = filter.from ?? windowEnd - Math.max(rangeDays, 1) * DAY_MS

  /* --- visible events + the 1500 cap -------------------------------- */
  const visible = useMemo(() => {
    const ids = filter.nodeIds ? new Set(filter.nodeIds) : null
    const rows = events.filter((e) => {
      if (e.occurred_at < windowStart || e.occurred_at > windowEnd) return false
      if (ids && !ids.has(e.node_id)) return false
      return true
    })
    rows.sort((a, b) => a.occurred_at - b.occurred_at || a.id - b.id)
    return rows
  }, [events, filter.nodeIds, windowStart, windowEnd])

  const capped = visible.length > MAX_RENDERED
  const shown = useMemo(
    () => (capped ? visible.slice(visible.length - MAX_RENDERED) : visible),
    [visible, capped]
  )

  /* --- axis buckets ------------------------------------------------- */
  const { buckets, contentWidth } = useMemo(() => {
    if (shown.length === 0) return { buckets: [] as number[], contentWidth: 1 }
    const px = BUCKET_PX[zoom]
    const out: number[] = []
    const last = bucketStart(shown[shown.length - 1].occurred_at, zoom)
    let cursor = bucketStart(shown[0].occurred_at, zoom)
    for (let guard = 0; cursor <= last && guard < 4000; guard += 1) {
      out.push(cursor)
      cursor = nextBucket(cursor, zoom)
    }
    return { buckets: out, contentWidth: Math.max(out.length * px, px) }
  }, [shown, zoom])

  /* --- lanes + clustering ------------------------------------------- */
  const lanes = useMemo<Lane[]>(() => {
    if (shown.length === 0 || buckets.length === 0) return []
    const px = BUCKET_PX[zoom]
    const slotOf = new Map<number, number>()
    buckets.forEach((b, i) => slotOf.set(b, i * px))

    const byNode = new Map<number, HubEvent[]>()
    for (const e of shown) {
      const list = byNode.get(e.node_id)
      if (list) list.push(e)
      else byNode.set(e.node_id, [e])
    }

    const out: Lane[] = []
    for (const [nodeId, list] of byNode) {
      const groups = new Map<number, HubEvent[]>()
      for (const e of list) {
        const b = bucketStart(e.occurred_at, zoom)
        const arr = groups.get(b)
        if (arr) arr.push(e)
        else groups.set(b, [e])
      }

      const clusters: Cluster[] = []
      const dots: Dot[] = []
      for (const [bucket, evs] of groups) {
        const slot = slotOf.get(bucket) ?? 0
        if (evs.length > CLUSTER_THRESHOLD) {
          clusters.push({
            key: `c-${nodeId}-${bucket}`,
            x: slot + px / 2,
            count: evs.length,
            bucket,
            newest: evs[evs.length - 1] ?? null
          })
          continue
        }
        // Fan the dots out inside their bucket slot so none stack perfectly.
        const step = px / (evs.length + 1)
        evs.forEach((e, i) => dots.push({ key: `d-${e.id}`, x: slot + step * (i + 1), event: e }))
      }

      dots.sort((a, b) => a.x - b.x)
      clusters.sort((a, b) => a.x - b.x)
      out.push({ nodeId, label: nodeLabel(nodeMap.get(nodeId), nodeId), events: list, clusters, dots })
    }

    // Newest activity first, so a filtered project sits at the top.
    out.sort((a, b) => {
      const at = a.events[a.events.length - 1]?.occurred_at ?? 0
      const bt = b.events[b.events.length - 1]?.occurred_at ?? 0
      return bt - at
    })
    return out
  }, [shown, buckets, zoom, nodeMap])

  /* --- selection + the list beside the lanes ------------------------ */
  const selected = useMemo(
    () => (selectedId === null ? null : shown.find((e) => e.id === selectedId) ?? null),
    [selectedId, shown]
  )

  const listEvents = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = selected ? [selected, ...shown.filter((e) => e.id !== selected.id)] : shown
    const matched = q
      ? base.filter((e) => {
          if ((e.message ?? '').toLowerCase().includes(q)) return true
          if (labelOf(e.node_id).toLowerCase().includes(q)) return true
          return e.files.some((f) => f.toLowerCase().includes(q))
        })
      : base
    return matched.slice(-200).reverse()
  }, [shown, selected, query, labelOf])

  /* --- interactions -------------------------------------------------- */
  const pickEvent = useCallback((ev: HubEvent) => setSelectedId(ev.id), [])

  const onCluster = useCallback(
    (lane: Lane, cluster: Cluster) => {
      const idx = ZOOM_ORDER.indexOf(zoom)
      if (idx < ZOOM_ORDER.length - 1) setZoom(ZOOM_ORDER[idx + 1])
      setFocusedBucket({ lane: lane.nodeId, bucket: cluster.bucket })
      if (cluster.newest) setSelectedId(cluster.newest.id)
    },
    [zoom, setZoom]
  )

  /** After a cluster click, bring that lane back into view. */
  useEffect(() => {
    if (!focusedBucket) return
    const id = window.requestAnimationFrame(() => {
      const el = laneRefs.current.get(focusedBucket.lane)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    })
    return () => window.cancelAnimationFrame(id)
  }, [focusedBucket])

  /** Ctrl/Cmd + wheel = zoom levels; Shift + wheel = horizontal scroll. */
  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const el = scrollRef.current
      if (!el) return
      if (e.ctrlKey || e.metaKey) {
        const idx = ZOOM_ORDER.indexOf(zoom)
        if (e.deltaY < 0 && idx < ZOOM_ORDER.length - 1) setZoom(ZOOM_ORDER[idx + 1])
        else if (e.deltaY > 0 && idx > 0) setZoom(ZOOM_ORDER[idx - 1])
        return
      }
      if (e.shiftKey && e.deltaY !== 0) {
        el.scrollLeft += e.deltaY
      }
    },
    [zoom, setZoom]
  )

  const applyRange = useCallback(
    (days: number) => {
      setRangeDays(days)
      setFilter({
        nodeIds: filter.nodeIds,
        sources: filter.sources,
        from: days === 0 ? undefined : Date.now() - days * DAY_MS,
        to: undefined
      })
    },
    [filter.nodeIds, filter.sources, setFilter]
  )

  const onSync = useCallback(() => {
    setSyncing(true)
    void sync()
      .catch(() => undefined)
      .finally(() => setSyncing(false))
  }, [sync])

  /* --- header state --------------------------------------------------- */
  const isSingleNode = Boolean(filter.nodeIds && filter.nodeIds.length === 1)
  const singleNodeId = isSingleNode && filter.nodeIds ? filter.nodeIds[0] : null
  const firstName = singleNodeId !== null ? labelOf(singleNodeId) : null
  const breadcrumbName = filter.nodeIds && filter.nodeIds.length > 0 ? firstName ?? '已选节点' : '全部项目'
  const noGitRepo = singleNodeId !== null ? statsCache[singleNodeId]?.isGitRepo === false : false
  const activePreset = RANGE_PRESETS.find((p) => (p.days === 0 ? rangeDays === 0 : rangeDays === p.days))?.label ?? null

  const rangeText = `${new Date(windowStart).toLocaleDateString('zh-CN')} — ${new Date(
    Math.min(windowEnd, Date.now())
  ).toLocaleDateString('zh-CN')}`

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--panel)] text-[var(--text)]" aria-label="变更时间线">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <nav className="flex min-w-0 items-center gap-1 text-sm" aria-label="面包屑">
          <span className="text-[var(--text-dim)]">时间线</span>
          <span className="text-[var(--text-dim)]" aria-hidden>
            /
          </span>
          <span className="truncate font-medium" title={breadcrumbName}>
            {breadcrumbName}
          </span>
        </nav>
        {filter.nodeIds && filter.nodeIds.length > 0 ? (
          <button
            type="button"
            onClick={() => clearFilter()}
            className="rounded-md border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-dim)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            清除过滤
          </button>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-0.5" role="group" aria-label="时间范围">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                aria-pressed={activePreset === p.label}
                onClick={() => applyRange(p.days)}
                className={`rounded-md px-2 py-0.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  activePreset === p.label
                    ? 'bg-[var(--accent)]/15 font-medium text-[var(--accent)]'
                    : 'text-[var(--text-dim)] hover:text-[var(--text)]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div
            className="flex items-center gap-0.5 rounded-md border border-[var(--border)] p-0.5"
            role="group"
            aria-label="缩放级别"
          >
            {ZOOM_ORDER.map((z) => (
              <button
                key={z}
                type="button"
                aria-pressed={zoom === z}
                title={`缩放：${ZOOM_LABEL[z]}（${ZOOM_PATTERN[z]}）`}
                onClick={() => setZoom(z)}
                className={`h-5 w-6 rounded text-[11px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  zoom === z ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-dim)] hover:bg-[var(--border)]/40'
                }`}
              >
                {ZOOM_LABEL[z]}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error ? (
        <p className="border-b border-[var(--border)] bg-amber-500/10 px-3 py-1 text-xs text-amber-700 dark:text-amber-300">
          {error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {capped ? (
            <p className="border-b border-[var(--border)] bg-[var(--border)]/20 px-3 py-1 text-[11px] text-[var(--text-dim)]">
              仅显示最近 {MAX_RENDERED} 条
            </p>
          ) : null}

          {loading && shown.length === 0 ? (
            <div className="p-3">
              <Skeleton rows={6} />
            </div>
          ) : lanes.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                title="该项目暂无改动记录"
                description={
                  noGitRepo
                    ? '该节点不是 Git 仓库，无法同步提交记录。'
                    : '同步 Git 后即可查看提交历史。'
                }
                actionLabel={syncing ? '同步中…' : '立即同步 Git'}
                onAction={onSync}
              />
            </div>
          ) : (
            <div
              ref={scrollRef}
              onWheel={onWheel}
              className="min-h-0 flex-1 overflow-auto"
              data-testid="timeline-scroll"
            >
              <div className="flex" style={{ width: contentWidth + LANE_LABEL_PX }}>
                {/* left column: sticky horizontally, holds the lane labels */}
                <div className="sticky left-0 z-20 shrink-0 border-r border-[var(--border)] bg-[var(--panel)]">
                  <div
                    className="flex items-center border-b border-[var(--border)] px-2 text-[10px] text-[var(--text-dim)]"
                    style={{ width: LANE_LABEL_PX, height: 32 }}
                  >
                    节点 / 最近改动
                  </div>
                  {lanes.map((lane) => (
                    <div
                      key={lane.nodeId}
                      className="flex items-center gap-2 border-b border-[var(--border)]/60 px-2"
                      style={{ width: LANE_LABEL_PX, height: LANE_HEIGHT }}
                      title={lane.label}
                    >
                      <span className="truncate text-xs text-[var(--text)]">
                        {truncateLabel(lane.label)}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] text-[var(--text-dim)]">
                        {lane.events.length}
                      </span>
                    </div>
                  ))}
                </div>

                {/* right column: the axis stays pinned while lanes scroll under it */}
                <div className="shrink-0" style={{ width: contentWidth }}>
                  <div className="sticky top-0 z-10">
                    <AxisStrip buckets={buckets} zoom={zoom} width={contentWidth} />
                  </div>
                  {lanes.map((lane) => (
                    <div
                      key={lane.nodeId}
                      ref={(el) => {
                        if (el) laneRefs.current.set(lane.nodeId, el)
                        else laneRefs.current.delete(lane.nodeId)
                      }}
                    >
                      <LaneBody
                        lane={lane}
                        zoom={zoom}
                        selectedId={selectedId}
                        onPick={pickEvent}
                        onCluster={onCluster}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <aside
          className="flex min-h-0 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--panel)]"
          style={{ width: LIST_WIDTH }}
          aria-label="事件列表"
        >
          <div className="border-b border-[var(--border)] p-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索提交信息或文件…"
              aria-label="搜索改动"
              className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <EventList
              events={listEvents}
              total={shown.length}
              labelOf={labelOf}
              selectedId={selectedId}
              onSelect={pickEvent}
            />
          </div>
        </aside>
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] px-3 py-1 text-[11px] text-[var(--text-dim)]">
        <span>{shown.length} 条改动</span>
        <span>{lanes.length} 个项目</span>
        <span>{rangeText}</span>
        <span className="ml-auto">Ctrl + 滚轮缩放 · Shift + 滚轮横向滚动</span>
      </footer>
    </section>
  )
}

export { Timeline }
export type { Zoom as TimelineZoom }
