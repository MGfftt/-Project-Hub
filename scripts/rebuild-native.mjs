#!/usr/bin/env node
/**
 * scripts/rebuild-native.mjs — rebuild `better-sqlite3` against the Electron ABI.
 *
 * WHY THIS EXISTS (§0.1 least-surprise, D-016):
 *   A plain `npm install` fetches/builds `better-sqlite3` for the *Node* ABI, but
 *   the app only ever loads it from Electron. The two ABIs are mutually
 *   incompatible, and the `node:sqlite` fallback in src/main/db/sqlite.ts cannot
 *   cover the gap either — Electron 33 ships Node 20.18.3 and `node:sqlite` only
 *   exists from Node 22.5. A mismatched addon therefore makes the app die on
 *   startup with `Could not locate the bindings file`.
 *
 *   `electron-builder install-app-deps` is the usual answer, but it drives
 *   node-gyp and demands a full Visual Studio / Xcode toolchain. This script
 *   instead asks `better-sqlite3`'s own installer to fetch the *prebuilt*
 *   Electron binary, which needs no compiler. (Running install-app-deps on a
 *   machine without MSVC destroys the working prebuilt addon — D-016.)
 *
 * Exit status is always 0: a failing postinstall would abort `npm install`
 * entirely and leave the user with no dependencies at all. Failures are reported
 * loudly with the manual recovery command instead.
 *
 * Set PROJECT_HUB_SKIP_REBUILD=1 to opt out.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const out = (msg) => process.stdout.write(`[rebuild-native] ${msg}\n`)
const warn = (msg) => process.stderr.write(`[rebuild-native] ${msg}\n`)

const MANUAL = [
  '  npm rebuild better-sqlite3 --foreground-scripts',
  '',
  '  with these environment variables set:',
  '    npm_config_runtime=electron',
  '    npm_config_target=<the electron version from devDependencies>',
  '    npm_config_disturl=https://electronjs.org/headers',
  '    npm_config_build_from_source=false',
].join('\n')

if (process.env.PROJECT_HUB_SKIP_REBUILD === '1') {
  out('skipped (PROJECT_HUB_SKIP_REBUILD=1)')
  process.exit(0)
}

// `--ignore-scripts` installs, or an install that failed before electron landed,
// must not turn into a hard error here.
const electronPkg = join(root, 'node_modules', 'electron', 'package.json')
if (!existsSync(electronPkg)) {
  out('electron is not installed yet — skipping (run this again after npm install)')
  process.exit(0)
}

const addonPkg = join(root, 'node_modules', 'better-sqlite3', 'package.json')
if (!existsSync(addonPkg)) {
  out('better-sqlite3 is not installed yet — skipping')
  process.exit(0)
}

/** Resolve the Electron binary path the same way the app does. */
function electronBinary() {
  try {
    const p = require('electron')
    if (typeof p === 'string' && existsSync(p)) return p
  } catch {
    /* fall through to the conventional layout */
  }
  const rel =
    process.platform === 'win32'
      ? join('dist', 'electron.exe')
      : process.platform === 'darwin'
        ? join('dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : join('dist', 'electron')
  const fallback = join(root, 'node_modules', 'electron', rel)
  return existsSync(fallback) ? fallback : null
}

/** Ask Electron itself whether the addon loads — the only test that matters. */
function loadsUnderElectron(bin) {
  // `require('better-sqlite3')` alone is NOT a valid probe: it only pulls in the
  // JavaScript wrapper and succeeds even when no native addon exists at all.
  // The binding is loaded lazily, on the first `new Database(...)`.
  const probe = [
    'try {',
    "  const Database = require('better-sqlite3')",
    "  const db = new Database(':memory:')",
    "  db.prepare('select 1 as ok').get()",
    '  db.close()',
    '} catch (e) {',
    "  console.error('[rebuild-native] ' + String(e.message).split('\\n')[0])",
    '  process.exit(1)',
    '}',
  ].join('\n')
  const res = spawnSync(bin, ['-e', probe], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  })
  return res.status === 0
}

const electronVersion = JSON.parse(readFileSync(electronPkg, 'utf8')).version
const bin = electronBinary()

if (bin && loadsUnderElectron(bin)) {
  out(`better-sqlite3 already matches electron ${electronVersion} — nothing to do`)
  process.exit(0)
}

out(`rebuilding better-sqlite3 for electron ${electronVersion} (prebuilt binary, no compiler needed)`)

// `npm_config_*` is how better-sqlite3's own install script is told which runtime
// to fetch a prebuild for. npm 11 additionally prints `Unknown env config
// "runtime"` etc. for anything it does not itself recognise — harmless noise,
// since the values are consumed by prebuild-install, not by npm.
const env = {
  ...process.env,
  npm_config_runtime: 'electron',
  npm_config_target: electronVersion,
  npm_config_disturl: 'https://electronjs.org/headers',
  // Never fall back to node-gyp: a source build needs a full MSVC/Xcode
  // toolchain that most users do not have, and a failed build leaves a
  // half-written addon behind.
  npm_config_build_from_source: 'false',
}

const ARGS = ['rebuild', 'better-sqlite3', '--foreground-scripts', '--loglevel=error']
// A shell is needed for `npm.cmd` on Windows; the arguments are literals, so
// passing one command string avoids Node's DEP0190 (args + shell:true).
const res =
  process.platform === 'win32'
    ? spawnSync(`npm ${ARGS.join(' ')}`, { cwd: root, env, stdio: 'inherit', shell: true })
    : spawnSync('npm', ARGS, { cwd: root, env, stdio: 'inherit' })

if (res.status !== 0) {
  warn(`\n  ` + '='.repeat(68))
  warn('  better-sqlite3 was NOT rebuilt for Electron.')
  warn('  The app will fail to start until this is fixed. Run manually:')
  warn('')
  warn(MANUAL)
  warn('  ' + '='.repeat(68) + '\n')
  process.exit(0)
}

if (bin && !loadsUnderElectron(bin)) {
  warn(`\n  ` + '='.repeat(68))
  warn('  better-sqlite3 rebuilt, but Electron still cannot load it.')
  warn('  See DECISIONS.md D-016 and the README install section.')
  warn('  ' + '='.repeat(68) + '\n')
  process.exit(0)
}

out(`ok — better-sqlite3 now matches electron ${electronVersion}`)
