/**
 * Path helpers shared by the main process and its workers (§7.1).
 *
 * Data-isolation rule: everything produced here is a *record* of a user path.
 * Nothing in this module writes to a user directory.
 */
import { existsSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

import { t } from '../i18n'

/**
 * Normalise a user-supplied path for storage.
 * - expands `~`
 * - resolves to an absolute path
 * - normalises separators and drops trailing separators
 *
 * The ORIGINAL CASE is preserved: the stored path is what the user sees in the
 * tree, the clipboard and the stats drawer, and lower-casing it here made every
 * Windows path render as `c:\users\…`. Use `pathKey` when you need a
 * case-insensitive comparison key (NTFS is case-insensitive; §14.3 risk row).
 */
export function normalizePath(input: string): string {
  let p = (input ?? '').trim()
  if (p === '') return ''
  if (p === '~') p = homedir()
  else if (p.startsWith('~' + sep) || p.startsWith('~/')) p = join(homedir(), p.slice(2))
  p = normalize(resolve(p))
  if (p.length > 3 && p.endsWith(sep)) p = p.slice(0, -1)
  return p
}

/** Resolve symlinks when possible; falls back to the lexical normalisation. */
export function canonicalPath(input: string): string {
  const n = normalizePath(input)
  try {
    return process.platform === 'win32' ? normalizePath(realpathSync.native(n)) : realpathSync(n)
  } catch {
    return n
  }
}

/** Case-insensitive on Windows, exact elsewhere. */
export function pathKey(p: string): string {
  const n = normalizePath(p)
  return process.platform === 'win32' ? n.toLowerCase() : n
}

export function isSubPath(parent: string, child: string): boolean {
  const a = pathKey(parent)
  const b = pathKey(child)
  if (a === b) return true
  const withSep = a.endsWith(sep) ? a : a + sep
  return b.startsWith(withSep)
}

/** `relative` without ever escaping the parent. */
export function safeRelative(parent: string, child: string): string | null {
  const rel = relative(parent, child)
  if (rel === '') return ''
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

export function pathExists(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

export function dirNameOf(p: string): string {
  return basename(normalizePath(p))
}

/** Display helper — keeps the original casing the user typed. */
export function displayPath(p: string): string {
  return normalize(p)
}

export function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/** Detect a Windows drive root or POSIX `/`, which must never be indexed. */
export function isFilesystemRoot(p: string): boolean {
  const n = normalizePath(p)
  if (n === sep) return true
  if (/^[a-z]:$/i.test(n)) return true
  if (/^[a-z]:[\\/]?$/i.test(n)) return true
  return false
}

export function assertIndexableRoot(p: string): { ok: true } | { ok: false; reason: string } {
  const n = normalizePath(p)
  if (!n) return { ok: false, reason: t('root.empty') }
  if (isFilesystemRoot(n)) return { ok: false, reason: t('root.filesystemRoot') }
  if (!pathExists(n)) return { ok: false, reason: t('root.missing') }
  if (isSubPath(homedir(), n) && pathKey(n) === pathKey(homedir())) {
    return { ok: false, reason: t('root.home') }
  }
  return { ok: true }
}
