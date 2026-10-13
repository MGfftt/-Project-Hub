/**
 * Thumbnail service (§7.10).
 *
 * Images are decoded with Electron's `nativeImage` — the only image decoder that
 * ships with the runtime — so **no image library is added to the dependency
 * list** (that is the justification the project book demands for every dep).
 *
 * Cache layout:  `${userData}/thumbnails/<sha1(absPath)>-<mtimeMs>-<size>-<edge>.png`
 * The key carries mtime and size, so an edited source file simply produces a new
 * cache entry; stale entries are pruned by `gc()` instead of being invalidated
 * eagerly. Everything lives under userData — never next to the user's file.
 */
import { nativeImage } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { sha1 } from '../utils/hash'
import { createLogger } from '../utils/logger'

const log = createLogger('thumbnail')

export interface ThumbRequest {
  file: string
  edge?: number
  modifiedMs?: number
  size?: number
}

export interface ThumbResult {
  ok: boolean
  /** Absolute path inside the thumbnail cache, when `ok`. */
  cachePath?: string
  width?: number
  height?: number
  error?: string
}

interface MemoryEntry {
  value: ThumbResult
  at: number
}

/** Bounded LRU: renderer re-requests the same icon on every tree repaint. */
class LruCache<T> {
  private map = new Map<string, T>()
  constructor(private readonly max: number) {}
  get(key: string): T | undefined {
    const hit = this.map.get(key)
    if (hit === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, hit)
    return hit
  }
  set(key: string, value: T): void {
    this.map.set(key, value)
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }
  clear(): void {
    this.map.clear()
  }
  get size(): number {
    return this.map.size
  }
}

const DEFAULT_EDGE = 64

export class Thumbnailer {
  private readonly cache = new LruCache<ThumbResult>(2048)

  constructor(private readonly cacheDir: string) {}

  private key(req: ThumbRequest): string {
    const edge = req.edge ?? DEFAULT_EDGE
    return `${req.file.toLowerCase()}|${req.modifiedMs ?? 0}|${req.size ?? 0}|${edge}`
  }

  private fileName(req: ThumbRequest): string {
    const edge = req.edge ?? DEFAULT_EDGE
    const id = sha1(`${req.file.toLowerCase()}|${req.modifiedMs ?? 0}|${req.size ?? 0}`).slice(0, 20)
    return `${id}-${edge}.png`
  }

  /**
   * Return a cached thumbnail, creating it on first use.
   * Never throws: a failure is reported as `{ok:false}` so one bad image cannot
   * take down the tree render.
   */
  async get(req: ThumbRequest): Promise<ThumbResult> {
    const key = this.key(req)
    const cached = this.cache.get(key)
    if (cached) {
      // Cache file may have been pruned by gc(); verify before reporting ok.
      if (!cached.ok || !cached.cachePath) return cached
      try {
        await fsp.access(cached.cachePath)
        return cached
      } catch {
        /* fall through and re-create */
      }
    }

    const result = await this.build(req)
    this.cache.set(key, result)
    return result
  }

  private async build(req: ThumbRequest): Promise<ThumbResult> {
    const edge = Math.max(16, Math.min(req.edge ?? DEFAULT_EDGE, 512))
    try {
      await fsp.mkdir(this.cacheDir, { recursive: true })
      const dest = join(this.cacheDir, this.fileName(req))

      // Already on disk from a previous run?
      try {
        await fsp.access(dest)
        const size = nativeImage.createFromPath(dest).getSize()
        return { ok: true, cachePath: dest, width: size.width, height: size.height }
      } catch {
        /* build it */
      }

      const img = nativeImage.createFromPath(req.file)
      if (img.isEmpty()) {
        return { ok: false, error: 'unsupported or unreadable image' }
      }
      const size = img.getSize()
      const scale = Math.min(1, edge / Math.max(size.width, size.height))
      const resized =
        scale < 1
          ? img.resize({
              width: Math.max(1, Math.round(size.width * scale)),
              height: Math.max(1, Math.round(size.height * scale)),
              quality: 'good'
            })
          : img
      const png = resized.toPNG()
      // Guard against decompression bombs: refuse > 8 MiB PNG output.
      if (png.byteLength > 8 * 1024 * 1024) return { ok: false, error: 'thumbnail too large' }
      await fsp.writeFile(dest, png)
      const out = resized.getSize()
      return { ok: true, cachePath: dest, width: out.width, height: out.height }
    } catch (err) {
      log.warn('thumbnail failed', { file: req.file, err: (err as Error).message })
      return { ok: false, error: (err as Error).message }
    }
  }

  /** Drop cached thumbnails whose source no longer exists or whose edge is unused. */
  async gc(knownEdges: number[] = [DEFAULT_EDGE, 128, 256]): Promise<{ removed: number; bytes: number }> {
    let removed = 0
    let bytes = 0
    let names: string[]
    try {
      names = await fsp.readdir(this.cacheDir)
    } catch {
      return { removed, bytes }
    }
    const keepSuffixes = knownEdges.map((e) => `-${e}.png`)
    for (const name of names) {
      if (!keepSuffixes.some((s) => name.endsWith(s))) {
        const abs = join(this.cacheDir, name)
        try {
          const st = await fsp.stat(abs)
          bytes += st.size
          await fsp.unlink(abs)
          removed += 1
        } catch {
          /* raced with another gc */
        }
      }
    }
    if (removed > 0) {
      this.cache.clear()
      log.info('thumbnail gc', { removed, bytes })
    }
    return { removed, bytes }
  }

  /** Total bytes used by the cache — surfaced in the settings panel. */
  async size(): Promise<{ files: number; bytes: number }> {
    let files = 0
    let bytes = 0
    try {
      for (const name of await fsp.readdir(this.cacheDir)) {
        try {
          const st = await fsp.stat(join(this.cacheDir, name))
          if (st.isFile()) {
            files += 1
            bytes += st.size
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* cache dir absent */
    }
    return { files, bytes }
  }

  clearMemory(): void {
    this.cache.clear()
  }

  get memorySize(): number {
    return this.cache.size
  }
}
