// Repair mojibake in project source files.
//
// Symptom: a file is valid ASCII/UTF-8 except for a few runs where Chinese text
// was written through the GBK (cp936) code page. Those bytes are not valid UTF-8
// and make the file unreadable by UTF-8 tooling.
//
// Fix: walk the bytes. Outside a bad run, copy through unchanged (ASCII and
// already-correct UTF-8 stay byte-identical). Inside a bad run, collect the
// maximal GBK-looking byte sequence and decode it as cp936, then emit UTF-8.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { TextDecoder } from 'node:util'

const ROOT = process.argv[2] || process.cwd()
const EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.md', '.html', '.json'])
const SKIP = new Set(['node_modules', '.git', '.npm-cache', '.cache', 'out', 'dist', 'release'])

const gbk = new TextDecoder('gbk', { fatal: false })
const utf8 = new TextDecoder('utf-8', { fatal: true })

function cont(b) {
  return b >= 0x80 && b <= 0xbf
}

/** Length of a valid UTF-8 sequence starting at i, or 0. */
function validSeq(b, i) {
  const c = b[i]
  if (c < 0x80) return 1
  if (c >= 0xc2 && c <= 0xdf && i + 1 < b.length && cont(b[i + 1])) return 2
  if (c >= 0xe0 && c <= 0xef && i + 2 < b.length && cont(b[i + 1]) && cont(b[i + 2])) return 3
  if (c >= 0xf0 && c <= 0xf4 && i + 3 < b.length && cont(b[i + 1]) && cont(b[i + 2]) && cont(b[i + 3])) return 4
  return 0
}

/** A byte that can begin or continue a GBK double-byte sequence. */
function gbkByte(b) {
  return b >= 0x81 && b <= 0xfe
}

function repair(buf) {
  const b = buf
  const out = []
  let i = 0
  let fixedRun = false
  while (i < b.length) {
    const n = validSeq(b, i)
    if (n > 0) {
      out.push(Buffer.from(b.subarray(i, i + n)))
      i += n
      continue
    }
    // Start of a bad run: swallow GBK lead+trail pairs until we hit something
    // that is plain ASCII or begins a valid UTF-8 sequence again.
    const start = i
    const bytes = []
    while (i < b.length) {
      if (b[i] < 0x80) {
        // ASCII punctuation emitted by the same code page (e.g. full-width
        // spaces) is fine to stop on.
        if (validSeq(b, i) > 0 && bytes.length === 0) break
        bytes.push(b[i])
        i += 1
        continue
      }
      if (gbkByte(b[i]) && i + 1 < b.length && gbkByte(b[i + 1])) {
        bytes.push(b[i], b[i + 1])
        i += 2
        continue
      }
      if (validSeq(b, i) > 0) break
      bytes.push(b[i])
      i += 1
    }
    if (i === start) {
      // Defensive: never loop forever.
      out.push(Buffer.from(b.subarray(i, i + 1)))
      i += 1
      continue
    }
    out.push(Buffer.from(gbk.decode(Uint8Array.from(bytes)), 'utf8'))
    fixedRun = true
  }
  return { buffer: Buffer.concat(out), fixedRun }
}

function walk(dir, hits) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') {
      if (SKIP.has(entry.name)) continue
    }
    if (SKIP.has(entry.name)) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(p, hits)
      continue
    }
    if (!entry.isFile()) continue
    if (!EXT.has(extname(entry.name))) continue
    const buf = readFileSync(p)
    try {
      utf8.decode(buf)
      continue // already valid UTF-8
    } catch {
      /* needs repair */
    }
    const { buffer, fixedRun } = repair(buf)
    if (!fixedRun) continue
    try {
      utf8.decode(buffer)
    } catch (err) {
      hits.push(`${relative(ROOT, p)}  UNREPAIRED (${err.message})`)
      continue
    }
    const before = buf.length
    const after = buffer.length
    writeFileSync(p, buffer)
    hits.push(`${relative(ROOT, p)}  repaired (${before} -> ${after} bytes)`)
  }
}

const hits = []
walk(ROOT, hits)
console.log(hits.length === 0 ? 'no mojibake found' : hits.join('\n'))
