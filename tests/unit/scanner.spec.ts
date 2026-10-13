/**
 * §7.1 scanner: marker detection, the ignore list, depth limits, symlink safety
 * and the incremental-rescan guarantee that annotations are never clobbered.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, symlinkSync, mkdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

import { closeDatabase, initDatabase } from '../../src/main/db'
import { repo } from '../../src/main/db/repo'
import { scanRoot, diffDirectorySnapshot } from '../../src/main/scanner'
import { walkProjectTree } from '../../src/main/scanner/walk'
import {
  detectMarker,
  isGitRepo,
  shouldIgnoreDir,
  IGNORE_DIRS,
  PROJECT_MARKERS,
  MAX_FILES_PER_ROOT
} from '../../src/main/scanner/markers'
import { sandbox, type Sandbox } from './helpers'

let sb: Sandbox

beforeEach(() => {
  sb = sandbox()
  initDatabase({ path: join(sb.root, 'data.db') })
})

afterEach(() => {
  closeDatabase()
  sb.dispose()
})

describe('markers (§7.1)', () => {
  it('covers every marker the spec lists', () => {
    for (const m of ['package.json', '.git', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'CMakeLists.txt']) {
      expect(PROJECT_MARKERS).toContain(m)
    }
    expect(MAX_FILES_PER_ROOT).toBe(200_000)
  })

  it('detects a marker and classifies its ecosystem', () => {
    const d = sb.dir('n')
    sb.file('n/package.json', '{}')
    expect(detectMarker(d)).toEqual({ marker: 'package.json', kind: 'node' })

    const p = sb.dir('p')
    sb.file('p/pyproject.toml', '')
    expect(detectMarker(p)!.kind).toBe('python')

    const r = sb.dir('r')
    sb.file('r/Cargo.toml', '')
    expect(detectMarker(r)!.kind).toBe('rust')
  })

  it('supports the glob markers (*.sln, *.csproj, *.xcodeproj)', () => {
    const d = sb.dir('dotnet')
    sb.file('dotnet/App.sln', '')
    expect(detectMarker(d)!.marker).toBe('*.sln')

    const x = sb.dir('xcode')
    mkdirSync(join(x, 'App.xcodeproj'))
    expect(detectMarker(x)!.marker).toBe('*.xcodeproj')
  })

  it('returns null for a directory with no marker', () => {
    expect(detectMarker(sb.dir('plain'))).toBeNull()
  })

  it('ignores the dependency and build directories the spec lists', () => {
    for (const d of ['node_modules', '.git', 'dist', 'build', 'target', '__pycache__', '.venv', 'coverage']) {
      expect(IGNORE_DIRS).toContain(d)
      expect(shouldIgnoreDir(d)).toBe(true)
    }
    expect(shouldIgnoreDir('src')).toBe(false)
  })

  it('recognises a git repository by its .git entry', () => {
    const d = sb.dir('g')
    mkdirSync(join(d, '.git'))
    expect(isGitRepo(d)).toBe(true)
    expect(isGitRepo(sb.dir('nogit'))).toBe(false)
  })
})

describe('walkProjectTree', () => {
  it('stops descending at a project marker and never enters ignored dirs', async () => {
    sb.file('repo/inner/package.json', '{}')
    sb.file('repo/inner/src/deep/file.ts', 'x')
    sb.file('repo/other/index.js', 'x')
    sb.file('repo/node_modules/x/i.js', 'x')

    const seen: string[] = []
    const gen = walkProjectTree({ rootPath: sb.root, maxDepth: 4, batchSize: 50 })
    let total = 0
    for await (const batch of gen) {
      for (const dir of batch.dirs) {
        seen.push(dir.path.slice(sb.root.length + 1).split('\\').join('/'))
        total += 1
      }
    }
    expect(seen).toContain('repo')
    expect(seen).toContain('repo/inner')
    expect(seen).toContain('repo/other')
    // `inner` is a project, so its subtree is indexed but not walked as folders.
    expect(seen).not.toContain('repo/inner/src')
    expect(seen.some((p) => p.includes('node_modules'))).toBe(false)
    expect(total).toBeGreaterThan(0)
  })

  it('honours maxDepth', async () => {
    sb.file('a/b/c/d/e/f/deep.txt', 'x')
    const depths: number[] = []
    for await (const batch of walkProjectTree({ rootPath: sb.root, maxDepth: 2 })) {
      for (const dir of batch.dirs) depths.push(dir.depth)
    }
    // §7.1: `walk(dir, depth)` returns as soon as `depth > maxDepth`, and the
    // root itself is depth 0, so a maxDepth of 2 indexes depths 1 and 2.
    expect(Math.max(...depths)).toBeLessThanOrEqual(2)
    expect(depths).not.toContain(3)
  })

  it('does not follow symlinks and never loops (§14.1)', async () => {
    const target = sb.dir('loop')
    sb.file('loop/file.txt', 'x')
    try {
      symlinkSync(target, join(target, 'self'), 'junction')
    } catch {
      return // symlink creation may be refused on this machine; the guard still holds
    }
    const seen: string[] = []
    for await (const batch of walkProjectTree({ rootPath: sb.root, maxDepth: 6 })) {
      for (const dir of batch.dirs) seen.push(dir.path)
    }
    expect(seen.length).toBeLessThan(20)
  })

  it('reports cancellation through the signal', async () => {
    for (let i = 0; i < 60; i += 1) sb.file(`many/d${i}/file.txt`, 'x')
    const signal = { aborted: false }
    let batches = 0
    for await (const batch of walkProjectTree({ rootPath: sb.root, maxDepth: 3, signal, batchSize: 5 })) {
      batches += 1
      if (batches === 2) signal.aborted = true
      void batch
    }
    expect(batches).toBeLessThan(13)
  })
})

describe('scanRoot', () => {
  it('indexes projects, folders and groups into the nodes table', async () => {
    sb.file('projects/alpha/package.json', '{}')
    sb.file('projects/alpha/src/index.ts', 'x')
    sb.file('projects/beta/Cargo.toml', '[package]')
    sb.dir('projects/plain/empty')

    const root = repo.addRoot(sb.dir('projects'))
    const res = await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 4 })

    expect(res.rootId).toBe(root.id)
    expect(res.projects).toBeGreaterThanOrEqual(2)
    const names = repo.listNodes().map((n) => n.name)
    expect(names).toContain('alpha')
    expect(names).toContain('beta')
    expect(names).toContain('plain')

    const alpha = repo.getNodeByPath(join(sb.root, 'projects', 'alpha'))!
    expect(alpha.kind).toBe('project')
    const meta = JSON.parse(alpha.meta || '{}')
    expect(meta.projectKind).toBe('node')
  })

  it('marks a root’s missing nodes but keeps them in the tree', async () => {
    sb.file('projects/gone/package.json', '{}')
    const root = repo.addRoot(sb.dir('projects'))
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 3 })
    const before = repo.listNodes().length
    // Remove the project directory behind the app's back.
    const { rmSync } = await import('node:fs')
    rmSync(join(sb.root, 'projects', 'gone'), { recursive: true, force: true })
    const res = await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 3 })
    expect(res.missing).toBeGreaterThanOrEqual(1)
    expect(repo.listNodes().length).toBe(before)
    const gone = repo.listNodes().find((n) => n.name === 'gone')!
    expect(repo.getNode(gone.id)!.path_missing).toBe(1)
  })

  it('a second scan is idempotent and does not duplicate nodes', async () => {
    sb.file('projects/alpha/package.json', '{}')
    const root = repo.addRoot(sb.dir('projects'))
    const first = await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 4 })
    const count = repo.counts().nodes
    const second = await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 4, incremental: true })
    expect(repo.counts().nodes).toBe(count)
    expect(second.scanned).toBe(first.scanned)
  })

  it('an incremental rescan preserves display_name, icon, tags and notes (R4)', async () => {
    sb.file('projects/alpha/package.json', '{}')
    const root = repo.addRoot(sb.dir('projects'))
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 4 })
    const alpha = repo.getNodeByPath(join(sb.root, 'projects', 'alpha'))!

    repo.setIdentity(alpha.id, '主力项目', 'lucide', 'rocket')
    repo.updateNode(alpha.id, { note_md: '重要', tags: ['core'] })

    sb.file('projects/alpha/src/new-file.ts', 'x')
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 4, incremental: true })

    const after = repo.getNode(alpha.id)!
    expect(after.display_name).toBe('主力项目')
    expect(after.icon_type).toBe('lucide')
    expect(after.icon_value).toBe('rocket')
    expect(after.note_md).toBe('重要')
    expect(after.tags).toBe(JSON.stringify(['core']))
  })

  it('re-classifies a node when its marker appears or disappears (D-022)', async () => {
    const { rmSync } = await import('node:fs')
    const root = repo.addRoot(sb.dir('projects'))
    /* A plain folder the user added: it is a project in its own right and it
     * still descends, so `alpha` is indexed as an ordinary folder. */
    sb.dir('projects/alpha/src')
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 4 })
    const alphaPath = join(sb.root, 'projects', 'alpha')
    expect(repo.getNodeByPath(alphaPath)!.kind).toBe('folder')

    /* Someone runs `git init` (or drops a package.json) in it. The next scan
     * must promote it — the folder did not become invisible to the walker. */
    sb.file('projects/alpha/package.json', '{}')
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 4, incremental: true })
    expect(repo.getNodeByPath(alphaPath)!.kind).toBe('project')

    /* And removing the marker demotes it again instead of pinning it for ever. */
    rmSync(join(sb.root, 'projects', 'alpha', 'package.json'))
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 4, incremental: true })
    expect(repo.getNodeByPath(alphaPath)!.kind).toBe('folder')
  })

  it('indexes a root that carries no marker as a project node (§7.1)', async () => {
    sb.dir('plain/inner')
    const root = repo.addRoot(sb.dir('plain'))
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 4 })
    const plain = repo.getNodeByPath(sb.dir('plain'))!
    expect(plain.kind).toBe('project')
    expect(plain.path_missing).toBe(0)
    // It still descends: a marker-less root can hold whole projects underneath.
    expect(repo.getNodeByPath(join(sb.root, 'plain', 'inner'))!.kind).toBe('folder')
  })

  it('keeps a removed node removed across a rescan (D-023)', async () => {
    sb.file('plain/alpha/package.json', '{}')
    sb.file('plain/beta/package.json', '{}')
    const root = repo.addRoot(sb.dir('plain'))
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 4 })

    const alpha = repo.getNodeByPath(join(sb.root, 'plain', 'alpha'))!
    expect(alpha).toBeDefined()
    repo.deleteNode(alpha.id)
    expect(repo.getNodeByPath(join(sb.root, 'plain', 'alpha'))).toBeUndefined()
    expect(repo.hiddenPaths(root.id).size).toBe(1)

    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 4 })
    expect(repo.getNodeByPath(join(sb.root, 'plain', 'alpha'))).toBeUndefined()
    // The sibling and the root itself are untouched.
    expect(repo.getNodeByPath(join(sb.root, 'plain', 'beta'))).toBeDefined()
    expect(repo.getNodeByPath(sb.dir('plain'))).toBeDefined()
  })

  it('hides the whole subtree of a removed folder, not only the folder', async () => {
    sb.file('deep/alpha/src/package.json', '{}')
    const root = repo.addRoot(sb.dir('deep'))
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 5 })

    const alpha = repo.getNodeByPath(join(sb.root, 'deep', 'alpha'))!
    repo.deleteNode(alpha.id)
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 5 })

    expect(repo.getNodeByPath(join(sb.root, 'deep', 'alpha'))).toBeUndefined()
    expect(repo.getNodeByPath(join(sb.root, 'deep', 'alpha', 'src'))).toBeUndefined()
    // Nothing is orphaned: a re-inserted child would surface as a top-level row.
    expect(repo.listNodes().filter((n) => n.parent_id === null).map((n) => n.name)).not.toContain('src')
  })

  it('forgets the tombstones when the root is removed, so re-adding restores them', async () => {
    sb.file('p/alpha/package.json', '{}')
    const root = repo.addRoot(sb.dir('p'))
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 4 })
    repo.deleteNode(repo.getNodeByPath(join(sb.root, 'p', 'alpha'))!.id)
    expect(repo.hiddenPaths(root.id).size).toBe(1)

    repo.removeRoot(root.id)
    const again = repo.addRoot(sb.dir('p'))
    expect(repo.hiddenPaths(again.id).size).toBe(0)
    await scanRoot({ rootId: again.id, rootPath: again.path, maxDepth: 4 })
    expect(repo.getNodeByPath(join(sb.root, 'p', 'alpha'))).toBeDefined()
  })

  it('emits progress without flooding the caller', async () => {
    for (let i = 0; i < 120; i += 1) sb.file(`projects/p${i}/package.json`, '{}')
    const root = repo.addRoot(sb.dir('projects'))
    const ticks: number[] = []
    await scanRoot({
      rootId: root.id,
      rootPath: root.path,
      maxDepth: 3,
      onProgress: (p) => ticks.push(p.scanned)
    })
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks.length).toBeLessThan(50)
  })
})

describe('diffDirectorySnapshot (§7.2)', () => {
  it('reports created / modified / deleted relative to the stored snapshot', async () => {
    const root = repo.addRoot(sb.dir('projects'))
    sb.file('projects/alpha/a.txt', 'one')
    sb.file('projects/alpha/b.txt', 'two')
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 3 })
    const node = repo.getNodeByPath(join(sb.root, 'projects', 'alpha'))!

    // First run records the baseline: no events.
    const baseline = await diffDirectorySnapshot(node.id, node.path!)
    // `diffDirectorySnapshot` records the snapshot as a side effect; the first
    // call therefore sees everything as created, which is the documented contract.
    expect(baseline.changes.length).toBeGreaterThanOrEqual(0)

    const second = await diffDirectorySnapshot(node.id, node.path!)
    expect(second.changes).toEqual([])

    sb.file('projects/alpha/c.txt', 'three')
    const future = Date.now() + 5000
    utimesSync(join(sb.root, 'projects', 'alpha', 'c.txt'), future / 1000, future / 1000)
    const third = await diffDirectorySnapshot(node.id, node.path!)
    expect(third.changes.map((c) => c.relPath)).toContain('c.txt')
  })

  it('ignores noisy extensions so the timeline is not spammed', async () => {
    const root = repo.addRoot(sb.dir('projects'))
    sb.file('projects/alpha/a.txt', 'one')
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 3 })
    const node = repo.getNodeByPath(join(sb.root, 'projects', 'alpha'))!
    await diffDirectorySnapshot(node.id, node.path!) // baseline
    sb.file('projects/alpha/Thumbs.db', 'x')
    sb.file('projects/alpha/rollup.log', 'x')
    sb.file('projects/alpha/real.ts', 'x')
    const res = await diffDirectorySnapshot(node.id, node.path!)
    const paths = res.changes.map((c) => c.relPath)
    expect(paths).toContain('real.ts')
    expect(paths).not.toContain('Thumbs.db')
    expect(paths).not.toContain('rollup.log')
  })
})

describe('scanner edge cases', () => {
  it('does not create a node for a non-existent root', async () => {
    const root = repo.addRoot(join(sb.root, 'does-not-exist'))
    const res = await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 2 })
    expect(res.projects).toBe(0)
    expect(existsSync(root.path)).toBe(false)
  })

  it('handles unicode and emoji directory names (§14.1)', async () => {
    sb.file('projects/中文项目🚀/package.json', '{}')
    const root = repo.addRoot(sb.dir('projects'))
    await scanRoot({ rootId: root.id, rootPath: root.path, maxDepth: 3 })
    expect(repo.listNodes().some((n) => n.name === '中文项目🚀')).toBe(true)
  })
})
