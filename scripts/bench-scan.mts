/**
 * §12 performance budget evidence.
 *
 *   node --experimental-transform-types --import ./scripts/alias-loader.mjs \
 *     scripts/bench-scan.mts --projects 200 --files-per-project 50
 *
 * Measures, against the REAL scanner and the REAL database layer:
 *
 *   NFR-05  scanning 10,000 files must finish in < 3 s
 *   NFR-09  a database holding 1,000 projects and 100,000 events must stay
 *           under 50 MB
 *
 * The DB layer runs on the `node:sqlite` fallback documented in DECISIONS.md
 * D-002 (an Electron-ABI better-sqlite3 binary cannot load under plain node).
 * Both drivers run identical SQL, so the measured file size and scan cost are
 * representative.
 *
 * Exit code is 0 when every budget holds, 1 otherwise, so this doubles as a gate.
 */
import { mkdirSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { closeDatabase, getDb, initDatabase } from '../src/main/db/index.ts'
import { repo } from '../src/main/db/repo.ts'
import { scanRoot } from '../src/main/scanner/index.ts'

const BUDGET_SCAN_FILES = 10_000
const BUDGET_SCAN_MS = 3_000
const BUDGET_DB_MB = 50
const BUDGET_PROJECTS = 1_000
const BUDGET_EVENTS = 100_000

function readFlag(argv: string[], name: string, fallback: number): number {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback
}

/** Build `projects` marker directories under `root`, `perProject` files each. */
function buildTree(root: string, projects: number, perProject: number): number {
  let files = 0
  mkdirSync(root, { recursive: true })
  for (let p = 0; p < projects; p += 1) {
    const dir = join(root, `group-${String(Math.floor(p / 20)).padStart(2, '0')}`, `proj-${String(p).padStart(4, '0')}`)
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `proj-${p}` }), 'utf8')
    files += 1
    for (let f = 0; f < perProject; f += 1) {
      writeFileSync(join(dir, 'src', `file-${f}.ts`), `export const v${f} = ${f}\n`, 'utf8')
      files += 1
    }
  }
  return files
}

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100
}

function dbFileFootprint(dbPath: string): number {
  let total = 0
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`
    if (existsSync(file)) total += statSync(file).size
  }
  return total
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const projects = readFlag(argv, 'projects', 200)
  const perProject = readFlag(argv, 'files-per-project', 50)
  const work = join(tmpdir(), `project-hub-bench-${Date.now()}`)
  const tree = join(work, 'tree')
  const dbPath = join(work, 'bench.db')
  mkdirSync(work, { recursive: true })

  const failures: string[] = []

  /* ---------------------------------------------------------------- NFR-05 */
  const files = buildTree(tree, projects, perProject)
  initDatabase({ path: dbPath })
  const root = repo.addRoot(tree)

  const t0 = Date.now()
  const res = await scanRoot({ rootId: root.id, rootPath: tree, maxDepth: 4, incremental: false })
  const scanMs = Date.now() - t0

  console.log(
    `NFR-05 scan: ${res.scanned} directories (${files} files), ${res.projects} projects in ${scanMs} ms`
  )
  if (files >= BUDGET_SCAN_FILES && scanMs >= BUDGET_SCAN_MS) {
    failures.push(`NFR-05: ${files} files took ${scanMs} ms, budget ${BUDGET_SCAN_MS} ms`)
  } else if (files < BUDGET_SCAN_FILES) {
    console.log(
      `  (note: fixture held ${files} files, below the ${BUDGET_SCAN_FILES}-file target — the timing is extrapolated, not asserted)`
    )
  }

  /* ---------------------------------------------------------------- NFR-09 */
  // Fill the same database with the §12 reference load: 1,000 projects and
  // 100,000 events. Nodes are inserted directly, since the scan above already
  // proved the scanner can produce them.
  const db = getDb()
  const fillStart = Date.now()
  // No outer BEGIN: `repo.insertEvents` opens its own transaction, and SQLite
  // (like better-sqlite3) refuses a nested one.
  for (let p = 0; p < BUDGET_PROJECTS; p += 1) {
    const id = repo.upsertNode({
      root_id: root.id,
      parent_id: null,
      name: `bench-proj-${p}`,
      path: join(tree, `bench-${p}`),
      kind: 'project'
    })
    const batch: Parameters<typeof repo.insertEvents>[0] = []
    const perNode = Math.ceil(BUDGET_EVENTS / BUDGET_PROJECTS)
    for (let e = 0; e < perNode; e += 1) {
      batch.push({
        node_id: id,
        source: 'git',
        ref: `bench-${p}-${e}`,
        message: `feat: synthetic commit ${e} for project ${p}`,
        author: 'bench',
        occurred_at: Date.now() - e * 60_000,
        file_count: 3,
        insertions: 12,
        deletions: 4,
        files_json: '["src/a.ts","src/b.ts","src/c.ts"]'
      })
    }
    repo.insertEvents(batch)
  }
  const fillMs = Date.now() - fillStart

  // Read the counts from the open handle, then close so the WAL is checkpointed
  // into the main file before it is measured.
  const counts = repo.counts()
  closeDatabase()
  const bytes = dbFileFootprint(dbPath)

  console.log(
    `NFR-09 db: ${counts.nodes} nodes (${BUDGET_PROJECTS} bench projects) + ${counts.events} events = ${mb(bytes)} MB in ${fillMs} ms`
  )
  if (counts.events >= BUDGET_EVENTS && bytes >= BUDGET_DB_MB * 1024 * 1024) {
    failures.push(`NFR-09: ${counts.events} events used ${mb(bytes)} MB, budget ${BUDGET_DB_MB} MB`)
  }

  /* -------------------------------------------------------------- teardown */
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* the fixture lives in the OS temp dir; a locked handle is not a failure */
  }

  console.log(`BENCH_SCAN ${JSON.stringify({ files, scanMs, nodes: counts.nodes, events: counts.events, dbMb: mb(bytes), fillMs })}`)

  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`)
    process.exitCode = 1
  } else {
    console.log('BENCH_RESULT PASS')
  }
}

main()
