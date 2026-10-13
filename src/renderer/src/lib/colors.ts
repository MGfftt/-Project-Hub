import type { CSSProperties } from 'react'

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
