import { create } from 'zustand'
import type { BackgroundStatus, TrayState } from '@shared/types'
import { applyResolvedTheme, type ThemePref } from '@renderer/lib/theme'

/* ---------------------------------------------------------------------------
 * ui.ts — view state, selection, panel geometry, dialogs and verbosity.
 *
 * Cross-store rules (contract §3):
 *   · nothing is imported from another store at module scope;
 *   · inside an action we reach for `useTree.getState()` / `useEvents.getState()`.
 *
 * Settings persistence: the frozen `SETTING_KEYS` covers the boolean/theme prefs.
 * Panel widths have no frozen key, so they persist under the documented `ui.*`
 * prefix instead of widening the shared key table.
 * ------------------------------------------------------------------------ */

export const PANEL_SETTING_KEYS = {
  leftWidth: 'ui.leftWidth',
  rightWidth: 'ui.rightWidth'
} as const

/** §9.1 — three-column widths and their drag limits. */
export const LEFT_WIDTH_DEFAULT = 320
export const LEFT_WIDTH_MIN = 240
export const LEFT_WIDTH_MAX = 480
export const RIGHT_WIDTH_DEFAULT = 360
export const RIGHT_WIDTH_MIN = 280
export const RIGHT_WIDTH_MAX = 520

export type MainView = 'tree' | 'timeline' | 'settings'
export type DialogKind = 'stats' | 'icon' | 'settings' | 'confirm'
export type StatusTone = 'info' | 'warn' | 'error'

export interface StatusMessage {
  text: string
  tone: StatusTone
  at: number
}

export interface UiState {
  mainView: MainView
  setMainView(v: MainView): void

  selectedId: number | null
  select(id: number | null): void

  /** Open map for the "expand all" affordance; react-arborist keeps its own. */
  expanded: Record<number, boolean>

  detailOpen: boolean
  setDetailOpen(open: boolean): void

  leftWidth: number
  rightWidth: number
  setLeftWidth(w: number, persist?: boolean): void
  setRightWidth(w: number, persist?: boolean): void

  compactMode: boolean
  setCompactMode(v: boolean): void

  clickToOpen: boolean
  setClickToOpen(v: boolean): void

  theme: ThemePref
  setTheme(t: ThemePref): void

  dialog: DialogKind | null
  dialogNodeId: number | null
  openDialog(d: DialogKind, nodeId?: number | null): void
  closeDialog(): void

  /** Transient StatusBar text; auto-cleared by StatusBar after 6s. */
  status: StatusMessage | null
  setStatus(text: string, tone?: StatusTone): void
  clearStatus(): void

  /* --- additive to the frozen §3 shape, needed by StatusBar ---------------- */
  background: BackgroundStatus | null
  setBackground(s: BackgroundStatus): void
  tray: TrayState | null
  setTray(t: TrayState): void

  /** Pulls the persisted preferences into the store (called once by AppShell). */
  hydrate(): Promise<void>
}

export const clampLeftWidth = (w: number): number =>
  Math.min(LEFT_WIDTH_MAX, Math.max(LEFT_WIDTH_MIN, Math.round(w)))

export const clampRightWidth = (w: number): number =>
  Math.min(RIGHT_WIDTH_MAX, Math.max(RIGHT_WIDTH_MIN, Math.round(w)))

async function persist(key: string, value: string): Promise<void> {
  const hub = window.hub
  if (!hub) return
  try {
    await hub.settings.set(key, value)
  } catch {
    /* a failed preference write must never break the interaction that caused it */
  }
}

export const useUi = create<UiState>()((set, get) => ({
  mainView: 'tree',
  setMainView: (v) => set({ mainView: v }),

  selectedId: null,
  select: (id) => set({ selectedId: id }),

  expanded: {},

  detailOpen: true,
  setDetailOpen: (open) => set({ detailOpen: open }),

  leftWidth: LEFT_WIDTH_DEFAULT,
  rightWidth: RIGHT_WIDTH_DEFAULT,
  setLeftWidth: (w, save: boolean = false) => {
    const next = clampLeftWidth(w)
    if (get().leftWidth === next) return
    set({ leftWidth: next })
    if (save) void persist(PANEL_SETTING_KEYS.leftWidth, String(next))
  },
  setRightWidth: (w, save: boolean = false) => {
    const next = clampRightWidth(w)
    if (get().rightWidth === next) return
    set({ rightWidth: next })
    if (save) void persist(PANEL_SETTING_KEYS.rightWidth, String(next))
  },

  compactMode: false,
  setCompactMode: (v) => {
    set({ compactMode: v })
    void persist('compactMode', v ? 'true' : 'false')
  },

  clickToOpen: true,
  setClickToOpen: (v) => {
    set({ clickToOpen: v })
    void persist('clickToOpen', v ? 'true' : 'false')
  },

  theme: 'system',
  setTheme: (t) => {
    set({ theme: t })
    applyResolvedTheme(t)
    void persist('theme', t)
  },

  dialog: null,
  dialogNodeId: null,
  openDialog: (d, nodeId = null) => set({ dialog: d, dialogNodeId: nodeId ?? get().selectedId }),
  closeDialog: () => set({ dialog: null, dialogNodeId: null }),

  status: null,
  setStatus: (text, tone: StatusTone = 'info') => set({ status: { text, tone, at: Date.now() } }),
  clearStatus: () => set({ status: null }),

  background: null,
  setBackground: (s) => set({ background: s }),
  tray: null,
  setTray: (t) => set({ tray: t }),

  hydrate: async () => {
    const hub = window.hub
    if (!hub) return
    try {
      const all = await hub.settings.all()
      const themeRaw = all.theme ?? all[('theme' as string) as keyof typeof all]
      const theme: ThemePref =
        themeRaw === 'light' || themeRaw === 'dark' || themeRaw === 'system' ? themeRaw : 'system'
      const left = Number(all[PANEL_SETTING_KEYS.leftWidth])
      const right = Number(all[PANEL_SETTING_KEYS.rightWidth])
      set({
        theme,
        compactMode: all.compactMode === 'true',
        clickToOpen: all.clickToOpen !== 'false',
        leftWidth: Number.isFinite(left) && left > 0 ? clampLeftWidth(left) : get().leftWidth,
        rightWidth: Number.isFinite(right) && right > 0 ? clampRightWidth(right) : get().rightWidth
      })
      applyResolvedTheme(theme)
    } catch {
      /* first launch or an unreadable DB: the defaults above are already valid */
    }
  }
}))
