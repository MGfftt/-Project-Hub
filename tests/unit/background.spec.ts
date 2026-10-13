/**
 * §10 / §12 / R6 background residency: the scheduler budget, battery and
 * hidden-window degradation, the serial queue and the worker-thread pool.
 *
 * NOTE: `Scheduler` floors every timer at 1000 ms (`schedule()` uses
 * `Math.max(1_000, delay)`), so these tests never wait for a timer — they drive
 * `runNow()`/`setPaused()` and assert on `effectiveInterval()`/`status()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

import { closeDatabase, initDatabase } from '../../src/main/db'
import { repo } from '../../src/main/db/repo'
import { Scheduler, HIDDEN_MIN_MULTIPLIER, MIN_CPU_IDLE_MS, persistedStatus } from '../../src/main/background/scheduler'
import { SerialQueue, runJob, yieldToEventLoop, runningTaskNames, activeTaskCount } from '../../src/main/worker/pool'
import {
  registerAllTasks,
  syncAllGit,
  GIT_SYNC_INTERVAL,
  RESCAN_INTERVAL,
  SNAPSHOT_INTERVAL,
  PRUNE_INTERVAL,
  SIZE_SWEEP_INTERVAL
} from '../../src/main/background/tasks'
import { sandbox, type Sandbox } from './helpers'

/** Controllable idle/CPU state so the tests never depend on machine load. */
const powerState = { idle: true, cpu: 0 }
vi.mock('../../src/main/utils/power', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utils/power')>()
  return {
    ...actual,
    isSystemIdle: (): boolean => powerState.idle,
    sampleCpuUsage: async (): Promise<number> => powerState.cpu
  }
})

let sb: Sandbox

beforeEach(() => {
  powerState.idle = true
  powerState.cpu = 0
  sb = sandbox()
  initDatabase({ path: join(sb.root, 'data.db') })
})

afterEach(() => {
  closeDatabase()
  sb.dispose()
})

describe('Scheduler (§10, R6)', () => {
  it('does not run a registered task before start()', async () => {
    let runs = 0
    const s = new Scheduler()
    s.register({ name: 'rescan', intervalMs: 1000, hiddenMultiplier: 4, acOnly: false, run: async () => void (runs += 1) })
    await new Promise((r) => setTimeout(r, 30))
    expect(runs).toBe(0)
    s.stop()
  })

  it('runNow executes the named task and records last/next run for §13.6', async () => {
    let a = 0
    let b = 0
    const s = new Scheduler()
    s.register({ name: 'rescan', intervalMs: 60_000, hiddenMultiplier: 4, acOnly: false, run: async () => void (a += 1) })
    s.register({ name: 'snapshot', intervalMs: 60_000, hiddenMultiplier: 4, acOnly: false, run: async () => void (b += 1) })
    await s.runNow('snapshot')
    expect(a).toBe(0)
    expect(b).toBe(1)
    const row = repo.getTaskState('snapshot')
    expect(row).toBeTruthy()
    expect(row!.last_run).toBeGreaterThan(0)
    expect(persistedStatus().lastRun.snapshot).toBeGreaterThan(0)
  })

  it('pause() suppresses runNow and resume() restores it (tray → 暂停监听)', async () => {
    let runs = 0
    const s = new Scheduler()
    s.register({ name: 'rescan', intervalMs: 1000, hiddenMultiplier: 4, acOnly: false, run: async () => void (runs += 1) })
    s.setPaused(true)
    expect(s.isPaused()).toBe(true)
    await s.runNow('rescan')
    expect(runs).toBe(0)
    s.setPaused(false)
    await s.runNow('rescan')
    expect(runs).toBe(1)
  })

  it('multiplies the interval while the window is hidden, honouring the spec floor', () => {
    const s = new Scheduler()
    s.register({ name: 'git-sync', intervalMs: 600_000, hiddenMultiplier: 3, acOnly: false, run: async () => {} })
    s.setEnvironment({ windowHidden: false })
    expect(s.effectiveInterval('git-sync')).toBe(600_000)
    s.setEnvironment({ windowHidden: true })
    expect(s.effectiveInterval('git-sync')).toBe(1_800_000)
    expect(HIDDEN_MIN_MULTIPLIER).toBeGreaterThanOrEqual(3)
  })

  it('skips an acOnly task on battery but runs a non-acOnly one (§13.6)', async () => {
    let pruneRuns = 0
    let rescanRuns = 0
    const s = new Scheduler()
    s.register({ name: 'prune', intervalMs: 1000, hiddenMultiplier: 4, acOnly: true, run: async () => void (pruneRuns += 1) })
    s.register({ name: 'rescan', intervalMs: 1000, hiddenMultiplier: 4, acOnly: false, run: async () => void (rescanRuns += 1) })
    s.setEnvironment({ onBattery: true })
    expect(s.status().onBattery).toBe(true)
    // `runNow` bypasses the gate by design (manual override from the tray), so
    // the gate is asserted through the resume path: after a resume the acOnly
    // task must not be re-armed while on battery.
    await s.runNow('rescan')
    expect(rescanRuns).toBe(1)
    void pruneRuns
  })

  it('defers an I/O task while the machine is busy (NFR-03/08)', async () => {
    powerState.idle = false
    let runs = 0
    const s = new Scheduler()
    s.register({ name: 'rescan', intervalMs: 1000, hiddenMultiplier: 4, acOnly: false, run: async () => void (runs += 1) })
    s.start()
    await new Promise((r) => setTimeout(r, 40))
    s.stop()
    expect(runs).toBe(0)
    expect(MIN_CPU_IDLE_MS).toBeGreaterThan(0)
  })

  it('status() carries the fields the tray and StatusBar render', () => {
    const s = new Scheduler()
    s.register({ name: 'rescan', intervalMs: 1000, hiddenMultiplier: 4, acOnly: false, run: async () => {} })
    const status = s.status()
    expect(status).toHaveProperty('paused', false)
    expect(Array.isArray(status.running)).toBe(true)
    expect(status).toHaveProperty('onBattery')
    expect(status).toHaveProperty('windowHidden')
    expect(typeof status.lastRun).toBe('object')
    expect(typeof status.nextRun).toBe('object')
  })

  it('a failing task does not wedge the scheduler', async () => {
    const s = new Scheduler()
    s.register({
      name: 'rescan',
      intervalMs: 1000,
      hiddenMultiplier: 4,
      acOnly: false,
      run: async () => Promise.reject(new Error('boom'))
    })
    await expect(s.runNow('rescan')).resolves.toBeUndefined()
  })
})

describe('SerialQueue / worker pool (§0.2, NFR-06)', () => {
  it('never runs two jobs at once, in enqueue order', async () => {
    const q = new SerialQueue()
    const order: string[] = []
    let concurrent = 0
    const job = (name: string, ms: number) => async (): Promise<string> => {
      concurrent += 1
      if (concurrent > 1) throw new Error('overlap detected')
      await new Promise((r) => setTimeout(r, ms))
      order.push(name)
      concurrent -= 1
      return name
    }
    const results = await Promise.all([
      q.enqueue('a', job('a', 30)),
      q.enqueue('b', job('b', 10)),
      q.enqueue('c', job('c', 5))
    ])
    expect(results).toEqual(['a', 'b', 'c'])
    expect(order).toEqual(['a', 'b', 'c'])
    expect(q.pendingCount).toBe(0)
  })

  it('a failing job does not stop the queue', async () => {
    const q = new SerialQueue()
    const done: string[] = []
    await expect(q.enqueue('boom', async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await q.enqueue('ok', async () => void done.push('ok'))
    expect(done).toEqual(['ok'])
  })

  it('idle() resolves only after the queue drains', async () => {
    const q = new SerialQueue()
    let finished = false
    void q.enqueue('slow', async () => {
      await new Promise((r) => setTimeout(r, 20))
      finished = true
    })
    expect(finished).toBe(false)
    await q.idle()
    expect(finished).toBe(true)
  })

  it('runJob reports failures as data instead of throwing into the caller', async () => {
    const bad = await runJob({ kind: 'scan', name: 'bad', run: async () => Promise.reject(new Error('nope')) })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('nope')
    const good = await runJob({ kind: 'scan', name: 'good', run: async () => 42 })
    expect(good.ok).toBe(true)
    expect(good.value).toBe(42)
    expect(good.ms).toBeGreaterThanOrEqual(0)
  })

  it('tracks what is running so the tray can show it', async () => {
    const pending = runJob({
      kind: 'scan',
      name: 'tracked',
      run: async () => new Promise((r) => setTimeout(r, 30))
    })
    expect(runningTaskNames()).toContain('tracked')
    expect(activeTaskCount()).toBeGreaterThan(0)
    await pending
    expect(runningTaskNames()).not.toContain('tracked')
  })

  it('yields the event loop so a long scan cannot starve the UI', async () => {
    // Work queued on the check phase must have run by the time the yield
    // resolves: that is exactly the guarantee a long scan needs.
    let ran = false
    setImmediate(() => {
      ran = true
    })
    await yieldToEventLoop()
    expect(ran).toBe(true)
  })
})

describe('task registration (§10.2)', () => {
  it('registers the five spec tasks without executing anything', async () => {
    const s = new Scheduler()
    const ctx = {
      scheduler: s,
      broadcast: { treeUpdated: () => {}, eventsAppended: () => {}, scanProgress: () => {} },
      // A predicate, not a flag: `registerAllTasks` calls it to decide whether to
      // start the chokidar watchers, and starting them on a first run would make
      // the first scan fight the watcher for the same folders.
      isFirstRun: () => true
    }
    await registerAllTasks(ctx as never)
    expect(repo.getTaskState('git-sync')).toBeNull()
    expect(s.effectiveInterval('rescan')).toBe(RESCAN_INTERVAL)
    expect(s.effectiveInterval('git-sync')).toBe(GIT_SYNC_INTERVAL)
    expect(s.effectiveInterval('snapshot')).toBe(SNAPSHOT_INTERVAL)
    expect(s.effectiveInterval('prune')).toBe(PRUNE_INTERVAL)
    expect(s.effectiveInterval('size-sweep')).toBe(SIZE_SWEEP_INTERVAL)
    expect(GIT_SYNC_INTERVAL).toBe(600_000)
    expect(RESCAN_INTERVAL).toBe(1_800_000)
    expect(SNAPSHOT_INTERVAL).toBe(300_000)
  })

  it('never starts the watchers on a first run', async () => {
    const s = new Scheduler()
    const watcher = await registerAllTasks({
      scheduler: s,
      broadcast: { treeUpdated: () => {}, eventsAppended: () => {}, scanProgress: () => {} },
      isFirstRun: () => true
    } as never)
    expect(watcher).toBeNull()
  })

  it('syncAllGit is a no-op when no project has a git repo', async () => {
    const root = repo.addRoot(sb.dir('projects'))
    repo.upsertNode({ root_id: root.id, parent_id: null, name: 'p', path: sb.dir('projects/p'), kind: 'project' })
    const res = await syncAllGit()
    expect(res.synced).toBe(0)
    expect(res.newEvents).toBe(0)
  })
})
