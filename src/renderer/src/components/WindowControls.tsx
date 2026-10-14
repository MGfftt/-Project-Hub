import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { t } from '@renderer/lib/i18n'

/* ---------------------------------------------------------------------------
 * WindowControls — §9.11.
 *
 * Windows only honours `transparent: true` on a window with no native frame, so
 * the app draws its own chrome and these three buttons are all that is left of
 * the title bar. They sit at the right end of the tab strip (AppShell), which is
 * also the window's drag handle.
 *
 * The maximise button has to follow the real window state, which can also change
 * from a double click on the drag region or from Win+Arrow, so the state is read
 * once on mount and then kept in step by the `window:maximized` broadcast.
 * ------------------------------------------------------------------------ */

const BUTTON =
  'app-no-drag focus-ring flex h-7 w-9 items-center justify-center rounded-[var(--radius-btn)] ' +
  'text-[var(--text-dim)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]'

export function WindowControls(): JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const hub = window.hub
    let alive = true
    void hub.window
      .state()
      .then((state) => {
        if (alive) setMaximized(state.maximized)
      })
      .catch(() => undefined)
    const off = hub.on('window:maximized', (payload) => {
      const next = payload as { maximized?: boolean } | null
      setMaximized(Boolean(next?.maximized))
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return (
    <div className="app-no-drag ml-1 flex items-center gap-0.5" data-window-controls>
      <button
        type="button"
        className={BUTTON}
        title={t('win.minimize')}
        aria-label={t('win.minimize')}
        onClick={() => void window.hub.window.minimize()}
      >
        <Minus size={14} aria-hidden />
      </button>
      <button
        type="button"
        className={BUTTON}
        title={maximized ? t('win.restore') : t('win.maximize')}
        aria-label={maximized ? t('win.restore') : t('win.maximize')}
        onClick={() => void window.hub.window.toggleMaximize()}
      >
        {maximized ? <Copy size={13} aria-hidden /> : <Square size={12} aria-hidden />}
      </button>
      <button
        type="button"
        className={`${BUTTON} hover:!bg-[#dc2626] hover:!text-white`}
        title={t('win.close')}
        aria-label={t('win.close')}
        onClick={() => void window.hub.window.close()}
      >
        <X size={15} aria-hidden />
      </button>
    </div>
  )
}

export default WindowControls
