/**
 * Icon resolution for tree rows and panels (§8.3, §8.4).
 *
 * `src/shared/icons.ts` ships pure path data and is shared with the main
 * process, so the renderer can render a built-in glyph from the same `IconDef`
 * the main process reports through `hub.icons.defs()`. This module owns only the
 * *choice* of glyph: the frozen fallback by node kind, and the marker-aware
 * inference that mirrors the main process when `icon_type === 'auto'`.
 *
 * Keep it free of React so `NodeIcon` stays a thin renderer.
 */

import { getIcon, type IconDef } from '@shared/icons'
import type { NodeKind, TreeNode } from '@shared/types'

/** §8.4 fallback when nothing more specific is known. */
const KIND_FALLBACK: Record<NodeKind, string> = {
  group: 'layers',
  project: 'package',
  folder: 'folder',
  note: 'lightbulb'
}

/**
 * Ordered inference rules for `icon_type === 'auto'`. The first match wins, so
 * the more specific patterns come first. `when` receives the lower-cased name
 * and the node's `meta.marker` / `meta.projectKind` when the scanner recorded
 * them.
 */
interface Rule {
  icon: string
  test: RegExp
}

const NAME_RULES: readonly Rule[] = [
  { icon: 'git-branch', test: /(^|[-_. ])(git|repo|clone)/ },
  { icon: 'database', test: /(^|[-_. ])(db|sql|sqlite|postgres|mysql|schema|migration)/ },
  { icon: 'server', test: /(^|[-_. ])(server|api|backend|service|gateway)/ },
  { icon: 'cloud', test: /(^|[-_. ])(cloud|aws|gcp|azure|deploy|infra)/ },
  { icon: 'terminal', test: /(^|[-_. ])(cli|shell|terminal|script|tool)/ },
  { icon: 'smartphone', test: /(^|[-_. ])(mobile|android|ios|app)/ },
  { icon: 'globe', test: /(^|[-_. ])(web|site|frontend|www)/ },
  { icon: 'flask', test: /(^|[-_. ])(test|spec|bench)/ },
  { icon: 'book', test: /(^|[-_. ])(doc|docs|guide|manual|book)/ },
  { icon: 'image', test: /(^|[-_. ])(image|asset|media|design)/ },
  { icon: 'music', test: /(^|[-_. ])(audio|sound|music)/ },
  { icon: 'video', test: /(^|[-_. ])(video|movie|film)/ },
  { icon: 'package', test: /(^|[-_. ])(pkg|package|lib|module|node)/ },
  { icon: 'wrench', test: /(^|[-_. ])(util|utils|helper|common|shared)/ },
  { icon: 'settings', test: /(^|[-_. ])(config|conf|setting)/ },
  { icon: 'cpu', test: /(^|[-_. ])(core|engine|kernel)/ }
]

/** Scanner marker → glyph, used before the name rules when a marker is known. */
const MARKER_ICON: Record<string, string> = {
  git: 'git-branch',
  node: 'package',
  python: 'terminal',
  rust: 'cpu',
  go: 'cpu',
  java: 'box',
  php: 'globe',
  ruby: 'box',
  dotnet: 'layers',
  xcode: 'smartphone',
  cmake: 'wrench',
  generic: 'folder'
}

function markerOf(node: TreeNode | undefined): string | null {
  if (!node) return null
  const meta = (node as { meta?: unknown }).meta
  if (!meta || typeof meta !== 'object') return null
  const record = meta as Record<string, unknown>
  const marker = record.marker
  if (typeof marker === 'string' && marker) return marker
  const kind = record.projectKind
  return typeof kind === 'string' && kind ? kind : null
}

/**
 * The glyph an `auto` node resolves to. Never returns an unknown name: the
 * result is always either a real entry of `BUILTIN_ICONS` or the kind fallback.
 */
export function autoIconName(node: TreeNode | undefined | null): string {
  const fallback: string = node ? KIND_FALLBACK[node.kind] : KIND_FALLBACK.folder
  if (!node) return fallback
  const marker = markerOf(node)
  if (marker) {
    const byMarker = MARKER_ICON[marker]
    if (byMarker) return byMarker
  }
  const name = (node.name || node.display_name || '').toLowerCase()
  for (const rule of NAME_RULES) {
    if (rule.test.test(name)) return rule.icon
  }
  return fallback
}

/** Resolves the `IconDef` a node renders; `undefined` means "no glyph known". */
export function defForNode(node: TreeNode | undefined | null): IconDef | undefined {
  if (!node) return undefined
  if (node.icon_type === 'lucide' && node.icon_value) {
    return getIcon(node.icon_value) ?? getIcon(autoIconName(node))
  }
  if (node.icon_type === 'auto') return getIcon(autoIconName(node))
  return undefined
}

/** A stable `hub-media://` URL for a stored image asset (icons and backgrounds). */
export function mediaUrl(filename: string): string {
  return `hub-media://local/${encodeURIComponent(filename)}`
}

/** True when the name is a known built-in glyph — used by tests and pickers. */
export function isBuiltinIcon(name: string): boolean {
  return getIcon(name) !== undefined
}
