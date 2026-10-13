import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { NodeApi } from 'react-arborist'
import { ChevronRight, Pencil } from 'lucide-react'
import type { TreeNode } from '@shared/types'
import { NodeIcon } from '@renderer/components/NodeIcon'
import { tagStyle } from '@renderer/lib/colors'
import { formatRelativeTime } from '@renderer/lib/format'
import { useTree } from '@renderer/stores/tree'

/* ---------------------------------------------------------------------------
 * NodeRow — the frozen row layout of §9.2:
 *
 *   [▸] [icon+dot] display name  [tag][tag][tag] +N
 *
 * react-arborist wraps this in its own `role="treeitem"` row that already owns
 * selection, aria state, focus and the click handler, so this component renders
 * only the row's *content* and re-uses the library's `style` (which carries the
 * 16px-per-level indent of §9.3).
 *
 * It does own two things the library would otherwise get wrong for this spec:
 * Enter and Space are handled here and stopped from reaching the library's own
 * key handler, which would otherwise use Enter for "start editing" (§8.5).
 * ------------------------------------------------------------------------ */

export interface NodeRowProps {
  node: NodeApi<TreeNode>
  /** Positioning style handed down by react-arborist (indent lives here). */
  style?: React.CSSProperties
  /**
   * react-arborist's drag handle is a *ref callback*, not an element: attaching
   * it to the row's root element is the only thing that makes the row draggable
   * (§7.8 drag-and-drop).
   */
  dragHandle?: (el: HTMLDivElement | null) => void
  compact?: boolean
  selected?: boolean
  onContextMenu?: (node: TreeNode, event: React.MouseEvent) => void
  /** `click` for pointer activation, `key` for an explicit Space/Enter. */
  onActivate?: (source: 'click' | 'key') => void
}

/** §8.3 — the frozen inline-rename hint. */
export const RENAME_HINT = '仅在本程序中显示，不会修改磁盘目录名'

/** At most this many tag pills are shown; the rest collapse into `+N` (§9.2). */
const MAX_VISIBLE_TAGS = 3

/** Live rename validation (§8.3): empty clears the alias, 64 chars is the cap. */
export const DISPLAY_NAME_MAX = 64

/** §9.3 — must match `indent` on `<Tree>` in NodeTree.tsx: the indent guides
 *  are positioned from this number, not from the padding react-arborist adds. */
const INDENT = 16

function Expander({
  open,
  leaf,
  onToggle
}: {
  open: boolean
  leaf: boolean
  onToggle: () => void
}): JSX.Element {
  if (leaf) return <span className="h-4 w-4 shrink-0" aria-hidden />
  return (
    <span
      role="button"
      aria-label={open ? '折叠' : '展开'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-dim)] hover:text-[var(--text)]"
    >
      <ChevronRight
        size={14}
        className={'transition-transform duration-150' + (open ? ' rotate-90' : '')}
      />
    </span>
  )
}

export const NodeRow = memo(function NodeRow({
  node,
  style,
  dragHandle,
  compact = false,
  selected = false,
  onContextMenu,
  onActivate
}: NodeRowProps): JSX.Element {
  const data = node.data
  const [localEditing, setLocalEditing] = useState(false)
  /* §8.3 — renaming can also be started by arborist itself (F2 → tree.edit(),
   * or the 重命名 context-menu item), so the input renders for either source. */
  const editing = localEditing || node.isEditing
  const [draft, setDraft] = useState(data.display_name ?? '')
  const inputRef = useRef<HTMLInputElement | null>(null)

  /* §9.2 relative time: the node's newest event, falling back to the row's own
   * modification stamp so the column is never blank. A primitive selector keeps
   * this subscription from re-rendering rows whose stats did not change. */
  const lastEventAt = useTree((s) => s.statsCache[data.id]?.lastEventAt ?? null)
  const stampLabel = formatRelativeTime(lastEventAt ?? data.updated_at)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const leaf = node.isLeaf
  const isVirtualGroup = data.kind === 'group' && !data.path

  const title = useMemo(() => {
    const parts = [data.display_name || data.name]
    if (data.path) parts.push(data.path)
    else if (data.kind === 'note') parts.push(String((data.meta?.text as string) ?? '') || '空白备注')
    else if (isVirtualGroup) parts.push('虚拟分组（无磁盘目录）')
    parts.push(data.kind === 'note' ? '单击查看 · 双击展开或折叠' : '单击查看 · 双击展开或打开目录')
    return parts.join('\n')
  }, [data.display_name, data.name, data.path, data.kind, data.meta, isVirtualGroup])

  const tags = useMemo(() => {
    const list = Array.isArray(data.tags) ? data.tags : []
    return {
      shown: list.slice(0, MAX_VISIBLE_TAGS),
      hidden: Math.max(0, list.length - MAX_VISIBLE_TAGS),
      all: list.join('、')
    }
  }, [data.tags])

  /* §9.2 — a collapsed parent advertises how much sits inside it. */
  const childCount = Array.isArray(data.children) ? data.children.length : 0

  function commit(): void {
    const value = draft.trim().slice(0, DISPLAY_NAME_MAX)
    setLocalEditing(false)
    /* Leaves arborist's own edit state whatever started it (an empty string is
     * passed through as null by the store, falling back to the disk name). */
    node.reset()
    // Only ever the in-app alias; the disk directory is never renamed (§8.3).
    // Reload so the row (and every other view) picks up the new alias.
    void window.hub.nodes
      .setDisplayName(data.id, value || null)
      .then(() => useTree.getState().load())
      .catch(() => undefined)
  }

  return (
    <div
      ref={dragHandle}
      title={title}
      style={style}
      data-node-id={data.id}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu?.(data, e)
      }}
      onAuxClick={(e) => {
        /* §8.5 — middle click reveals in the OS file manager. The DOM event
           lands on the row, so it is handled where the node id is known. */
        if (e.button !== 1 || !data.path) return
        e.preventDefault()
        e.stopPropagation()
        const hub = window.hub
        if (hub) void hub.shell.revealFolder(data.id).catch(() => undefined)
      }}
      onKeyDown={(e) => {
        /* §8.5 — Enter opens, Space toggles. Both must not reach arborist,
           which uses Enter to begin editing and Space to activate. */
        if (editing) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          onActivate?.('key')
        }
      }}
      className={[
        'relative flex h-full w-full items-center gap-1.5 pr-2 text-[var(--font-main)]',
        compact ? 'row-compact' : 'row',
        selected ? 'row-selected' : 'row-hover',
        data.status === 'archived' ? 'opacity-60 grayscale' : '',
        data.path_missing === 1 ? 'opacity-70' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Indent guides. react-arborist pads the row by `indent * level`, so one
          hairline per ancestor level (drawn at the centre of that level's
          expander column) turns the flat list into a readable tree. */}
      {node.level > 0
        ? Array.from({ length: node.level }, (_, i) => (
            <span
              key={`guide-${i}`}
              aria-hidden
              className="pointer-events-none absolute"
              style={{
                left: INDENT * i + INDENT / 2,
                top: 0,
                bottom: 0,
                width: 1,
                background: 'var(--border)'
              }}
            />
          ))
        : null}

      <Expander open={node.isOpen} leaf={leaf} onToggle={() => node.toggle()} />

      <span className={isVirtualGroup ? 'text-[var(--accent)]' : 'text-[var(--text-dim)]'}>
        <NodeIcon node={data} size={16} withStatus />
      </span>

      {editing ? (
        <input
          ref={inputRef}
          className="input h-6 flex-1 py-0 text-[var(--font-main)]"
          value={draft}
          maxLength={DISPLAY_NAME_MAX}
          title={RENAME_HINT}
          aria-label="重命名显示名称"
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setLocalEditing(false)
              setDraft(data.display_name ?? '')
              node.reset()
            }
            e.stopPropagation()
          }}
        />
      ) : (
        <span
          className={
            'truncate ' +
            (node.level === 0 ? 'font-semibold' : 'font-normal') +
            /* §9.2 — a missing path greys the name out; never a strikethrough. */
            (data.path_missing === 1 ? ' text-[var(--text-dim)]' : '')
          }
        >
          {data.display_name || data.name}
        </span>
      )}

      {!node.isOpen && childCount > 0 ? (
        <span
          className="shrink-0 rounded-full bg-[var(--hover)] px-1.5 text-[10px] leading-4 text-[var(--text-dim)]"
          title={`${childCount} 个直接子节点，展开即可看到`}
        >
          {childCount}
        </span>
      ) : null}

      {data.status === 'paused' ? (
        <span className="tag tag-warn shrink-0">已暂停</span>
      ) : data.status === 'done' ? (
        <span className="tag tag-ok shrink-0">已完成</span>
      ) : null}

      {tags.shown.map((tag) => (
        <span key={tag} className="tag shrink-0" style={tagStyle(tag)} title={tag}>
          {tag}
        </span>
      ))}
      {tags.hidden > 0 ? (
        <span className="tag shrink-0 bg-[var(--hover)] text-[var(--text-dim)]" title={tags.all}>
          +{tags.hidden}
        </span>
      ) : null}

      {/* §9.2 — tags, then the relative time at the row's right edge. */}
      <span
        className="shrink-0 text-[var(--font-minor)] text-[var(--text-dim)]"
        title={`最近改动：${stampLabel}`}
      >
        {stampLabel}
      </span>

      <span className="flex-1" />

      {!editing ? (
        <span
          role="button"
          aria-label="重命名"
          title="重命名（程序内，不会修改磁盘目录名）"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            setDraft(data.display_name ?? '')
            setLocalEditing(true)
          }}
          className="inline-flex shrink-0 cursor-pointer items-center rounded px-1 text-[var(--text-dim)] opacity-0 hover:text-[var(--text)] focus:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Pencil size={12} aria-hidden />
        </span>
      ) : null}
    </div>
  )
})

export default NodeRow
