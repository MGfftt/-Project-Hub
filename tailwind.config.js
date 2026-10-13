/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Driven by CSS variables so light/dark switch does not rebuild classes (§9.5)
        app: {
          bg: 'var(--app-bg)',
          panel: 'var(--app-panel)',
          border: 'var(--app-border)',
          text: 'var(--app-text)',
          muted: 'var(--app-muted)',
          hover: 'var(--app-hover)',
          accent: 'var(--app-accent)'
        },
        status: {
          active: '#22c55e',
          paused: '#f59e0b',
          done: '#3b82f6',
          archived: '#9ca3af'
        },
        source: {
          git: '#8b5cf6',
          fs: '#06b6d4',
          manual: '#f59e0b'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Microsoft YaHei', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace']
      },
      fontSize: {
        // §9.1 typography scale
        node: ['14px', '20px'],
        minor: ['12px', '16px'],
        tag: ['11px', '14px']
      }
    }
  },
  plugins: []
}
