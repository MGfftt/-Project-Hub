import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export function sha1(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex')
}

export function shortHash(input: string): string {
  return sha1(input).slice(0, 12)
}

/** Streaming hash for snapshot file comparison (only used on demand). */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolveP, reject) => {
    const h = createHash('sha1')
    const s = createReadStream(path)
    s.on('data', (c) => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolveP(h.digest('hex')))
  })
}

/** Deterministic string -> hue, used for tag colours (§9.2 rule 5). */
export function stringToHue(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) % 360
  }
  return h
}
