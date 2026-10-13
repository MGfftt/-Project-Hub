/**
 * Git worker (§7.1, §0.2).
 *
 * Reads commit history in a Worker thread: `git log` shells out, and shelling out
 * from the main process would freeze the UI for as long as git takes. The worker
 * performs read-only git commands only (see `services/git.ts`).
 *
 * Contract:
 *   in : { type:'sync', repos:[{ nodeId, path, lastHash, limit }], sinceIso? }
 *   out: { type:'progress', done, total, repo }
 *        { type:'done', ok:true, value: [{ nodeId, path, newEvents, headHash, error? }] }
 *        { type:'done', ok:false, error: string }
 *
 * The worker deliberately does NOT write to SQLite: it returns raw events and the
 * main process persists them. That keeps exactly one writer for the `events`
 * table, which is what makes §7.3's "a second sync adds 0 rows" guarantee hold
 * without cross-thread coordination.
 */
import { parentPort } from 'node:worker_threads'
import { syncRepo, type RepoSyncOutcome } from '../services/git'

interface GitRequest {
  type: 'sync'
  repos: Array<{ nodeId: number; path: string; lastHash: string | null; limit: number }>
  sinceIso?: string
}

const port = parentPort
if (!port) {
  process.exitCode = 0
} else {
  port.on('message', (raw: unknown) => {
    const msg = raw as GitRequest
    if (msg?.type !== 'sync') return
    void run(msg)
  })
}

const CONCURRENCY = 2 // NFR-06: at most two git processes app-wide.

async function run(msg: GitRequest): Promise<void> {
  const port = parentPort
  if (!port) return
  try {
    const out: RepoSyncOutcome[] = []
    const queue = [...msg.repos]
    let done = 0

    const worker = async (): Promise<void> => {
      for (;;) {
        const target = queue.shift()
        if (!target) return
        const outcome = await syncRepo({
          repo: { nodeId: target.nodeId, path: target.path, lastHash: target.lastHash },
          limit: target.limit,
          sinceIso: msg.sinceIso
        })
        out.push(outcome)
        done += 1
        port.postMessage({ type: 'progress', done, total: msg.repos.length, repo: target.path })
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, msg.repos.length) }, worker))
    port.postMessage({ type: 'done', ok: true, value: out })
  } catch (err) {
    port.postMessage({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    port.close()
  }
}
