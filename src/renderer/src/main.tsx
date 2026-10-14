import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyResolvedTheme, readStoredThemePref, systemPrefersDark } from './lib/theme'
import { readStoredLang, setLang } from './lib/i18n'
import './styles.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('renderer bootstrap failed: #root is missing from index.html')
}

/* ---------------------------------------------------------------------------
 * Theme (§9.5)
 *
 * The authority is `hub.settings[SETTING_KEYS.theme]`. That read is async, so a
 * synchronous localStorage hint is applied first to avoid a flash of the wrong
 * theme, then corrected from the settings row. `system` also tracks the OS
 * while the window stays open.
 * ------------------------------------------------------------------------ */

applyResolvedTheme(readStoredThemePref(), systemPrefersDark())

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (document.documentElement.dataset.themePref === 'system') {
    applyResolvedTheme('system', systemPrefersDark())
  }
})

async function syncThemeFromSettings(): Promise<void> {
  const hub = window.hub
  if (!hub) return
  try {
    const raw = await hub.settings.get('theme')
    if (raw === 'light' || raw === 'dark' || raw === 'system') {
      applyResolvedTheme(raw, systemPrefersDark())
    }
  } catch {
    /* best effort: the hint from localStorage already painted a usable theme */
  }
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

void syncThemeFromSettings()
void syncLangFromSettings()
