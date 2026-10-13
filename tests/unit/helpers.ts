/**
 * Shared test helpers.
 *
 * Two hard rules the tests themselves must obey:
 *   1. every temporary directory lives under the OS temp dir, never inside the
 *      repo checkout, so a failed test can never look like project data;
 *   2. the DB is opened in `:memory:` mode unless a test explicitly needs a file
 *      on disk (the isolation tests do, because they hash the file's directory).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { initDatabase, closeDatabase, setDb } from '../../src/main/db'
import { repo } from '../../src/main/db/repo'
import { DatabaseCtor, driverName, type Database } from '../../src/main/db/sqlite'

export { driverName }

/** A tracked temp directory that is removed when `dispose()` is called. */
export interface Sandbox {
  readonly root: string
  dir(...parts: string[]): string
  file(relPath: string, content?: string | Buffer): string
  dispose(): void
}

export function sandbox(prefix = 'hub-test-'): Sandbox {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return {
    root,
    dir(...parts: string[]): string {
      const p = join(root, ...parts)
      mkdirSync(p, { recursive: true })
      return p
    },
    file(relPath: string, content = 'x'): string {
      const p = join(root, relPath)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content)
      return p
    },
    dispose(): void {
      // Windows keeps handles to the SQLite WAL/SHM files alive for a moment
      // after they are closed, so retry instead of failing the whole test.
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}

/** Fresh in-memory DB exposed through the main-process singleton. */
export function memoryDb(): Database {
  return initDatabase({ path: ':memory:', memory: true }).db
}

export function fileDb(path: string): Database {
  return initDatabase({ path }).db
}

export function disposeDb(): void {
  closeDatabase()
}

/** Build a small, deterministic project fixture: root/{a,b,c}. */
export function projectFixture(sb: Sandbox): string {
  sb.file('proj-a/package.json', '{"name":"proj-a"}')
  sb.file('proj-a/src/index.ts', 'export const a = 1\n')
  sb.file('proj-a/README.md', '# proj a\n')
  sb.file('proj-b/pyproject.toml', '[project]\nname="proj-b"\n')
  sb.file('proj-b/main.py', 'print(1)\n')
  sb.dir('proj-c/nested/deep')
  sb.file('proj-c/nested/deep/Cargo.toml', '[package]\nname="deep"\n')
  // Noise that the scanner must ignore or skip.
  sb.file('proj-a/node_modules/left-pad/index.js', 'module.exports=1\n')
  sb.file('proj-a/dist/bundle.js', 'console.log(1)\n')
  return sb.root
}

/** Recursive listing of (relativePath -> {size, mtimeMs, sha1}) for a tree. */
export type TreeHash = Map<string, { size: number; mtimeMs: number; sha1: string }>

export function hashTree(root: string): TreeHash {
  const out: TreeHash = new Map()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      const st = statSync(abs)
      out.set(relative(root, abs).split(sep).join('/'), {
        size: st.size,
        mtimeMs: st.mtimeMs,
        sha1: createHash('sha1').update(readFileSync(abs)).digest('hex')
      })
    }
  }
  walk(root)
  return out
}

/** Compares two `hashTree` results; returns a human-readable diff list. */
export function diffTrees(before: TreeHash, after: TreeHash): string[] {
  const problems: string[] = []
  for (const [rel, meta] of after) {
    const prev = before.get(rel)
    if (!prev) problems.push(`created: ${rel}`)
    else if (prev.sha1 !== meta.sha1) problems.push(`modified: ${rel}`)
  }
  for (const rel of before.keys()) if (!after.has(rel)) problems.push(`deleted: ${rel}`)
  return problems
}

/** Convenience: every tracked node's absolute path from the repo. */
export function allPaths(): string[] {
  return repo
    .listNodes()
    .map((n) => n.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
}

// Keep `DatabaseCtor` re-exported for suites that need a raw handle.
export { DatabaseCtor }
export { setDb }
