/**
 * The chosen background image (§9.5).
 *
 * Until now the settings dialog copied a picture into `userData/backgrounds`,
 * recorded it in `background.json` and showed its file name — and nothing ever
 * painted it. This module is the missing half: it puts the picture on the
 * window and turns the surfaces translucent so it is actually visible.
 *
 * The URL is a `hub-media://` URL built by the main process, which is stable
 * across launches (it carries the absolute path, not a port), so it is mirrored
 * into `localStorage` as a first-paint hint exactly like the theme is.
 */

const WALLPAPER_HINT_KEY = 'hub.wallpaper'

/** Only our own media scheme may reach a CSS `url()`. */
function isSafeWallpaperUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('hub-media://') && url.length < 4096
}

/**
 * Paints (or removes) the wallpaper. Idempotent, and safe to call with a `null`
 * URL before the async settings read resolves.
 */
export function applyWallpaper(url: string | null | undefined): void {
  const root = document.documentElement
  if (isSafeWallpaperUrl(url)) {
    root.style.setProperty('--wallpaper', `url("${url.replace(/["\\]/g, '')}")`)
    root.dataset.wallpaper = '1'
    try {
      window.localStorage.setItem(WALLPAPER_HINT_KEY, url)
    } catch {
      /* private mode — the attribute above still applied */
    }
    return
  }
  root.style.removeProperty('--wallpaper')
  delete root.dataset.wallpaper
  try {
    window.localStorage.removeItem(WALLPAPER_HINT_KEY)
  } catch {
    /* ignore */
  }
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

/** Reads the picture recorded in `background.json` and paints it. */
export async function syncWallpaperFromSettings(): Promise<void> {
  const hub = window.hub
  if (!hub) return
  try {
    const image = (await hub.settings.background.current()) as { url?: string } | null
    applyWallpaper(image?.url ?? null)
  } catch {
    /* keep whatever the hint painted */
  }
}
