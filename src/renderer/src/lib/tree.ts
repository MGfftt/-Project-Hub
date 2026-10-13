/**
 * Pure tree helpers shared by the stores, the shell's keyboard navigation and
 * the panels. Deliberately free of React and of `window.hub` so they can be unit
 * tested in isolation.
 */

import type { TreeNode } from '@shared/types'

export interface FlatRow {
  node: TreeNode
  depth: number
  /** Whether the node has children (hidden or not) and can be collapsed. */
  hasChildren: boolean
  expanded: boolean
}

const EMPTY_CHILDREN: TreeNode[] = []

export function childrenOf(node: TreeNode): TreeNode[] {
  return node.children ?? EMPTY_CHILDREN
}

/** Forest → id map (first wins, so a duplicated id cannot shadow its parent). */
export function indexById(nodes: TreeNode[]): Map<number, TreeNode> {
  const map = new Map<number, TreeNode>()
  const walk = (list: TreeNode[]): void => {
    for (const n of list) {
      if (!map.has(n.id)) map.set(n.id, n)
      const kids = n.children
      if (kids && kids.length > 0) walk(kids)
    }
  }
  walk(nodes)
  return map
}

/** Visible rows in display order — exactly what ↑/↓ should walk (§8.5). */
export function flattenVisible(nodes: TreeNode[], open: Record<number, boolean>): FlatRow[] {
  const out: FlatRow[] = []
  const walk = (list: TreeNode[], depth: number): void => {
    for (const node of list) {
      const kids = childrenOf(node)
      const hasChildren = kids.length > 0
      const expanded = hasChildren && Boolean(open[node.id])
      out.push({ node, depth, hasChildren, expanded })
      if (expanded) walk(kids, depth + 1)
    }
  }
  walk(nodes, 0)
  return out
}

export function indexOfId(rows: FlatRow[], id: number | null): number {
  if (id === null) return -1
  return rows.findIndex((r) => r.node.id === id)
}

/** Walks `parent_id` links up to the owning root (§8.5 Ctrl+R). */
export function rootIdOf(byId: Map<number, TreeNode>, id: number | null): number | null {
  if (id === null) return null
  let current = byId.get(id)
  const seen = new Set<number>()
  while (current && current.parent_id !== null && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.parent_id)
    if (!parent) break
    current = parent
  }
  return current ? current.id : null
}

/** Every open row plus all of its descendants. */
export function expandAllOpen(nodes: TreeNode[]): Record<number, boolean> {
  const open: Record<number, boolean> = {}
  const walk = (list: TreeNode[]): void => {
    for (const n of list) {
      const kids = childrenOf(n)
      if (kids.length > 0) {
        open[n.id] = true
        walk(kids)
      }
    }
  }
  walk(nodes)
  return open
}

/** Ids of a node and every descendant — the filter for 「查看改动」 (§8.2). */
export function descendantIds(node: TreeNode | undefined, byId: Map<number, TreeNode>): number[] {
  if (!node) return []
  const root = byId.get(node.id) ?? node
  const out: number[] = []
  const seen = new Set<number>()
  const walk = (n: TreeNode): void => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    out.push(n.id)
    for (const kid of childrenOf(n)) walk(kid)
  }
  walk(root)
  return out
}

export function kindLabel(kind: TreeNode['kind']): string {
  switch (kind) {
    case 'group':
      return '分组'
    case 'project':
      return '项目'
    case 'folder':
    default:
      return '目录'
  }
}

export function statusLabel(status: TreeNode['status']): string {
  switch (status) {
    case 'active':
      return '活跃'
    case 'paused':
      return '暂停'
    case 'done':
      return '已完成'
    case 'archived':
    default:
      return '已归档'
  }
}

export function displayNameOf(node: TreeNode | undefined | null): string {
  if (!node) return ''
  return node.display_name || node.name
}
