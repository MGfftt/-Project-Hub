import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { ChevronDown, ChevronRight, Maximize2, Minus, Plus, StickyNote } from 'lucide-react'
import type { TreeNode } from '@shared/types'
import { useTree } from '@renderer/stores/tree'
import { useUi } from '@renderer/stores/ui'
import NodeIcon from '@renderer/components/NodeIcon'
import { descendantIds, kindLabel } from '@renderer/lib/tree'
import { nodeColorValue, statusColor } from '@renderer/lib/colors'

/* ---------------------------------------------------------------------------
 * ProjectMap — the whole library drawn as a tree, not described as text.
 *
 * This is the view the middle column lands on when nothing is selected, and it
 * is reachable at any time from the 全景图 tab. It answers "what do I have?"
 * without requiring the user to click anything first, which is what a plain
 * reading of the project asked for: a graphical, at-a-glance picture.
 *
 * Layout is the classic left-to-right tidy tree, computed in one pass:
 *   · every *visible* leaf takes the next vertical slot;
 *   · a parent sits at the midpoint of its first and last visible child;
 *   · x is simply the depth, so a column reads as one level of the hierarchy.
 *
 * Cards are plain (absolutely positioned) DOM rather than <foreignObject>, so
 * they keep the app's own typography, focus ring and hover states, and only the
 * connectors live in SVG — which is also what keeps a click target reliable.
 * ------------------------------------------------------------------------ */

const CARD_W = 210
const CARD_H = 38
const GAP_X = 58
const GAP_Y = 14
const PAD = 26
const SLOT = CARD_H + GAP_Y
const MAX_CARDS = 4000
const MIN_SCALE = 0.35
const MAX_SCALE = 1.6
/** §9.9 — a card only becomes a drag source after this much pointer travel, so
 *  a plain click still selects instead of starting (and instantly ending) a
 *  one-pixel drag. */
const DRAG_START_PX = 4

/** The floating copy of the card that follows the pointer (§9.9). */
interface MapGhost {
  id: number
  /** Client coordinates of the pointer. */
  x: number
  y: number
  /** Card currently under the pointer, or null when the drop is illegal. */
  over: number | null
}

/** Accent per node family — the marker's ecosystem when we know it. */
const ACCENT: Record<string, string> = {
  git: '#3b82f6',
  node: '#22c55e',
  python: '#eab308',
  rust: '#f97316',
  go: '#06b6d4',
  java: '#ef4444',
  php: '#8b5cf6',
  ruby: '#ec4899',
  dotnet: '#6366f1',
  xcode: '#0ea5e9',
  cmake: '#64748b',
  generic: '#94a3b8',
  project: '#3b82f6',
  folder: '#94a3b8',
  group: '#a855f7',
  note: '#f59e0b'
}

interface Placed {
  node: TreeNode
  depth: number
  x: number
  y: number
  children: TreeNode[]
  expanded: boolean
}

export function accentFor(node: TreeNode): string {
  const meta = (node.meta ?? {}) as Record<string, unknown>
  const projectKind = typeof meta.projectKind === 'string' ? meta.projectKind : null
  if (projectKind && ACCENT[projectKind]) return ACCENT[projectKind]
  return ACCENT[node.kind] ?? ACCENT.generic
}

function layoutForest(
  forest: TreeNode[],
  isOpen: (id: number) => boolean
): { placed: Placed[]; width: number; height: number } {
  const placed: Placed[] = []
  let cursor = 0
  let maxDepth = 0

  const walk = (node: TreeNode, depth: number): number => {
    const kids = Array.isArray(node.children) ? node.children : []
    const expanded = kids.length > 0 && isOpen(node.id)
    if (depth > maxDepth) maxDepth = depth

    let y: number
    if (expanded) {
      const ys = kids.map((kid) => walk(kid, depth + 1))
      y = (ys[0] + ys[ys.length - 1]) / 2
    } else {
      y = cursor
      cursor += SLOT
    }
    placed.push({ node, depth, x: depth * (CARD_W + GAP_X), y, children: kids, expanded })
    return y
  }

  for (const root of forest) {
    if (placed.length >= MAX_CARDS) break
    walk(root, 0)
    /* a little breathing room between two roots */
    cursor += GAP_Y * 2
  }

  return {
    placed,
    width: Math.max(1, (maxDepth + 1) * (CARD_W + GAP_X) - GAP_X) + PAD * 2,
    height: Math.max(SLOT, cursor - GAP_Y) + PAD * 2
  }
}

function connector(from: Placed, to: Placed): string {
  const x1 = from.x + CARD_W + PAD
  const y1 = from.y + CARD_H / 2 + PAD
  const x2 = to.x + PAD
  const y2 = to.y + CARD_H / 2 + PAD
  const mid = Math.max(16, (x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`
}

export function ProjectMap(): JSX.Element {
  const nodes = useTree((s) => s.nodes)
  const open = useTree((s) => s.open)
  const select = useUi((s) => s.select)
  const setMainView = useUi((s) => s.setMainView)
  const selectedId = useUi((s) => s.selectedId)
  const setStatus = useUi((s) => s.setStatus)
  const setOpen = useTree((s) => s.setOpen)
  const toggleOpen = useTree((s) => s.toggleOpen)

  const boxRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)
  const autoFitted = useRef(false)

  /* §9.9 drag state. The live drop target is kept in a ref as well as in state:
   * `pointermove` updates arrive faster than React commits, and `pointerup` must
   * read the target that the *last* move computed, not the last rendered one. */
  const [ghost, setGhost] = useState<MapGhost | null>(null)
  const pendingDrag = useRef<{ id: number; x: number; y: number } | null>(null)
  const liveDrag = useRef<{ id: number; over: number | null } | null>(null)
  const justDragged = useRef(false)

  const isOpen = useCallback((id: number) => open[id] === true || open[id] === undefined, [open])

  const { placed, width, height } = useMemo(
    () => layoutForest(nodes, isOpen),
    [nodes, isOpen]
  )

  /* Fit to the column once the tree is known — a wide forest is unreadable at
   * 100%, and the user can still zoom afterwards. */
  useEffect(() => {
    if (autoFitted.current || placed.length === 0) return
    const box = boxRef.current
    if (!box) return
    const next = Math.min(1, Math.max(MIN_SCALE, (box.clientWidth - 16) / width))
    autoFitted.current = true
    setScale(next)
  }, [placed.length, width])

  const zoom = useCallback((delta: number) => {
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((s + delta) * 100) / 100)))
  }, [])

  const fit = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    setScale(Math.min(1, Math.max(MIN_SCALE, (box.clientWidth - 16) / width)))
  }, [width])

  const onCardClick = useCallback(
    (node: TreeNode) => {
      select(node.id)
      setMainView('overview')
    },
    [select, setMainView]
  )

  const byId = useMemo(() => new Map(placed.map((p) => [p.node.id, p])), [placed])

  /* --- §9.9 dragging a card onto another card ------------------------ */

  /**
   * The card under the pointer, or `null` when dropping there is illegal.
   *
   * Three rules, all enforced here rather than only visually: a node cannot be
   * dropped onto itself, it cannot be dropped into its own subtree (that would
   * detach the subtree from the forest and orphan it), and a note — an
   * annotation, not a container — never accepts children.
   */
  const dropTargetAt = useCallback((x: number, y: number, fromId: number): number | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    const card = el?.closest('[data-map-card]') as HTMLElement | null
    if (!card) return null
    const id = Number(card.dataset.mapCard)
    if (!Number.isInteger(id) || id === fromId) return null
    const current = useTree.getState().byId
    const from = current.get(fromId)
    if (!from) return null
    if (descendantIds(from, current).includes(id)) return null
    if (current.get(id)?.kind === 'note') return null
    return id
  }, [])

  const onCardPointerDown = (node: TreeNode, e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    // The expander and the +N pill are controls; a drag must not start on them.
    if ((e.target as HTMLElement).closest('[data-map-nodrag]')) return
    pendingDrag.current = { id: node.id, x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onCardPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const start = pendingDrag.current
    if (!start) return
    if (liveDrag.current === null) {
      const travel = Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y)
      if (travel <= DRAG_START_PX) return
      liveDrag.current = { id: start.id, over: null }
    }
    const over = dropTargetAt(e.clientX, e.clientY, start.id)
    liveDrag.current.over = over
    setGhost({ id: start.id, x: e.clientX, y: e.clientY, over })
  }

  const onCardPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const start = pendingDrag.current
    const moved = liveDrag.current
    pendingDrag.current = null
    liveDrag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (!start || moved === null) return
    setGhost(null)
    /* The click event fires after pointerup, so the flag has to survive until
     * the next task — clearing it synchronously would let a real drag that
     * ended where it began also select the card. */
    justDragged.current = true
    window.setTimeout(() => {
      justDragged.current = false
    }, 0)
    const target = moved.over
    if (target === null) return
    void window.hub?.nodes
      .move(start.id, target, 0)
      .then(() => {
        setStatus('已移动节点', 'info')
        return useTree.getState().load()
      })
      .catch((err: unknown) => setStatus(`移动失败：${String(err)}`, 'error'))
  }

  /* Escape abandons a drag that is already in flight. Registered once — the
   * handler reads the ref, so it never needs to re-bind as the ghost moves. */
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape' || liveDrag.current === null) return
      pendingDrag.current = null
      liveDrag.current = null
      setGhost(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (nodes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-10">
        <div className="card max-w-[420px] p-6 text-center">
          <div className="mb-2 text-[15px] font-medium">还没有任何项目</div>
          <p className="text-[var(--font-minor)] leading-relaxed text-[var(--text-dim)]">
            用左上角的「根目录」按钮添加一个文件夹，它就会作为一棵树出现在这里。
            文件夹里有没有 Git 都可以 —— 之后再 <code>git init</code>，下一次扫描也会认出来。
          </p>
        </div>
      </div>
    )
  }

  const projectCount = placed.filter((p) => p.node.kind === 'project').length
  const groupCount = placed.filter((p) => p.node.kind === 'group').length
  const folderCount = placed.filter((p) => p.node.kind === 'folder').length
  const noteCount = placed.filter((p) => p.node.kind === 'note').length

  /** Annotate whatever is selected, so the map is a place to think, not just look. */
  function addNote(): void {
    void window.hub?.nodes
      .createNote(selectedId, '')
      .then((id) => {
        setStatus('已添加备注，写好内容后它会挂在这个节点下面', 'info')
        return useTree.getState().load().then(() => {
          if (selectedId != null) useTree.getState().setOpen(selectedId, true)
          select(id)
        })
      })
      .catch((err: unknown) => setStatus(`添加备注失败：${String(err)}`, 'error'))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2 text-[var(--font-minor)] text-[var(--text-dim)]"
        style={{ borderColor: 'var(--border)' }}
      >
        <Legend color={ACCENT.project} label="项目" count={projectCount} />
        <Legend color={ACCENT.group} label="分组" count={groupCount} />
        <Legend color={ACCENT.folder} label="目录" count={folderCount} />
        {noteCount > 0 ? <Legend color={ACCENT.note} label="备注" count={noteCount} /> : null}
        <span className="flex-1" />
        <button
          type="button"
          className="btn"
          title={
            selectedId == null
              ? '先选一个节点，备注就会挂在它下面'
              : '在当前选中的节点下添加一条备注'
          }
          onClick={addNote}
        >
          <StickyNote size={13} aria-hidden />
          添加备注
        </button>
        <span className="hidden sm:inline">单击卡片查看，点箭头展开，拖动卡片可换父节点</span>
        <span className="flex items-center gap-1">
          <button type="button" className="btn btn-ghost" title="缩小" onClick={() => zoom(-0.1)}>
            <Minus size={13} aria-hidden />
          </button>
          <span className="w-10 text-center tabular-nums">{Math.round(scale * 100)}%</span>
          <button type="button" className="btn btn-ghost" title="放大" onClick={() => zoom(0.1)}>
            <Plus size={13} aria-hidden />
          </button>
          <button type="button" className="btn btn-ghost" title="适应宽度" onClick={fit}>
            <Maximize2 size={13} aria-hidden />
          </button>
        </span>
      </div>

      <div
        ref={boxRef}
        className={
          /* Selecting text mid-drag would highlight half the map. */
          'relative min-h-0 flex-1 overflow-auto' + (ghost === null ? '' : ' select-none')
        }
      >
        <div style={{ width: width * scale, height: height * scale, position: 'relative' }}>
          <div
            style={{
              width,
              height,
              position: 'relative',
              transform: `scale(${scale})`,
              transformOrigin: 'top left'
            }}
          >
            <svg
              className="pointer-events-none absolute inset-0"
              width={width}
              height={height}
              aria-hidden
            >
              {placed.map((parent) =>
                parent.expanded
                  ? parent.children.map((child) => {
                      const to = byId.get(child.id)
                      if (!to) return null
                      return (
                        <path
                          key={`${parent.node.id}-${child.id}`}
                          d={connector(parent, to)}
                          fill="none"
                          stroke="var(--border)"
                          strokeWidth={1.5}
                        />
                      )
                    })
                  : null
              )}
            </svg>

            {placed.map(({ node, x, y, children, expanded }) => {
              const active = selectedId === node.id
              /* §9.8 — a colour the user set wins over the kind/ecosystem hue. */
              const accent = nodeColorValue(node.color) ?? accentFor(node)
              const label = node.display_name || node.name
              const dropping = ghost !== null && ghost.over === node.id
              const lifted = ghost !== null && ghost.id === node.id
              return (
                <div
                  key={node.id}
                  data-map-card={node.id}
                  className="absolute flex cursor-grab items-center gap-1.5 rounded-md border pr-1.5 shadow-sm transition-colors"
                  onPointerDown={(e) => onCardPointerDown(node, e)}
                  onPointerMove={onCardPointerMove}
                  onPointerUp={onCardPointerUp}
                  onPointerCancel={onCardPointerUp}
                  style={{
                    left: x + PAD,
                    top: y + PAD,
                    width: CARD_W,
                    height: CARD_H,
                    borderColor: active || dropping ? accent : 'var(--border)',
                    borderLeft: `3px solid ${accent}`,
                    background: dropping
                      ? `${accent}1f`
                      : active
                        ? 'var(--selected)'
                        : 'var(--card, var(--bg))',
                    boxShadow: dropping
                      ? `inset 0 0 0 2px ${accent}`
                      : active
                        ? `inset 0 0 0 1px ${accent}`
                        : undefined,
                    opacity: lifted ? 0.4 : 1
                  }}
                >
                  {children.length > 0 ? (
                    <button
                      type="button"
                      data-map-nodrag
                      onPointerDown={(e) => e.stopPropagation()}
                      className="focus-ring ml-0.5 -mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--hover)]"
                      aria-expanded={expanded}
                      title={expanded ? '收起' : `展开（${children.length} 个子节点）`}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleOpen(node.id)
                      }}
                    >
                      {expanded ? (
                        <ChevronDown size={13} aria-hidden />
                      ) : (
                        <ChevronRight size={13} aria-hidden />
                      )}
                    </button>
                  ) : (
                    <span className="ml-1 w-3 shrink-0" />
                  )}

                  <button
                    type="button"
                    data-map-label={node.id}
                    className="focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 py-0.5 text-left"
                    title={
                      node.path ??
                      (node.kind === 'note'
                        ? `备注：${String((node.meta?.text as string) ?? '') || '（空白）'}`
                        : `${label}（虚拟分组）`)
                    }
                    onClick={() => {
                      /* A drag that ended on its own card must not also select. */
                      if (justDragged.current) return
                      onCardClick(node)
                    }}
                  >
                    <span
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
                      style={{ background: `${accent}22`, color: accent }}
                    >
                      <NodeIcon node={node} size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] leading-4">{label}</span>
                      <span className="block truncate text-[10px] leading-3 text-[var(--text-dim)]">
                        {node.kind === 'note'
                          ? String((node.meta?.text as string) ?? '').split(/\r?\n/)[0] || '空白备注'
                          : kindLabel(node.kind)}
                        {node.kind !== 'note' && children.length > 0
                          ? ` · ${children.length} 个子节点`
                          : ''}
                      </span>
                    </span>
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        background: statusColor(node.status),
                        opacity: node.path_missing === 1 ? 0.35 : 1
                      }}
                      aria-hidden
                    />
                  </button>

                  {!expanded && children.length > 0 ? (
                    <button
                      type="button"
                      data-map-nodrag
                      onPointerDown={(e) => e.stopPropagation()}
                      className="focus-ring -ml-1 shrink-0 rounded-full border px-1 text-[10px] leading-4 text-[var(--text-dim)]"
                      style={{ borderColor: 'var(--border)' }}
                      title={`已收起 ${children.length} 个子节点`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpen(node.id, true)
                      }}
                    >
                      +{children.length}
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>

        {/* §9.9 — the card being dragged, as a fixed-size copy that follows the
            pointer. It sits outside the scaled wrapper so it keeps its own size
            at any zoom, and it is `pointer-events-none` so the hit test under it
            still reaches the card the user is hovering. */}
        {ghost === null
          ? null
          : (() => {
              const dragged = placed.find((p) => p.node.id === ghost.id)?.node ?? null
              const box = boxRef.current
              const rect = box?.getBoundingClientRect()
              const left = ghost.x - (rect?.left ?? 0) + (box?.scrollLeft ?? 0)
              const top = ghost.y - (rect?.top ?? 0) + (box?.scrollTop ?? 0)
              const draggedAccent = dragged
                ? nodeColorValue(dragged.color) ?? accentFor(dragged)
                : 'var(--border)'
              return (
                <div
                  data-map-ghost={ghost.id}
                  className="pointer-events-none absolute z-20 flex max-w-[240px] items-center gap-1.5 rounded-md border px-2 py-1 shadow-lg"
                  style={{
                    left: left + 14,
                    top: top + 10,
                    borderColor: draggedAccent,
                    borderLeft: `3px solid ${draggedAccent}`,
                    background: 'var(--panel)',
                    transform: `scale(${Math.max(0.75, Math.min(1, scale))})`,
                    transformOrigin: 'top left'
                  }}
                >
                  <span className="min-w-0 truncate text-[12px]">
                    {dragged ? dragged.display_name || dragged.name : '节点'}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--text-dim)]">
                    {ghost.over === null ? '拖到另一个节点上' : '松开即可移入'}
                  </span>
                </div>
              )
            })()}
      </div>
    </div>
  )
}

function Legend({ color, label, count }: { color: string; label: string; count: number }): JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} aria-hidden />
      {label}
      <span className="tabular-nums">{count}</span>
    </span>
  )
}

export default ProjectMap
