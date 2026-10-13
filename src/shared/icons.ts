/**
 * Hand-rolled icon set (§9.3).
 *
 * The project book's rule is "every dependency must justify why a native API or a
 * small built-in cannot replace it". Shipped SVG path data is exactly such a case:
 * we need ~40 glyphs, they must work inside an `<svg>` we theme with CSS, and they
 * must share the stroke language of the rest of the UI. Shipping the paths costs
 * ~4 KB and removes a runtime dependency from the critical paint path.
 *
 * `lucide-react` is still a dependency and is used for interactive controls, where
 * its richer component API (sizes, props, tree-shaking) earns its place.
 */
export interface IconDef {
  name: string
  /** 24x24 viewBox path data, stroke-based. */
  path: string
  /** Extra shapes drawn after the main path. */
  extra?: string
}

export const BUILTIN_ICONS: IconDef[] = [
  { name: 'folder', path: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
  { name: 'folder-open', path: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3z' , extra: 'M3 10h18l-2 8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
  { name: 'file-code', path: 'M14 3v5h5M6 3h8l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', extra: 'M10 13l-2 2 2 2M14 13l2 2-2 2' },
  { name: 'terminal', path: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', extra: 'M7 9l3 3-3 3M13 15h4' },
  { name: 'git-branch', path: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', extra: 'M18 9a9 9 0 0 1-9 9' },
  { name: 'git-commit', path: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 12h6M15 12h6' },
  { name: 'package', path: 'M12 2l9 5v10l-9 5-9-5V7z', extra: 'M3 7l9 5 9-5M12 12v10' },
  { name: 'database', path: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z', extra: 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3' },
  { name: 'server', path: 'M3 4h18v6H3zM3 14h18v6H3z', extra: 'M7 7h.01M7 17h.01' },
  { name: 'cloud', path: 'M6 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.6A3.5 3.5 0 0 1 18 18z' },
  { name: 'cpu', path: 'M6 6h12v12H6z', extra: 'M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4M10 10h4v4h-4z' },
  { name: 'smartphone', path: 'M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z', extra: 'M11 18h2' },
  { name: 'globe', path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', extra: 'M3 12h18M12 3c2.5 2.5 3.5 5.7 3.5 9S14.5 18.5 12 21c-2.5-2.5-3.5-5.7-3.5-9S9.5 5.5 12 3z' },
  { name: 'palette', path: 'M12 21a9 9 0 1 1 0-18c4 0 7 2.5 7 6 0 2.5-2 3-4 3h-1a2 2 0 0 0-1 3.7A1.6 1.6 0 0 1 12 21z', extra: 'M7.5 11h.01M10 7.5h.01M14.5 7.5h.01' },
  { name: 'music', path: 'M9 18V5l10-2v13', extra: 'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z' },
  { name: 'video', path: 'M3 7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', extra: 'M16 10l5-3v10l-5-3z' },
  { name: 'image', path: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', extra: 'M3 16l4-4 4 4 3-3 7 6M8.5 9.5h.01' },
  { name: 'book', path: 'M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-3-2H4z', extra: 'M20 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 3-2h7z' },
  { name: 'flask', path: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3', extra: 'M7.5 15h9' },
  { name: 'rocket', path: 'M5 15c-1 3 0 4 0 4s1 1 4 0M14 4c3 0 6 3 6 6 0 4-6 10-6 10l-4-4S6 14 6 10', extra: 'M9 15l-2 2M13 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z' },
  { name: 'bug', path: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z', extra: 'M12 4v4M12 16v4M4 12h4M16 12h4M6 6l3 3M18 6l-3 3M6 18l3-3M18 18l-3-3' },
  { name: 'wrench', path: 'M15 4a5 5 0 0 0-4 8l-7 7 2 2 7-7a5 5 0 0 0 8-4l-3 3-3-3z' },
  { name: 'settings', path: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', extra: 'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15H2.7a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.2-2.8L4 8.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.7 4.2V4a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2z' },
  { name: 'star', path: 'M12 3l2.9 6 6.1.9-4.4 4.4 1 6.2-5.6-3-5.6 3 1-6.2L3 9.9 9.1 9z' },
  { name: 'heart', path: 'M12 20s-7-4.4-7-9.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7 3.5C19 15.6 12 20 12 20z' },
  { name: 'flag', path: 'M5 21V4M5 4h11l-1.5 4L16 12H5' },
  { name: 'archive', path: 'M3 4h18v4H3z', extra: 'M5 8h14v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zM10 12h4' },
  { name: 'lightbulb', path: 'M9 18h6M10 21h4', extra: 'M12 3a6 6 0 0 1 3.5 10.9c-.5.4-.5 1-.5 1.6H9c0-.6 0-1.2-.5-1.6A6 6 0 0 1 12 3z' },
  { name: 'target', path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z' },
  { name: 'zap', path: 'M13 2L4 14h6l-1 8 9-12h-6z' },
  { name: 'shield', path: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' },
  { name: 'key', path: 'M15 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', extra: 'M11 11l-8 8v2h2l1-1v-2h2v-2h2z' },
  { name: 'lock', path: 'M6 11h12v9a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z', extra: 'M9 11V8a3 3 0 0 1 6 0v3' },
  { name: 'chart', path: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  { name: 'layers', path: 'M12 3l9 5-9 5-9-5z', extra: 'M3 13l9 5 9-5' },
  { name: 'box', path: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
  { name: 'puzzle', path: 'M10 4a2 2 0 1 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 1 1 0 4h-1v3a1 1 0 0 1-1 1h-3v-1a2 2 0 1 0-4 0v1H7a1 1 0 0 1-1-1v-3H5a2 2 0 1 1 0-4h1V6a1 1 0 0 1 1-1h3z' },
  { name: 'gamepad', path: 'M7 8h10a5 5 0 0 1 4.6 7l-.5 1.2A2 2 0 0 1 17.4 17l-1.6-1.6H8.2L6.6 17a2 2 0 0 1-3.7-.8L2.4 15A5 5 0 0 1 7 8z', extra: 'M8 11v2M7 12h2M15.5 11.5h.01M17.5 13h.01' },
  { name: 'camera', path: 'M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', extra: 'M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z' },
  { name: 'mail', path: 'M3 6h18v12H3z', extra: 'M3 7l9 6 9-6' },
  { name: 'calendar', path: 'M4 6h16v15H4z', extra: 'M4 10h16M8 3v4M16 3v4' },
  { name: 'clock', path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', extra: 'M12 7v5l3 2' },
  { name: 'download', path: 'M12 3v12M7 10l5 5 5-5M4 21h16' },
  { name: 'upload', path: 'M12 21V9M7 14l5-5 5 5M4 3h16' },
  { name: 'link', path: 'M9 15l6-6', extra: 'M10.5 6.5l1.5-1.5a4 4 0 0 1 5.7 5.7L16 12.4M13.5 17.5L12 19a4 4 0 0 1-5.7-5.7L8 11.6' },
  { name: 'tag', path: 'M20 12l-8 8-9-9V3h8z', extra: 'M7 7h.01' }
]

export const ICON_NAMES = BUILTIN_ICONS.map((i) => i.name)

const BY_NAME = new Map(BUILTIN_ICONS.map((i) => [i.name, i]))

export function getIcon(name: string): IconDef | undefined {
  return BY_NAME.get(name)
}

/** Deterministic default glyph for a project kind detected by the scanner. */
export const KIND_ICON: Record<string, string> = {
  git: 'git-branch',
  node: 'package',
  python: 'flask',
  rust: 'settings',
  go: 'rocket',
  java: 'box',
  php: 'globe',
  ruby: 'star',
  dotnet: 'box',
  xcode: 'smartphone',
  cmake: 'wrench',
  generic: 'folder'
}

export function iconForMarker(marker: string | null | undefined): string {
  if (!marker) return 'folder'
  if (marker === '.git') return 'git-branch'
  if (marker === 'package.json' || marker === 'pnpm-workspace.yaml') return 'package'
  if (marker === 'pyproject.toml' || marker === 'requirements.txt') return 'flask'
  if (marker === 'Cargo.toml') return 'settings'
  if (marker === 'go.mod') return 'rocket'
  if (marker === 'pom.xml' || marker.startsWith('build.gradle')) return 'box'
  if (marker === 'composer.json') return 'globe'
  if (marker === 'Gemfile') return 'star'
  if (marker.endsWith('.sln') || marker.endsWith('.csproj')) return 'box'
  if (marker.endsWith('.xcodeproj')) return 'smartphone'
  if (marker === 'CMakeLists.txt') return 'wrench'
  return 'folder'
}
