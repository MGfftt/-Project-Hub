/**
 * Repairs source files that survived a UTF-8 -> GBK -> UTF-8 round trip.
 *
 * Symptom: Chinese text renders as rare ideographs (for example 绔嬪嵆鍚屾
 * instead of 立即同步) and a bare 搂 appears where § was meant. The bytes are
 * valid UTF-8, so a UTF-8 validator cannot see the damage — the file must be
 * re-encoded as GBK and re-decoded as UTF-8 to get the original text back.
 *
 * Usage:
 *   node scripts/fix-mojibake.mjs            # report only
 *   node scripts/fix-mojibake.mjs --write    # repair in place
 *   node scripts/fix-mojibake.mjs --write src/main
 *
 * Exit code 1 when damaged files remain (so it can gate a build), 0 otherwise.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const WRITE = process.argv.includes('--write')
const ROOTS = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const TARGETS = ROOTS.length > 0 ? ROOTS : ['src', 'tests', 'scripts', 'docs']
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.md', '.html', '.json', '.yml', '.yaml'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.npm-cache', '.cache', 'out', 'dist', 'release', '.vite'])

/** Rare ideographs that normal Chinese prose does not use. */
const RARE = /[\u9000-\u9fff]/
/** Two consecutive rare ideographs is already conclusive. */
const RARE_RUN = /[\u9000-\u9fff]{2,}/
/** 搂 leaks from § (0xC2 0xA7 read as GBK). Built from its code point so this
 *  script contains no mojibake character of its own. */
const SECTION_LEAK = new RegExp(String.fromCharCode(0x6402), 'g')

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out)
    } else {
      const dot = entry.name.lastIndexOf('.')
      if (dot > 0 && EXTENSIONS.has(entry.name.slice(dot))) out.push(full)
    }
  }
  return out
}

/** UTF-8 text -> the bytes a GBK writer would have produced for those characters. */
function textToGbkBytes(text) {
  const out = []
  for (const ch of text) {
    const hex = encodeGbkChar(ch)
    if (hex === null) return null
    out.push(hex)
  }
  return Uint8Array.from(out)
}

// Built lazily from the decoder so the table cannot drift from the platform's.
let GBK_TABLE = null
function encodeGbkChar(ch) {
  if (GBK_TABLE === null) GBK_TABLE = buildGbkTable()
  const hit = GBK_TABLE.get(ch)
  return hit === undefined ? null : hit
}

function buildGbkTable() {
  const table = new Map()
  const decoder = new TextDecoder('gbk', { fatal: false })
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue
      const text = decoder.decode(Uint8Array.from([lead, trail]))
      if (text.length !== 1 || text === '\ufffd') continue
      if (!table.has(text)) table.set(text, [lead, trail])
    }
  }
  for (let byte = 0x20; byte <= 0x7e; byte += 1) table.set(String.fromCharCode(byte), [byte])
  return table
}

/** Attempt to recover the original UTF-8 text; null when the repair is not clean. */
function repair(text) {
  const bytes = textToGbkBytes(text)
  if (bytes === null) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Whole-file repair first; when a file mixes damaged and healthy text (so the
 * whole-text GBK round trip cannot succeed) fix it one line at a time, which is
 * safe because damage never spans a line break.
 */
function repairFile(text) {
  const whole = repair(text)
  if (whole !== null) return { text: whole, mode: 'whole' }
  const lines = text.split('\n')
  let changed = false
  const out = lines.map((line) => {
    if (!RARE.test(line) && !SECTION_LEAK.test(line)) return line
    const fixed = repair(line)
    if (fixed === null || fixed === line) return line
    changed = true
    return fixed
  })
  return changed ? { text: out.join('\n'), mode: 'line' } : null
}

const files = []
for (const target of TARGETS) {
  const abs = resolve(target)
  try {
    if (statSync(abs).isDirectory()) files.push(...walk(abs))
    else files.push(abs)
  } catch {
    /* missing target: ignore */
  }
}

const damaged = []
const repaired = []
const manual = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (!RARE.test(text) && !SECTION_LEAK.test(text)) continue
  const score = (text.match(RARE_RUN) ?? []).length + (text.match(SECTION_LEAK) ?? []).length
  if (score === 0) continue
  damaged.push({ file, score })

  const fixed = repairFile(text)
  if (fixed === null) {
    manual.push({ file, score })
    continue
  }
  if (fixed.text !== text) {
    repaired.push({ file, score, mode: fixed.mode })
    if (WRITE) writeFileSync(file, fixed.text, 'utf8')
  }
}

const rel = (file) => relative(process.cwd(), file).replaceAll('\\', '/')

console.log(`${WRITE ? 'repair' : 'scan'}: ${files.length} files inspected`)
if (repaired.length > 0) {
  console.log(`${WRITE ? 'repaired' : 'repairable'}: ${repaired.length}`)
  for (const item of repaired) console.log(`  ${WRITE ? 'fixed  ' : 'can fix'} ${rel(item.file)}  (score ${item.score}, ${item.mode})`)
}
if (manual.length > 0) {
  console.log(`manual: ${manual.length}`)
  for (const item of manual) console.log(`  review ${rel(item.file)}  (score ${item.score})`)
}
if (damaged.length === 0) console.log('no mojibake found')

process.exitCode = manual.length > 0 ? 1 : 0
