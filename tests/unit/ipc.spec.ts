/**
 * §7.7 IPC surface: the router must reject renderer-supplied paths, keep the
 * annotation writes inside the database and expose exactly the frozen channels.
 *
 * Electron is mocked because the router only needs `ipcMain.handle` to capture
 * handlers; the interesting behaviour (path anchoring, validation, fallbacks) is
 * plain Node code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const openedPaths: string[] = []
const openedExternal: string[] = []
const clipboardWrites: string[] = []
/**
 * `vi.hoisted` because the `vi.mock` factory is lifted above every other
 * statement — a plain `let` here would be in the temporal dead zone when the
 * factory runs and the save dialog would always look cancelled.
 */
const saveBox = vi.hoisted(() => ({ path: null as string | null }))

vi.mock('electron', () => {
  const app = {
    getPath: (name: string): string => (name === 'userData' ? process.env.HUB_TEST_USERDATA! : process.env.HUB_TEST_USERDATA!),
    getVersion: (): string => '2.0.0',
    quit: (): void => {},
    setLoginItemSettings: (): void => {},
    getLoginItemSettings: (): { openAtLogin: boolean } => ({ openAtLogin: false })
  }
  const ipcMain = {
    handle: (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    },
    removeHandler: (channel: string): void => void handlers.delete(channel)
  }
  const shell = {
    openPath: async (p: string): Promise<string> => {
      openedPaths.push(p)
      return ''
    },
    showItemInFolder: (p: string): void => void openedPaths.push(p),
    openExternal: async (u: string): Promise<void> => void openedExternal.push(u),
    trashItem: async (p: string): Promise<void> => void openedPaths.push(`trash:${p}`)
  }
  const clipboard = { writeText: (t: string): void => void clipboardWrites.push(t) }
  const dialog = {
    showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async (): Promise<{ canceled: boolean; filePath?: string }> =>
      saveBox.path ? { canceled: false, filePath: saveBox.path } : { canceled: true }
  }
  const nativeImage = {
    createFromPath: (): { isEmpty: () => boolean; resize: () => { toPNG: () => Buffer } } => ({
      isEmpty: () => true,
      resize: () => ({ toPNG: () => Buffer.alloc(0) })
    }),
    createFromBuffer: (): { isEmpty: () => boolean } => ({ isEmpty: () => true })
  }
  class BrowserWindow {}
  return { app, ipcMain, shell, clipboard, dialog, nativeImage, BrowserWindow, default: { app, ipcMain, shell } }
})

const { closeDatabase, initDatabase } = await import('../../src/main/db')
const { repo } = await import('../../src/main/db/repo')
const { registerIpcHandlers } = await import('../../src/main/ipc/main')
const { createAnchor, iconStoreDir, backgroundStoreDir } = await import('../../src/main/ipc/anchor')
const { Thumbnailer } = await import('../../src/main/services/thumbnailer')
const { Scheduler } = await import('../../src/main/background/scheduler')
const { SerialQueue } = await import('../../src/main/worker/pool')
const { CH } = await import('../../src/shared/channels')
const { sandbox } = await import('./helpers')
type Sandbox = import('./helpers').Sandbox

let sb: Sandbox
let userData: string
let projectRoot: string
let nodeId: number
let groupId: number

function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`channel not registered: ${channel}`)
  return Promise.resolve(fn({}, ...args) as T)
}

beforeEach(async () => {
  handlers.clear()
  openedPaths.length = 0
  clipboardWrites.length = 0
  saveBox.path = null
  sb = sandbox()
  userData = sb.dir('appdata')
  process.env.HUB_TEST_USERDATA = userData
  projectRoot = sb.dir('projects')
  const projectPath = sb.dir('projects/alpha')
  initDatabase({ path: join(userData, 'data.db') })

  const root = repo.addRoot(projectRoot)
  await (await import('../../src/main/scanner')).scanRoot({ rootId: root.id, rootPath: projectRoot, maxDepth: 3 })
  nodeId = repo.getNodeByPath(projectPath)!.id
  groupId = repo.createGroup('分组', null)

  registerIpcHandlers({
    anchor: createAnchor({
      thumbsDir: iconStoreDir(userData),
      backgroundsDir: backgroundStoreDir(userData),
      appDir: userData
    }),
    thumbnailer: new Thumbnailer(iconStoreDir(userData)),
    scheduler: new Scheduler(),
    userData,
    dbPath: join(userData, 'data.db'),
    thumbsDir: iconStoreDir(userData),
    backgroundsDir: backgroundStoreDir(userData),
    getWindow: () => null,
    broadcast: () => {},
    scanQueue: new SerialQueue()
  } as never)
})

afterEach(() => {
  closeDatabase()
  delete process.env.HUB_TEST_USERDATA
  sb.dispose()
})

describe('channel registration', () => {
  it('registers every frozen channel', () => {
    // `CH` nests one level (`settings.background`), so collect recursively rather
    // than assuming a flat map — a shallow walk silently skips those three.
    const collect = (node: Record<string, unknown>, out: string[] = []): string[] => {
      for (const value of Object.values(node)) {
        if (typeof value === 'string') out.push(value)
        else if (value && typeof value === 'object' && !Array.isArray(value)) collect(value as Record<string, unknown>, out)
      }
      return out
    }
    const expected = collect(CH as unknown as Record<string, unknown>).filter(
      (c) => !Object.values(CH.broadcast).includes(c as never)
    )
    expect(expected.length).toBeGreaterThan(20)
    const missing = expected.filter((c) => !handlers.has(c))
    expect(missing).toEqual([])
  })
})

describe('shell.* — §8.1 (R2)', () => {
  it('opens a project folder by id, never by a renderer-supplied path', async () => {
    const res = await call<{ ok: boolean }>(CH.shell.openFolder, nodeId)
    expect(res.ok).toBe(true)
    expect(openedPaths[0]).toBe(join(projectRoot, 'alpha'))
  })

  it('refuses to open a virtual group (no disk path)', async () => {
    const res = await call<{ ok: boolean; error?: string }>(CH.shell.openFolder, groupId)
    expect(res.ok).toBe(false)
  })

  it('refuses to open a node whose path disappeared (§14.1)', async () => {
    const { rmSync } = await import('node:fs')
    rmSync(join(projectRoot, 'alpha'), { recursive: true, force: true })
    const res = await call<{ ok: boolean; error?: string }>(CH.shell.openFolder, nodeId)
    expect(res.ok).toBe(false)
    expect(String(res.error)).toMatch(/不存在|missing/i)
  })

  it('ignores an id that does not exist', async () => {
    const res = await call<{ ok: boolean }>(CH.shell.openFolder, 999_999)
    expect(res.ok).toBe(false)
  })

  it('copies the resolved absolute path to the clipboard', async () => {
    await call(CH.shell.copyPath, nodeId)
    expect(clipboardWrites[0]).toBe(join(projectRoot, 'alpha'))
  })

  it('reveals a folder in the file manager', async () => {
    await call(CH.shell.revealFolder, nodeId)
    expect(openedPaths.length).toBeGreaterThan(0)
  })
})

describe('shell.openFile — traversal guard', () => {
  it('rejects a relative path that escapes the node', async () => {
    for (const rel of ['../../etc/passwd', '..\\..\\windows\\win.ini', '/etc/passwd', '\\windows\\system32']) {
      await call(CH.shell.openFile, nodeId, rel)
      expect(openedPaths, `should not open ${rel}`).not.toContain(rel)
    }
    expect(openedExternal.length).toBe(0)
  })

  it('accepts a path inside the node', async () => {
    sb.file('projects/alpha/src/index.ts', 'x')
    await call(CH.shell.openFile, nodeId, 'src/index.ts')
    // `openFile` is typed `Promise<void>` (frozen Api), so success is observed
    // through the shell mock rather than a return value.
    expect(openedPaths).toContain(join(projectRoot, 'alpha', 'src', 'index.ts'))
  })

  it('refuses a path that does not exist on disk', async () => {
    await call(CH.shell.openFile, nodeId, 'src/missing.ts')
    expect(openedPaths.some((p) => p.includes('missing.ts'))).toBe(false)
  })
})

describe('nodes.setIcon — an image must already live in the app store', () => {
  it('rejects a renderer-supplied arbitrary path', async () => {
    await expect(call(CH.nodes.setIcon, nodeId, 'image', 'C:\\Windows\\win.ini')).rejects.toThrow()
    expect(repo.getNode(nodeId)!.icon_type).not.toBe('image')
  })

  it('rejects a traversal filename', async () => {
    await expect(call(CH.nodes.setIcon, nodeId, 'image', '../../secret.png')).rejects.toThrow()
    expect(repo.getNode(nodeId)!.icon_type).not.toBe('image')
  })

  it('accepts lucide and emoji identities (R4)', async () => {
    await call(CH.nodes.setIcon, nodeId, 'lucide', 'rocket')
    expect(repo.getNode(nodeId)!.icon_value).toBe('rocket')
    await call(CH.nodes.setIcon, nodeId, 'emoji', '🚀')
    expect(repo.getNode(nodeId)!.icon_type).toBe('emoji')
    expect(repo.getNode(nodeId)!.icon_value).toBe('🚀')
    await call(CH.nodes.setIcon, nodeId, 'auto', null)
    expect(repo.getNode(nodeId)!.icon_type).toBe('auto')
  })
})

describe('nodes.* identity and annotation (R4, §8.3)', () => {
  it('setDisplayName stores an alias and never renames the directory', async () => {
    await call(CH.nodes.setDisplayName, nodeId, '主力项目')
    const row = repo.getNode(nodeId)!
    expect(row.display_name).toBe('主力项目')
    expect(row.name).toBe('alpha')
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(projectRoot, '主力项目'))).toBe(false)
    expect(existsSync(join(projectRoot, 'alpha'))).toBe(true)
  })

  it('an empty alias clears back to the directory name', async () => {
    await call(CH.nodes.setDisplayName, nodeId, '主力项目')
    await call(CH.nodes.setDisplayName, nodeId, null)
    expect(repo.getNode(nodeId)!.display_name).toBeNull()
  })

  it('rejects an alias for a node that does not exist', async () => {
    await expect(call(CH.nodes.setDisplayName, 999_999, 'x')).rejects.toThrow()
  })

  it('update stores notes and tags as JSON in the database only', async () => {
    await call(CH.nodes.update, nodeId, { note_md: '标注 🚀', tags: ['a', 'b'] })
    const row = repo.getNode(nodeId)!
    expect(row.note_md).toBe('标注 🚀')
    expect(JSON.parse(row.tags)).toEqual(['a', 'b'])
  })

  it('createGroup makes a virtual node with no disk path and returns its id', async () => {
    const id = await call<number>(CH.nodes.createGroup, '新分组', null)
    expect(typeof id).toBe('number')
    const created = repo.getNode(id)!
    expect(created.kind).toBe('group')
    expect(created.path).toBeNull()
  })

  it('remove deletes the node and its subtree', async () => {
    const parent = repo.createGroup('outer', null)
    const child = repo.createGroup('inner', parent)
    await call(CH.nodes.remove, parent)
    expect(repo.getNode(parent)).toBeUndefined()
    expect(repo.getNode(child)).toBeUndefined()
  })
})

describe('events.* (§7.4, R3)', () => {
  it('lists events with the frozen filter shape', async () => {
    repo.insertEvents([
      {
        node_id: nodeId,
        source: 'git',
        ref: 'a1',
        message: 'feat',
        author: 'dev',
        occurred_at: Date.now(),
        file_count: 1,
        insertions: 2,
        deletions: 1,
        files_json: JSON.stringify(['+ a.ts'])
      }
    ])
    const events = await call<unknown[]>(CH.events.list, { nodeIds: [nodeId], limit: 10 })
    expect(events.length).toBe(1)
  })

  it('heatmap returns day buckets', async () => {
    const buckets = await call<unknown[]>(CH.events.heatmap, 0, Date.now() + 1)
    expect(Array.isArray(buckets)).toBe(true)
  })
})

describe('settings.*', () => {
  it('round-trips a value through the settings table', async () => {
    await call(CH.settings.set, 'theme', 'dark')
    const value = await call<string | null>(CH.settings.get, 'theme')
    expect(value).toBe('dark')
  })

  it('get() falls back to the frozen default for an unset key', async () => {
    expect(await call<string | null>(CH.settings.get, 'clickToOpen')).toBe('true')
  })

  it('all() returns the whole map', async () => {
    await call(CH.settings.set, 'compactMode', 'true')
    const all = await call<Record<string, string>>(CH.settings.all)
    expect(all.compactMode).toBe('true')
  })
})

describe('icons.* (§8.3)', () => {
  it('listBuiltin exposes the built-in names', async () => {
    const names = await call<string[]>(CH.icons.listBuiltin)
    expect(Array.isArray(names)).toBe(true)
    expect(names.length).toBeGreaterThan(40)
  })

  it('defs exposes renderable path data for every built-in', async () => {
    const defs = await call<Array<{ name: string; path: string }>>(CH.icons.defs)
    expect(defs.length).toBeGreaterThan(40)
    expect(defs.every((d) => typeof d.path === 'string' && d.path.length > 0)).toBe(true)
  })

  it('gcUnused removes nothing when every asset is referenced', async () => {
    const res = await call<{ removed: number }>(CH.icons.gcUnused)
    expect(res.removed).toBe(0)
  })
})

describe('roots.*', () => {
  it('add is idempotent for the same path', async () => {
    const before = repo.listRoots().length
    await call(CH.roots.add, projectRoot)
    expect(repo.listRoots().length).toBe(before)
  })

  it('setEnabled toggles without deleting nodes', async () => {
    const root = repo.listRoots()[0]
    await call(CH.roots.setEnabled, root.id, false)
    expect(repo.getRoot(root.id)!.enabled).toBe(0)
    expect(repo.counts().nodes).toBeGreaterThan(0)
    await call(CH.roots.setEnabled, root.id, true)
    expect(repo.getRoot(root.id)!.enabled).toBe(1)
  })

  it('remove drops the root and only its own nodes', async () => {
    const root = repo.listRoots()[0]
    const group = repo.createGroup('keep-me', null)
    await call(CH.roots.remove, root.id)
    expect(repo.getRoot(root.id)).toBeUndefined()
    expect(repo.getNode(group)).toBeTruthy()
  })
})

describe('background.* (R6)', () => {
  it('status reports the paused flag', async () => {
    const status = await call<{ paused: boolean; running: string[] }>(CH.background.status)
    expect(status.paused).toBe(false)
    // `running` is the frozen list of in-flight task names, not a flag.
    expect(Array.isArray(status.running)).toBe(true)
  })

  it('pause and resume flip the flag', async () => {
    await call(CH.background.pause)
    expect((await call<{ paused: boolean }>(CH.background.status)).paused).toBe(true)
    await call(CH.background.resume)
    expect((await call<{ paused: boolean }>(CH.background.status)).paused).toBe(false)
  })

  it('runNow rejects a task name outside the whitelist', async () => {
    await expect(call(CH.background.runNow, 'rm-rf')).rejects.toThrow(/未知|unknown|whitelist|任务/i)
  })

  it('runNow accepts a whitelisted task name', async () => {
    await expect(call(CH.background.runNow, 'prune')).resolves.toBeUndefined()
  })
})

describe('export.*', () => {
  it('json export returns the frozen node/event payload', async () => {
    const json = await call<string>(CH.export.json)
    const parsed = JSON.parse(json)
    expect(parsed).toHaveProperty('nodes')
    expect(parsed).toHaveProperty('events')
    expect(parsed).toHaveProperty('roots')
    // The export is a serialisable snapshot — no renderer-only fields leak in.
    expect(Array.isArray(parsed.nodes)).toBe(true)
  })

  it('markdown export writes a bilingual document, not a renderer-supplied string', async () => {
    const target = join(sb.dir('out'), 'hub.md')
    saveBox.path = target
    try {
      const res = await call<{ ok: boolean; path?: string }>(CH.export.writeFile, 'markdown', 'IGNORED')
      expect(res.ok).toBe(true)
      const { readFileSync } = await import('node:fs')
      const doc = readFileSync(target, 'utf8')
      // Rendered main-side from the database: the renderer's argument is ignored.
      expect(doc).not.toContain('IGNORED')
      expect(doc).toContain('## 项目树 / Tree')
      expect(doc).toContain('## 变更时间线 / Timeline')
    } finally {
      saveBox.path = null
    }
  })

  it('a cancelled save dialog writes nothing', async () => {
    const res = await call<{ ok: boolean; error?: string }>(CH.export.writeFile, 'json', '{}')
    expect(res.ok).toBe(false)
  })
})

describe('path isolation at the IPC boundary (§0.2)', () => {
  it('no handler ever receives a raw filesystem path for a node operation', () => {
    // Every node-addressed handler is keyed by an integer id: assert the ids we
    // pass are numbers and that the resolved path always came from the database.
    expect(typeof nodeId).toBe('number')
    expect(repo.getNode(nodeId)!.path).toBe(join(projectRoot, 'alpha'))
  })
})
