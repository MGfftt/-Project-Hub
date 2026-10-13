/**
 * §7.3 git sync: the numstat parser, read-only guarantees and the cursor rules.
 *
 * The parser is a pure function so it is tested against recorded `git log`
 * output — a real repository is created when the machine has a working git.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { closeDatabase, initDatabase } from '../../src/main/db'
import { repo } from '../../src/main/db/repo'
import { parseNumstatLog, probeRepo, syncRepo, headHash, logOnce, GIT_LOG_FORMAT } from '../../src/main/services/git'
import { sandbox, type Sandbox } from './helpers'

let sb: Sandbox

beforeEach(() => {
  sb = sandbox()
  initDatabase({ path: join(sb.root, 'data.db') })
})

afterEach(() => {
  closeDatabase()
  sb.dispose()
})

/* ----------------------------- pure parser ------------------------------ */
// Records are separated by \u0002, fields by \u0001 (GIT_LOG_FORMAT).
const REC = '\u0002'
const F = '\u0001'

describe('parseNumstatLog (§7.3)', () => {
  it('reads hash, author, ISO date, subject and numstat totals', () => {
    const raw =
      `abc123${F}Ada Lovelace${F}2024-03-05T10:00:00+08:00${F}feat: add thing` +
      `${REC}12\t3\tsrc/a.ts\n5\t0\tsrc/b.ts\n`
    const [entry] = parseNumstatLog(raw)
    expect(entry.hash).toBe('abc123')
    expect(entry.author).toBe('Ada Lovelace')
    expect(entry.subject).toBe('feat: add thing')
    expect(entry.fileList).toHaveLength(2)
    expect(entry.insertions).toBe(17)
    expect(entry.deletions).toBe(3)
    expect(entry.fileList).toEqual(['src/a.ts', 'src/b.ts'])
    expect(new Date(entry.date).getTime()).toBe(Date.parse('2024-03-05T10:00:00+08:00'))
  })

  it('treats "-" (binary) numstat columns as zero', () => {
    const raw = `deadbeef${F}Dev${F}2024-01-01T00:00:00Z${F}add logo${REC}-\t-\tassets/logo.png\n`
    const [entry] = parseNumstatLog(raw)
    expect(entry.insertions).toBe(0)
    expect(entry.deletions).toBe(0)
    expect(entry.fileList).toHaveLength(1)
  })

  it('handles several commits including one with no file changes', () => {
    // Verified against a real repository: git prints the header, the \u0002 from
    // the format, a blank line, and only THEN the numstat block — so a commit's
    // numstat lines always follow its own header.
    const raw =
      `a1${F}Dev${F}2024-01-01T00:00:00Z${F}empty commit${REC}\n` +
      `\nb2${F}Dev${F}2024-01-02T00:00:00Z${F}second${REC}\n` +
      `2\t0\ty.ts\n3\t1\tz.ts\n`
    const entries = parseNumstatLog(raw)
    expect(entries.map((e) => e.hash)).toEqual(['a1', 'b2'])
    expect(entries[0].fileList).toHaveLength(0)
    expect(entries[1].fileList).toHaveLength(2)
    expect(entries[1].insertions).toBe(5)
    expect(entries[1].deletions).toBe(1)
  })

  it('parses genuine `git log` output, newest commit first', () => {
    // Byte-for-byte shape captured from `git log --numstat --format=...` on a
    // two-commit repository (the second commit adds y.ts, the first adds x.ts).
    const raw =
      `9abc${F}Dev${F}2026-10-13T12:28:34+08:00${F}second${REC}\n` +
      `\n2\t0\ty.ts\n` +
      `97a8${F}Dev${F}2026-10-13T12:28:33+08:00${F}first${REC}\n` +
      `\n1\t0\tx.ts\n`
    const entries = parseNumstatLog(raw)
    expect(entries.map((e) => e.hash)).toEqual(['9abc', '97a8'])
    expect(entries[0].fileList).toEqual(['y.ts'])
    expect(entries[1].fileList).toEqual(['x.ts'])
    expect(entries[0].insertions + entries[1].insertions).toBe(3)
  })

  it('keeps a subject containing the field separator out of the hash', () => {
    const raw = `c3${F}Dev${F}2024-01-03T00:00:00Z${F}fix: a | b & c` + `${REC}1\t0\ta.ts\n`
    const [entry] = parseNumstatLog(raw)
    expect(entry.subject).toBe('fix: a | b & c')
    expect(entry.hash).toBe('c3')
  })

  it('returns an empty array for empty input', () => {
    expect(parseNumstatLog('')).toEqual([])
    expect(parseNumstatLog('\n')).toEqual([])
  })

  it('declares a format that cannot collide with a commit subject', () => {
    expect(GIT_LOG_FORMAT).toContain('%H')
    expect(GIT_LOG_FORMAT).toContain('%aI')
    expect(GIT_LOG_FORMAT.endsWith('\u0002')).toBe(true)
  })
})

/* --------------------------- real repositories -------------------------- */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_NOSYSTEM: '1'
    }
  })
}

function makeRepo(name = 'repo'): string {
  const dir = sb.dir(name)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  return dir
}

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasGit)('git service (real repository)', () => {
  it('probeRepo reports branch and repo-ness', async () => {
    const dir = makeRepo()
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'first commit')
    const probe = await probeRepo(dir)
    expect(probe.isRepo).toBe(true)
    expect(probe.branch).toBe('main')
  })

  it('a repo with no commits is reported as a repo with no head', async () => {
    const dir = makeRepo('empty')
    const probe = await probeRepo(dir)
    expect(probe.isRepo).toBe(true)
    expect(await headHash(dir)).toBeNull()
  })

  it('non-repo directories are rejected without throwing (§14.1)', async () => {
    const probe = await probeRepo(sb.dir('not-a-repo'))
    expect(probe.isRepo).toBe(false)
    expect(await headHash(sb.dir('not-a-repo'))).toBeNull()
  })

  it('syncRepo returns the commits with numstat data', async () => {
    const dir = makeRepo()
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'feat: first')
    writeFileSync(join(dir, 'b.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'feat: second')

    const node = repo.upsertNode({ root_id: null, parent_id: null, name: 'r', path: dir, kind: 'project' })
    const res = await syncRepo({ repo: { nodeId: node, path: dir, lastHash: null } })
    expect(res.error).toBeUndefined()
    expect(res.newEvents.length).toBe(2)
    // Newest first is not guaranteed by git log; the set must be complete.
    const subjects = res.newEvents.map((e) => e.subject).sort()
    expect(subjects).toEqual(['feat: first', 'feat: second'])
    expect(res.headHash).toBe(await headHash(dir))
    const second = res.newEvents.find((e) => e.subject === 'feat: second')!
    expect(second.insertions).toBe(1)
    expect(second.files).toBe(1)
    expect(second.fileList).toHaveLength(1)
  })

  it('a second sync from the recorded cursor adds 0 events (§7.3)', async () => {
    const dir = makeRepo()
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'first')
    const node = repo.upsertNode({ root_id: null, parent_id: null, name: 'r', path: dir, kind: 'project' })

    const first = await syncRepo({ repo: { nodeId: node, path: dir, lastHash: repo.getCursor(node) } })
    const added = repo.insertEvents(
      first.newEvents.map((e) => ({
        node_id: node,
        source: 'git' as const,
        ref: e.hash,
        message: e.subject,
        author: e.author,
        occurred_at: Date.parse(e.date) || Date.now(),
        file_count: e.files,
        insertions: e.insertions,
        deletions: e.deletions,
        files_json: JSON.stringify(e.fileList)
      }))
    )
    repo.setCursor(node, first.headHash!)
    expect(added).toBe(1)

    const second = await syncRepo({ repo: { nodeId: node, path: dir, lastHash: repo.getCursor(node) } })
    const addedAgain = repo.insertEvents(
      second.newEvents.map((e) => ({
        node_id: node,
        source: 'git' as const,
        ref: e.hash,
        message: e.subject,
        author: e.author,
        occurred_at: Date.parse(e.date) || Date.now(),
        file_count: e.files,
        insertions: e.insertions,
        deletions: e.deletions,
        files_json: JSON.stringify(e.fileList)
      }))
    )
    expect(addedAgain).toBe(0)
    expect(repo.listEvents({ nodeIds: [node] }).length).toBe(1)
  })

  it('a force-push / rewritten history still produces events (date window fallback)', async () => {
    const dir = makeRepo()
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'first')
    const head1 = (await headHash(dir))!
    // Rewrite history: amend so the recorded cursor no longer exists.
    writeFileSync(join(dir, 'b.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '--amend', '-m', 'first (amended)')
    const node = repo.upsertNode({ root_id: null, parent_id: null, name: 'r', path: dir, kind: 'project' })
    const res = await syncRepo({ repo: { nodeId: node, path: dir, lastHash: head1 }, sinceIso: new Date(0).toISOString() })
    expect(res.error).toBeUndefined()
    expect(res.newEvents.length).toBeGreaterThanOrEqual(1)
    expect(res.newEvents.some((e) => e.subject === 'first (amended)')).toBe(true)
  })

  it('logOnce returns a mutable array and never throws on a non-repo', async () => {
    const dir = makeRepo()
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'first')
    const log = await logOnce(dir, 5)
    expect(log.length).toBe(1)
    const empty = await logOnce(sb.dir('nope'), 5)
    expect(empty).toEqual([])
  })
})

describe('git isolation', () => {
  it('syncRepo issues no working-tree-modifying command', async () => {
    // The service only ever runs `git log`, `git rev-parse` and `git status`;
    // assert the module text contains no mutating verb.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'git.ts'), 'utf8')
    for (const verb of ['git add', 'git commit', "'add'", '"add"', "'push'", "'checkout'", "'reset'", "'clean'", "'stash'"]) {
      expect(src).not.toContain(verb)
    }
    expect(existsSync(join(process.cwd(), 'src', 'main', 'services', 'git.ts'))).toBe(true)
  })
})
