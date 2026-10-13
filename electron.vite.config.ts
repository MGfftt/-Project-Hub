import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    },
    build: {
      // Node 20 is Electron 33's bundled runtime; `node:sqlite` (the driver
      // fallback in `src/main/db/sqlite.ts`) needs at least 22.5 to exist, and
      // `target` only affects syntax downlevelling, so we keep the known-good floor
      // and let the driver shim decide at runtime.
      target: 'node20',
      rollupOptions: {
        input: {
          // main entry + worker thread entries (each worker is its own bundle)
          index: resolve('src/main/index.ts'),
          'workers/scan': resolve('src/main/worker/scan.ts'),
          'workers/git': resolve('src/main/worker/git.ts'),
          'workers/size': resolve('src/main/worker/size.ts')
        },
        output: {
          // CJS with an explicit `.cjs` extension: the package is `"type": "module"`
          // (so the renderer/preload tooling stays ESM-friendly) and this keeps the
          // main bundle loading as CommonJS, which is what `__dirname` and the
          // synchronous `better-sqlite3` require path both expect.
          entryFileNames: '[name].cjs',
          chunkFileNames: 'chunks/[name]-[hash].cjs',
          format: 'cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        // A sandboxed preload cannot use `require` for anything but a tiny
        // allowlist, so it is emitted as CJS and kept dependency-free.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
