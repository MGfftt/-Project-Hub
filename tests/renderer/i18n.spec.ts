import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLang, MESSAGES, setLang, t, tCount } from '../../src/renderer/src/lib/i18n'
import { formatEventMessage } from '../../src/renderer/src/lib/format'

/*
 * §9.10 — the two properties the dictionaries rest on:
 *   1. every key carries both languages, and
 *   2. an english sentence never interpolates a chinese count noun.
 * Plus the one place a translation is computed rather than looked up: the
 * filesystem event summary, which is stored in the database as `新建 3 · 修改 1`.
 */

afterEach(() => {
  setLang('zh')
  vi.restoreAllMocks()
})

describe('the message tables', () => {
  it('give every key a non-empty chinese and english string', () => {
    const keys = Object.keys(MESSAGES)
    expect(keys.length).toBeGreaterThan(400)
    const broken = keys.filter((key) => {
      const entry = MESSAGES[key]
      return !entry[0]?.trim() || !entry[1]?.trim()
    })
    expect(broken).toEqual([])
  })

  it('never leave a chinese character in the english half', () => {
    const leaking = Object.entries(MESSAGES)
      .filter(([, entry]) => /[\u4e00-\u9fff]/.test(entry[1]))
      .map(([key]) => key)
    expect(leaking).toEqual([])
  })

  it('return the key itself, loudly, when it is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(t('nope.not.a.key')).toBe('nope.not.a.key')
    expect(warn).toHaveBeenCalledWith('[i18n] missing key: nope.not.a.key')
  })
})

describe('t() and tCount()', () => {
  it('switch language without a reload', () => {
    expect(t('tree.root')).toBe('根目录')
    setLang('en')
    expect(getLang()).toBe('en')
    expect(t('tree.root')).toBe('Root')
    setLang('zh')
    expect(t('tree.root')).toBe('根目录')
  })

  it('interpolate the placeholder', () => {
    setLang('en')
    expect(t('detail.eventFiles', { n: 5 })).toBe('5 files')
    setLang('zh')
    expect(t('detail.eventFiles', { n: 5 })).toBe('5 个文件')
  })

  it('pick the english singular at exactly one', () => {
    setLang('en')
    expect(tCount('map.childCountOne', 'map.childCount', 1)).toBe('1 child')
    expect(tCount('map.childCountOne', 'map.childCount', 2)).toBe('2 children')
    expect(tCount('map.childCountOne', 'map.childCount', 0)).toBe('0 children')
  })

  it('keep chinese unchanged by the count', () => {
    expect(tCount('map.childCountOne', 'map.childCount', 1)).toBe('1 个子节点')
    expect(tCount('map.childCountOne', 'map.childCount', 5)).toBe('5 个子节点')
  })
})

describe('formatEventMessage()', () => {
  it('re-renders a stored filesystem summary in english', () => {
    setLang('en')
    expect(formatEventMessage('新建 3 · 修改 1', 'fs')).toBe('3 created · 1 modified')
    expect(formatEventMessage('删除 2', 'fs')).toBe('2 deleted')
  })

  it('leaves it alone in chinese', () => {
    expect(formatEventMessage('新建 3 · 修改 1', 'fs')).toBe('新建 3 · 修改 1')
  })

  it('never touches a commit subject, whatever it says', () => {
    setLang('en')
    expect(formatEventMessage('新建 3', 'git')).toBe('新建 3')
    expect(formatEventMessage('Fix the 修改 path', 'git')).toBe('Fix the 修改 path')
  })

  it('passes an unrecognised filesystem message through rather than mangling it', () => {
    setLang('en')
    expect(formatEventMessage('something else', 'fs')).toBe('something else')
  })

  it('degrades an empty message to an empty string', () => {
    expect(formatEventMessage(null, 'fs')).toBe('')
    expect(formatEventMessage('   ', 'git')).toBe('')
  })
})
