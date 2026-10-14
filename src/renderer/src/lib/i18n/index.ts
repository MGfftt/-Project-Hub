/* ---------------------------------------------------------------------------
 * i18n (§9.10)
 *
 * One flat table, `key -> [中文, English]`, assembled from the dictionaries in
 * `./parts`. Components call `t('tree.newGroup')`; nothing else decides how a
 * string reads.
 *
 * Why a module-level function instead of a React context: the strings are also
 * needed outside components (the tree store's status lines, `lib/format.ts`
 * relative times, the colour and kind labels). A hook would force every one of
 * those call sites to become a component. Instead `App.tsx` remounts the shell
 * when the language changes, so every `t()` call re-reads the current language.
 *
 * The authority for the choice is `hub.settings[SETTING_KEYS.language]`; the
 * localStorage hint below only lets the first paint land in the right language
 * before that async read resolves — exactly the trick `lib/theme.ts` uses.
 * ------------------------------------------------------------------------ */

import { useSyncExternalStore } from 'react'
import { PARTS } from './parts'
import type { Dict, Entry, Lang } from './types'

export type { Dict, Entry, Lang }

/** The languages the picker offers, each written in its own language. */
export const LANGUAGES: readonly { id: Lang; native: string }[] = [
  { id: 'zh', native: '中文' },
  { id: 'en', native: 'English' }
]

export const MESSAGES: Dict = Object.assign({}, ...PARTS) as Dict

/** Synchronous hint. Never the source of truth — `hub.settings` is. */
const LANG_HINT_KEY = 'hub.lang'

const listeners = new Set<() => void>()
let current: Lang = 'zh'

export function isLang(value: unknown): value is Lang {
  return value === 'zh' || value === 'en'
}

export function readStoredLang(): Lang {
  try {
    const raw = window.localStorage.getItem(LANG_HINT_KEY)
    return isLang(raw) ? raw : 'zh'
  } catch {
    return 'zh'
  }
}

export function getLang(): Lang {
  return current
}

/** Switches language, mirrors it into `localStorage`, and wakes every subscriber. */
export function setLang(lang: Lang): void {
  if (!isLang(lang)) return
  const changed = lang !== current
  current = lang
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  try {
    window.localStorage.setItem(LANG_HINT_KEY, lang)
  } catch {
    /* private mode / disabled storage — the in-memory value still applied */
  }
  if (changed) for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Subscribe a component to the current language. */
export function useLang(): Lang {
  return useSyncExternalStore(
    subscribe,
    getLang,
    () => 'zh' as Lang
  )
}

const warned = new Set<string>()

/**
 * Looks a message up and fills `{name}` placeholders.
 *
 * A missing key returns the key itself rather than the Chinese text: an
 * untranslated string has to be visible, not silently plausible.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const entry: Entry | undefined = MESSAGES[key]
  if (!entry) {
    if (!warned.has(key)) {
      warned.add(key)
      console.warn(`[i18n] missing key: ${key}`)
    }
    return key
  }
  let text = entry[current === 'en' ? 1 : 0]
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

/** The same lookup, as an array — handy where a list of strings is expected. */
export function tList(keys: readonly string[]): string[] {
  return keys.map((key) => t(key))
}

/**
 * Count-sensitive lookup, because English needs "1 child" where Chinese keeps
 * "1 个子节点". Pass the singular key first, the plural key second; `{n}` is
 * always supplied.
 */
export function tCount(
  one: string,
  many: string,
  n: number,
  vars?: Record<string, string | number>
): string {
  return t(n === 1 ? one : many, { n, ...(vars ?? {}) })
}
