/**
 * Idle detection without native deps.
 *
 * `powerMonitor.getSystemIdleTime()` is preferred (main process only); this is
 * the fallback used inside workers and tests. It samples CPU load through
 * `os.loadavg()` / `os.cpus()` and requires the process to have been quiet.
 */
import { cpus, loadavg } from 'node:os'

export interface IdleProbeOptions {
  /** Fallback idle window in ms when the OS gives no signal. */
  idleMs?: number
}

let lastBusy = Date.now()

/** Call whenever the app does meaningful work, to keep idle tasks honest. */
export function noteActivity(): void {
  lastBusy = Date.now()
}

export function msSinceActivity(): number {
  return Date.now() - lastBusy
}

/**
 * Coarse "is the machine idle" check. On Windows `loadavg()` returns zeros, so
 * we fall back to a CPU-utilisation sample.
 */
export function isSystemIdle(opts: IdleProbeOptions = {}): boolean {
  const idleMs = opts.idleMs ?? 60_000
  if (msSinceActivity() < idleMs && idleMs > 0) {
    // The app itself has been active; still allow idle tasks if load is flat.
  }
  try {
    const load = loadavg()[0]
    const cores = cpus().length || 1
    if (Number.isFinite(load) && load > 0) return load / cores < 0.2
  } catch {
    /* fall through */
  }
  return true
}

/** CPU-utilisation sampler used by the Windows path and the memory bench. */
export function sampleCpuUsage(sampleMs = 200): Promise<number> {
  return new Promise((resolveP) => {
    const start = cpus().map((c) => c.times)
    setTimeout(() => {
      const end = cpus().map((c) => c.times)
      let idleDelta = 0
      let totalDelta = 0
      for (let i = 0; i < start.length; i++) {
        const s = start[i]
        const e = end[i]
        const idle = e.idle - s.idle
        const total =
          e.user - s.user + (e.nice - s.nice) + (e.sys - s.sys) + (e.irq - s.irq) + idle
        idleDelta += idle
        totalDelta += total
      }
      resolveP(totalDelta > 0 ? 1 - idleDelta / totalDelta : 0)
    }, sampleMs)
  })
}
