/**
 * Chinese-first formatting helpers (§9.1 typography, §8.2 属性 fields).
 *
 * Every function is pure and defensive: the renderer formats values that arrive
 * from SQLite, and a single `null` must degrade to 「—」 instead of throwing.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const EMPTY = '—'

/** 「刚刚」/「3 分钟前」/「2 小时前」/「3 天前」/「2024-01-05」 */
export function formatRelativeTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return EMPTY
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`
  return shortDate(ts)
}

/**
 * Alias kept for the timeline view: `formatRelative` is the name §9.4-era code
 * reaches for, `formatRelativeTime` is the one the renderer contract names.
 */
export const formatRelative = formatRelativeTime

/** 「1.2 MB」; `null` (size still being computed) renders as 「—」. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return EMPTY
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  const gb = mb / 1024
  if (gb < 1024) return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`
  return `${(gb / 1024).toFixed(2)} TB`
}

/** 「1,234,567」 */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return EMPTY
  const sign = n < 0 ? '-' : ''
  const digits = Math.trunc(Math.abs(n)).toString()
  let out = ''
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return sign + out
}

/** 「2024-01-05 14:03」; `null` renders as 「—」. */
export function formatDateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return EMPTY
  const d = new Date(ts)
  return `${shortDate(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 「2024-01-05」 */
export function formatDate(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return EMPTY
  return shortDate(ts)
}

/** 「+1,204 / -318」 */
export function formatDelta(insertions: number | null | undefined, deletions: number | null | undefined): string {
  const plus = insertions && Number.isFinite(insertions) ? formatCount(insertions) : '0'
  const minus = deletions && Number.isFinite(deletions) ? formatCount(deletions) : '0'
  return `+${plus} / -${minus}`
}

/** 「3 天」/「5 小时」/「12 分钟」 — used for `nextRun` countdowns. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return EMPTY
  if (ms <= 0) return '即将'
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} 分钟`
  if (ms < DAY) return `${Math.round(ms / HOUR)} 小时`
  return `${Math.round(ms / DAY)} 天`
}

/** 「123 字」 for a Markdown note body. */
export function formatNoteLength(markdown: string | null | undefined): string {
  if (!markdown) return '0 字'
  return `${formatCount(markdown.length)} 字`
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function shortDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
