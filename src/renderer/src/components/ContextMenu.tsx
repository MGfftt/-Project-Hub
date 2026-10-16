import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BarChart3,
  FolderPlus,
  Info,
  MapPin,
  NotebookPen,
  Palette,
  Pencil,
  Copy,
  FolderMinus,
  FolderOpen,
  Trash2
} from 'lucide-react'
import type { TreeNode } from '@shared/types'
import { NODE_COLORS, nodeColorKey, nodeColorValue } from '@renderer/lib/colors'
import { t } from '@renderer/lib/i18n'

/* ---------------------------------------------------------------------------
 * ContextMenu — the frozen §8.2 order and availability rules.
 *
 *   📂 打开文件夹 (bold)      disabled for groups and for missing paths
 *   📍 在文件管理器中显示      same
 *   📋 复制路径               disabled only for virtual groups (path === null)
 *   ─────
 *   📊 查看改动 / ℹ️ 属性 / 📝 标注
 *   ─────
 *   ✏️ 重命名（程序内） / 🎨 更改图标
 *   ─────
 *   📁 新建子分组 / 🗑️ 从库中移除
 *
 * Rendered through a portal so a narrow column can never clip it, and clamped
 * into the viewport so the last row is always clickable.
 * ------------------------------------------------------------------------ */

export interface ContextMenuAction {
  id: string
  label: string
  icon?: JSX.Element
  separatorBefore?: boolean
  bold?: boolean
  danger?: boolean
  disabled?: boolean
  hint?: string
  run?: () => void
}

export interface ContextMenuProps {
  node: TreeNode
  x: number
  y: number
  /** Whether this node is currently held by a virtual group (§7.8). */
  insideGroup?: boolean
  onClose: () => void
  /** Frozen order is applied here, so callers only supply behaviour. */
  onOpenFolder?: (node: TreeNode) => void
  onReveal?: (node: TreeNode) => void
  onCopyPath?: (node: TreeNode) => void
  onViewChanges?: (node: TreeNode) => void
  onProperties?: (node: TreeNode) => void
  onAnnotate?: (node: TreeNode) => void
  onRename?: (node: TreeNode) => void
  onChangeIcon?: (node: TreeNode) => void
  /** §9.8 — shown as a swatch row so a colour is one right-click away. */
  onChangeColor?: (node: TreeNode, color: string | null) => void
  onNewGroup?: (node: TreeNode) => void
  /** §7.8 — only meaningful while the node sits inside a virtual group. */
  onRemoveFromGroup?: (node: TreeNode) => void
  onRemove?: (node: TreeNode) => void
}

const ICON_SIZE = 14

export function ContextMenu({
  node,
  x,
  y,
  insideGroup = false,
  onClose,
  onOpenFolder,
  onReveal,
  onCopyPath,
  onViewChanges,
  onProperties,
  onAnnotate,
  onRename,
  onChangeIcon,
  onChangeColor,
  onNewGroup,
  onRemoveFromGroup,
  onRemove
}: ContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  const isVirtualGroup = node.kind === 'group' && !node.path
  const missing = node.path_missing === 1
  const noDiskPath = !node.path || missing
  /* The `node` prop is a snapshot, so a freshly picked colour is tracked here
   * to keep the swatch ring on the new choice while the menu stays open. */
  const [pickedColor, setPickedColor] = useState<string | null | undefined>(undefined)
  const currentColor = pickedColor === undefined ? nodeColorValue(node.color) : pickedColor
  /* §8.2 — a disabled 打开/在文件管理器中显示 explains itself on hover. */
  const noDiskHint = missing
    ? t('tree.pathMissing')
    : !node.path
      ? t('tree.groupNoDiskPath')
      : undefined

  const actions: ContextMenuAction[] = [
    {
      id: 'open',
      label: t('tree.openFolder'),
      icon: <FolderOpen size={ICON_SIZE} aria-hidden />,
      bold: true,
      disabled: noDiskPath,
      hint: noDiskHint,
      run: () => onOpenFolder?.(node)
    },
    {
      id: 'reveal',
      label: t('tree.revealInFileManager'),
      icon: <MapPin size={ICON_SIZE} aria-hidden />,
      disabled: noDiskPath,
      hint: noDiskHint,
      run: () => onReveal?.(node)
    },
    {
      id: 'copy',
      label: t('tree.copyPath'),
      icon: <Copy size={ICON_SIZE} aria-hidden />,
      disabled: node.path == null,
      run: () => onCopyPath?.(node)
    },
    {
      id: 'changes',
      label: t('tree.viewChanges'),
      icon: <BarChart3 size={ICON_SIZE} aria-hidden />,
      separatorBefore: true,
      run: () => onViewChanges?.(node)
    },
    {
      id: 'props',
      label: t('tree.properties'),
      icon: <Info size={ICON_SIZE} aria-hidden />,
      run: () => onProperties?.(node)
    },
    {
      id: 'note',
      label: t('tree.annotate'),
      icon: <NotebookPen size={ICON_SIZE} aria-hidden />,
      run: () => onAnnotate?.(node)
    },
    {
      id: 'rename',
      label: t('tree.renameInApp'),
      icon: <Pencil size={ICON_SIZE} aria-hidden />,
      separatorBefore: true,
      hint: t('tree.renameHintMenu'),
      run: () => onRename?.(node)
    },
    {
      id: 'icon',
      label: t('tree.changeIcon'),
      icon: <Palette size={ICON_SIZE} aria-hidden />,
      run: () => onChangeIcon?.(node)
    },
    {
      id: 'group',
      label: t('tree.newChildGroup'),
      icon: <FolderPlus size={ICON_SIZE} aria-hidden />,
      separatorBefore: true,
      run: () => onNewGroup?.(node)
    },
    {
      id: 'ungroup',
      label: t('tree.removeFromGroup'),
      icon: <FolderMinus size={ICON_SIZE} aria-hidden />,
      /* §7.8 — only a node held by a *group* has a membership to undo. The
       * panel supplies the answer; a node inside a real folder keeps the disk's
       * own structure and has nothing to unbind. */
      disabled: !insideGroup,
      hint: insideGroup ? t('tree.removeFromGroupHint') : undefined,
      run: () => onRemoveFromGroup?.(node)
    },
    {
      id: 'remove',
      label: t('tree.removeFromLibrary'),
      icon: <Trash2 size={ICON_SIZE} aria-hidden />,
      danger: true,
      hint: t('tree.removeHint'),
      run: () => onRemove?.(node)
    }
  ]

  const closeOnOutside = useCallback(
    (event: MouseEvent) => {
      if (!menuRef.current) return
      if (!menuRef.current.contains(event.target as globalThis.Node)) onClose()
    },
    [onClose]
  )

  useEffect(() => {
    document.addEventListener('mousedown', closeOnOutside, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    document.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('scroll', onClose, true)
    }
  }, [closeOnOutside, onClose])

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))
    setPos({ left, top })
  }, [x, y])

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button[data-action]:not(:disabled)') ?? []
    )
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(index + 1 + items.length) % items.length].focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(index - 1 + items.length) % items.length].focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0].focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      items[items.length - 1].focus()
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      onClose()
    }
  }

  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button[data-action]:not(:disabled)')
    first?.focus()
  }, [])

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('tree.menuLabel', { name: node.display_name || node.name })}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="hub-pop-in fixed z-50 max-h-[calc(100vh-8px)] min-w-[224px] overflow-auto rounded-lg border p-1 shadow-xl"
      style={{
        left: pos.left,
        top: pos.top,
        borderColor: 'var(--border)',
        backgroundColor: 'var(--panel)',
        color: 'var(--text)'
      }}
    >
      <div className="truncate px-2 py-1 text-[var(--font-tag)] text-[var(--text-dim)]">
        {node.display_name || node.name}
        {missing ? ` · ${t('tree.pathMissing')}` : ''}
      </div>

      {actions.map((action) => (
        <div key={action.id}>
          {action.separatorBefore ? (
            <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />
          ) : null}
          <button
            type="button"
            role="menuitem"
            data-action={action.id}
            disabled={action.disabled}
            title={action.hint}
            onClick={() => {
              if (action.disabled) return
              onClose()
              action.run?.()
            }}
            className={[
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--font-minor)]',
              action.bold ? 'font-semibold' : 'font-normal',
              action.disabled
                ? 'cursor-not-allowed opacity-40'
                : action.danger
                  ? 'hover:bg-[#dc2626] hover:text-white'
                  : 'hover:bg-[var(--hover)]'
            ].join(' ')}
          >
            <span className="w-4 shrink-0 text-[var(--text-dim)]">{action.icon}</span>
            <span className="flex-1 truncate">{action.label}</span>
            {action.disabled && isVirtualGroup && action.id === 'copy' ? (
              <span className="text-[var(--font-tag)]">{t('tree.virtualGroup')}</span>
            ) : null}
          </button>
        </div>
      ))}

      {/* §9.8 — picking a colour keeps the menu open so several can be compared. */}
      <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />
      <div className="px-2 py-1">
        <div className="mb-1 text-[var(--font-tag)] text-[var(--text-dim)]">{t('tree.color')}</div>
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label={t('tree.nodeColor')}
        >
          {NODE_COLORS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="menuitemradio"
              data-color={entry.id}
              aria-checked={currentColor === entry.value}
              aria-label={t(nodeColorKey(entry.id))}
              title={t(nodeColorKey(entry.id))}
              className="focus-ring h-4 w-4 shrink-0 rounded-full border-2"
              style={{
                background: entry.value,
                borderColor: currentColor === entry.value ? 'var(--text)' : 'transparent'
              }}
              onClick={() => {
                setPickedColor(entry.value)
                onChangeColor?.(node, entry.value)
              }}
            />
          ))}
          <button
            type="button"
            role="menuitemradio"
            data-color="none"
            aria-checked={currentColor === null}
            title={t('tree.noCustomColor')}
            className={`btn h-4 shrink-0 px-1.5 py-0 text-[10px] focus-ring ${
              currentColor === null ? 'btn-primary' : ''
            }`}
            onClick={() => {
              setPickedColor(null)
              onChangeColor?.(node, null)
            }}
          >
            {t('color.none')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default ContextMenu
