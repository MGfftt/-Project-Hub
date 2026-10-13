/**
 * Git layer (§7.7 `events.syncAllGit`).
 *
 * Wrapped in a thin façade over `simple-git` so that:
 *   - only read-only git commands are ever issued (no add/commit/checkout/push),
 *     and every command runs with `--no-optional-locks` so we never write a
 *     `.git/index.lock` into a user repository;
 *   - the parsing of `git log --numstat` is a pure function
 *     (`parseNumstatLog`) that unit tests can exercise with fixture text.
 */
import { simpleGit, type SimpleGit, type DefaultLogFields, type ListLogLine } from 'simple-git'
import type { RawGitEvent } from '../../shared/types'
import { createLogger } from '../utils/logger'

const log = createLogger('git')

export interface GitProbeResult {
  isRepo: boolean
  branch: string | null
  remote: string | null
  ahead: number
  behind: number
}

const READ_ONLY_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1'
}

/**
 * Environment handed to every git child.
 *
 * simple-git inspects the spawned env and REFUSES to run when it finds keys such
 * as `GIT_PAGER`/`PAGER` (allowUnsafePager), `EDITOR`/`GIT_EDITOR`/`VISUAL`
 * (allowUnsafeEditor), `GIT_ASKPASS` (allowUnsafeAskPass) or `GIT_CONFIG_*`
 * (allowUnsafeConfigPaths) — and the ambient shell here does export `GIT_PAGER`,
 * which made every probe report "not a repository". Instead of enabling those
 * unsafe switches we strip the keys: this app only ever runs read-only local
 * commands (`log`, `status`, `revparse`), which need none of them.
 */
const UNSAFE_ENV_KEYS = new Set([
  'GIT_PAGER',
  'PAGER',
  'GIT_EDITOR',
  'EDITOR',
  'VISUAL',
  'GIT_SEQUENCE_EDITOR',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_TEMPLATE_DIR',
  'GIT_EXTERNAL_DIFF',
  'GIT_DIFF_OPTS'
])

export function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (UNSAFE_ENV_KEYS.has(key.toUpperCase())) continue
    env[key] = value
  }
  return { ...env, ...READ_ONLY_ENV }
}

export function gitFor(dir: string): SimpleGit {
  return simpleGit({
    baseDir: dir,
    binary: 'git',
    maxConcurrentProcesses: 2,
    trimmed: true,
    config: ['core.quotepath=false']
  }).env(gitEnv())
}

/** Cheap probe used by the stats drawer and the tray tooltip. */
export async function probeRepo(dir: string): Promise<GitProbeResult> {
  const out: GitProbeResult = { isRepo: false, branch: null, remote: null, ahead: 0, behind: 0 }
  try {
    const g = gitFor(dir)
    if (!(await g.checkIsRepo())) return out
    out.isRepo = true
    const status = await g.status()
    out.branch = status.current ?? null
    out.ahead = status.ahead
    out.behind = status.behind
    try {
      const remotes = await g.getRemotes(true)
      out.remote = remotes[0]?.refs?.fetch ?? remotes[0]?.refs?.push ?? null
    } catch {
      out.remote = null
    }
    return out
  } catch (err) {
    log.debug('probe failed', { dir, err: (err as Error).message })
    return out
  }
}

const NUMSTAT_SEP = '\u0001'
const RECORD_SEP = '\u0002'

/** Format string that keeps subjects containing tabs/newlines intact. */
export const GIT_LOG_FORMAT = [
  '%H',
  '%an',
  '%aI',
  '%s'
].join(NUMSTAT_SEP) + RECORD_SEP

export interface GitLogEntry {
  hash: string
  author: string
  date: string
  subject: string
  insertions: number
  deletions: number
  /** Changed paths, in the order git printed them. */
  fileList: string[]
}

/**
 * Parse the stdout of
 *   `git log --numstat --no-renames --format=<GIT_LOG_FORMAT>`
 * into structured entries. Pure — see `tests/unit/git.spec.ts`.
 *
 * Git prints the formatted header, then the newline that separates commits, then
 * the numstat block — so the `\u0002` record separator that ends the format lands
 * BEFORE the numstat lines of that same commit:
 *
 *   <hash>\x01<author>\x01<iso>\x01<subject>\x02\n
 *   <add>\t<del>\t<path>\n      (repeated; binary files report "-\t-")
 *   <hash2>\x01...\x02\n
 *   ...
 *
 * Splitting on `\u0002` therefore yields, for every i >= 1, a chunk whose LAST
 * line is the header of commit i and whose preceding lines are the numstat block
 * of commit i-1. A chunk that does not end in a header belongs to the commit
 * before it (that is the case for the final chunk).
 */
export function parseNumstatLog(raw: string): GitLogEntry[] {
  if (!raw.trim()) return []

  const fromHeader = (line: string | undefined): GitLogEntry | null => {
    if (!line) return null
    const parts = line.split(NUMSTAT_SEP)
    // A header is the only line carrying three \u0001 separators; numstat lines
    // never contain one, which is what makes this test reliable.
    if (parts.length < 4) return null
    const [hash, author, date, subject] = parts
    if (!hash || !hash.trim()) return null
    return {
      hash: hash.trim(),
      author: author || 'unknown',
      date: date || new Date().toISOString(),
      subject: subject || '',
      insertions: 0,
      deletions: 0,
      fileList: []
    }
  }

  const addNumstat = (entry: GitLogEntry | null, lines: string[]): void => {
    if (!entry) return
    for (const line of lines) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const [addRaw, delRaw, ...pathParts] = parts
      const add = addRaw === '-' ? 0 : Number.parseInt(addRaw, 10)
      const del = delRaw === '-' ? 0 : Number.parseInt(delRaw, 10)
      if (Number.isFinite(add)) entry.insertions += add
      if (Number.isFinite(del)) entry.deletions += del
      entry.fileList.push(pathParts.join('\t'))
    }
  }

  const chunks = raw.split(RECORD_SEP)
  const entries: GitLogEntry[] = []
  let current = fromHeader(chunks[0]?.replace(/^\r?\n/, ''))
  if (current) entries.push(current)

  for (let i = 1; i < chunks.length; i += 1) {
    const lines = chunks[i].split(/\r?\n/)
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    const next = fromHeader(lines[lines.length - 1])
    if (next) lines.pop()
    addNumstat(current, lines)
    if (next) {
      entries.push(next)
      current = next
    }
  }

  return entries
}

export interface SyncReposOptions {
  repo: { nodeId: number; path: string; lastHash: string | null }
  /** Hard cap on commits fetched per repository per sync. */
  limit?: number
  /** Only walk commits newer than this ISO date (90-day window, §7.3). */
  sinceIso?: string
}

export interface RepoSyncOutcome {
  nodeId: number
  path: string
  newEvents: RawGitEvent[]
  headHash: string | null
  error?: string
}

/**
 * Read new commits for one repository.
 * Read-only: `git log` only. When `lastHash` is set we ask git for
 * `lastHash..HEAD`; if that range fails (force-push, rebase, gc) we fall back to
 * a date-bounded `git log` and let the caller de-duplicate on commit hash.
 */
export async function syncRepo(options: SyncReposOptions): Promise<RepoSyncOutcome> {
  const { repo: target, limit = 200, sinceIso } = options
  const out: RepoSyncOutcome = { nodeId: target.nodeId, path: target.path, newEvents: [], headHash: null }
  try {
    const g = gitFor(target.path)
    if (!(await g.checkIsRepo())) {
      out.error = 'not a git repository'
      return out
    }

    const headRaw = await g.revparse(['HEAD'])
    const head = headRaw.trim()
    out.headHash = head || null
    if (!head) return out
    if (target.lastHash && target.lastHash === head) return out

    const range = target.lastHash ? `${target.lastHash}..HEAD` : null
    const args = [
      'log',
      `--max-count=${limit}`,
      '--numstat',
      '--no-renames',
      '--no-merges',
      `--format=${GIT_LOG_FORMAT}`
    ]
    if (range) args.push(range)
    else if (sinceIso) args.push(`--since=${sinceIso}`)

    let raw: string
    try {
      raw = await g.raw(args)
    } catch (rangeErr) {
      // History rewritten: fall back to a bounded, date-windowed log.
      log.warn('range log failed, falling back to date window', {
        path: target.path,
        err: (rangeErr as Error).message
      })
      const fallback = args.filter((a) => a !== range)
      if (sinceIso) fallback.push(`--since=${sinceIso}`)
      raw = await g.raw(fallback)
    }

    out.newEvents = parseNumstatLog(raw).map(toRawEvent)
    return out
  } catch (err) {
    out.error = (err as Error).message
    log.debug('sync failed', { path: target.path, err: out.error })
    return out
  }
}

function toRawEvent(entry: GitLogEntry): RawGitEvent {
  return {
    hash: entry.hash,
    author: entry.author,
    date: entry.date,
    subject: entry.subject,
    files: entry.fileList.length,
    insertions: entry.insertions,
    deletions: entry.deletions,
    fileList: entry.fileList.slice(0, 50)
  }
}

/** Newest commit hash reachable from HEAD without walking history. */
export async function headHash(dir: string): Promise<string | null> {
  try {
    const g = gitFor(dir)
    if (!(await g.checkIsRepo())) return null
    const hash = (await g.revparse(['HEAD'])).trim()
    return hash || null
  } catch {
    return null
  }
}

/** Typed helper kept for callers that prefer simple-git's own log shape. */
export async function logOnce(dir: string, limit = 20): Promise<Array<DefaultLogFields & ListLogLine>> {
  try {
    const res = await gitFor(dir).log({ maxCount: limit })
    // simple-git types `all` as readonly; the copy keeps the signature mutable
    // for callers that sort in place.
    return [...res.all]
  } catch {
    return []
  }
}
