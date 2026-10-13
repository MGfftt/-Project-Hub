import { create } from 'zustand'
import type { DayCount, EventFilter, HubEvent } from '@shared/types'

/* ---------------------------------------------------------------------------
 * events.ts — the timeline's data, its filter and the heatmap grid.
 *
 * `filter.nodeIds === undefined` means "every node"; the tree's 「查看改动」
 * action narrows it to a node plus its descendants (§8.2).
 * ------------------------------------------------------------------------ */

export type EventZoom = 'day' | 'week' | 'month' | 'quarter' | 'year'

export interface EventsState {
  events: HubEvent[]
  loading: boolean
  error: string | null
  filter: EventFilter
  setFilter(f: EventFilter): void
  /**
   * Narrow the timeline to a node and its descendants — how the selection scopes
   * 改动时间线 — without disturbing the date or source filters the user picked.
   * `null` widens it back to every node.
   */
  setScope(nodeIds: number[] | null): void
  clearFilter(): void
  load(): Promise<void>

  heatmap: DayCount[]
  loadHeatmap(from: number, to: number): Promise<void>

  zoom: EventZoom
  setZoom(z: EventZoom): void

  sync(): Promise<{ synced: number; newEvents: number }>
}

const EMPTY_EVENTS: HubEvent[] = []
const HEATMAP_LIMIT = 2000

export const useEvents = create<EventsState>()((set, get) => ({
  events: EMPTY_EVENTS,
  loading: false,
  error: null,
  filter: {},

  setFilter: (f) => {
    set({ filter: f })
    void get().load()
  },

  setScope: (nodeIds) => {
    const next = { ...get().filter }
    if (nodeIds === null) delete next.nodeIds
    else next.nodeIds = [...nodeIds]
    set({ filter: next })
    void get().load()
  },

  clearFilter: () => {
    set({ filter: {} })
    void get().load()
  },

  load: async () => {
    const hub = window.hub
    if (!hub) {
      set({ loading: false })
      return
    }
    set({ loading: true })
    try {
      const events = await hub.events.list({ limit: 5000, ...get().filter })
      set({ events, loading: false, error: null })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '读取改动记录失败' })
    }
  },

  heatmap: [],
  loadHeatmap: async (from, to) => {
    const hub = window.hub
    if (!hub) return
    try {
      const days = await hub.events.heatmap(from, to)
      set({ heatmap: days.slice(0, HEATMAP_LIMIT) })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '读取热力图失败' })
    }
  },

  zoom: 'month',
  setZoom: (z) => set({ zoom: z }),

  sync: async () => {
    const hub = window.hub
    if (!hub) return { synced: 0, newEvents: 0 }
    try {
      const result = await hub.events.syncAllGit()
      await get().load()
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : '同步 Git 失败'
      set({ error: message })
      throw err instanceof Error ? err : new Error(message)
    }
  }
}))
