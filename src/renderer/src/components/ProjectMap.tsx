import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Maximize2, Minus, Plus } from 'lucide-react'
import type { TreeNode } from '@shared/types'
import { useTree } from '@renderer/stores/tree'
import { useUi } from '@renderer/stores/ui'
import NodeIcon from '@renderer/components/NodeIcon'
import { kindLabel } from '@renderer/lib/tree'
import { statusColor } from '@renderer/lib/colors'

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
  group: '#a855f7'
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
  const setOpen = useTree((s) => s.setOpen)
  const toggleOpen = useTree((s) => s.toggleOpen)

  const boxRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)
  const autoFitted = useRef(false)

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2 text-[var(--font-minor)] text-[var(--text-dim)]"
        style={{ borderColor: 'var(--border)' }}
      >
        <Legend color={ACCENT.project} label="项目" count={projectCount} />
        <Legend color={ACCENT.group} label="分组" count={groupCount} />
        <Legend color={ACCENT.folder} label="目录" count={folderCount} />
        <span className="flex-1" />
        <span className="hidden sm:inline">单击卡片选中并查看，点箭头展开或收起</span>
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

      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-auto">
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
              const accent = accentFor(node)
              const label = node.display_name || node.name
              return (
                <div
                  key={node.id}
                  data-map-card={node.id}
                  className="absolute flex items-center gap-1.5 rounded-md border pr-1.5 shadow-sm transition-colors"
                  style={{
                    left: x + PAD,
                    top: y + PAD,
                    width: CARD_W,
                    height: CARD_H,
                    borderColor: active ? accent : 'var(--border)',
                    borderLeft: `3px solid ${accent}`,
                    background: active ? 'var(--selected)' : 'var(--card, var(--bg))',
                    boxShadow: active ? `inset 0 0 0 1px ${accent}` : undefined
                  }}
                >
                  {children.length > 0 ? (
                    <button
                      type="button"
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
                    title={node.path ?? `${label}（虚拟分组）`}
                    onClick={() => onCardClick(node)}
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
                        {kindLabel(node.kind)}
                        {children.length > 0 ? ` · ${children.length} 个子节点` : ''}
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
