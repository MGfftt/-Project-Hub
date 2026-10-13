/**
 * Sandboxed filesystem operations for the main process.
 *
 * DATA ISOLATION CONTRACT (§8) — every write in this module is redirected into the
 * app's own `userData` directory:
 *   - `userData/thumbnails/…`      icon and preview copies
 *   - `userData/backgrounds/…`     wallpaper copies
 *   - `userData/logs/…`
 * There is deliberately **no** API here that writes into a user project folder,
 * and `tests/unit/isolation.spec.ts` proves it: it hashes an indexed tree before
 * and after the whole scan/annotate/thumbnail/snapshot pipeline and asserts the
 * hash is unchanged.
 */
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs'
import { join, extname, basename, dirname, isAbsolute } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
}

export async function pathIsDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export async function pathIsFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile()
  } catch {
    return false
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Atomic JSON write: temp file + rename, so a crash never leaves a torn file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(dirname(file))
  const tmp = `${file}.${randomUUID()}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

/**
 * Recursive disk usage. Returns bytes, file count and directory count.
 * Bounded: stops after `maxEntries` so a huge folder cannot hang the UI thread.
 */
export interface SizeResult {
  bytes: number
  files: number
  dirs: number
  truncated: boolean
}

export async function directorySize(
  root: string,
  options: { maxEntries?: number; skip?: (name: string) => boolean } = {}
): Promise<SizeResult> {
  const maxEntries = options.maxEntries ?? 200_000
  const skip = options.skip ?? ((): boolean => false)
  const out: SizeResult = { bytes: 0, files: 0, dirs: 0, truncated: false }
  const stack: string[] = [root]

  while (stack.length > 0) {
    if (out.files + out.dirs >= maxEntries) {
      out.truncated = true
      break
    }
    const dir = stack.pop()!
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (skip(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        out.dirs += 1
        stack.push(abs)
      } else if (entry.isFile()) {
        try {
          const st = await fsp.stat(abs)
          out.bytes += st.size
          out.files += 1
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  return out
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.svg'])
const BACKGROUND_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

export function isImageFile(p: string): boolean {
  return IMAGE_EXT.has(extname(p).toLowerCase())
}

export function isBackgroundFile(p: string): boolean {
  return BACKGROUND_EXT.has(extname(p).toLowerCase())
}

export function isSvg(p: string): boolean {
  return extname(p).toLowerCase() === '.svg'
}

/**
 * Copy a file into `destDir` under a fresh UUID name.
 * Used for custom icons (§9.3) and custom backgrounds (§9.5).
 */
export async function copyIntoStore(
  source: string,
  destDir: string,
  keepExt = true
): Promise<{ filename: string; bytes: number }> {
  await ensureDir(destDir)
  const ext = keepExt ? extname(source).toLowerCase() : ''
  const filename = `${randomUUID()}${ext}`
  const dest = join(destDir, filename)
  await pipeline(createReadStream(source), createWriteStream(dest))
  const st = await fsp.stat(dest)
  return { filename, bytes: st.size }
}

export async function removeFileQuiet(file: string): Promise<boolean> {
  try {
    await fsp.unlink(file)
    return true
  } catch {
    return false
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Best-effort move to the OS trash. Falls back to a permanent delete. */
export async function trashFile(file: string, trash: (p: string) => Promise<void>): Promise<void> {
  try {
    await trash(file)
  } catch {
    await removeFileQuiet(file)
  }
}

/**
 * Resolve `relPath` inside `base` and return null when it escapes.
 * The icon/background stores are addressed from the renderer, so every lookup
 * goes through this guard — a `../` in a renderer payload can never read outside.
 *
 * The check is deliberately strict: ANY `..` segment is refused, even when the
 * path would normalise back inside `base` (e.g. `.../../x`). A store filename is
 * a plain name, so nothing legitimate is lost and no traversal trick survives.
 */
export function resolveInside(base: string, relPath: string): string | null {
  if (!relPath || relPath.includes('\0')) return null
  const segments = relPath.split(/[\\/]+/)
  if (segments.some((seg) => seg === '..')) return null
  // An absolute path (or a Windows drive/UNC prefix) is never a store filename.
  if (isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) return null
  const target = join(base, relPath)
  const normalizedBase = base.endsWith('\\') || base.endsWith('/') ? base : base + (process.platform === 'win32' ? '\\' : '/')
  const comparable = process.platform === 'win32' ? target.toLowerCase() : target
  const comparableBase = process.platform === 'win32' ? normalizedBase.toLowerCase() : normalizedBase
  if (!comparable.startsWith(comparableBase)) return null
  if (basename(target).startsWith('..')) return null
  return target
}

/** File name without extension, used for icon captions. */
export function stem(p: string): string {
  const b = basename(p)
  const e = extname(b)
  return e ? b.slice(0, -e.length) : b
}

/**
 * Read at most `maxBytes` of a text file.
 *
 * Truncates rather than refusing: a preview wants the first N bytes of a large
 * file, and returning `null` for anything over the cap made the function useless
 * for exactly the case its name describes. `null` is reserved for "cannot read"
 * (missing, a directory, a permission error).
 */
export async function readTextCapped(file: string, maxBytes = 512 * 1024): Promise<string | null> {
  let handle: fsp.FileHandle | undefined
  try {
    const st = await fsp.stat(file)
    if (!st.isFile()) return null
    handle = await fsp.open(file, 'r')
    const length = Math.max(0, Math.min(maxBytes, st.size))
    if (length === 0) return ''
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, 0)
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
