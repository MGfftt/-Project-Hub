import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

export interface ConfirmDialogProps {
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Destructive actions render the confirm button in red (§8.2 从库中移除). */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation modal. Escape cancels, Enter confirms, the dialog traps Tab and
 * starts on the confirm button so a keyboard-only user never has to hunt for it
 * (§9.7 全部交互元素键盘可达).
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
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
    [onCancel]
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hub-confirm-title"
        aria-describedby="hub-confirm-message"
        className="card hub-pop-in w-full max-w-sm p-4 shadow-xl"
        onKeyDown={onKeyDown}
      >
        <h2 id="hub-confirm-title" className="text-sm font-semibold text-[var(--text)]">
          {title}
        </h2>
        <div
          id="hub-confirm-message"
          className="mt-2 break-words text-xs leading-5 text-[var(--text-dim)]"
        >
          {message}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
