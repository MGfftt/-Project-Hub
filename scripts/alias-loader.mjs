/**
 * Register the TypeScript/alias resolution hook used by the benchmark scripts.
 *
 * Usage:
 *   node --experimental-transform-types --import ./scripts/alias-loader.mjs <script>
 *
 * Node 24 strips types by itself; `--experimental-transform-types` additionally
 * supports the two TS-only constructs the sources use (parameter properties in
 * class constructors and enums). The Electron app never loads this file.
 */
import { register } from 'node:module'

register('./alias-hooks.mjs', import.meta.url)
