/* ---------------------------------------------------------------------------
 * i18n/types.ts — the shapes the message table is built from.
 *
 * Kept in its own module so the `parts/*` dictionaries can import the types
 * without importing the runtime (which would be a cycle).
 * ------------------------------------------------------------------------ */

export type Lang = 'zh' | 'en'

/**
 * `[中文, English]`. Both halves are required and the array is positional, so a
 * key cannot ship half-translated: the compiler rejects a one-element tuple.
 */
export type Entry = readonly [zh: string, en: string]

export type Dict = Record<string, Entry>
