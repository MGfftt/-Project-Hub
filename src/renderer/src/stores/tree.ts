import { create } from 'zustand'
import type { NodeStats, ScanProgress, TreeNode } from '@shared/types'
import { expandAllOpen, indexById } from '@renderer/lib/tree'

/* ---------------------------------------------------------------------------
 * tree.ts — the project forest, its open map and the per-node stats cache.
 *
 * The store owns `nodes` (the forest) and `open` (which rows are expanded, the
 * same map the keyboard navigation in AppShell walks through). `react-arborist`
 * keeps its own open bookkeeping; both are kept in step by the tree components.
 * ------------------------------------------------------------------------ */

export interface TreeState {
  nodes: TreeNode[]
  byId: Map<number, TreeNode>
  loading: boolean
  error: string | null
  scanProgress: ScanProgress | null
  open: Record<number, boolean>
  focusId: number | null

  load(): Promise<void>
  setOpen(id: number, open: boolean): void
  toggleOpen(id: number): void
  expandAll(): void
  collapseAll(): void

  statsCache: Record<number, NodeStats>
  loadStats(id: number): Promise<NodeStats>

  /** Forces consumers to re-read the forest after a mutation. */
  revision: number
  bump(): void
  setScanProgress(p: ScanProgress | null): void
  setFocus(id: number | null): void
}

const EMPTY_FOREST: TreeNode[] = []

function install(set: (partial: Partial<TreeState>) => void, nodes: TreeNode[]): void {
  set({ nodes, byId: indexById(nodes), loading: false, error: null })
}

export const useTree = create<TreeState>()((set, get) => ({
  nodes: EMPTY_FOREST,
  byId: new Map<number, TreeNode>(),
  loading: false,
  error: null,
  scanProgress: null,
  open: {},
  focusId: null,
  statsCache: {},
  revision: 0,

  load: async () => {
    const hub = window.hub
    if (!hub) {
      set({ loading: false })
      return
    }
    set({ loading: true })
    try {
      const nodes = await hub.nodes.tree()
      const { open } = get()
      const nextOpen: Record<number, boolean> = {}
      // Drop entries for ids that disappeared, and auto-open the first level so
      // a freshly added root is visible without a click (§8.1 expects a tree).
      for (const root of nodes) {
        nextOpen[root.id] = open[root.id] ?? true
      }
      for (const [key, value] of Object.entries(open)) {
        const id = Number(key)
        if (value && !(id in nextOpen)) nextOpen[id] = true
      }
      install(set, nodes)
      set({ open: nextOpen })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '读取项目树失败' })
    }
  },

  setOpen: (id, open) => set({ open: { ...get().open, [id]: open } }),

  toggleOpen: (id) => {
    const { open } = get()
    set({ open: { ...open, [id]: !open[id] } })
  },

  expandAll: () => {
    set({ open: expandAllOpen(get().nodes) })
  },

  collapseAll: () => {
    set({ open: {} })
  },

  loadStats: async (id) => {
    const cached = get().statsCache[id]
    if (cached) return cached
    const hub = window.hub
    if (!hub) throw new Error('window.hub 不可用')
    const stats = await hub.nodes.stats(id)
    set({ statsCache: { ...get().statsCache, [id]: stats } })
    return stats
  },

  bump: () => set({ revision: get().revision + 1 }),
  setScanProgress: (p) => set({ scanProgress: p }),
  setFocus: (id) => set({ focusId: id })
}))
