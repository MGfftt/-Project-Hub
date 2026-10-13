/**
 * Browser-safe POSIX path helpers for the renderer.
 * The renderer never touches the filesystem — it only formats paths it got
 * from the main process over IPC.
 */

const SEP_RE = /[\\/]+/

export function basename(p: string): string {
  if (!p) return ''
  const trimmed = p.replace(/[\\/]+$/, '')
  const parts = trimmed.split(SEP_RE)
  return parts[parts.length - 1] ?? ''
}

export function dirname(p: string): string {
  if (!p) return ''
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx <= 0 ? trimmed.slice(0, Math.max(idx, 0)) : trimmed.slice(0, idx)
}

export function join(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join('/')
    .replace(/\/{2,}/g, '/')
}

export function extname(p: string): string {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i)
}

export function truncateMiddle(p: string, max = 48): string {
  if (p.length <= max) return p
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${p.slice(0, head)}…${p.slice(p.length - tail)}`
}
