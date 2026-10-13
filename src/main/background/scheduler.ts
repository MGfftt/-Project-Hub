/**
 * Background task scheduler (§7.3, §7.5).
 *
 * Responsibilities
 * ----------------
 * - Own every scheduled job: incremental rescan, git sync, snapshot refresh,
 *   the nightly prune, and the low-frequency size sweep.
 * - Respect the user's pause switch, battery state and window visibility: when
 *   the window is hidden the interval is stretched (not stopped), when on
 *   battery all I/O-heavy jobs are paused (FR-5.5).
 * - Persist `last_run` / `next_run` into `task_state` so the settings panel can
 *   show real numbers after a restart.
 *
 * Every job is a `WorkerJob` executed through `runJob`, so the concurrency budget
 * (one CPU-heavy task at a time) is enforced centrally instead of per job.
 */
import { repo } from '../db/repo'
import type { BackgroundStatus } from '../../shared/types'
import { createLogger } from '../utils/logger'
import { runJob, runningTaskNames } from '../worker/pool'
import { isSystemIdle, sampleCpuUsage } from '../utils/power'

const log = createLogger('scheduler')

export type TaskName = 'rescan' | 'git-sync' | 'snapshot' | 'prune' | 'size-sweep'

export interface ScheduledTask {
  name: TaskName
  /** Base interval in ms when the window is visible and the app is on AC power. */
  intervalMs: number
  /** Multiplier applied while the window is hidden (NFR-06). */
  hiddenMultiplier: number
  /** Never run while on battery. */
  acOnly: boolean
  run: () => Promise<void>
}

export interface SchedulerHooks {
  onStatus?: (status: BackgroundStatus) => void
  isOnBattery?: () => boolean
  isWindowHidden?: () => boolean
}

/** A hidden window stretches every interval by at least this factor (§10). */
export const HIDDEN_MIN_MULTIPLIER = 3
/** How long a busy machine defers the next background tick. */
export const MIN_CPU_IDLE_MS = 2_000

export class Scheduler {
  private readonly tasks = new Map<TaskName, ScheduledTask>()
  private readonly timers = new Map<TaskName, NodeJS.Timeout>()
  private paused = false
  private stopped = false
  private lastRun: Record<string, number> = {}
  private nextRun: Record<string, number> = {}
  private battery = false
  private hidden = false

  constructor(private readonly hooks: SchedulerHooks = {}) {}

  register(task: ScheduledTask): void {
    this.tasks.set(task.name, task)
  }

  /** Arm every registered task. Called once from `app.whenReady`. */
  start(): void {
    this.stopped = false
    for (const name of this.tasks.keys()) {
      this.schedule(name, this.baseInterval(name))
    }
    log.info('scheduler started', { tasks: [...this.tasks.keys()] })
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    log.info('scheduler pause changed', { paused })
    if (paused) {
      for (const timer of this.timers.values()) clearTimeout(timer)
      this.timers.clear()
    } else {
      for (const name of this.tasks.keys()) this.schedule(name, 5_000)
    }
    this.emitStatus()
  }

  isPaused(): boolean {
    return this.paused
  }

  setEnvironment(env: { onBattery?: boolean; windowHidden?: boolean }): void {
    const batteryChanged = env.onBattery !== undefined && env.onBattery !== this.battery
    const hiddenChanged = env.windowHidden !== undefined && env.windowHidden !== this.hidden
    if (env.onBattery !== undefined) this.battery = env.onBattery
    if (env.windowHidden !== undefined) this.hidden = env.windowHidden
    if (batteryChanged || hiddenChanged) {
      log.debug('scheduler environment', { battery: this.battery, hidden: this.hidden })
      // Re-arm with the new effective interval.
      for (const name of this.tasks.keys()) {
        const existing = this.timers.get(name)
        if (existing) clearTimeout(existing)
        this.timers.delete(name)
        this.schedule(name, 1_000)
      }
    }
    this.emitStatus()
  }

  status(): BackgroundStatus {
    return {
      paused: this.paused,
      running: runningTaskNames(),
      lastRun: { ...this.lastRun },
      nextRun: { ...this.nextRun },
      onBattery: this.battery,
      windowHidden: this.hidden
    }
  }

  /** Run one task right now (used by the tray menu and by tests). */
  async runNow(name: TaskName): Promise<void> {
    const task = this.tasks.get(name)
    if (!task) return
    if (this.paused) {
      log.debug('runNow ignored while paused', { name })
      return
    }
    await this.execute(task)
  }

  /** Exposed for tests: effective interval for a task under current conditions. */
  effectiveInterval(name: TaskName): number {
    return this.baseInterval(name)
  }

  /* ---------------------------------------------------------------- */

  private baseInterval(name: TaskName): number {
    const task = this.tasks.get(name)
    if (!task) return 0
    return this.hidden ? Math.round(task.intervalMs * Math.max(task.hiddenMultiplier, HIDDEN_MIN_MULTIPLIER)) : task.intervalMs
  }

  private schedule(name: TaskName, delayMs: number): void {
    if (this.stopped) return
    const existing = this.timers.get(name)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      void this.tick(name)
    }, Math.max(1_000, delayMs))
    // Do not keep the process alive purely for a timer.
    timer.unref?.()
    this.timers.set(name, timer)
    this.nextRun[name] = Date.now() + Math.max(1_000, delayMs)
    repo.setTaskState(name, this.lastRun[name] ?? null, this.nextRun[name])
    this.emitStatus()
  }

  private async tick(name: TaskName): Promise<void> {
    const task = this.tasks.get(name)
    if (!task || this.stopped) return

    if (this.paused || (task.acOnly && this.battery)) {
      this.schedule(name, this.baseInterval(name))
      return
    }

    // Idle gate: never start an I/O-heavy job while the machine is visibly busy
    // (the user is compiling, gaming or rendering). Re-check in a minute.
    if (!isSystemIdle()) {
      this.schedule(name, 60_000)
      return
    }

    await this.execute(task)
    this.schedule(name, this.baseInterval(name))
  }

  private async execute(task: ScheduledTask): Promise<void> {
    // Cheap guard against a hot CPU from another process.
    try {
      const usage = await sampleCpuUsage(120)
      if (usage > 0.85) {
        log.debug('cpu busy, deferring task', { name: task.name, usage })
        await new Promise((r) => setTimeout(r, MIN_CPU_IDLE_MS))
      }
    } catch {
      /* sampler unavailable */
    }

    const result = await runJob<void>({
      kind: task.name === 'git-sync' ? 'git' : task.name === 'snapshot' ? 'snapshot' : 'scan',
      name: `scheduler:${task.name}`,
      run: () => task.run()
    })
    if (result.ok) {
      this.lastRun[task.name] = Date.now()
      repo.setTaskState(task.name, this.lastRun[task.name], this.nextRun[task.name] ?? null)
    }
    this.emitStatus()
  }

  private emitStatus(): void {
    this.hooks.onStatus?.(this.status())
  }
}

/** Read the persisted task table back into a status object (before `start`). */
export function persistedStatus(): { lastRun: Record<string, number>; nextRun: Record<string, number> } {
  const lastRun: Record<string, number> = {}
  const nextRun: Record<string, number> = {}
  for (const row of repo.allTaskStates()) {
    if (row.last_run !== null) lastRun[row.task] = row.last_run
    if (row.next_run !== null) nextRun[row.task] = row.next_run
  }
  return { lastRun, nextRun }
}
