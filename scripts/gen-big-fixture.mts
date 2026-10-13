/**
 * Generate a synthetic project tree for the §12 performance budget.
 *
 *   node --experimental-transform-types --import ./scripts/alias-loader.mjs \
 *     scripts/gen-big-fixture.mts --projects 200 --files-per-project 50 --out .bench/tree
 *
 * NFR-05 asks for 10,000 files (200 x 50 by default). Each project looks like a
 * real Node project: a marker file the scanner recognises, a `src` tree, a
 * `node_modules` directory that must be skipped, and a `.git` directory.
 *
 * The generator is deliberately synchronous and boring — it is fixture data, not
 * part of the app.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

interface Args {
  projects: number
  filesPerProject: number
  out: string
  clean: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { projects: 200, filesPerProject: 50, out: '.bench/tree', clean: true }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const next = argv[i + 1]
    if (key === '--projects') args.projects = Number(next)
    else if (key === '--files-per-project') args.filesPerProject = Number(next)
    else if (key === '--out') args.out = String(next)
    else if (key === '--keep') args.clean = false
  }
  if (!Number.isFinite(args.projects) || args.projects <= 0) throw new Error('--projects must be > 0')
  if (!Number.isFinite(args.filesPerProject) || args.filesPerProject < 0) {
    throw new Error('--files-per-project must be >= 0')
  }
  return args
}

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8')
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const out = join(process.cwd(), args.out)

  if (args.clean && existsSync(out)) rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  let files = 0
  const started = Date.now()

  for (let p = 0; p < args.projects; p += 1) {
    const group = `group-${String(Math.floor(p / 20)).padStart(2, '0')}`
    const name = `proj-${String(p).padStart(4, '0')}`
    const dir = join(out, group, name)
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
    mkdirSync(join(dir, '.git'), { recursive: true })

    // The marker the scanner keys on (§7.1).
    write(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }, null, 2))
    files += 1

    // A file the scanner must never descend into.
    write(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = () => 0\n')
    files += 1

    for (let f = 0; f < args.filesPerProject; f += 1) {
      const bucket = `m${f % 8}`
      mkdirSync(join(dir, 'src', bucket), { recursive: true })
      write(
        join(dir, 'src', bucket, `file-${String(f).padStart(4, '0')}.ts`),
        `export const value_${f} = ${f}\n`
      )
      files += 1
    }
  }

  const ms = Date.now() - started
  console.log(
    `gen-big-fixture: ${args.projects} projects, ${files} files in ${ms} ms -> ${out}`
  )
  console.log(`BENCH_FIXTURE ${JSON.stringify({ projects: args.projects, files, ms, out })}`)
}

main()
