import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { t } from '@renderer/lib/i18n'

export interface ModalProps {
  title: string
  onClose(): void
  children: ReactNode
  /** Extra classes for the panel (width overrides live at the call site). */
  className?: string
  footer?: ReactNode
}

/**
 * Shared dialog frame for the 属性 / 图标 / 设置 dialogs.
 *
 * Owns only the mechanics the three dialogs share: the overlay, Escape to close,
 * `role="dialog"` + `aria-modal`, an initial focus target and a Tab loop. The
 * content and the footer belong to the caller.
 */
export function Modal({ title, onClose, children, className, footer }: ModalProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const first = panel.querySelector<HTMLElement>(
      '[data-autofocus], button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    first?.focus()
  }, [])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (!focusables || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    },
    [onClose]
  )

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`card glass-panel hub-pop-in flex max-h-[85vh] w-full max-w-lg flex-col shadow-xl ${className ?? ''}`}
        onKeyDown={onKeyDown}
      >
        <header
          className="flex items-center gap-2 border-b px-4 py-2.5"
          style={{ borderColor: 'var(--border)' }}
        >
          <h2 className="text-sm font-semibold text-[var(--text)]">{title}</h2>
          <button
            type="button"
            className="btn btn-ghost ml-auto h-6 w-6 px-0 text-sm"
            onClick={onClose}
            aria-label={t('settings.close')}
            title={t('settings.closeHint')}
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div>
        {footer ? (
          <footer
            className="flex items-center justify-end gap-2 border-t px-4 py-2.5"
            style={{ borderColor: 'var(--border)' }}
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  )
}

export default Modal
