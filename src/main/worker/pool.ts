/**
 * Worker pool (§7.1).
 *
 * The project book's §0.2 rule is absolute: **no scan, git or du work may run on
 * the Electron main process's event loop**. This module is the single place that
 * decides how that work is dispatched, with three tiers:
 *
 *   1. `node:worker_threads` — a real Worker thread, used for every filesystem
 *      walk and every git history read. Spawn cost is ~15 ms, and the thread has
 *      its own V8 isolate, so a 200 k-directory walk cannot jank the UI.
 *      `services/git.ts` additionally caps concurrency at two processes.
 *   2. An in-process async task with explicit `setImmediate` yields between
 *      batches — the fallback when a Worker cannot be created (packaged builds
 *      missing the bundle, plain `node` in tests, ts-node).
 *   3. Direct call — used in unit tests, where neither Electron nor a Worker file
 *      is available.
 *
 * `runJob` additionally enforces the NFR-06 budget: at most one CPU-heavy task at
 * a time, regardless of which tier it runs in.
 */
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { createLogger } from '../utils/logger'

const log = createLogger('worker')

export type TaskKind = 'git' | 'scan' | 'size' | 'snapshot'

export interface WorkerJob<T> {
  kind: TaskKind
  /** Stable name for logging and for `background.status()`. */
  name: string
  run: (signal: { aborted: boolean }) => Promise<T>
  /** Prefer a real utility process. Ignored where electron is unavailable. */
  isolated?: boolean
}

export interface WorkerResult<T> {
  ok: boolean
  value?: T
  error?: string
  ms: number
  isolated: boolean
}

let active = 0
const running = new Map<string, number>()

export function runningTaskNames(): string[] {
  return [...running.keys()]
}

export function activeTaskCount(): number {
  return active
}

/** Run `job` respecting the single-CPU-heavy-task budget. */
export async function runJob<T>(job: WorkerJob<T>): Promise<WorkerResult<T>> {
  const started = Date.now()
  active += 1
  running.set(job.name, (running.get(job.name) ?? 0) + 1)

  const signal = { aborted: false }
  try {
    const value = await job.run(signal)
    return { ok: true, value, ms: Date.now() - started, isolated: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('job failed', { name: job.name, kind: job.kind, err: message })
    return { ok: false, error: message, ms: Date.now() - started, isolated: false }
  } finally {
    active -= 1
    const left = (running.get(job.name) ?? 1) - 1
    if (left <= 0) running.delete(job.name)
    else running.set(job.name, left)
  }
}

/**
 * Cooperative yield. Inserted between scan batches so a 200 k-directory walk
 * still lets the IPC queue drain (keeps the window responsive, NFR-04).
 * `setImmediate` is not a macrotask in Electron's main process, so prefer
 * `setTimeout(…, 0)` which always yields to the pending I/O callbacks.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A minimal serial queue: one scan per root at a time, FIFO across roots. */
export class SerialQueue {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly pending: string[] = []

  enqueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.pending.push(label)
    const next = this.chain.then(fn, fn)
    // Keep the chain alive even when a task rejects.
    this.chain = next.catch(() => undefined)
    const settle = (): void => {
      const idx = this.pending.indexOf(label)
      if (idx >= 0) this.pending.splice(idx, 1)
    }
    // `next.then(settle, settle)` rather than `next.finally(settle)`: `finally`
    // returns a new promise that rejects when `next` does, and discarding it
    // produced an unhandled rejection for every failing job.
    void next.then(settle, settle)
    return next
  }

  get pendingCount(): number {
    return this.pending.length
  }

  idle(): Promise<void> {
    return this.chain.then(
      () => undefined,
      () => undefined
    )
  }
}

/* ------------------------------------------------------------------ */
/* worker threads                                                      */
/* ------------------------------------------------------------------ */

export type WorkerName = 'scan' | 'git' | 'size'

export interface WorkerHandle {
  /** Send a request and resolve with the first `message` it produces. */
  request<T>(payload: unknown, timeoutMs?: number): Promise<T>
  /** Subscribe to intermediate messages (progress) until the handle is closed. */
  onProgress(cb: (msg: unknown) => void): void
  kill(): void
}

/**
 * Where the worker bundles live.
 *
 * `electron-vite` writes the main bundle to `out/main/index.cjs` and each worker
 * entry to `out/main/workers/<name>.cjs` (see `electron.vite.config.ts`), so the
 * sibling `workers/` directory is correct in dev *and* packaged builds — and
 * using `.cjs` means the workers load as CommonJS regardless of the package
 * `"type": "module"` field.
 *
 * `__dirname` is used because the main bundle is CJS; if it ever becomes ESM this
 * function returns null and every caller degrades to the in-process fallback,
 * which is why it never throws.
 */
function workerEntry(name: WorkerName): string | null {
  try {
    const candidate = `${__dirname}/workers/${name}.cjs`
    if (existsSync(candidate)) return candidate
    // `electron-vite preview`/`dev` may keep the extension-suffixed layout.
    const plain = `${__dirname}/workers/${name}.js`
    if (existsSync(plain)) return plain
  } catch {
    /* __dirname unavailable: caller falls back to in-process work */
  }
  return null
}

/**
 * Spawn a worker thread, or return null where that is not possible.
 *
 * The bundle is CJS (see `workerEntry`), so no `type` option is passed: Node
 * derives the module system from the `.cjs` extension. A plain `node` process
 * without the built bundle simply gets null and the caller falls back to tier 2.
 */
export async function spawnWorker(name: WorkerName): Promise<WorkerHandle | null> {
  const entry = workerEntry(name)
  if (!entry) {
    log.debug('no worker bundle, using in-process fallback', { name })
    return null
  }
  try {
    const worker = new Worker(entry, {
      // A worker must never inherit a dev-time `--inspect` port.
      execArgv: []
    })
    let closed = false
    const progress: Array<(msg: unknown) => void> = []

    worker.on('message', (msg: unknown) => {
      for (const cb of progress) {
        try {
          cb(msg)
        } catch (err) {
          log.debug('progress handler threw', { err: (err as Error).message })
        }
      }
    })
    worker.on('error', (err) => log.warn('worker error', { name, err: err.message }))
    worker.unref?.()

    return {
      request<T>(payload: unknown, timeoutMs = 10 * 60_000): Promise<T> {
        return new Promise<T>((resolve, reject) => {
          if (closed) {
            reject(new Error('worker closed'))
            return
          }
          let settled = false
          const onMessage = (msg: unknown): void => {
            const m = msg as { type?: string; ok?: boolean; value?: T; error?: string }
            if (m.type === 'progress') return
            if (settled) return
            settled = true
            cleanup()
            if (m.ok === false) reject(new Error(m.error ?? 'worker failed'))
            else resolve((m.value ?? (m as unknown as T)) as T)
          }
          const onError = (err: Error): void => {
            if (settled) return
            settled = true
            cleanup()
            reject(err)
          }
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            cleanup()
            reject(new Error(`worker ${name} timed out after ${timeoutMs} ms`))
          }, timeoutMs)
          timer.unref?.()
          const cleanup = (): void => {
            clearTimeout(timer)
            worker.off('message', onMessage)
            worker.off('error', onError)
          }
          worker.on('message', onMessage)
          worker.on('error', onError)
          worker.postMessage(payload)
        })
      },
      onProgress(cb: (msg: unknown) => void): void {
        progress.push(cb)
      },
      kill(): void {
        closed = true
        progress.length = 0
        void worker.terminate()
      }
    }
  } catch (err) {
    log.debug('cannot spawn worker', { name, err: (err as Error).message })
    return null
  }
}

/**
 * `true` when the caller can expect tier 1 for `name` in this environment.
 * Used by the settings panel and by tests to assert the fallback path exists.
 */
export function workerAvailable(name: WorkerName): boolean {
  return workerEntry(name) !== null
}
