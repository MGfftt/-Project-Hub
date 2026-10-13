/**
 * Scanner primitives — project markers and ignore rules (§7.1).
 * Pure data + pure functions so both the worker and the unit tests share them.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  '*.sln',
  '*.csproj',
  '*.xcodeproj',
  'CMakeLists.txt'
] as const

export const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  '.cache',
  '.idea',
  '.vscode',
  'vendor',
  'Pods',
  '.gradle',
  '.tox',
  'coverage'
])

export const MAX_FILES_PER_ROOT = 200_000

/** Directories whose contents are never scanned for change snapshots. */
export const SNAPSHOT_IGNORE_DIRS = new Set([
  ...IGNORE_DIRS,
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'release',
  '.turbo',
  '.parcel-cache'
])

export type MarkerKind =
  | 'git'
  | 'node'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'php'
  | 'ruby'
  | 'dotnet'
  | 'xcode'
  | 'cmake'
  | 'generic'

export interface MarkerHit {
  marker: string
  kind: MarkerKind
}

const EXACT_KIND: Record<string, MarkerKind> = {
  '.git': 'git',
  'package.json': 'node',
  'pnpm-workspace.yaml': 'node',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  'Cargo.toml': 'rust',
  'go.mod': 'go',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'build.gradle.kts': 'java',
  'composer.json': 'php',
  'Gemfile': 'ruby',
  'CMakeLists.txt': 'cmake'
}

const GLOB_KIND: Array<{ suffix: string; kind: MarkerKind }> = [
  { suffix: '.sln', kind: 'dotnet' },
  { suffix: '.csproj', kind: 'dotnet' },
  { suffix: '.xcodeproj', kind: 'xcode' }
]

/** Detect the marker inside `dir`. Returns null when it is not a project. */
export function detectMarker(dir: string): MarkerHit | null {
  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => e.name)
  } catch {
    return null
  }
  const entrySet = new Set(entries)

  for (const marker of PROJECT_MARKERS) {
    if (marker.includes('*')) {
      const suffix = marker.slice(1)
      const hit = entries.find((e) => e.toLowerCase().endsWith(suffix.toLowerCase()))
      if (hit) {
        // Report the frozen pattern (`*.sln`), not the concrete filename: the
        // marker is what identifies the ecosystem for `iconForMarker` (§9.3).
        const g = GLOB_KIND.find((x) => x.suffix.toLowerCase() === suffix.toLowerCase())
        return { marker, kind: g?.kind ?? 'generic' }
      }
      continue
    }
    if (entrySet.has(marker)) {
      // `.git` may be a file inside worktrees/submodules — still a marker.
      return { marker, kind: EXACT_KIND[marker] ?? 'generic' }
    }
  }
  return null
}

export function isGitRepo(dir: string): boolean {
  try {
    return existsSync(join(dir, '.git'))
  } catch {
    return false
  }
}

export function shouldIgnoreDir(name: string): boolean {
  return IGNORE_DIRS.has(name)
}

export function shouldIgnoreSnapshotDir(name: string): boolean {
  return SNAPSHOT_IGNORE_DIRS.has(name)
}
