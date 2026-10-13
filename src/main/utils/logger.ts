/**
 * Structured logger. Writes to stdout and, when a sink is installed by the main
 * process, mirrors into `userData/logs/app.log` — never into a project folder.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type Sink = (line: string) => void | Promise<void>

const sinks: Sink[] = []
let minLevel: LogLevel = process.env.PROJECT_HUB_LOG === 'debug' ? 'debug' : 'info'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function addLogSink(sink: Sink): void {
  sinks.push(sink)
}

/** Remove a previously added sink (used by tests so a sink cannot leak). */
export function removeLogSink(sink: Sink): void {
  const idx = sinks.indexOf(sink)
  if (idx >= 0) sinks.splice(idx, 1)
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return
  const ts = new Date().toISOString()
  const tail =
    extra === undefined
      ? ''
      : ' ' +
        (() => {
          if (extra instanceof Error) return `${extra.message}\n${extra.stack ?? ''}`
          try {
            return JSON.stringify(extra)
          } catch {
            return String(extra)
          }
        })()
  const line = `${ts} [${level.toUpperCase()}] [${scope}] ${message}${tail}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  for (const s of sinks) {
    try {
      const result = s(line)
      // A sink may be async (the file mirror is). Logging must never produce an
      // unhandled rejection, so an async sink's failure is swallowed too.
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch(() => undefined)
      }
    } catch {
      /* logging must never throw */
    }
  }
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e)
  }
}

export const logger = createLogger('app')
