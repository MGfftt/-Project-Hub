/**
 * §7.4 / §8.2 events: filtering, aggregation, the heatmap day bucketing and the
 * “second sync adds 0 events” guarantee at the repo level.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { closeDatabase, initDatabase } from '../../src/main/db'
import { repo } from '../../src/main/db/repo'
import { localDay } from '../../src/main/db/repo'
import { sandbox, type Sandbox } from './helpers'

let sb: Sandbox
let alpha: number
let beta: number
let group: number

beforeEach(() => {
  sb = sandbox()
  initDatabase({ path: join(sb.root, 'data.db') })
  const root = repo.addRoot(sb.dir('projects'))
  alpha = repo.upsertNode({
    root_id: root.id,
    parent_id: null,
    name: 'alpha',
    path: sb.dir('projects/alpha'),
    kind: 'project'
  })
  beta = repo.upsertNode({
    root_id: root.id,
    parent_id: null,
    name: 'beta',
    path: sb.dir('projects/beta'),
    kind: 'project'
  })
  group = repo.createGroup('分组', null)
})

afterEach(() => {
  closeDatabase()
  sb.dispose()
})

let seq = 0
function addEvent(
  node: number,
  opts: { source?: 'git' | 'fs' | 'manual'; at?: number; ins?: number; del?: number; ref?: string | null } = {}
): void {
  seq += 1
  repo.insertEvents([
    {
      node_id: node,
      source: opts.source ?? 'git',
      ref: opts.ref === undefined ? `ref-${seq}` : opts.ref,
      message: `change ${seq}`,
      author: 'dev',
      occurred_at: opts.at ?? 1_700_000_000_000 + seq * 1000,
      file_count: 1,
      insertions: opts.ins ?? 5,
      deletions: opts.del ?? 1,
      files_json: JSON.stringify(['~ src/a.ts'])
    }
  ])
}

describe('events repository', () => {
  it('lists newest first and honours the limit', () => {
    for (let i = 0; i < 10; i += 1) addEvent(alpha)
    const all = repo.listEvents({})
    expect(all.length).toBe(10)
    expect(all[0].occurred_at).toBeGreaterThan(all[9].occurred_at)
    expect(repo.listEvents({ limit: 3 }).length).toBe(3)
  })

  it('clamps an absurd limit to the memory-budget ceiling', () => {
    for (let i = 0; i < 5; i += 1) addEvent(alpha)
    expect(repo.listEvents({ limit: 10_000_000 }).length).toBe(5)
  })

  it('filters by node, by subtree and by source', () => {
    addEvent(alpha, { source: 'git' })
    addEvent(beta, { source: 'fs' })
    addEvent(group, { source: 'manual' })
    expect(repo.listEvents({ nodeIds: [alpha] }).length).toBe(1)
    expect(repo.listEvents({ nodeIds: [alpha, beta] }).length).toBe(2)
    expect(repo.listEvents({ sources: ['fs'] }).length).toBe(1)
    expect(repo.listEvents({ sources: ['git', 'manual'] }).length).toBe(2)
  })

  it('filters by time range', () => {
    addEvent(alpha, { at: 1000 })
    addEvent(alpha, { at: 5000 })
    addEvent(alpha, { at: 9000 })
    expect(repo.listEvents({ from: 2000, to: 6000 }).length).toBe(1)
    expect(repo.listEvents({ from: 2000 }).length).toBe(2)
    expect(repo.listEvents({ to: 6000 }).length).toBe(2)
  })

  it('parses files_json back into the wire shape', () => {
    addEvent(alpha)
    const ev = repo.listEvents({ nodeIds: [alpha] })[0]
    expect(Array.isArray(ev.files)).toBe(true)
    expect(ev.files[0]).toBe('~ src/a.ts')
  })

  it('aggregates stats per node and per subtree', () => {
    addEvent(alpha, { ins: 10, del: 2 })
    addEvent(alpha, { ins: 3, del: 1 })
    addEvent(beta, { ins: 7, del: 0 })
    const one = repo.eventStatsSingle(alpha)
    expect(one.count).toBe(2)
    expect(one.insertions).toBe(13)
    expect(one.deletions).toBe(3)
    const both = repo.eventStats([alpha, beta])
    expect(both.count).toBe(3)
    expect(both.insertions).toBe(20)
    expect(both.first).not.toBeNull()
    expect(both.last).not.toBeNull()
    expect(Number(both.first)).toBeLessThan(Number(both.last))
  })

  it('returns an empty aggregate rather than null for a node with no events', () => {
    const stats = repo.eventStatsSingle(alpha)
    expect(stats.count).toBe(0)
    expect(stats.insertions).toBe(0)
  })

  it('the same commit cannot be inserted twice — §7.3', () => {
    addEvent(alpha, { ref: 'deadbeef' })
    addEvent(alpha, { ref: 'deadbeef' })
    expect(repo.listEvents({ nodeIds: [alpha] }).length).toBe(1)
    // …but the same commit on a different node is a different event.
    addEvent(beta, { ref: 'deadbeef' })
    expect(repo.listEvents({ nodeIds: [beta] }).length).toBe(1)
  })

  it('tracks the per-node git cursor', () => {
    expect(repo.getCursor(alpha)).toBeNull()
    repo.setCursor(alpha, 'abc123')
    expect(repo.getCursor(alpha)).toBe('abc123')
    repo.setCursor(alpha, 'def456')
    expect(repo.getCursor(alpha)).toBe('def456')
  })
})

describe('heatmap day bucketing (§9.6)', () => {
  it('buckets by LOCAL day, not UTC', () => {
    // 2024-03-05T23:30 local — in UTC-5 this is 2024-03-06T04:30Z.
    const localLate = new Date(2024, 2, 5, 23, 30, 0).getTime()
    addEvent(alpha, { at: localLate })
    const counts = repo.dailyCounts(0, localLate + 1, [alpha])
    expect(counts.length).toBe(1)
    expect(counts[0].day).toBe('2024-03-05')
    expect(localDay(localLate)).toBe('2024-03-05')
  })

  it('sums insertions and deletions per day', () => {
    const day = new Date(2024, 2, 7, 12, 0, 0).getTime()
    addEvent(alpha, { at: day, ins: 4, del: 1 })
    addEvent(alpha, { at: day + 1000, ins: 6, del: 2 })
    const [bucket] = repo.dailyCounts(day - 1000, day + 2000, [alpha])
    expect(bucket.count).toBe(2)
    expect(bucket.insertions).toBe(10)
    expect(bucket.deletions).toBe(3)
  })

  it('returns one entry per non-empty day, ascending', () => {
    const d1 = new Date(2024, 0, 2, 9, 0, 0).getTime()
    const d2 = new Date(2024, 0, 4, 9, 0, 0).getTime()
    addEvent(alpha, { at: d2 })
    addEvent(alpha, { at: d1 })
    const days = repo.dailyCounts(0, d2 + 1000, [alpha]).map((c) => c.day)
    expect(days).toEqual(['2024-01-02', '2024-01-04'])
  })

  it('restricts the heatmap to the given subtree', () => {
    addEvent(alpha)
    addEvent(beta)
    const onlyAlpha = repo.dailyCounts(0, Date.now() + 1e7, [alpha])
    const total = onlyAlpha.reduce((n, c) => n + c.count, 0)
    expect(total).toBe(1)
  })
})

describe('search (§7.7)', () => {
  it('matches display name, name, path and tags, and ranks the display name first', () => {
    repo.setIdentity(alpha, '主力项目', 'auto', null)
    repo.updateNode(beta, { tags: ['主力'] })
    const hits = repo.searchNodes('主力')
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits[0].nodeId).toBe(alpha)
    expect(hits[0].matchedOn).toBe('display_name')
  })

  it('matches paths case-insensitively on Windows', () => {
    const hits = repo.searchNodes('ALPHA')
    expect(hits.some((h) => h.nodeId === alpha)).toBe(true)
  })

  it('returns an empty list for a query with no match', () => {
    expect(repo.searchNodes('zzzz-no-such-thing')).toEqual([])
  })

  it('caps the result set', () => {
    for (let i = 0; i < 40; i += 1) {
      repo.upsertNode({
        root_id: null,
        parent_id: null,
        name: `match-${i}`,
        path: null,
        kind: 'group'
      })
    }
    expect(repo.searchNodes('match', 10).length).toBe(10)
  })

  it('includes an annotation hit with a snippet', () => {
    repo.updateNode(alpha, { note_md: '这是一个非常重要的项目说明' } as never)
    const hits = repo.searchNodes('非常重要')
    expect(hits.some((h) => h.nodeId === alpha && h.matchedOn === 'note')).toBe(true)
  })
})

describe('settings and task state (§6.1)', () => {
  it('round-trips a setting and falls back to null', () => {
    expect(repo.getSetting('theme')).toBeNull()
    repo.setSetting('theme', 'dark')
    expect(repo.getSetting('theme')).toBe('dark')
    repo.setSetting('theme', 'light')
    expect(repo.getSetting('theme')).toBe('light')
    expect(repo.allSettings().theme).toBe('light')
  })

  it('persists scheduler bookkeeping for §13.6', () => {
    const next = Date.now() + 600_000
    repo.setTaskState('git-sync', Date.now(), next, { note: 'first' })
    const state = repo.getTaskState('git-sync')
    expect(state).toBeTruthy()
    expect(state!.next_run).toBe(next)
    expect(repo.allTaskStates().length).toBe(1)
  })
})

describe('export surface (§7.7)', () => {
  it('caps the export at the documented ceiling', () => {
    for (let i = 0; i < 12; i += 1) addEvent(alpha)
    expect(repo.listEventsForExport(5).length).toBe(5)
    expect(repo.listEventsForExport().length).toBe(12)
  })
})

describe('cleanup', () => {
  it('prunes snapshots whose node no longer exists', () => {
    repo.putSnapshotEntry(alpha, 'a.ts', 1, 1)
    repo.putSnapshotEntry(beta, 'b.ts', 1, 1)
    repo.deleteNode(beta)
    // `snapshots.node_id` is `ON DELETE CASCADE`, so deleting the node already
    // removed its rows: the guard finds no orphans and must report 0, while the
    // surviving node's snapshot stays untouched.
    expect(repo.snapshots(beta)).toEqual([])
    const removed = repo.pruneSnapshots()
    expect(removed).toBe(0)
    expect(repo.snapshots(alpha).length).toBe(1)
  })

  it('deleting a root also clears the snapshot rows of its nodes', () => {
    const root = repo.addRoot(sb.dir('projects'))
    const id = repo.upsertNode({
      root_id: root.id,
      parent_id: null,
      name: 'p',
      path: sb.dir('projects/p'),
      kind: 'project'
    })
    repo.putSnapshotEntry(id, 'x.ts', 1, 1)
    repo.removeRoot(root.id)
    expect(repo.snapshots(id)).toEqual([])
    rmSync(join(sb.root, 'projects'), { recursive: true, force: true })
  })
})
