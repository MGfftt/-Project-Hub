/**
 * Connection + migration bootstrap.
 *
 * IMPORTANT (data isolation): this module only ever opens the SQLite file it is
 * given. In the app that path is `app.getPath('userData')/data.db`. No code path
 * writes into an indexed project folder.
 */
import { DatabaseCtor, type Database as SqliteDatabase, type SqliteRow } from './sqlite.js'
import { SCHEMA_SQL } from './schema.js'
import { renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DB = SqliteDatabase

export const SCHEMA_VERSION = 1

export interface OpenOptions {
  /** SQLite file path. Callers pass `app.getPath('userData')/data.db`. */
  path: string
  /** In-memory mode is used by unit tests. */
  memory?: boolean
  readonly?: boolean
}

export interface OpenResult {
  db: DB
  /** Set when the previous file failed `integrity_check` and was moved aside. */
  recoveredFrom?: string
}

let singleton: DB | null = null

function applyPragmas(db: DB): void {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('temp_store = MEMORY')
  db.pragma('cache_size = -8000') // 8MB page cache (§12.2)
}

function applySchema(db: DB): void {
  db.exec(SCHEMA_SQL)
}

/** Open a file-backed connection with the pragmas the §12 budget depends on. */
function tryOpen(path: string): DB {
  const db = new DatabaseCtor(path)
  applyPragmas(db)
  return db
}

/** Park an unusable database file (plus its WAL siblings) next to the original. */
function moveAside(path: string): string {
  const backupPath = `${path}.corrupt-${Date.now()}`
  renameSync(path, backupPath)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(path + suffix)) renameSync(path + suffix, backupPath + suffix)
  }
  return backupPath
}

/**
 * §6.2 / §14.1 — an existing file is only trusted when it opens, answers
 * `integrity_check` with exactly `ok`, and accepts the schema. Anything that
 * throws along the way (an unreadable header, a pragma failure, a failed check)
 * means the file cannot be used: it is parked as `<db>.corrupt-<ts>` and a fresh
 * database is created, so a damaged file degrades to an empty library instead of
 * a crash loop. Only a failure to open the *fresh* file is fatal.
 */
function verifyOrRebuild(opts: OpenOptions): OpenResult {
  let db: DB | null = null
  let reason = ''
  try {
    // Assign the handle BEFORE the pragmas run: if `journal_mode = WAL` fails on a
    // bogus file, the connection must still be closed, otherwise Windows keeps the
    // file locked and it cannot be renamed (`EBUSY`).
    db = new DatabaseCtor(opts.path)
    applyPragmas(db)
    const check = db.pragma('integrity_check') as SqliteRow[] | undefined
    const ok = Array.isArray(check) && check.length === 1 && check[0]?.integrity_check === 'ok'
    if (ok) {
      applySchema(db)
      db.pragma(`user_version = ${SCHEMA_VERSION}`)
      return { db }
    }
    reason = 'integrity_check did not return ok'
  } catch (err) {
    reason = (err as Error).message
  }

  try {
    db?.close()
  } catch {
    /* the handle is unusable anyway */
  }
  db = null

  let backupPath: string
  try {
    backupPath = moveAside(opts.path)
  } catch (err) {
    throw new Error(
      `[db] ${opts.path} is unusable (${reason}) and could not be moved aside: ${(err as Error).message}`
    )
  }

  const fresh = tryOpen(opts.path)
  applySchema(fresh)
  fresh.pragma(`user_version = ${SCHEMA_VERSION}`)
  return { db: fresh, recoveredFrom: backupPath }
}

export function openDatabase(opts: OpenOptions): OpenResult {
  mkdirSync(dirname(opts.path), { recursive: true })

  if (opts.memory) {
    const db = new DatabaseCtor(':memory:')
    // foreign_keys works in memory mode too, but WAL does not apply.
    db.pragma('foreign_keys = ON')
    db.pragma('temp_store = MEMORY')
    applySchema(db)
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
    return { db }
  }

  if (!existsSync(opts.path)) {
    const db = tryOpen(opts.path)
    applySchema(db)
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
    return { db }
  }

  return verifyOrRebuild(opts)
}

/** Process-wide handle used by the main process. */
export function initDatabase(opts: OpenOptions): OpenResult {
  const res = openDatabase(opts)
  singleton = res.db
  return res
}

export function getDb(): DB {
  if (!singleton) throw new Error('[db] not initialised')
  return singleton
}

export function setDb(db: DB): void {
  singleton = db
}

export function closeDatabase(): void {
  if (!singleton) return
  try {
    singleton.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    /* best effort */
  }
  singleton.close()
  singleton = null
}

export function getUserVersion(db: DB): number {
  return Number((db.pragma('user_version', { simple: true }) as number) ?? 0)
}

export { DatabaseCtor }
