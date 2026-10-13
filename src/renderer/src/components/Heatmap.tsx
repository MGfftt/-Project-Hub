/**
 * Heatmap — a GitHub-style year grid built from `hub.events.heatmap(from, to)`.
 *
 * 53 columns x 7 rows of 12px cells with 2px gaps. The whole grid is derived
 * from a single `useMemo` day -> count map, so a mouse move only re-renders the
 * one cell whose hover state changed (each cell owns its own tooltip state).
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { DayCount } from '@shared/types'
import { useEvents } from '@renderer/stores/events'
import { useUi } from '@renderer/stores/ui'

const COLS = 53
const ROWS = 7
const CELL = 12
const GAP = 2
const STEP = CELL + GAP
const DAY_MS = 86_400_000
const WEEKDAYS = ['一', '三', '五'] as const
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'] as const

export interface HeatmapProps {
  /** Inclusive range start (ms). Defaults to Jan 1 of the shown year. */
  from?: number
  /** Exclusive range end (ms, i.e. Jan 1 of the following year). */
  to?: number
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
  if (!entry || entry.count <= 0) return `${day} · 0 次改动`
  return `${day} · ${entry.count} 次改动 · +${entry.insertions} / -${entry.deletions}`
}

/* ------------------------------------------------------------------ */
/* One cell — owns its hover state so the grid never re-renders         */
/* ------------------------------------------------------------------ */

interface CellProps {
  day: string
  inYear: boolean
  level: number
  entry: DayCount | undefined
  onPick: (day: string) => void
}

const HeatCell = memo(function HeatCell({ day, inYear, level, entry, onPick }: CellProps) {
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
      className="rounded-[2px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{
        width: CELL,
        height: CELL,
        marginRight: GAP,
        marginBottom: GAP,
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
    const cols: Array<{
      key: string
      label: string
      /** px offset of the month tick, or null when this column repeats it. */
      labelLeft: number | null
      cells: Array<{ day: string; inYear: boolean }>
    }> = []
    let lastLabel = ''
    for (let col = 0; col < COLS; col += 1) {
      const cells: Array<{ day: string; inYear: boolean }> = []
      let label = ''
      for (let row = 0; row < ROWS; row += 1) {
        const d = cellDate(origin, col, row)
        const inYear = d.getFullYear() === year
        if (row === 0) label = MONTHS[d.getMonth()]
        cells.push({ day: dayKey(d), inYear })
      }
      const labelLeft = label !== lastLabel ? col * STEP : null
      lastLabel = label
      cols.push({ key: `col-${col}`, label, labelLeft, cells })
    }
    return cols
  }, [origin, year])

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

  const gridWidth = COLS * STEP
  const gridHeight = ROWS * STEP

  return (
    <section className="inline-flex flex-col gap-2 text-[var(--text)]" aria-label="改动热力图">
      <header className="flex items-center gap-2">
        {showYearSelector ? (
          <div className="flex items-center gap-1" role="group" aria-label="年份">
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
          {empty ? '该时间段暂无改动' : `${totalCount} 次改动`}
        </span>
      </header>

      <div className="flex gap-2">
        {/* weekday labels: 一 / 三 / 五 sit on rows 1, 3 and 5 */}
        <div className="flex flex-col pt-4 text-[10px] leading-none text-[var(--text-dim)]">
          {Array.from({ length: ROWS }, (_, row) => (
            <span
              key={row}
              className="flex items-center"
              style={{ height: CELL, marginBottom: GAP, fontSize: 9 }}
            >
              {row === 1 ? WEEKDAYS[0] : row === 3 ? WEEKDAYS[1] : row === 5 ? WEEKDAYS[2] : ''}
            </span>
          ))}
        </div>

        <div className="flex flex-col">
          {/* month labels: first column of each new month */}
          <div className="relative mb-1 h-3" style={{ width: gridWidth }}>
            {columns.map((col) =>
              col.labelLeft === null ? null : (
                <span
                  key={col.key}
                  className="absolute top-0 text-[10px] leading-none text-[var(--text-dim)]"
                  style={{ left: col.labelLeft }}
                >
                  {col.label}
                </span>
              )
            )}
          </div>

          {empty ? (
            <p
              className="grid place-items-center rounded-md border border-dashed border-[var(--border)] text-[11px] text-[var(--text-dim)]"
              style={{ width: gridWidth, height: gridHeight }}
            >
              该时间段暂无改动
            </p>
          ) : (
            <div
              className="flex"
              style={{ width: gridWidth, height: gridHeight }}
              role="grid"
              aria-label={`${year} 年改动热力图`}
            >
              {columns.map((col) => (
                <div key={col.key} className="flex flex-col" role="rowgroup">
                  {col.cells.map((cell) => (
                    <HeatCell
                      key={cell.day}
                      day={cell.day}
                      inYear={cell.inYear}
                      level={cell.inYear ? levelOf(byDay.get(cell.day)?.count ?? 0) : 0}
                      entry={byDay.get(cell.day)}
                      onPick={onPick}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <footer className="flex items-center gap-2 pl-6 text-[10px] text-[var(--text-dim)]">
        <span>少</span>
        {LEVELS.map((_, level) => (
          <span
            key={level}
            className="rounded-[2px]"
            style={{ width: CELL, height: CELL, backgroundColor: cellBackground(level) }}
            aria-hidden
          />
        ))}
        <span>多</span>
      </footer>
    </section>
  )
}

export { Heatmap }
