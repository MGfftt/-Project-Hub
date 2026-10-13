/**
 * SQLite driver shim.
 *
 * Production uses `better-sqlite3` (the frozen choice, §3). Its addon is built
 * against the Electron ABI, so it cannot be loaded from a plain `node` process —
 * which is exactly where `vitest` runs.
 *
 * Rather than skip the DB tests, this module probes for better-sqlite3 and falls
 * back to Node's built-in `node:sqlite` (`DatabaseSync`) with a small
 * better-sqlite3-compatible surface (`prepare/exec/transaction/pragma/close`).
 * Both drivers speak the same SQL, so `schema.sql`, `repo.ts` and every test are
 * literally identical across the two — see DECISIONS.md D-002.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * `node:sqlite` is loaded lazily, never as a static import, for two reasons:
 *
 *  1. Electron 33 ships Node 20.18, where `node:sqlite` does not exist yet (it
 *     landed in Node 22.5). A top-level `import ... from 'node:sqlite'` would
 *     therefore crash the packaged app on startup even though production uses
 *     better-sqlite3.
 *  2. Vite resolves static imports itself; `node:sqlite` is only registered as a
 *     builtin under its prefixed name, so Vite strips `node:` and then fails on
 *     the bare specifier `sqlite` under vitest.
 *
 * `require` is opaque to Vite and Rollup, and Rollup shims `import.meta.url` to
 * `pathToFileURL(__filename).href` in the CJS main bundle, so this resolves the
 * same way in dev, in `out/` and in an asar archive.
 */
type NodeSqliteModule = {
  DatabaseSync: new (path: string, options?: Record<string, unknown>) => NodeSqliteDb
}

interface NodeSqliteDb {
  prepare(sql: string): NodeSqliteStmt
  exec(sql: string): void
  close(): void
}

interface NodeSqliteStmt {
  run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  iterate(...params: unknown[]): Iterable<unknown>
  setReadBigInts?(on: boolean): void
}

let cachedNodeSqlite: NodeSqliteModule | null | undefined

function loadNodeSqlite(): NodeSqliteModule | null {
  if (cachedNodeSqlite !== undefined) return cachedNodeSqlite
  try {
    cachedNodeSqlite = require('node:sqlite') as NodeSqliteModule
  } catch {
    cachedNodeSqlite = null
  }
  return cachedNodeSqlite
}

/** True when this process has Node's built-in SQLite (Node >= 22.5). */
export const hasNodeSqlite = (): boolean => loadNodeSqlite() !== null

export interface RunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface Statement {
  run(...params: unknown[]): RunResult
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  iterate(...params: unknown[]): IterableIterator<unknown>
}

export interface SqliteRow {
  [key: string]: unknown
}

export interface Database {
  prepare(sql: string): Statement
  exec(sql: string): void
  transaction<F extends (...args: never[]) => unknown>(fn: F): F
  pragma(source: string, options?: { simple?: boolean }): unknown
  close(): void
  readonly open: boolean
  readonly driver: 'better-sqlite3' | 'node:sqlite'
}

export interface DatabaseConstructor {
  new (path: string, options?: Record<string, unknown>): Database
}

/* ------------------------------------------------------------------ */
/* better-sqlite3 probe                                                */
/* ------------------------------------------------------------------ */

interface NativeCtor {
  new (path: string, options?: Record<string, unknown>): unknown
}

function probeBetterSqlite3(): NativeCtor | null {
  try {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const mod = require('better-sqlite3') as any
    const ctor = (mod?.default ?? mod) as NativeCtor | undefined
    if (typeof ctor !== 'function') return null
    // Loading the addon is the real test — ABI mismatch throws here.
    const probe = new ctor(':memory:')
    ;(probe as { close(): void }).close()
    return ctor
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* node:sqlite adapter                                                 */
/* ------------------------------------------------------------------ */

type ParamValue = string | number | bigint | null | Uint8Array

function toBindParams(params: unknown[]): ParamValue[] {
  if (params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    // Named-parameter object: node:sqlite resolves `@name` keys with or without
    // the sigil, which matches better-sqlite3's `@name` usage in repo.ts.
    return [params[0] as ParamValue]
  }
  return params as ParamValue[]
}

class NodeSqliteStatement implements Statement {
  constructor(private readonly inner: NodeSqliteStmt) {}

  run(...params: unknown[]): RunResult {
    const r = this.inner.run(...toBindParams(params))
    return {
      changes: Number(r?.changes ?? 0),
      lastInsertRowid: (r?.lastInsertRowid ?? 0) as number | bigint
    }
  }
  get(...params: unknown[]): unknown {
    return this.inner.get(...toBindParams(params))
  }
  all(...params: unknown[]): unknown[] {
    return this.inner.all(...toBindParams(params)) as unknown[]
  }
  *iterate(...params: unknown[]): IterableIterator<unknown> {
    yield* this.inner.iterate(...toBindParams(params)) as Iterable<unknown>
  }
}

class NodeSqliteDatabase implements Database {
  private readonly inner: NodeSqliteDb
  private isOpen = true
  readonly driver = 'node:sqlite' as const

  constructor(path: string) {
    const mod = loadNodeSqlite()
    if (!mod) {
      throw new Error(
        '[db] no SQLite driver available: better-sqlite3 could not be loaded and this ' +
          'Node build has no `node:sqlite` (needs Node >= 22.5)'
      )
    }
    this.inner = new mod.DatabaseSync(path)
    // better-sqlite3 returns JS numbers by default; match that.
    try {
      this.inner.prepare('SELECT 1').setReadBigInts?.(false)
    } catch {
      /* optional */
    }
  }

  prepare(sql: string): Statement {
    const stmt = this.inner.prepare(sql)
    try {
      stmt.setReadBigInts?.(false)
    } catch {
      /* optional */
    }
    return new NodeSqliteStatement(stmt)
  }

  exec(sql: string): void {
    this.inner.exec(sql)
  }

  transaction<F extends (...args: never[]) => unknown>(fn: F): F {
    const self = this
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      self.inner.exec('BEGIN')
      try {
        const out = (fn as unknown as (...a: unknown[]) => unknown).apply(this, args)
        self.inner.exec('COMMIT')
        return out
      } catch (err) {
        try {
          self.inner.exec('ROLLBACK')
        } catch {
          /* already rolled back */
        }
        throw err
      }
    }
    return wrapped as unknown as F
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    const rows = this.inner.prepare(`PRAGMA ${source}`).all() as Array<Record<string, unknown>>

    // better-sqlite3 semantics, and the two drivers MUST agree: `db.pragma(x)`
    // returns an ARRAY of row objects, and only `{simple: true}` unwraps the
    // first column of the first row. An earlier version unwrapped single-column
    // pragmas unconditionally, which made `PRAGMA integrity_check` return the
    // string `'ok'` here while production (better-sqlite3) returned
    // `[{integrity_check:'ok'}]` — so `verifyOrRebuild` in db/index.ts judged
    // every healthy existing database corrupt on this driver alone.
    if (options?.simple) {
      const first = rows[0]
      if (!first) return undefined
      const keys = Object.keys(first)
      return keys.length ? first[keys[0]] : undefined
    }
    return rows
  }

  close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.inner.close()
  }

  get open(): boolean {
    return this.isOpen
  }
}

/* ------------------------------------------------------------------ */
/* export                                                             */
/* ------------------------------------------------------------------ */

const NativeBetterSqlite3 = probeBetterSqlite3()

export const driverName: 'better-sqlite3' | 'node:sqlite' = NativeBetterSqlite3
  ? 'better-sqlite3'
  : 'node:sqlite'

const DatabaseCtor: DatabaseConstructor = NativeBetterSqlite3
  ? (NativeBetterSqlite3 as unknown as DatabaseConstructor)
  : (NodeSqliteDatabase as unknown as DatabaseConstructor)

export { DatabaseCtor }
export default DatabaseCtor
