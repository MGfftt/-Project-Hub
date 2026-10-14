/* ---------------------------------------------------------------------------
 * i18n/parts/index.ts — every dictionary, in the order they are merged.
 *
 * One file per area of the interface. Adding a key means adding it to exactly
 * one of these, which is what keeps two people from editing the same table.
 * ------------------------------------------------------------------------ */

import type { Dict } from '../types'
import { app } from './app'
import { core } from './core'
import { detail } from './detail'
import { map } from './map'
import { settings } from './settings'
import { tree } from './tree'

export const PARTS: readonly Dict[] = [core, app, tree, detail, map, settings]
