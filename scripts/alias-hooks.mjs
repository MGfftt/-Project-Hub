/**
 * Module-resolution hook (runs on Node's loader thread).
 *
 * Maps the two tsconfig path aliases used across the project so the benchmark
 * scripts can import the real TypeScript sources under plain `node`:
 *   @shared/*  ->  src/shared/*
 *   @main/*    ->  src/main/*
 * It also fills in the extensionless relative imports that `moduleResolution:
 * bundler` allows but Node's ESM resolver rejects (`'../db'` -> `'../db/index.ts'`).
 *
 * Registered by `scripts/alias-loader.mjs`. The Electron app never uses this
 * file: electron-vite resolves the aliases at build time.
 */
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Resolve `spec` to a real .ts/.tsx file, or null when it is a package. */
function resolveCandidate(spec, parentURL) {
  let base
  if (spec.startsWith('@shared/')) base = join(ROOT, 'src', 'shared', spec.slice('@shared/'.length))
  else if (spec.startsWith('@main/')) base = join(ROOT, 'src', 'main', spec.slice('@main/'.length))
  else if (spec.startsWith('.')) {
    const parentDir = parentURL?.startsWith('file:') ? dirname(fileURLToPath(parentURL)) : ROOT
    base = join(parentDir, spec)
  } else if (spec.startsWith('file:')) {
    base = fileURLToPath(spec)
  } else return null

  // The sources use `NodeNext`-style `./x.js` specifiers that actually point at
  // `./x.ts` on disk, plus extensionless `./db` directory imports.
  const swapped = base.replace(/\.(js|jsx|mjs|cjs)$/, (m) => (m === '.js' ? '.ts' : '.tsx'))
  const tries = [
    base,
    swapped,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx')
  ]
  for (const t of tries) if (existsSync(t) && statSync(t).isFile()) return t
  return null
}

export async function resolve(specifier, context, nextResolve) {
  const hit = resolveCandidate(specifier, context.parentURL)
  // No explicit `format`: Node must keep inferring `module-typescript` from the
  // .ts extension, otherwise the file is parsed as plain JS and every type
  // annotation becomes a syntax error.
  if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true }
  return nextResolve(specifier, context)
}
