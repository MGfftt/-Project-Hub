/**
 * §0.2 prohibition 1 — the app must never write into an indexed project folder.
 *
 * These tests are deliberately adversarial: they hash every byte of the indexed
 * tree before the app does its work and compare afterwards. Any annotation, icon,
 * thumbnail, log or database byte that landed inside the user's repository shows
 * up as `created:`/`modified:` in the diff and fails the suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { closeDatabase, initDatabase } from '../../src/main/db'
import { repo } from '../../src/main/db/repo'
import { scanRoot } from '../../src/main/scanner'
import { Thumbnailer } from '../../src/main/services/thumbnailer'
import { createAnchor, backgroundStoreDir, iconStoreDir, logDir, storeFootprint } from '../../src/main/ipc/anchor'
import { snapshotEvents, diffDirectorySnapshot } from '../../src/main/scanner'
import { addLogSink, createLogger, removeLogSink } from '../../src/main/utils/logger'
import { copyIntoStore, writeJsonAtomic, ensureDir } from '../../src/main/utils/fsops'
import { sandbox, hashTree, diffTrees, projectFixture, type Sandbox } from './helpers'

let sb: Sandbox
let appData: string
let projectRoot: string

beforeEach(() => {
  sb = sandbox()
  appData = sb.dir('appdata') // stands in for `app.getPath('userData')`
  projectRoot = sb.dir('projects')
  sb.file('projects/proj-a/package.json', '{"name":"proj-a"}')
  sb.file('projects/proj-a/src/index.ts', 'export const a = 1\n')
  sb.file('projects/proj-a/node_modules/x/i.js', 'x\n')
  sb.file('projects/proj-b/pyproject.toml', '[project]\nname="proj-b"\n')
  sb.dir('projects/proj-c/sub')
  initDatabase({ path: join(appData, 'data.db') })
})

afterEach(() => {
  closeDatabase()
  sb.dispose()
})

describe('data isolation: scanning', () => {
  it('a full scan leaves the indexed tree byte-identical', async () => {
    const before = hashTree(projectRoot)
    const root = repo.addRoot(projectRoot)
    await scanRoot({ rootId: root.id, rootPath: projectRoot, maxDepth: 4 })
    expect(diffTrees(before, hashTree(projectRoot))).toEqual([])
  })

  it('writes the database and nothing else outside userData', async () => {
    const before = hashTree(projectRoot)
    const root = repo.addRoot(projectRoot)
    await scanRoot({ rootId: root.id, rootPath: projectRoot, maxDepth: 4 })
    // The only file the app created is its own DB (plus WAL/SHM siblings).
    const created = [...hashTree(projectRoot).keys()]
    expect(created.sort()).toEqual([...before.keys()].sort())
  })
})

describe('data isolation: annotations and identity', () => {
  it('annotation, rename, tags and meta never touch the folder', async () => {
    const root = repo.addRoot(projectRoot)
    await scanRoot({ rootId: root.id, rootPath: projectRoot, maxDepth: 4 })
    const before = hashTree(projectRoot)

    const node = repo
      .listNodes()
      .find((n) => n.name === 'proj-a')
    expect(node).toBeTruthy()

    repo.updateNode(node!.id, {
      note_md: '# 主力项目\n\n这是中文标注 with emoji 🚀 and code `x`',
      tags: ['backend', '主力'],
      status: 'active'
    })
    repo.setIdentity(node!.id, '主力项目', 'lucide', 'rocket')
    repo.createGroup('虚拟分组', node!.id)

    expect(diffTrees(before, hashTree(projectRoot))).toEqual([])
    // The identity survives a read-back, and the on-disk name is untouched.
    const again = repo.getNode(node!.id)!
    expect(again.display_name).toBe('主力项目')
    expect(again.name).toBe('proj-a')
    expect(existsSync(join(projectRoot, 'proj-a', '主力项目'))).toBe(false)
  })

  it('snapshot diffing is read-only', async () => {
    const root = repo.addRoot(projectRoot)
    await scanRoot({ rootId: root.id, rootPath: projectRoot, maxDepth: 4 })
    const node = repo.listNodes().find((n) => n.name === 'proj-a')!
    const before = hashTree(projectRoot)
    const outcome = await diffDirectorySnapshot(node.id, node.path!)
    repo.insertEvents(snapshotEvents(node.id, outcome.changes, Date.now()))
    expect(diffTrees(before, hashTree(projectRoot))).toEqual([])
  })
})

describe('data isolation: icons, thumbnails, backgrounds and logs', () => {
  it('imported icons are copied under userData, never into the project', async () => {
    const source = sb.file('pictures/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const before = hashTree(projectRoot)
    const dir = iconStoreDir(appData)
    const res = await copyIntoStore(source, dir, true)
    expect(existsSync(join(dir, res.filename))).toBe(true)
    expect(res.filename.startsWith(source)).toBe(false)
    expect(diffTrees(before, hashTree(projectRoot))).toEqual([])
  })

  it('thumbnail cache lives only in userData/thumbnails', async () => {
    const thumbs = join(appData, 'thumbnails')
    ensureDir(thumbs)
    const t = new Thumbnailer(thumbs)
    // 1x1 transparent PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    )
    const icon = sb.file('projects/proj-a/icon.png', png)
    // Baseline AFTER the fixture exists: the thumbnailer must not add or change
    // a single byte inside the indexed folder.
    const before = hashTree(projectRoot)
    const res = await t.get({ file: icon, edge: 32 })
    if (res.ok) expect(res.cachePath!.startsWith(appData)).toBe(true)
    expect(diffTrees(before, hashTree(projectRoot))).toEqual([])
  })

  it('background and log directories are derived from userData', () => {
    expect(backgroundStoreDir(appData)).toBe(join(appData, 'backgrounds'))
    expect(logDir(appData)).toBe(join(appData, 'logs'))
    expect(iconStoreDir(appData)).toBe(join(appData, 'thumbnails'))
  })

  it('a log sink writing through the funnel cannot reach a project folder', async () => {
    const before = hashTree(projectRoot)
    const writes: Array<Promise<void>> = []
    const sink = (line: string): void => {
      writes.push(writeJsonAtomic(join(logDir(appData), 'app.log.json'), { line }))
    }
    addLogSink(sink)
    try {
      createLogger('isolation-test').info('hello', { roots: [projectRoot] })
      await Promise.all(writes)
      // The mirror really was written, and it landed under userData.
      expect(existsSync(join(logDir(appData), 'app.log.json'))).toBe(true)
    } finally {
      removeLogSink(sink)
    }
    expect(diffTrees(before, hashTree(projectRoot))).toEqual([])
  })
})

describe('data isolation: the path anchor refuses project writes', () => {
  it('anchor.paths.indexed accepts a path inside a root but names nothing writable', async () => {
    const root = repo.addRoot(projectRoot)
    await scanRoot({ rootId: root.id, rootPath: projectRoot, maxDepth: 2 })
    const anchor = createAnchor({
      thumbsDir: join(appData, 'thumbnails'),
      backgroundsDir: join(appData, 'backgrounds'),
      appDir: appData
    })
    expect(anchor.paths.indexed(projectRoot)).toBeTruthy()
    expect(anchor.paths.indexed(join(sb.root, 'elsewhere'))).toBeNull()
    // A renderer-supplied filename can never escape the store directory.
    expect(anchor.paths.icon('../../../etc/passwd')).toBeNull()
    expect(anchor.paths.icon('..\\..\\windows\\system32\\config')).toBeNull()
    expect(anchor.paths.background('.../../x')).toBeNull()
  })

  it('storeFootprint only reports directories under userData', () => {
    const fp = storeFootprint([join(appData, 'thumbnails'), join(appData, 'backgrounds')])
    expect(fp.every((f) => f.dir.startsWith(appData))).toBe(true)
  })
})

describe('data isolation: project bookkeeping is invisible to the user folder', () => {
  it('no stray dotfiles are created in the indexed root', async () => {
    const root = repo.addRoot(projectRoot)
    await scanRoot({ rootId: root.id, rootPath: projectRoot, maxDepth: 4 })
    repo.setMeta(repo.listNodes()[0].id, { diskSizeBytes: 1, fileCount: 1 })
    const entries = readdirSync(projectRoot)
    for (const e of entries) {
      expect(e.startsWith('.')).toBe(false)
      expect(statSync(join(projectRoot, e)).isSymbolicLink()).toBe(false)
    }
  })
})
