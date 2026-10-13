import { create } from 'zustand'
import { DEFAULT_SETTINGS, SETTING_KEYS } from '@shared/types'

/* ---------------------------------------------------------------------------
 * settings.ts — a thin, cached mirror of the `settings` table.
 *
 * Reads and writes always go through `SETTING_KEYS`; nothing in the renderer may
 * invent a literal key (§2 of the contract). Unknown keys still round-trip, which
 * is what the preload API allows.
 * ------------------------------------------------------------------------ */

export interface SettingsState {
  values: Record<string, string>
  loading: boolean
  error: string | null
  load(): Promise<void>
  set(key: string, value: string): Promise<void>
  get(key: string, fallback?: string): string
  /** True when `key` is on at launch (defaults come from `DEFAULT_SETTINGS`). */
  flag(key: string): boolean
}

export const settingsDefaults = DEFAULT_SETTINGS
export { SETTING_KEYS }

export const useSettings = create<SettingsState>()((set, get) => ({
  values: { ...DEFAULT_SETTINGS },
  loading: false,
  error: null,

  load: async () => {
    const hub = window.hub
    if (!hub) return
    set({ loading: true })
    try {
      const values = await hub.settings.all()
      set({ values: { ...DEFAULT_SETTINGS, ...values }, loading: false, error: null })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '读取设置失败' })
    }
  },

  set: async (key, value) => {
    set({ values: { ...get().values, [key]: value } })
    const hub = window.hub
    if (!hub) return
    try {
      await hub.settings.set(key, value)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '保存设置失败' })
    }
  },

  get: (key, fallback = '') => get().values[key] ?? DEFAULT_SETTINGS[key] ?? fallback,

  flag: (key) => get().get(key, DEFAULT_SETTINGS[key] ?? 'false') === 'true'
}))
