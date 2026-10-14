/**
 * The chosen background image and its tint (§9.11).
 *
 * The settings dialog copies a picture into `userData/backgrounds` and records
 * it in `background.json`; this module is what actually paints it. The picture
 * is the base layer of the whole window, every sub-interface sits on top of it
 * as a translucent sheet, and the sheet's colour is the picture's own average
 * colour — measured in the main process (`tintOf`) and handed over with the URL.
 *
 * The URL is a `hub-media://` URL built by the main process, which is stable
 * across launches (it carries the absolute path, not a port), so both the URL
 * and the tint are mirrored into `localStorage` as first-paint hints exactly
 * like the theme is.
 */

const WALLPAPER_HINT_KEY = 'hub.wallpaper'
const TINT_HINT_KEY = 'hub.wallpaper.tint'

/**
 * §9.11 — the window-level half of the effect.
 *
 * Acrylic is not something CSS can ask for: the compositor has to draw the
 * desktop behind the page, and only the main process can ask it. The two
 * switches live in different callers, so the last known state is remembered
 * here and each caller sends only the half it owns.
 */
let materialGlass = false
let materialPicture = false

function pushWindowMaterial(): void {
  try {
    void window.hub?.appearance
      ?.setMaterial({ glass: materialGlass, picture: materialPicture })
      .catch(() => {
        /* an older main process without the channel — the wash still stands in */
      })
  } catch {
    /* no hub at all (unit tests import this module) — nothing to tell */
  }
}

export function syncWindowMaterial(patch: { glass?: boolean; picture?: boolean }): void {
  if (patch.glass !== undefined) materialGlass = patch.glass
  if (patch.picture !== undefined) materialPicture = patch.picture
  pushWindowMaterial()
}

/** Only our own media scheme may reach a CSS `url()`. */
function isSafeWallpaperUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('hub-media://') && url.length < 4096
}

/** Only a plain `#rrggbb` may reach a CSS custom property. */
function isSafeTint(tint: unknown): tint is string {
  return typeof tint === 'string' && /^#[0-9a-fA-F]{6}$/.test(tint)
}

/**
 * Perceived brightness of `#rrggbb`, 0 (black) to 1 (white).
 *
 * Deliberately the plain channel mean and not relative luminance: this decides
 * whether the interface should be light or dark, which is a judgement about how
 * bright the picture *looks*, and gamma-corrected luminance calls every average
 * photograph dark.
 */
export function tintBrightness(tint: string): number {
  const value = Number.parseInt(tint.slice(1), 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return (r + g + b) / 765
}

/**
 * True when the picture is dark enough that the interface should be dark; null
 * when there is no picture, which means "let the theme preference decide".
 */
export function tintIsDark(tint: string | null | undefined): boolean | null {
  if (!isSafeTint(tint)) return null
  return tintBrightness(tint) < 0.5
}

function clearTint(root: HTMLElement): void {
  root.style.removeProperty('--tint')
  delete root.dataset.tint
  try {
    window.localStorage.removeItem(TINT_HINT_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Paints (or removes) the picture and its tint. Idempotent, and safe to call
 * with nulls before the async settings read resolves.
 */
export function applyWallpaper(url: string | null | undefined, tint: string | null | undefined = null): void {
  const root = document.documentElement
  if (isSafeWallpaperUrl(url)) {
    root.style.setProperty('--wallpaper', `url("${url.replace(/["\\]/g, '')}")`)
    root.dataset.wallpaper = '1'
    try {
      window.localStorage.setItem(WALLPAPER_HINT_KEY, url)
    } catch {
      /* private mode — the attribute above still applied */
    }
    if (isSafeTint(tint)) {
      root.style.setProperty('--tint', tint)
      root.dataset.tint = '1'
      try {
        window.localStorage.setItem(TINT_HINT_KEY, tint)
      } catch {
        /* ignore */
      }
    } else {
      clearTint(root)
    }
    syncWindowMaterial({ picture: true })
    return
  }
  root.style.removeProperty('--wallpaper')
  delete root.dataset.wallpaper
  clearTint(root)
  try {
    window.localStorage.removeItem(WALLPAPER_HINT_KEY)
  } catch {
    /* ignore */
  }
  syncWindowMaterial({ picture: false })
}

/** Synchronous hint so the first frame is already painted. */
export function readStoredWallpaper(): string | null {
  try {
    const raw = window.localStorage.getItem(WALLPAPER_HINT_KEY)
    return isSafeWallpaperUrl(raw) ? raw : null
  } catch {
    return null
  }
}

/** Synchronous hint for the tint, so the first frame is already tinted. */
export function readStoredTint(): string | null {
  try {
    const raw = window.localStorage.getItem(TINT_HINT_KEY)
    return isSafeTint(raw) ? raw : null
  } catch {
    return null
  }
}

/**
 * What the picture currently on screen says about light versus dark: `true`
 * for a dark picture, `false` for a bright one, `null` when there is none.
 *
 * The hint is the same value `applyWallpaper` just recorded, so this is always
 * in step with what is painted — including on the very first frame.
 */
export function activeTintDark(): boolean | null {
  return tintIsDark(readStoredTint())
}

/**
 * Reads the picture recorded in `background.json`, paints it with its tint and
 * returns that tint (null when no picture is set).
 */
export async function syncWallpaperFromSettings(): Promise<string | null> {
  const hub = window.hub
  if (!hub) return null
  try {
    const image = (await hub.settings.background.current()) as { url?: string; tint?: string | null } | null
    const tint = image?.tint ?? readStoredTint()
    applyWallpaper(image?.url ?? null, tint)
    return isSafeTint(tint) ? tint : null
  } catch {
    /* keep whatever the hint painted */
    return readStoredTint()
  }
}
