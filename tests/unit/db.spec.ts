/**
 * §6 data model: schema, migrations, integrity recovery and the tree builder.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { closeDatabase, initDatabase, SCHEMA_VERSION, getUserVersion, type OpenResult } from '../../src/main/db'
import { repo } from '../../src/main/db/repo'
import { driverName } from '../../src/main/db/sqlite'
import { sandbox, type Sandbox } from './helpers'

let sb: Sandbox

/** Open a file-backed DB and keep the whole result (needs `recoveredFrom`). */
function initFile(rel = 'data.db'): OpenResult {
  return initDatabase({ path: join(sb.root, rel) })
}

beforeEach(() => {
  sb = sandbox()
})

afterEach(() => {
  closeDatabase()
  sb.dispose()
})

describe('schema (§6.1)', () => {
  it('creates every spec table', () => {
    const { db } = initFile()
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
    for (const t of ['roots', 'nodes', 'events', 'snapshots', 'git_cursors', 'icon_assets', 'settings', 'task_state']) {
      expect(names, `missing table ${t}`).toContain(t)
    }
    expect(getUserVersion(db)).toBe(SCHEMA_VERSION)
  })

  it('sets the pragmas the budget depends on', () => {
    const { db } = initFile()
    // `{simple: true}` is better-sqlite3's documented unwrap, and both drivers
    // must agree on it (see the pragma note in src/main/db/sqlite.ts).
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(1)
    expect(Number(db.pragma('synchronous', { simple: true }))).toBe(1) // NORMAL
  })

  it('reopens a healthy existing file without declaring it corrupt', () => {
    // Regression guard: `verifyOrRebuild` reads `PRAGMA integrity_check` as a ROW
    // ARRAY. A driver that unwrapped that pragma to the scalar `'ok'` made every
    // second launch park a perfectly good database as `<db>.corrupt-<ts>`.
    const path = join(sb.dir('appdata'), 'reopen.db')
    const first = initDatabase({ path })
    const check = first.db.pragma('integrity_check') as Array<{ integrity_check: string }>
    expect(Array.isArray(check), 'integrity_check must return a row array').toBe(true)
    expect(check[0]?.integrity_check).toBe('ok')
    closeDatabase()

    const second = initDatabase({ path })
    expect(second.recoveredFrom).toBeUndefined()
    expect(existsSync(path)).toBe(true)
    closeDatabase()
  })

  it('enforces one event per (node, source, ref) — §7.3 “second sync adds 0”', () => {
    initFile()
    const root = repo.addRoot(sb.dir('projects'))
    const id = repo.upsertNode({
      root_id: root.id,
      parent_id: null,
      name: 'p',
      path: sb.dir('projects/p'),
      kind: 'project'
    })
    const event = {
      node_id: id,
      source: 'git' as const,
      ref: 'abcdef1234567890',
      message: 'fix: thing',
      author: 'dev',
      occurred_at: 1_700_000_000_000,
      file_count: 2,
      insertions: 10,
      deletions: 3,
      files_json: JSON.stringify(['+ a.ts', '~ b.ts'])
    }
    expect(repo.insertEvents([event])).toBe(1)
    expect(repo.insertEvents([event])).toBe(0)
    expect(repo.counts().events).toBe(1)
    // A NULL ref (fs/manual events) is exempt from the uniqueness rule.
    repo.insertEvents([{ ...event, ref: null, source: 'fs', message: 'a' }])
    repo.insertEvents([{ ...event, ref: null, source: 'fs', message: 'b' }])
    expect(repo.counts().events).toBe(3)
  })

  it('cascades deletes from a root down to events and snapshots', () => {
    initFile()
    const projects = sb.dir('projects')
    const root = repo.addRoot(projects)
    const id = repo.upsertNode({
      root_id: root.id,
      parent_id: null,
      name: 'p',
      path: join(projects, 'p'),
      kind: 'project'
    })
    repo.insertEvents([{ node_id: id, source: 'git', ref: 'a', message: 'm', author: 'x', occurred_at: 1 }])
    repo.putSnapshotEntry(id, 'src/a.ts', 1, 2)
    expect(repo.counts().events).toBe(1)
    repo.removeRoot(root.id)
    expect(repo.counts().nodes).toBe(0)
    expect(repo.counts().events).toBe(0)
    expect(repo.snapshots(id)).toEqual([])
  })

  it('recovers from a corrupted file instead of crashing (§14.1)', () => {
    const path = join(sb.root, 'data.db')
    writeFileSync(path, 'this is definitely not sqlite')
    const res = initFile()
    expect(res.db).toBeTruthy()
    expect(res.db.prepare('SELECT 1 AS c').get()).toEqual({ c: 1 })
    expect(repo.counts().nodes).toBe(0)
    // The unusable file was parked, not silently reused.
    expect(res.recoveredFrom).toBeTruthy()
    expect(existsSync(res.recoveredFrom!)).toBe(true)
    expect(readdirSync(sb.root).some((f) => f.startsWith('data.db.corrupt'))).toBe(true)
  })
})

describe('tree building (§6.2 / §7.4)', () => {
  beforeEach(() => {
    initFile()
  })

  const seed = (): void => {
    const root = repo.addRoot(sb.dir('projects'))
    const a = repo.upsertNode({
      root_id: root.id,
      parent_id: null,
      name: 'a',
      path: sb.dir('projects/a'),
      kind: 'project',
      sort_order: 1
    })
    const b = repo.upsertNode({
      root_id: root.id,
      parent_id: null,
      name: 'b',
      path: sb.dir('projects/b'),
      kind: 'project',
      sort_order: 0
    })
    const g = repo.createGroup('分组', null)
    repo.upsertNode({ root_id: root.id, parent_id: g, name: 'c', path: sb.dir('projects/c'), kind: 'folder' })
    expect([a, b, g].every((n) => n > 0)).toBe(true)
  }

  it('nests by parent_id and sorts by (sort_order, name)', () => {
    seed()
    const forest = repo.tree()
    expect(forest.map((n) => n.name)).toEqual(['b', 'a', '分组'])
    expect(forest.find((n) => n.name === '分组')!.children!.map((n) => n.name)).toEqual(['c'])
  })

  it('listNodes is flat, tree() is nested', () => {
    seed()
    expect(repo.listNodes().length).toBe(4)
    expect(repo.tree().length).toBe(3)
  })

  it('moveNode re-parents and re-indexes siblings', () => {
    seed()
    const folder = repo.listNodes().find((n) => n.name === 'c')!
    const group = repo.listNodes().find((n) => n.kind === 'group')!
    repo.moveNode(folder.id, group.id, 0)
    expect(repo.getNode(folder.id)!.parent_id).toBe(group.id)
  })

  it('refuses to move a node beneath its own descendant', () => {
    const outer = repo.createGroup('outer', null)
    const inner = repo.createGroup('inner', outer)
    expect(() => repo.moveNode(outer, inner, 0)).toThrow(/descendant/i)
    expect(() => repo.moveNode(outer, outer, 0)).toThrow()
  })

  it('descendantIds walks the whole subtree', () => {
    seed()
    const group = repo.listNodes().find((n) => n.kind === 'group')!
    const ids = repo.descendantIds(group.id)
    expect(ids).toContain(group.id)
    expect(ids.length).toBe(2)
  })

  it('marks missing paths without deleting the annotation', () => {
    seed()
    const node = repo.listNodes().find((n) => n.name === 'a')!
    repo.setIdentity(node.id, '别名', 'emoji', '🚀')
    repo.markMissing(node.id, true)
    const after = repo.getNode(node.id)!
    expect(after.path_missing).toBe(1)
    expect(after.display_name).toBe('别名')
    expect(after.icon_value).toBe('🚀')
  })
})

describe('sqlite driver', () => {
  it('reports which driver is in use', () => {
    expect(['better-sqlite3', 'node:sqlite']).toContain(driverName)
  })
})
