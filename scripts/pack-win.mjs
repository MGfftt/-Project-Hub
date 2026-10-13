#!/usr/bin/env node
/**
 * Windows packaging for hosts where electron-builder's sign stage cannot run.
 *
 * electron-builder stamps the icon and version strings in the same step that
 * prepares code signing, so on a machine that cannot unpack `winCodeSign`
 * (creating the two macOS dylib symlinks inside it needs Developer Mode or an
 * elevated shell) both the installer *and* the exe branding are lost. See
 * DECISIONS.md D-018.
 *
 * This script does the three steps that recover the full result:
 *
 *   1. `electron-builder --dir` with the sign stage disabled
 *   2. stamp the exe through app-builder's built-in rcedit
 *      (the same code path electron-builder uses on Windows — it needs no
 *      winCodeSign, which is why it still works here)
 *   3. `electron-builder --win nsis --prepackaged <dir>` so the installer is
 *      built from the already-stamped application
 *
 *   npm run build:win:nosign
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = '.builder.nosign.yml'
const OUT_DIR = 'release'
const APP_DIR = join(OUT_DIR, 'win-unpacked')

if (process.platform !== 'win32') {
  console.error('pack:win:nosign is Windows-only; use `npm run build:win` elsewhere.')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const productName = pkg.build?.productName ?? 'Project Hub'

/**
 * Every helper electron-builder shells out to (app-builder, rcedit, the code
 * signing tools) keeps its downloads in a cache under %LOCALAPPDATA%. On a host
 * that denies directory creation there — and on any locked-down machine — the
 * whole packaging step dies in a Go helper with a bare `Access is denied`.
 * `ELECTRON_BUILDER_CACHE` and `ELECTRON_CACHE` move those caches inside the
 * project, where writing is always allowed.
 */
const CACHE_ROOT = join(ROOT, '.cache')
const spawnEnv = {
  ...process.env,
  ELECTRON_BUILDER_CACHE: join(CACHE_ROOT, 'electron-builder'),
  ELECTRON_CACHE: join(CACHE_ROOT, 'electron'),
  electron_config_cache: join(CACHE_ROOT, 'electron')
}
mkdirSync(spawnEnv.ELECTRON_BUILDER_CACHE, { recursive: true })

/**
 * app-builder unpacks its helper archives by shelling out to `7za`, and it looks
 * for it on PATH. electron-builder depends on `7zip-bin`, which ships exactly
 * that binary, so expose it — otherwise a host without a system-wide 7-Zip
 * install fails with `exec: "7za": executable file not found in %PATH%`.
 */
const sevenZipDir = join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64')
if (existsSync(join(sevenZipDir, '7za.exe'))) {
  const path = `${sevenZipDir}${delimiter}${spawnEnv.PATH ?? ''}`
  spawnEnv.PATH = path
  spawnEnv.Path = path
}

/** Windows file versions need four parts: 2.0.0 -> 2.0.0.0 */
const winVersion = (v) => {
  const parts = String(v).split('.').filter((p) => /^\d+$/.test(p))
  while (parts.length < 4) parts.push('0')
  return parts.slice(0, 4).join('.')
}

const run = (label, command, args) => {
  console.log(`\n=== ${label} ===`)
  const res = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: false, env: spawnEnv })
  if (res.error) {
    console.error(`${label} failed to start: ${res.error.message}`)
    process.exit(1)
  }
  if (res.status !== 0) {
    console.error(`${label} exited with ${res.status}`)
    process.exit(res.status ?? 1)
  }
}

const electronBuilder = join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
const appBuilder = join(ROOT, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe')
for (const [what, p] of [
  ['electron-builder', electronBuilder],
  ['app-builder', appBuilder]
]) {
  if (!existsSync(p)) {
    console.error(`Cannot find ${what} at ${p}. Run \`npm install\` first.`)
    process.exit(1)
  }
}

// 1. Unpacked application, without the sign/rcedit stage.
//
// electron-builder would otherwise unpack Electron into a cache under
// %LOCALAPPDATA%, which can be unwritable. `npm install` already placed the same
// runtime in node_modules/electron/dist, so point electron-builder at it and the
// whole packaging step stays offline and needs no privileged directory.
const distArgs = []
const localDist = join(ROOT, 'node_modules', 'electron', 'dist')
const localZipCache = join(ROOT, '.cache', 'electron')
if (existsSync(join(localDist, 'electron.exe'))) {
  distArgs.push(`--config.electronDist=${localDist}`)
  console.log(`Using the Electron runtime already installed at ${localDist}`)
} else if (existsSync(localZipCache)) {
  const zip = readdirSync(localZipCache).find((f) => /^electron-v[\d.]+-win32-x64\.zip$/.test(f))
  if (zip) {
    distArgs.push(`--config.electronDist=${localZipCache}`)
    console.log(`Using the cached Electron archive ${zip}`)
  }
}

run('1/3 pack (no sign stage)', process.execPath, [
  electronBuilder,
  '--win',
  '--x64',
  '--dir',
  '--config',
  CONFIG,
  ...distArgs
])

const exe = join(ROOT, APP_DIR, `${productName}.exe`)
if (!existsSync(exe)) {
  console.error(`Expected ${exe} after packing.`)
  process.exit(1)
}

// 2. Stamp icon + version metadata. The argument list mirrors what
//    app-builder-lib/out/winPackager.js builds in `signAndEditResources`.
const icon = join(ROOT, 'build', 'icon.ico')
const rceditArgs = [
  exe,
  '--set-version-string', 'FileDescription', pkg.description ?? productName,
  '--set-version-string', 'ProductName', productName,
  '--set-version-string', 'CompanyName', pkg.author ?? '',
  '--set-version-string', 'LegalCopyright', 'Copyright (c) 2024 Project Hub Contributors',
  '--set-version-string', 'InternalName', productName,
  '--set-version-string', 'OriginalFilename', '',
  '--set-file-version', pkg.version,
  '--set-product-version', winVersion(pkg.version)
]
if (existsSync(icon)) {
  rceditArgs.push('--set-icon', icon)
} else {
  console.warn(`No ${icon} — run \`npm run make:icon\` for a custom icon.`)
}

/**
 * Find an `rcedit-x64.exe` that has already been unpacked by app-builder. The
 * winCodeSign archive contains two macOS dylib symlinks; extracting them needs
 * the symlink privilege, so on a host without Developer Mode 7za reports an
 * error — but it still unpacks everything else, rcedit included.
 */
const findRcedit = () => {
  const roots = [spawnEnv.ELECTRON_BUILDER_CACHE, join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache')]
  const walk = (dir, depth) => {
    if (depth > 4) return null
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (e.isFile() && /^rcedit(-x64)?\.exe$/i.test(e.name)) return join(dir, e.name)
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const hit = walk(join(dir, e.name), depth + 1)
        if (hit) return hit
      }
    }
    return null
  }
  for (const r of roots) {
    if (r && existsSync(r)) {
      const hit = walk(r, 0)
      if (hit) return hit
    }
  }
  return null
}

let rcedit = findRcedit()
if (!rcedit) {
  // Nothing cached yet: ask app-builder to fetch the archive. It may exit
  // non-zero purely because of the two symlinks, so the result is not fatal —
  // only the absence of rcedit afterwards is.
  console.log('Fetching the rcedit tool through app-builder…')
  spawnSync(appBuilder, ['rcedit', '--args', JSON.stringify(rceditArgs)], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env: spawnEnv
  })
  rcedit = findRcedit()
}
if (!rcedit) {
  console.error(
    'Could not obtain rcedit. Run `npm run build:win` once on an unrestricted machine, or set\n' +
      'HTTP_PROXY/HTTPS_PROXY if the download is being blocked by a firewall.'
  )
  process.exit(1)
}

run('2/3 stamp exe', rcedit, rceditArgs)

// 3. Installer, built from the stamped directory so nothing is re-packed.
run('3/3 build installer', process.execPath, [
  electronBuilder,
  '--win',
  'nsis',
  '--x64',
  '--prepackaged',
  APP_DIR,
  '--config',
  CONFIG
])

console.log(`\nDone. Installer and unpacked app are in ${resolve(ROOT, OUT_DIR)}`)
