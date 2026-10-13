/**
 * Scan worker (§7.1, §0.2).
 *
 * Runs the filesystem walk in its own Worker thread so the main process event
 * loop — which owns the window, the tray and every IPC reply — never blocks.
 *
 * Contract (matches `ScanWorkerRequest` in `shared/types.ts` plus the reply
 * added for the pool):
 *   in : { type:'scan', rootId, rootPath, maxDepth, incremental, dbPath }
 *   out: { type:'progress', scanned, current }  (repeated)
 *        { type:'done', ok:true, value: ScanResult }
 *        { type:'done', ok:false, error: string }
 *
 * The worker owns its own SQLite connection to the *same* database file. WAL
 * mode lets both processes read freely, and the main process's `SerialQueue`
 * guarantees only one writer (the scanner) is ever active, so there is no write
 * contention by construction. The worker never opens any file except the
 * database path it was handed — the isolation rule of §8 holds here too.
 */
import { parentPort } from 'node:worker_threads'
import { initDatabase, closeDatabase } from '../db'
import { scanRoot } from '../scanner'
import type { ScanResult } from '../../shared/types'

interface ScanRequest {
  type: 'scan'
  rootId: number
  rootPath: string
  maxDepth: number
  incremental: boolean
  dbPath: string
}

const port = parentPort
if (!port) {
  // Imported as a plain module (tests, accidental main-process import): do
  // nothing rather than throw, so the fallback path stays available.
  process.exitCode = 0
} else {
  port.on('message', (raw: unknown) => {
    const msg = raw as ScanRequest
    if (msg?.type !== 'scan') return
    void run(msg)
  })
}

async function run(msg: ScanRequest): Promise<void> {
  const port = parentPort
  if (!port) return
  let lastSent = 0
  try {
    initDatabase({ path: msg.dbPath })
    const result: ScanResult = await scanRoot({
      rootId: msg.rootId,
      rootPath: msg.rootPath,
      maxDepth: msg.maxDepth,
      incremental: msg.incremental,
      onProgress: (p) => {
        // Throttle: at most one progress message every 100 ms. The renderer only
        // needs a moving counter (§8.4), and unthrottled posting from a 200 k
        // directory walk would itself become the bottleneck.
        const now = Date.now()
        if (now - lastSent < 100) return
        lastSent = now
        port.postMessage({ type: 'progress', rootId: p.rootId, scanned: p.scanned, current: p.current })
      }
    })
    port.postMessage({ type: 'done', ok: true, value: result })
  } catch (err) {
    port.postMessage({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    // Checkpoint the WAL so the main process sees the new rows immediately and
    // the -wal file does not grow while the app idles (NFR-04).
    try {
      closeDatabase()
    } catch {
      /* already closed */
    }
    port.close()
  }
}
