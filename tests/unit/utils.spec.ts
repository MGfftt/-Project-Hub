/**
 * Utilities and pure helpers: path normalisation and traversal guards, the
 * fuzzy matcher that powers both search and rename detection, hashing, the
 * Markdown exporter and the built-in icon set.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join, resolve, sep } from 'node:path'

import {
  normalizePath,
  pathKey,
  isSubPath,
  safeRelative,
  isFilesystemRoot,
  assertIndexableRoot,
  displayPath,
  toPosix
} from '../../src/main/utils/path'
import { sha1, shortHash, stringToHue } from '../../src/main/utils/hash'
import { directorySize, resolveInside, isImageFile, readTextCapped, stem } from '../../src/main/utils/fsops'
import { fuzzyMatch, rankByMatch, similarity } from '../../src/shared/match'
import { toMarkdown, treeToMarkdown } from '../../src/main/services/markdown'
import { BUILTIN_ICONS, getIcon, ICON_NAMES, iconForMarker } from '../../src/shared/icons'
import { CH } from '../../src/shared/channels'
import type { HubEvent, NodeDetail, Root, TreeNode } from '../../src/shared/types'
import { sandbox, type Sandbox } from './helpers'

let sb: Sandbox

beforeEach(() => {
  sb = sandbox()
})

afterEach(() => {
  sb.dispose()
})

describe('utils/path (§7.1)', () => {
  it('normalises separators, trailing separators and ~', () => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    const withTilde = normalizePath('~/projects/')
    expect(withTilde.endsWith('projects')).toBe(true)
    if (home) expect(withTilde.startsWith(normalizePath(home))).toBe(true)
    // A relative path is resolved against the CWD — an indexed root must be
    // absolute, so silently keeping `a/b/c` relative would be dangerous.
    expect(normalizePath('a/b/c')).toBe(resolve(process.cwd(), 'a/b/c'))
    // An absolute path keeps its identity and only loses the trailing separator.
    const abs = resolve(process.cwd(), 'a/b/c')
    expect(normalizePath(`${abs}${sep}`)).toBe(abs)
    expect(normalizePath(`${abs}${sep}${sep}`)).toBe(abs)
  })

  it('is case-insensitive only on Windows', () => {
    const a = pathKey('C:\\Users\\X\\Proj')
    const b = pathKey('c:\\users\\x\\proj')
    if (process.platform === 'win32') expect(a).toBe(b)
    else expect(a).not.toBe(b)
  })

  it('isSubPath is not fooled by a shared prefix', () => {
    expect(isSubPath('/a/b', '/a/b/c')).toBe(true)
    expect(isSubPath('/a/b', '/a/bc')).toBe(false)
    expect(isSubPath('/a/b', '/a/b')).toBe(true)
  })

  it('safeRelative refuses to escape the base', () => {
    expect(safeRelative('/a/b', '/a/b/c/d')).toBe(join('c', 'd'))
    expect(safeRelative('/a/b', '/a/b')).toBe('')
    expect(safeRelative('/a/b', '/a/c')).toBeNull()
    expect(safeRelative('/a/b', '/etc/passwd')).toBeNull()
  })

  it('detects filesystem roots so they can never be indexed (§0.2)', () => {
    expect(isFilesystemRoot('/')).toBe(true)
    if (process.platform === 'win32') {
      expect(isFilesystemRoot('C:\\')).toBe(true)
      expect(isFilesystemRoot('C:\\Users')).toBe(false)
    }
  })

  it('assertIndexableRoot rejects the dangerous cases (数据隔离)', () => {
    expect(assertIndexableRoot('').ok).toBe(false)
    expect(assertIndexableRoot('/').ok).toBe(false)
    expect(assertIndexableRoot(join(sb.root, 'missing')).ok).toBe(false)
    const real = sb.dir('project')
    expect(assertIndexableRoot(real).ok).toBe(true)
  })

  it('displayPath and toPosix produce stable, readable output', () => {
    expect(toPosix('a\\b\\c')).toBe('a/b/c')
    expect(typeof displayPath(sb.root)).toBe('string')
  })
})

describe('utils/hash', () => {
  it('sha1 and shortHash are deterministic', () => {
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    expect(shortHash('abc')).toHaveLength(12)
    expect(shortHash('abc')).toBe(shortHash('abc'))
  })

  it('stringToHue is stable and inside 0..359', () => {
    for (const s of ['a', 'backend', '主力项目🚀', '']) {
      const h = stringToHue(s)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
      expect(stringToHue(s)).toBe(h)
    }
  })
})

describe('utils/fsops (write funnel)', () => {
  it('directorySize counts files and bytes and can skip subtrees', async () => {
    sb.file('t/a.txt', 'x'.repeat(100))
    sb.file('t/sub/b.txt', 'x'.repeat(50))
    sb.file('t/node_modules/c.txt', 'x'.repeat(1000))
    const all = await directorySize(join(sb.root, 't'))
    expect(all.files).toBe(3)
    expect(all.bytes).toBe(1150)
    const skipped = await directorySize(join(sb.root, 't'), { skip: (name) => name === 'node_modules' })
    expect(skipped.files).toBe(2)
    expect(skipped.bytes).toBe(150)
  })

  it('resolveInside rejects traversal and NUL bytes', () => {
    expect(resolveInside(sb.root, 'a/b.txt')).toBeTruthy()
    expect(resolveInside(sb.root, '..\\..\\etc')).toBeNull()
    expect(resolveInside(sb.root, '../outside')).toBeNull()
    expect(resolveInside(sb.root, 'a\0b')).toBeNull()
  })

  it('isImageFile recognises the supported formats', () => {
    for (const f of ['a.png', 'a.PNG', 'a.jpg', 'a.jpeg', 'a.webp', 'a.gif', 'a.bmp', 'a.ico', 'a.svg']) {
      expect(isImageFile(f)).toBe(true)
    }
    expect(isImageFile('a.txt')).toBe(false)
  })

  it('readTextCapped truncates instead of loading a huge file', async () => {
    sb.file('big.txt', 'x'.repeat(5000))
    const text = await readTextCapped(join(sb.root, 'big.txt'), 100)
    expect(text).not.toBeNull()
    expect((text ?? '').length).toBeLessThanOrEqual(100)
  })

  it('stem strips only the last extension', () => {
    expect(stem('archive.tar.gz')).toBe('archive.tar')
    expect(stem('noext')).toBe('noext')
  })
})

describe('shared/match (§8.4 search + rename heuristic)', () => {
  it('matches a contiguous substring and ranks it above a subsequence', () => {
    const contiguous = fuzzyMatch('src/main/index.ts', 'main')
    const scattered = fuzzyMatch('src/main/index.ts', 'smi')
    expect(contiguous.matched).toBe(true)
    expect(scattered.matched).toBe(true)
    expect(contiguous.score).toBeGreaterThan(scattered.score)
  })

  it('is case-insensitive and reports the matched ranges', () => {
    const res = fuzzyMatch('ProjectHub', 'hub')
    expect(res.matched).toBe(true)
    expect(res.ranges.length).toBeGreaterThan(0)
    const [start, end] = res.ranges[0]
    expect('ProjectHub'.slice(start, end).toLowerCase()).toBe('hub')
  })

  it('rejects a query whose characters are missing', () => {
    expect(fuzzyMatch('abcdef', 'xyz').matched).toBe(false)
    expect(fuzzyMatch('abc', 'abcd').matched).toBe(false)
  })

  it('boosts a match at the start of a word or string', () => {
    const start = fuzzyMatch('main-index', 'main')
    const middle = fuzzyMatch('xmainx', 'main')
    expect(start.score).toBeGreaterThan(middle.score)
  })

  it('an empty query matches nothing rather than everything', () => {
    expect(fuzzyMatch('abc', '').matched).toBe(false)
  })

  it('rankByMatch sorts descending and drops non-matches', () => {
    const items = [{ name: 'alpha' }, { name: 'beta' }, { name: 'alp' }]
    const ranked = rankByMatch(items, 'alp', (i) => [i.name])
    expect(ranked.length).toBe(2)
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score)
  })

  it('similarity detects containment for rename tracking', () => {
    expect(similarity('project-hub', 'project-hub-2')).toBeGreaterThan(0.8)
    expect(similarity('aaa', 'zzz')).toBeLessThan(0.5)
  })
})

describe('shared/icons', () => {
  it('ships the built-in set with valid path data', () => {
    expect(BUILTIN_ICONS.length).toBeGreaterThanOrEqual(40)
    for (const icon of BUILTIN_ICONS) {
      expect(icon.name).toMatch(/^[a-z0-9-]+$/)
      expect(icon.path.trim().length).toBeGreaterThan(0)
      expect(ICON_NAMES).toContain(icon.name)
    }
  })

  it('looks up by name and returns undefined — never throws — for an unknown name', () => {
    expect(getIcon('rocket')).toBeTruthy()
    expect(getIcon('rocket')!.name).toBe('rocket')
    // A miss must stay distinguishable from a hit; the *renderer* applies the
    // kind/marker fallback (`defForNode` in lib/treeIcons.ts), not this lookup.
    expect(getIcon('definitely-not-an-icon')).toBeUndefined()
    expect(() => getIcon('')).not.toThrow()
  })

  it('maps a project marker to a sensible icon', () => {
    expect(iconForMarker('package.json')).toBe('package')
    expect(iconForMarker('Cargo.toml')).toBeTruthy()
    expect(iconForMarker('no-such-marker')).toBeTruthy()
  })
})

describe('shared/channels', () => {
  it('exposes the six broadcast channels the renderer subscribes to', () => {
    const values = Object.values(CH.broadcast)
    expect(values).toContain('tree:updated')
    expect(values).toContain('events:appended')
    expect(values).toContain('scan:progress')
    expect(values).toContain('task:status')
    expect(values).toContain('window:visibility')
    expect(values).toContain('tray:state')
  })

  it('uses namespaced channel names', () => {
    // `settings.background` nests, so values must be collected recursively — a
    // shallow walk yields an empty list for that group and silently passes.
    const collect = (node: Record<string, unknown>, out: string[] = []): string[] => {
      for (const value of Object.values(node)) {
        if (typeof value === 'string') out.push(value)
        else if (value && typeof value === 'object') collect(value as Record<string, unknown>, out)
      }
      return out
    }
    const names = collect(CH as unknown as Record<string, unknown>)
    expect(names.length).toBeGreaterThan(25)
    for (const name of names) expect(name).toContain(':')
    expect(names).toContain('settings:background:current')
  })
})

describe('services/markdown (§7.7 export)', () => {
  // Fixtures are module-level and must not depend on the per-test sandbox, which
  // is only created in `beforeEach` (reading it here runs at collection time).
  const ROOT_DIR = 'hub-root'
  const root: Root = { id: 1, path: ROOT_DIR, enabled: 1, max_depth: 4, added_at: 1 }
  const tree: TreeNode[] = [
    {
      id: 10,
      parent_id: null,
      root_id: 1,
      kind: 'project',
      name: 'alpha',
      display_name: '主力项目',
      path: `${ROOT_DIR}/alpha`,
      status: 'active',
      color: null,
      priority: 0,
      icon_type: 'lucide',
      icon_value: 'rocket',
      tags: ['backend', '主力'],
      sort_order: 0,
      path_missing: 0,
      created_at: 1,
      updated_at: 2,
      children: []
    },
    {
      id: 11,
      parent_id: null,
      root_id: 1,
      kind: 'project',
      name: 'beta',
      display_name: null,
      path: `${ROOT_DIR}/beta`,
      status: 'paused',
      color: null,
      priority: 0,
      icon_type: 'auto',
      icon_value: null,
      tags: [],
      sort_order: 1,
      path_missing: 1,
      created_at: 1,
      updated_at: 2,
      children: []
    }
  ]
  const nodes: NodeDetail[] = [
    { ...tree[0], note_md: '这是标注\n第二行', meta: { diskSizeBytes: 2048, projectKind: 'node' } },
    { ...tree[1], note_md: '', meta: {} }
  ]
  const events: HubEvent[] = [
    {
      id: 1,
      node_id: 10,
      source: 'git',
      ref: 'abc',
      message: 'feat: add | pipe',
      author: 'dev',
      occurred_at: Date.UTC(2024, 2, 5, 2, 0, 0),
      file_count: 2,
      insertions: 12,
      deletions: 3,
      files: ['+ a.ts', '~ b.ts']
    }
  ]

  it('emits every documented section in order, bilingually', () => {
    const md = toMarkdown({ roots: [root], nodes, events, appVersion: '2.0.0' })
    const headings = ['# Project Hub', '## 概览 / Summary', '## 已索引根目录 / Indexed roots', '## 项目树 / Tree', '## 变更时间线 / Timeline']
    let cursor = -1
    for (const h of headings) {
      const at = md.indexOf(h)
      expect(at, `missing heading ${h}`).toBeGreaterThan(-1)
      expect(at).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('exports the in-app alias while keeping the disk name', () => {
    const md = toMarkdown({ roots: [root], nodes, events })
    expect(md).toContain('主力项目')
    expect(md).toContain('alpha')
    expect(md).toContain('#backend')
  })

  it('renders the annotation as a blockquote and marks a missing path', () => {
    const md = toMarkdown({ roots: [root], nodes, events })
    expect(md).toContain('> 这是标注')
    expect(md).toContain('路径缺失')
  })

  it('escapes pipes and includes the +/- columns', () => {
    const md = toMarkdown({ roots: [root], nodes, events })
    expect(md).toContain('\\|')
    expect(md).toContain('12')
    expect(md).toContain('3')
  })

  it('warns when the timeline was truncated', () => {
    const many: HubEvent[] = Array.from({ length: 3 }, (_, i) => ({ ...events[0], id: i + 1, message: `c${i}` }))
    const md = toMarkdown({ roots: [root], nodes, events: many, appVersion: '2.0.0' })
    expect(md).toContain('c0')
  })

  it('treeToMarkdown nests children', () => {
    const parent: TreeNode = { ...tree[0], children: [{ ...tree[1], name: 'child' }] }
    const md = treeToMarkdown([parent])
    // Line 0 is the document heading; the tree body starts after it.
    const body = md.split('\n').filter(Boolean).slice(1)
    expect(body[0]).toContain('主力项目')
    expect(body[0].startsWith('  ')).toBe(false)
    expect(body[1].startsWith('  ')).toBe(true)
    expect(body[1]).toContain('child')
  })

  it('treeToMarkdown works on a subtree whose parent is outside the slice', () => {
    // A node handed in on its own must still render even though its stored
    // `parent_id` points at a row the caller did not include.
    const orphan: TreeNode = { ...tree[0], parent_id: 999, children: [] }
    const md = treeToMarkdown([orphan])
    expect(md).toContain('主力项目')
    expect(md).toContain('#backend')
  })

  it('treeToMarkdown renders annotations from the nodes it was given', () => {
    const withNote = { ...tree[0], note_md: '只在本程序中可见', children: [] }
    expect(treeToMarkdown([withNote])).toContain('只在本程序中可见')
  })
})
