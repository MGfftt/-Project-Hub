import type { CSSProperties } from 'react'
import { t } from './i18n'

/**
 * Deterministic tag colours (§9.2 rule 5: 每个标签颜色由字符串 hash 到 HSL).
 *
 * The same tag always maps to the same hue, on every machine and every render —
 * the hue is a pure function of the string, so `NodeRow` never needs to memoise
 * it and re-renders stay colour-stable.
 */

/** Classic djb2, folded into 0..359. */
export function hueFromString(s: string): number {
  const str = s || '?'
  let hash = 5381
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 360
}

/**
 * Pill colours for a tag. One inline style pair works in both themes: dark mode
 * scales it down through the `.dark .tag { filter: … }` rule in `styles.css`.
 */
export function tagStyle(tag: string): CSSProperties {
  const h = hueFromString(tag)
  return {
    backgroundColor: `hsl(${h} 70% 92% / 0.9)`,
    color: `hsl(${h} 45% 28%)`
  }
}

/** Alias used by older call sites that describe the return value, not the tag. */
export const stringToHue = hueFromString

/* ---------------------------------------------------------------------------
 * §9.8 — the per-node colour palette.
 *
 * `nodes.color` is a free-form TEXT column, and the value that goes into it is
 * the colour itself (a literal hex string). Storing the value rather than a
 * palette *id* means a later palette edit can never silently repaint existing
 * rows: a colour either still parses or it falls back to the kind accent.
 *
 * The order is frozen — the swatch row in the detail panel reads it in this
 * order, and so would a legend.
 * ------------------------------------------------------------------------ */

export interface NodeColorDef {
  /** Stable id: used for `data-color`, aria labels and test selectors. */
  id: string
  value: string
}

export const NODE_COLORS: readonly NodeColorDef[] = [
  { id: 'red', value: '#ef4444' },
  { id: 'orange', value: '#f97316' },
  { id: 'yellow', value: '#eab308' },
  { id: 'green', value: '#22c55e' },
  { id: 'cyan', value: '#06b6d4' },
  { id: 'blue', value: '#3b82f6' },
  { id: 'purple', value: '#a855f7' },
  { id: 'pink', value: '#ec4899' },
  { id: 'brown', value: '#b45309' },
  { id: 'gray', value: '#94a3b8' }
]

/** The message key for a swatch label — `color.blue` and friends. */
export function nodeColorKey(id: string): string {
  return `color.${id}`
}

const NODE_COLOR_VALUES: ReadonlySet<string> = new Set(NODE_COLORS.map((c) => c.value))

/**
 * The node's own colour, or `null` when it has none.
 *
 * The value is validated against the palette before it reaches an inline style:
 * the column is TEXT and could hold anything (an older build, a hand-edited
 * database), and an unvalidated string interpolated into `borderLeft` would be
 * a way to inject arbitrary CSS. An unknown value degrades to "no colour", so a
 * wayward row renders with the kind accent instead of breaking the view.
 */
export function nodeColorValue(color: string | null | undefined): string | null {
  return typeof color === 'string' && NODE_COLOR_VALUES.has(color) ? color : null
}

/** Translated label for a stored colour, for tooltips and the status bar. */
export function nodeColorLabel(color: string | null | undefined): string | null {
  const value = nodeColorValue(color)
  if (value === null) return null
  const def = NODE_COLORS.find((c) => c.value === value)
  return def ? t(nodeColorKey(def.id)) : null
}

/** `#rrggbb` + alpha, for the tinted chip behind an icon. */
export function tint(color: string, alpha: number): string {
  const hex = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')
  return `${color}${hex}`
}

/** Source colour for an event dot (§9.4), resolved against the CSS tokens. */
export function eventColor(source: 'git' | 'fs' | 'manual'): string {
  switch (source) {
    case 'git':
      return 'var(--ev-git)'
    case 'fs':
      return 'var(--ev-fs)'
    case 'manual':
    default:
      return 'var(--ev-manual)'
  }
}

/** Status dot colour (§6.5). */
export function statusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'var(--st-active)'
    case 'paused':
      return 'var(--st-paused)'
    case 'done':
      return 'var(--st-done)'
    case 'archived':
    default:
      return 'var(--st-archived)'
  }
}
