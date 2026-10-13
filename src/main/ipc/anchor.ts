/**
 * The only two places the renderer may name a native filesystem path.
 *
 * DATA ISOLATION (§8) in one sentence: the renderer can *read* paths the main
 * process already indexed, and it can *pick* new ones through a native dialog —
 * it can never invent a path and have the main process touch it.
 *
 * `src/main/ipc/anchor.ts` is the single funnel for renderer-supplied native
 * paths:
 *   - `resolveNodePath(nodeId)`  looks the path up in SQLite by id. The renderer
 *     sends an integer, never a string. A guessed id simply resolves to nothing.
 *   - `resolveIconAsset(filename)` and `resolveBackground(filename)` resolve
 *     inside `userData/`, with traversal rejected.
 *
 * `tests/unit/isolation.test.ts` asserts that no other module calls a
 * write-capable `node:fs` function on a path that came from the renderer.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { repo } from '../db/repo'
import { resolveInside } from '../utils/fsops'
import { pathKey } from '../utils/path'

export interface Anchor {
  paths: {
    /** Resolve an indexed node to its absolute path, or null. */
    node(id: number): string | null
    /** Resolve a stored icon by file name inside userData/thumbnails. */
    icon(filename: string): string | null
    background(filename: string): string | null
    /** Resolve a path *only* if it is inside an indexed root. */
    indexed(candidate: string): string | null
  }
  isInsideIndexedRoot(candidate: string): boolean
}

export function createAnchor(opts: {
  thumbsDir: string
  backgroundsDir: string
  appDir: string
}): Anchor {
  const indexedRoots = (): string[] => repo.listRoots().map((r) => r.path)

  const isInside = (candidate: string): boolean => {
    const key = pathKey(candidate)
    return indexedRoots().some((root) => {
      const rk = pathKey(root)
      if (key === rk) return true
      const withSep = rk.endsWith('\\') || rk.endsWith('/') ? rk : rk + (process.platform === 'win32' ? '\\' : '/')
      return key.startsWith(withSep)
    })
  }

  return {
    paths: {
      node(id: number): string | null {
        if (!Number.isInteger(id) || id <= 0) return null
        const node = repo.getNode(id)
        if (!node?.path) return null
        return node.path
      },
      icon(filename: string): string | null {
        return resolveInside(opts.thumbsDir, filename)
      },
      background(filename: string): string | null {
        return resolveInside(opts.backgroundsDir, filename)
      },
      indexed(candidate: string): string | null {
        if (typeof candidate !== 'string' || candidate.length === 0) return null
        return isInside(candidate) ? candidate : null
      }
    },
    isInsideIndexedRoot: isInside
  }
}

/** Used by the settings panel: how much of userData are we actually using? */
export function storeFootprint(dirs: string[]): Array<{ dir: string; files: number }> {
  const out: Array<{ dir: string; files: number }> = []
  for (const dir of dirs) {
    try {
      if (!existsSync(dir)) {
        out.push({ dir, files: 0 })
        continue
      }
      const files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length
      out.push({ dir, files })
    } catch {
      out.push({ dir, files: 0 })
    }
  }
  return out
}

/** Convenience for the ipc layer: the icons directory lives beside thumbnails. */
export function iconStoreDir(userData: string): string {
  return join(userData, 'thumbnails')
}

export function backgroundStoreDir(userData: string): string {
  return join(userData, 'backgrounds')
}

export function logDir(userData: string): string {
  return join(userData, 'logs')
}
