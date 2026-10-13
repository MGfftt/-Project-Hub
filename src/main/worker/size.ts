/**
 * Size worker (§7.1, §0.2).
 *
 * `du`-style directory walking is the single most I/O-heavy thing this app can
 * do, so it runs in its own thread and is only ever started on demand (the node
 * properties drawer, or a manual "重新统计" in settings). The result is cached in
 * `nodes.meta` by the main process, so the second open of the same drawer is free.
 *
 * Contract:
 *   in : { type:'size', nodeId, path }
 *   out: { type:'done', ok:true, value:{ bytes, files, dirs } }
 *        { type:'done', ok:false, error: string }
 */
import { parentPort } from 'node:worker_threads'
import { directorySize } from '../utils/fsops'

interface SizeRequest {
  type: 'size'
  nodeId: number
  path: string
}

const port = parentPort
if (!port) {
  process.exitCode = 0
} else {
  port.on('message', (raw: unknown) => {
    const msg = raw as SizeRequest
    if (msg?.type !== 'size') return
    void run(msg)
  })
}

async function run(msg: SizeRequest): Promise<void> {
  const port = parentPort
  if (!port) return
  try {
    const result = await directorySize(msg.path, {
      // Skip the two directories that dominate size and are never interesting to
      // a project overview. Both are regenerable, which is exactly why the
      // budget (§12) says counting them is wasted I/O.
      maxEntries: 200_000,
      skip: (name) => name === 'node_modules' || name === '.git' || name === '__pycache__'
    })
    port.postMessage({
      type: 'done',
      ok: true,
      value: { nodeId: msg.nodeId, bytes: result.bytes, files: result.files, dirs: result.dirs }
    })
  } catch (err) {
    port.postMessage({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    port.close()
  }
}
