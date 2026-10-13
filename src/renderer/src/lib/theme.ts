/**
 * Theme plumbing (§9.5).
 *
 * `styles.css` owns the actual tokens (`:root` = light, `.dark` = dark); this
 * module only decides which class `<html>` carries and mirrors the choice into
 * `localStorage` so the next window can paint the right theme before the async
 * `hub.settings` read resolves.
 */

export type ThemePref = 'light' | 'dark' | 'system'

export const THEME_SETTING_KEY = 'theme'

/** Synchronous hint. Never the source of truth — `hub.settings` is. */
const THEME_HINT_KEY = 'hub.theme'

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function isThemePref(value: unknown): value is ThemePref {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function readStoredThemePref(): ThemePref {
  try {
    const raw = window.localStorage.getItem(THEME_HINT_KEY)
    return isThemePref(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

/** Resolves a preference to `light`/`dark` and returns the concrete theme. */
export function resolveTheme(pref: ThemePref, prefersDark: boolean = systemPrefersDark()): 'light' | 'dark' {
  if (pref === 'system') return prefersDark ? 'dark' : 'light'
  return pref
}

/**
 * Applies the theme to `<html>` and remembers the preference. Returns the
 * concrete theme that ended up on the element (handy for tests and callers).
 */
export function applyResolvedTheme(
  pref: ThemePref = readStoredThemePref(),
  prefersDark: boolean = systemPrefersDark()
): 'light' | 'dark' {
  const resolved = resolveTheme(pref, prefersDark)
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.dataset.themePref = pref
  root.style.colorScheme = resolved
  try {
    window.localStorage.setItem(THEME_HINT_KEY, pref)
  } catch {
    /* private mode / disabled storage — the class above still applied */
  }
  return resolved
}
