/**
 * Theme plumbing (§9.5).
 *
 * `styles.css` owns the actual tokens (`:root` = light, `.dark` = dark); this
 * module only decides which class `<html>` carries and mirrors the choice into
 * `localStorage` so the next window can paint the right theme before the async
 * `hub.settings` read resolves.
 *
 * §9.11 — frosted glass is NOT a fourth theme. It is a boolean effect that can
 * be layered over light, dark or system (`applyGlass`), and while a background
 * picture is set the light/dark choice follows that picture's average colour
 * rather than the stored preference (`lib/wallpaper.ts` decides which).
 */
import { activeTintDark } from './wallpaper'

export type ThemePref = 'light' | 'dark' | 'system'

/** Synchronous hint. Never the source of truth — `hub.settings` is. */
const THEME_HINT_KEY = 'hub.theme'
const GLASS_HINT_KEY = 'hub.glass'

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

/**
 * Resolves a preference to `light`/`dark`.
 *
 * `system` asks the OS; the two explicit choices are taken at their word.
 */
export function resolveTheme(pref: ThemePref, prefersDark: boolean = systemPrefersDark()): 'light' | 'dark' {
  if (pref === 'system') return prefersDark ? 'dark' : 'light'
  return pref
}

/**
 * Applies the theme to `<html>` and remembers the preference. Returns the
 * concrete theme that ended up on the element (handy for tests and callers).
 *
 * `pictureDark` is the background picture's verdict on light versus dark; it
 * defaults to the picture currently painted, so every caller gets the override
 * for free and no caller can forget it. Pass `null` explicitly to ignore the
 * picture (the OS-change listener does that while no picture is set).
 */
export function applyResolvedTheme(
  pref: ThemePref = readStoredThemePref(),
  prefersDark: boolean = systemPrefersDark(),
  pictureDark: boolean | null = activeTintDark()
): 'light' | 'dark' {
  const resolved = pictureDark === null ? resolveTheme(pref, prefersDark) : pictureDark ? 'dark' : 'light'
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.dataset.themePref = pref
  /* §9.11 — "the picture is driving the colours" is visible in the DOM, so the
     settings dialog can say so without re-reading the settings table. */
  if (pictureDark === null) delete root.dataset.themeAuto
  else root.dataset.themeAuto = '1'
  root.style.colorScheme = resolved
  try {
    window.localStorage.setItem(THEME_HINT_KEY, pref)
  } catch {
    /* private mode / disabled storage — the class above still applied */
  }
  return resolved
}

/**
 * §9.11 — the frosted-glass switch.
 *
 * A separate attribute, so the token blocks in `styles.css` can layer the
 * effect on top of either light or dark instead of duplicating both. It is
 * deliberately independent of the theme and of whether a picture is set.
 */
export function applyGlass(enabled: boolean): void {
  const root = document.documentElement
  if (enabled) root.dataset.glass = '1'
  else delete root.dataset.glass
  try {
    window.localStorage.setItem(GLASS_HINT_KEY, enabled ? '1' : '0')
  } catch {
    /* private mode / disabled storage — the attribute above still applied */
  }
}

/** Synchronous hint so the first frame is already frosted (or not). */
export function readStoredGlass(): boolean {
  try {
    return window.localStorage.getItem(GLASS_HINT_KEY) === '1'
  } catch {
    return false
  }
}
