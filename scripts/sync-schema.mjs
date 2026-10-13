#!/usr/bin/env node
/**
 * Regenerate `src/main/db/schema.ts` from `src/main/db/schema.sql`.
 *
 * Why this exists: electron-vite bundles `src/main/index.ts` and each worker
 * entry separately, so reading `schema.sql` from disk at runtime would depend
 * on the packaged layout (and would break inside an asar archive). The TS copy
 * is embedded instead, which keeps migrations deterministic everywhere.
 *
 * `schema.sql` stays the readable source of truth; this script keeps the two in
 * sync. Run it after editing the SQL: `npm run sync:schema`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(here, '..', 'src', 'main', 'db', 'schema.sql')
const tsPath = join(here, '..', 'src', 'main', 'db', 'schema.ts')

const HEADER = `/**
 * Embedded copy of schema.sql.
 *
 * electron-vite bundles \`src/main/index.ts\` and the worker entries separately;
 * reading schema.sql from disk at runtime would depend on the packaged layout.
 * A generated TS module keeps migrations deterministic in dev, in \`out/\` and
 * inside an asar archive.
 *
 * Regenerate with: \`node scripts/sync-schema.mjs\`
 */`

const sql = readFileSync(sqlPath, 'utf8').replace(/\r\n/g, '\n')

// The SQL never contains a backtick or an interpolation today; escape anyway so
// a future comment cannot break out of the template literal.
const escaped = sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

const out = `${HEADER}
export const SCHEMA_SQL = \`${escaped}\`
`

writeFileSync(tsPath, out, 'utf8')

const lines = sql.trimEnd().split('\n').length
console.log(
  `sync-schema: ${relative(process.cwd(), sqlPath)} (${lines} lines) -> ${relative(process.cwd(), tsPath)} (${out.length} bytes)`
)
