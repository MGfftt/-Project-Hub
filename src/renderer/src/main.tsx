import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import {
  applyGlass,
  applyResolvedTheme,
  isThemePref,
  readStoredGlass,
  readStoredThemePref,
  systemPrefersDark
} from './lib/theme'
import { readStoredLang, setLang } from './lib/i18n'
import { applyWallpaper, readStoredTint, readStoredWallpaper, syncWallpaperFromSettings } from './lib/wallpaper'
import './styles.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('renderer bootstrap failed: #root is missing from index.html')
}

/* ---------------------------------------------------------------------------
 * Appearance (§9.5, §9.11)
 *
 * Three inputs, applied in this order because they depend on each other: the
 * background picture (whose average colour is the tint), the frosted glass
 * switch, and the theme preference — which the picture overrides while one is
 * set, since light text on a bright picture (or the reverse) is unreadable.
 *
 * The authority is the `settings` table. Those reads are async, so synchronous
 * localStorage hints paint the first frame and are corrected a moment later.
 * ------------------------------------------------------------------------ */

applyWallpaper(readStoredWallpaper(), readStoredTint())
applyGlass(readStoredGlass())
applyResolvedTheme(readStoredThemePref(), systemPrefersDark())

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const root = document.documentElement
  /* §9.11 — with a picture set the average colour decides, so the OS preference
     is not an input at all. */
  if (root.dataset.themePref !== 'system' || root.dataset.themeAuto === '1') return
  applyResolvedTheme('system', systemPrefersDark(), null)
})

/* §9.11 — the compositor drops the window's backdrop while it is off screen
   (minimised, or hidden to the tray) and nothing tells us when it comes back:
   the window event fires before the compositor is done, and asking then is
   ignored. The page knows the moment it is on screen again, so that is where the
   request is repeated from. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  void window.hub?.appearance.reassert()
})

async function syncAppearanceFromSettings(): Promise<void> {
  const hub = window.hub
  if (!hub) return
  const [themeRaw, glassRaw] = await Promise.all([
    hub.settings.get('theme').catch(() => null),
    hub.settings.get('glass').catch(() => null)
  ])
  /* The picture must be painted before the theme resolves: it is what the
     theme resolves against. */
  await syncWallpaperFromSettings()
  applyGlass(glassRaw === null || glassRaw === undefined ? readStoredGlass() : String(glassRaw) === 'true')
  applyResolvedTheme(isThemePref(themeRaw) ? themeRaw : readStoredThemePref(), systemPrefersDark())
}

/* ---------------------------------------------------------------------------
 * Language (§9.10)
 *
 * Same shape as the theme: the localStorage hint paints the first frame in the
 * remembered language, then the `settings` row corrects it. Setting it before
 * `render` is what keeps a Chinese↔English switch from flashing the other
 * language on every launch.
 * ------------------------------------------------------------------------ */

setLang(readStoredLang())

async function syncLangFromSettings(): Promise<void> {
  const hub = window.hub
  if (!hub) return
  try {
    const raw = await hub.settings.get('language')
    if (raw === 'zh' || raw === 'en') setLang(raw)
  } catch {
    /* best effort: the hint from localStorage already painted a usable language */
  }
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)

void syncAppearanceFromSettings()
void syncLangFromSettings()
