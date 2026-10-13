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
  FolderOpen,
  Trash2
} from 'lucide-react'
import type { TreeNode } from '@shared/types'

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
  onNewGroup?: (node: TreeNode) => void
  onRemove?: (node: TreeNode) => void
}

const ICON_SIZE = 14

export function ContextMenu({
  node,
  x,
  y,
  onClose,
  onOpenFolder,
  onReveal,
  onCopyPath,
  onViewChanges,
  onProperties,
  onAnnotate,
  onRename,
  onChangeIcon,
  onNewGroup,
  onRemove
}: ContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  const isVirtualGroup = node.kind === 'group' && !node.path
  const missing = node.path_missing === 1
  const noDiskPath = !node.path || missing
  /* §8.2 — a disabled 打开/在文件管理器中显示 explains itself on hover. */
  const noDiskHint = missing ? '路径不存在' : !node.path ? '分组没有对应的磁盘目录' : undefined

  const actions: ContextMenuAction[] = [
    {
      id: 'open',
      label: '打开文件夹',
      icon: <FolderOpen size={ICON_SIZE} aria-hidden />,
      bold: true,
      disabled: noDiskPath,
      hint: noDiskHint,
      run: () => onOpenFolder?.(node)
    },
    {
      id: 'reveal',
      label: '在文件管理器中显示',
      icon: <MapPin size={ICON_SIZE} aria-hidden />,
      disabled: noDiskPath,
      hint: noDiskHint,
      run: () => onReveal?.(node)
    },
    {
      id: 'copy',
      label: '复制路径',
      icon: <Copy size={ICON_SIZE} aria-hidden />,
      disabled: node.path == null,
      run: () => onCopyPath?.(node)
    },
    {
      id: 'changes',
      label: '查看改动',
      icon: <BarChart3 size={ICON_SIZE} aria-hidden />,
      separatorBefore: true,
      run: () => onViewChanges?.(node)
    },
    {
      id: 'props',
      label: '属性',
      icon: <Info size={ICON_SIZE} aria-hidden />,
      run: () => onProperties?.(node)
    },
    {
      id: 'note',
      label: '标注',
      icon: <NotebookPen size={ICON_SIZE} aria-hidden />,
      run: () => onAnnotate?.(node)
    },
    {
      id: 'rename',
      label: '重命名（程序内）',
      icon: <Pencil size={ICON_SIZE} aria-hidden />,
      separatorBefore: true,
      hint: '仅修改程序内显示名，不会修改磁盘目录名',
      run: () => onRename?.(node)
    },
    {
      id: 'icon',
      label: '更改图标',
      icon: <Palette size={ICON_SIZE} aria-hidden />,
      run: () => onChangeIcon?.(node)
    },
    {
      id: 'group',
      label: '新建子分组',
      icon: <FolderPlus size={ICON_SIZE} aria-hidden />,
      separatorBefore: true,
      run: () => onNewGroup?.(node)
    },
    {
      id: 'remove',
      label: '从库中移除',
      icon: <Trash2 size={ICON_SIZE} aria-hidden />,
      danger: true,
      hint: '仅从本程序移除，磁盘文件保持不变',
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
      aria-label={`${node.display_name || node.name} 的操作`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="hub-pop-in fixed z-50 min-w-[224px] rounded-lg border p-1 shadow-xl"
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
        {missing ? ' · 路径不存在' : ''}
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
              <span className="text-[var(--font-tag)]">虚拟分组</span>
            ) : null}
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}

export default ContextMenu
