/**
 * Heatmap — a GitHub-style year grid built from `hub.events.heatmap(from, to)`.
 *
 * 53 columns x 7 rows. The cell size is derived from the width of the column
 * the grid is dropped into: a fixed 12px cell needs 742px, which the 400px
 * left panel clips — the whole second half of the year, and therefore every
 * recent change, simply fell off the edge. Cells now shrink to fit (down to
 * MIN_CELL, with a horizontal scroll beyond that).
 *
 * The whole grid is derived from a single `useMemo` day -> count map, so a
 * mouse move only re-renders the one cell whose hover state changed.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DayCount } from '@shared/types'
import { useEvents } from '@renderer/stores/events'
import { useUi } from '@renderer/stores/ui'
import { t, tCount } from '@renderer/lib/i18n'

const COLS = 53
const ROWS = 7
/** Below this the squares stop reading as squares and the grid scrolls. */
const MIN_CELL = 4
const MAX_CELL = 12
/** Gap as a fraction of the cell, GitHub-ish. */
const GAP_RATIO = 0.2
/** Two month labels closer than this would print on top of each other. */
const LABEL_MIN_GAP = 26
const DAY_MS = 86_400_000
const WEEKDAY_KEYS = ['map.weekday.mon', 'map.weekday.wed', 'map.weekday.fri'] as const
const MONTH_KEYS = [
  'map.month.jan',
  'map.month.feb',
  'map.month.mar',
  'map.month.apr',
  'map.month.may',
  'map.month.jun',
  'map.month.jul',
  'map.month.aug',
  'map.month.sep',
  'map.month.oct',
  'map.month.nov',
  'map.month.dec'
] as const

export interface HeatmapProps {
  /** Inclusive range start (ms). Defaults to Jan 1 of the shown year. */
  from?: number
  /** Exclusive range end (ms, i.e. Jan 1 of the following year). */
  to?: number
}

interface Metrics {
  cell: number
  gap: number
  step: number
  width: number
  height: number
}

/**
 * Largest grid that still fits `available` px. `cell` is clamped, so a very
 * narrow panel produces an overflowing grid that the caller scrolls.
 */
function metricsFor(available: number): Metrics {
  const width = Math.max(140, available)
  for (let cell = MAX_CELL; cell >= MIN_CELL; cell -= 1) {
    const gap = Math.max(1, Math.round(cell * GAP_RATIO))
    const step = cell + gap
    const grid = COLS * step - gap
    if (grid <= width) return { cell, gap, step, width: grid, height: ROWS * step - gap }
  }
  const gap = 1
  const step = MIN_CELL + gap
  return {
    cell: MIN_CELL,
    gap,
    step,
    width: COLS * step - gap,
    height: ROWS * step - gap
  }
}

/* ------------------------------------------------------------------ */
/* Date helpers                                                        */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** `YYYY-MM-DD` in local time — the format `DayCount.day` uses. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function startOfYear(year: number): number {
  return new Date(year, 0, 1, 0, 0, 0, 0).getTime()
}

/** Sunday of the week containing Jan 1 — the grid's top-left cell. */
function gridOrigin(year: number): Date {
  const jan1 = new Date(year, 0, 1)
  const d = new Date(jan1.getFullYear(), jan1.getMonth(), jan1.getDate())
  d.setDate(d.getDate() - d.getDay())
  return d
}

function cellDate(origin: Date, col: number, row: number): Date {
  const d = new Date(origin.getFullYear(), origin.getMonth(), origin.getDate())
  d.setDate(d.getDate() + col * ROWS + row)
  return d
}

/** Five steps of the accent colour, level 0 being the empty cell. */
const LEVELS = [0, 0.18, 0.38, 0.62, 0.9] as const

function levelOf(count: number): number {
  if (count <= 0) return 0
  if (count === 1) return 1
  if (count <= 3) return 2
  if (count <= 6) return 3
  return 4
}

function cellBackground(level: number): string {
  if (level <= 0) return 'var(--border)'
  return `color-mix(in srgb, var(--accent) ${Math.round(LEVELS[level] * 100)}%, var(--panel))`
}

function cellTitle(day: string, entry: DayCount | undefined): string {
  if (!entry || entry.count <= 0) return t('map.heatmap.cellEmpty', { day })
  return t('map.heatmap.cell', {
    day,
    n: entry.count,
    ins: entry.insertions,
    del: entry.deletions
  })
}

/* ------------------------------------------------------------------ */
/* One cell — owns its hover state so the grid never re-renders         */
/* ------------------------------------------------------------------ */

interface CellProps {
  day: string
  inYear: boolean
  level: number
  entry: DayCount | undefined
  cell: number
  gap: number
  onPick: (day: string) => void
}

const HeatCell = memo(function HeatCell({
  day,
  inYear,
  level,
  entry,
  cell,
  gap,
  onPick
}: CellProps) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      role="button"
      tabIndex={inYear ? 0 : -1}
      aria-label={cellTitle(day, entry)}
      aria-hidden={inYear ? undefined : true}
      title={cellTitle(day, entry)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => {
        if (inYear) onPick(day)
      }}
      onKeyDown={(e) => {
        if (!inYear) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPick(day)
        }
      }}
      className="focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{
        width: cell,
        height: cell,
        marginRight: gap,
        marginBottom: gap,
        borderRadius: Math.max(1, Math.min(2, Math.floor(cell / 3))),
        backgroundColor: cellBackground(level),
        opacity: inYear ? 1 : 0,
        outline: hovered && inYear ? '1px solid var(--text-dim)' : 'none',
        cursor: inYear ? 'pointer' : 'default'
      }}
    />
  )
})

/* ------------------------------------------------------------------ */
/* Heatmap                                                             */
/* ------------------------------------------------------------------ */

export default function Heatmap({ from, to }: HeatmapProps) {
  const heatmap = useEvents((s) => s.heatmap)
  const loadHeatmap = useEvents((s) => s.loadHeatmap)
  const eventsLoading = useEvents((s) => s.loading)
  const setFilter = useEvents((s) => s.setFilter)
  const setMainView = useUi((s) => s.setMainView)

  const [year, setYear] = useState(() => new Date().getFullYear())

  const rangeFrom = from ?? startOfYear(year)
  const rangeTo = to ?? startOfYear(year + 1)
  const showYearSelector = from === undefined && to === undefined

  /* --- how much room do we actually have? -------------------------- */
  const boxRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [boxWidth, setBoxWidth] = useState(0)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = (): void => setBoxWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const metrics = useMemo(() => metricsFor(boxWidth || 320), [boxWidth])

  /* Once the grid overflows, the newest weeks matter most — start there. */
  useEffect(() => {
    const el = scrollRef.current
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = el.scrollWidth
  }, [metrics.step])

  useEffect(() => {
    void loadHeatmap(rangeFrom, rangeTo).catch(() => undefined)
  }, [loadHeatmap, rangeFrom, rangeTo])

  /* --- the single derived lookup ---------------------------------- */
  const byDay = useMemo(() => {
    const map = new Map<string, DayCount>()
    for (const d of heatmap) map.set(d.day, d)
    return map
  }, [heatmap])

  const origin = useMemo(() => gridOrigin(year), [year])

  const columns = useMemo(() => {
    /* A narrow panel cannot print twelve month ticks without them touching,
       so label every Nth month — a regular cadence reads better than an
       irregular skip. */
    const stride = Math.max(1, Math.ceil((12 * LABEL_MIN_GAP) / metrics.width))
    const cols: Array<{
      key: string
      labelKey: string
      /** px offset of the month tick, or null when this column repeats it. */
      labelLeft: number | null
      cells: Array<{ day: string; inYear: boolean }>
    }> = []
    let lastDrawn = ''
    let lastLeft = -Infinity
    for (let col = 0; col < COLS; col += 1) {
      const cells: Array<{ day: string; inYear: boolean }> = []
      let labelKey = ''
      for (let row = 0; row < ROWS; row += 1) {
        const d = cellDate(origin, col, row)
        const inYear = d.getFullYear() === year
        /* The tick names the month of the week's first day, and only weeks
           that start inside the shown year get one — otherwise the leading
           days of the previous December carry a bogus 12月 that then collides
           with January's. */
        if (row === 0 && inYear && d.getMonth() % stride === 0) {
          labelKey = MONTH_KEYS[d.getMonth()]
        }
        cells.push({ day: dayKey(d), inYear })
      }
      const left = col * metrics.step
      const draw = labelKey !== '' && labelKey !== lastDrawn && left - lastLeft >= LABEL_MIN_GAP
      if (draw) {
        lastDrawn = labelKey
        lastLeft = left
      }
      cols.push({ key: `col-${col}`, labelKey, labelLeft: draw ? left : null, cells })
    }
    return cols
  }, [origin, year, metrics.step, metrics.width])

  const totalCount = useMemo(
    () => heatmap.reduce((sum, d) => sum + (d.count > 0 ? d.count : 0), 0),
    [heatmap]
  )
  const empty = !eventsLoading && totalCount === 0

  /* --- interactions ------------------------------------------------ */
  const onPick = useCallback(
    (day: string) => {
      const start = new Date(`${day}T00:00:00`).getTime()
      if (Number.isNaN(start)) return
      setFilter({ from: start, to: start + DAY_MS })
      setMainView('timeline')
    },
    [setFilter, setMainView]
  )

  const years = useMemo(() => {
    const current = new Date().getFullYear()
    return [current, current - 1, current - 2]
  }, [])

  const { cell, gap, width: gridWidth, height: gridHeight } = metrics

  return (
    <section
      className="flex w-full min-w-0 flex-col gap-2 text-[var(--text)]"
      aria-label={t('map.heatmap.label')}
    >
      <header className="flex items-center gap-2">
        {showYearSelector ? (
          <div className="flex items-center gap-1" role="group" aria-label={t('map.heatmap.year')}>
            {years.map((y) => (
              <button
                key={y}
                type="button"
                aria-pressed={y === year}
                onClick={() => setYear(y)}
                className={`rounded-md px-2 py-0.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  y === year
                    ? 'bg-[var(--accent)]/15 font-medium text-[var(--accent)]'
                    : 'text-[var(--text-dim)] hover:text-[var(--text)]'
                }`}
              >
                {y}
              </button>
            ))}
          </div>
        ) : null}
        <span className="ml-auto text-[11px] text-[var(--text-dim)]">
          {empty ? t('map.heatmap.empty') : tCount('map.heatmap.totalOne', 'map.heatmap.total', totalCount)}
        </span>
      </header>

      <div className="flex w-full min-w-0 gap-2">
        {/* weekday labels: 一 / 三 / 五 sit on rows 1, 3 and 5 */}
        <div className="flex shrink-0 flex-col pt-4 text-[10px] leading-none text-[var(--text-dim)]">
          {Array.from({ length: ROWS }, (_, row) => (
            <span
              key={row}
              className="flex items-center"
              style={{ height: cell, marginBottom: gap, fontSize: 9 }}
            >
              {row === 1
                ? t(WEEKDAY_KEYS[0])
                : row === 3
                  ? t(WEEKDAY_KEYS[1])
                  : row === 5
                    ? t(WEEKDAY_KEYS[2])
                    : ''}
            </span>
          ))}
        </div>

        <div ref={boxRef} className="min-w-0 flex-1">
          <div ref={scrollRef} className="overflow-x-auto">
            <div className="flex flex-col" style={{ width: gridWidth }}>
              {/* month labels: first column of each new month */}
              <div className="relative mb-1 h-3" style={{ width: gridWidth }}>
                {columns.map((col) =>
                  col.labelLeft === null ? null : (
                    <span
                      key={col.key}
                      className="absolute top-0 text-[10px] leading-none text-[var(--text-dim)]"
                      style={{ left: col.labelLeft }}
                    >
                      {t(col.labelKey)}
                    </span>
                  )
                )}
              </div>

              {empty ? (
                <p
                  className="grid place-items-center rounded-md border border-dashed border-[var(--border)] text-[11px] text-[var(--text-dim)]"
                  style={{ width: gridWidth, height: gridHeight }}
                >
                  {t('map.heatmap.empty')}
                </p>
              ) : (
                <div
                  className="flex"
                  style={{ width: gridWidth, height: gridHeight }}
                  role="grid"
                  aria-label={t('map.heatmap.gridLabel', { year })}
                >
                  {columns.map((col) => (
                    <div key={col.key} className="flex flex-col" role="rowgroup">
                      {col.cells.map((c) => (
                        <HeatCell
                          key={c.day}
                          day={c.day}
                          inYear={c.inYear}
                          level={c.inYear ? levelOf(byDay.get(c.day)?.count ?? 0) : 0}
                          entry={byDay.get(c.day)}
                          cell={cell}
                          gap={gap}
                          onPick={onPick}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <footer className="flex items-center gap-2 pl-4 text-[10px] text-[var(--text-dim)]">
        <span>{t('map.heatmap.less')}</span>
        {LEVELS.map((_, level) => (
          <span
            key={level}
            style={{
              width: cell,
              height: cell,
              borderRadius: Math.max(1, Math.min(2, Math.floor(cell / 3))),
              backgroundColor: cellBackground(level)
            }}
            aria-hidden
          />
        ))}
        <span>{t('map.heatmap.more')}</span>
      </footer>
    </section>
  )
}

export { Heatmap }
