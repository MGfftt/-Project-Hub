import {
  Atom,
  Archive,
  Binary,
  Book,
  BookOpen,
  Bookmark,
  Box,
  Boxes,
  Braces,
  Briefcase,
  Brush,
  Bug,
  Building,
  Camera,
  CheckCircle,
  Clock,
  Cloud,
  Code,
  Code2,
  Cpu,
  Database,
  FileCode,
  FileCode2,
  Flame,
  FlaskConical,
  Folder,
  FolderCode,
  FolderGit,
  FolderKanban,
  FolderOpen,
  FolderTree,
  Gamepad2,
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  Github,
  Gitlab,
  Globe,
  GraduationCap,
  Grid3x3,
  Hammer,
  Heart,
  Layers,
  List,
  Microscope,
  Monitor,
  Music,
  Package,
  Palette,
  PenTool,
  Puzzle,
  Rocket,
  Server,
  Smartphone,
  Star,
  Terminal,
  Trash2,
  TriangleAlert,
  Video,
  Wrench,
  Zap
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * §8.4 — the frozen built-in icon set, resolved statically.
 *
 * `src/shared/icons.ts` ships the 45 glyphs that are simple enough to draw by
 * hand as raw path data. The remaining names in the frozen §8.4 list are taken
 * from `lucide-react` — but only the ones actually named here.
 *
 * This table exists instead of `import * as Lucide from 'lucide-react'` on
 * purpose: lucide-react exports 5234 components, and a namespace import defeats
 * tree-shaking, which pulled the entire library into the renderer bundle
 * (measured: 1.62 MB before this file, see DECISIONS.md D-011). Naming the
 * icons explicitly keeps the bundle small, which is what NFR-01 cold start and
 * R5 low resource use are measured against.
 *
 * A `lucide` node may still hold a name outside this table (the IPC layer only
 * validates that the icon is not an out-of-store image path). `resolveLucideIcon`
 * then returns undefined and the caller falls back to the inferred auto glyph,
 * so an unknown name never renders as nothing.
 */
export type LucideIconComponent = LucideIcon

export const LUCIDE_ICONS: Record<string, LucideIconComponent> = {
  /* §8.4 exact names, kebab-case as stored on the node. */
  'folder': Folder,
  'folder-tree': FolderTree,
  'folder-code': FolderCode,
  'folder-open': FolderOpen,
  'folder-git': FolderGit,
  'folder-kanban': FolderKanban,
  'package': Package,
  'box': Box,
  'boxes': Boxes,
  'cpu': Cpu,
  'database': Database,
  'server': Server,
  'cloud': Cloud,
  'globe': Globe,
  'terminal': Terminal,
  'code': Code,
  'code-2': Code2,
  'file-code': FileCode,
  'file-code-2': FileCode2,
  'braces': Braces,
  'binary': Binary,
  'bug': Bug,
  'git-branch': GitBranch,
  'git-commit': GitCommit,
  'git-merge': GitMerge,
  'git-pull-request': GitPullRequest,
  'github': Github,
  'gitlab': Gitlab,
  'book': Book,
  'book-open': BookOpen,
  'graduation-cap': GraduationCap,
  'flask-conical': FlaskConical,
  'microscope': Microscope,
  'atom': Atom,
  'briefcase': Briefcase,
  'building': Building,
  'rocket': Rocket,
  'zap': Zap,
  'flame': Flame,
  'star': Star,
  'heart': Heart,
  'bookmark': Bookmark,
  'palette': Palette,
  'brush': Brush,
  'camera': Camera,
  'music': Music,
  'video': Video,
  'gamepad-2': Gamepad2,
  'smartphone': Smartphone,
  'monitor': Monitor,
  'pen-tool': PenTool,
  'wrench': Wrench,
  'hammer': Hammer,
  'puzzle': Puzzle,
  'layers': Layers,
  'grid-3x3': Grid3x3,
  'list': List,
  'check-circle': CheckCircle,
  'clock': Clock,
  'archive': Archive,
  'trash-2': Trash2,
  /* §9.2 — a missing disk path is drawn as an amber warning, not a built-in. */
  'alert-triangle': TriangleAlert
}

export const LUCIDE_ICON_NAMES: string[] = Object.keys(LUCIDE_ICONS)

/** `folder-code` → `FolderCode`, the shape lucide-react's own exports use. */
export function pascalCase(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/** Resolve one stored icon name, or undefined when it is outside the table. */
export function resolveLucideIcon(name: string | null | undefined): LucideIconComponent | undefined {
  if (!name) return undefined
  return LUCIDE_ICONS[name] ?? LUCIDE_ICONS[name.toLowerCase()]
}
