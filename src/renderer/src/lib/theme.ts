/**
 * Theme plumbing (§9.5).
 *
 * `styles.css` owns the actual tokens (`:root` = light, `.dark` = dark); this
 * module only decides which class `<html>` carries and mirrors the choice into
 * `localStorage` so the next window can paint the right theme before the async
 * `hub.settings` read resolves.
 */

export type ThemePref = 'light' | 'dark' | 'system' | 'glass'

export const THEME_SETTING_KEY = 'theme'

/** Synchronous hint. Never the source of truth — `hub.settings` is. */
const THEME_HINT_KEY = 'hub.theme'

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function isThemePref(value: unknown): value is ThemePref {
  return value === 'light' || value === 'dark' || value === 'system' || value === 'glass'
}

export function readStoredThemePref(): ThemePref {
  try {
    const raw = window.localStorage.getItem(THEME_HINT_KEY)
    return isThemePref(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

/**
 * Resolves a preference to `light`/`dark` and returns the concrete theme.
 *
 * `glass` (§9.11) is still a light/dark choice — it follows the system for the
 * text and border colours and only makes the surfaces translucent, so it
 * resolves exactly like `system` and adds a second attribute on `<html>`.
 */
export function resolveTheme(pref: ThemePref, prefersDark: boolean = systemPrefersDark()): 'light' | 'dark' {
  if (pref === 'system' || pref === 'glass') return prefersDark ? 'dark' : 'light'
  return pref
}

/** True when the preference wants frosted-glass surfaces. */
export function isGlassPref(pref: ThemePref): boolean {
  return pref === 'glass'
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
  /* §9.11 — a separate attribute, so the token block in styles.css can be
     layered on top of either light or dark instead of duplicating both. */
  if (isGlassPref(pref)) root.dataset.glass = '1'
  else delete root.dataset.glass
  root.style.colorScheme = resolved
  try {
    window.localStorage.setItem(THEME_HINT_KEY, pref)
  } catch {
    /* private mode / disabled storage — the class above still applied */
  }
  return resolved
}
