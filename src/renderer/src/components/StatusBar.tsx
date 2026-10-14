import { useCallback, useEffect, useState } from 'react'
import type { BackgroundStatus } from '@shared/types'
import type { AppInfo } from '@renderer/env'
import { useUi } from '@renderer/stores/ui'
import { useTree } from '@renderer/stores/tree'
import { useEvents } from '@renderer/stores/events'
import { formatCount } from '@renderer/lib/format'
import { t } from '@renderer/lib/i18n'

/* ---------------------------------------------------------------------------
 * StatusBar — §8.1 打开反馈, §9.6 扫描进度, §10.6 隐藏窗口, path_missing 警告.
 *
 * Left   : scan progress while a scan runs, otherwise the library summary.
 * Middle : transient text (`ui.status`), auto-cleared after 6s, toned by kind.
 * Right  : background maintenance state, power state, 「立即同步 Git」, and the
 *          「路径不存在」 warning for the selected node.
 * ------------------------------------------------------------------------ */

const STATUS_TTL_MS = 6000
const INFO_POLL_MS = 30_000

const TONE_STYLE: Record<'info' | 'warn' | 'error', { color: string }> = {
  info: { color: 'var(--tone-info)' },
  warn: { color: 'var(--tone-warn)' },
  error: { color: 'var(--tone-error)' }
}

export function StatusBar(): JSX.Element {
  const scanProgress = useTree((s) => s.scanProgress)
  const revision = useTree((s) => s.revision)
  const nodes = useTree((s) => s.nodes)
  const byId = useTree((s) => s.byId)

  const status = useUi((s) => s.status)
  const clearStatus = useUi((s) => s.clearStatus)
  const background = useUi((s) => s.background)
  const setBackground = useUi((s) => s.setBackground)
  const tray = useUi((s) => s.tray)
  const selectedId = useUi((s) => s.selectedId)

  const sync = useEvents((s) => s.sync)
  const [syncing, setSyncing] = useState(false)
  const [info, setInfo] = useState<AppInfo | null>(null)

  /* --- library summary, refreshed on mutations and slowly in the background -- */
  useEffect(() => {
    let alive = true
    const read = (): void => {
      const hub = window.hub
      if (!hub) return
      void hub.app
        .info()
        .then((next) => {
          if (alive) setInfo(next)
        })
        .catch(() => undefined)
    }
    read()
    const timer = window.setInterval(read, INFO_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [revision, nodes.length])

  /* --- background status, in case no push arrived yet ----------------------- */
  useEffect(() => {
    const hub = window.hub
    if (!hub || background) return
    let alive = true
    void hub.background
      .status()
      .then((next: BackgroundStatus) => {
        if (alive) setBackground(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [background, setBackground])

  /* --- transient text lives 6s --------------------------------------------- */
  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => clearStatus(), STATUS_TTL_MS)
    return () => window.clearTimeout(timer)
  }, [status, clearStatus])

  const onSync = useCallback(() => {
    setSyncing(true)
    const ui = useUi.getState()
    void sync()
      .then((result) => {
        ui.setStatus(
          result.newEvents > 0
            ? t('map.sync.done', {
                synced: formatCount(result.synced),
                events: formatCount(result.newEvents)
              })
            : t('map.sync.doneEmpty', { synced: formatCount(result.synced) }),
          'info'
        )
      })
      .catch(() => ui.setStatus(t('map.sync.failed'), 'error'))
      .finally(() => setSyncing(false))
  }, [sync])

  const selected = selectedId === null ? undefined : byId.get(selectedId)
  const pathMissing = selected?.path_missing === 1
  const hiddenCount = tray ? tray.unreadEvents : 0

  return (
    <footer
      className="glass-panel flex min-h-[26px] flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-0.5 text-[12px] leading-5"
      style={{ borderColor: 'var(--border)', backgroundColor: 'var(--panel)', color: 'var(--text-dim)' }}
      aria-label={t('map.statusBar')}
    >
      {/* left: scan progress or the library summary */}
      {scanProgress ? (
        <span className="flex min-w-[9rem] items-center gap-2" aria-busy="true">
          {/* The scanner reports a running count, not a total, so the bar is an
              indeterminate sweep rather than a fake percentage. */}
          <span
            className="relative h-1.5 w-24 shrink-0 overflow-hidden rounded-full"
            style={{ backgroundColor: 'var(--border)' }}
          >
            <span className="skeleton absolute inset-y-0 left-0 w-1/2 rounded-full" />
          </span>
          <span className="truncate text-[var(--text)]">
            {t('map.scanning', { n: formatCount(scanProgress.scanned) })}
          </span>
          {scanProgress.current ? (
            <span className="max-w-[14rem] truncate" title={scanProgress.current}>
              {scanProgress.current}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="truncate" title={t('map.summary.title')}>
          {info
            ? t('map.summary', {
                roots: formatCount(info.roots),
                nodes: formatCount(info.nodes),
                events: formatCount(info.events)
              })
            : t('map.summary.loading')}
        </span>
      )}

      {/* middle: transient feedback */}
      {status ? (
        <span
          className="min-w-0 truncate font-medium"
          style={TONE_STYLE[status.tone]}
          role="status"
          aria-live="polite"
          title={status.text}
        >
          {status.text}
        </span>
      ) : null}

      <span className="ml-auto" />

      {/* right: warnings, power, background maintenance, manual sync */}
      {pathMissing ? (
        <span
          className="rounded px-1.5 font-medium"
          style={{ color: 'var(--tone-error)', backgroundColor: 'rgba(220,38,38,0.1)' }}
          title={selected?.path ?? ''}
          role="alert"
        >
          {t('map.pathMissing')}
        </span>
      ) : null}

      {hiddenCount > 0 ? (
        <span title={t('map.unread.title')}>
          {t('map.unread', { n: formatCount(hiddenCount) })}
        </span>
      ) : null}

      {background?.onBattery ? (
        <span title={t('map.battery.title')}>{t('map.battery')}</span>
      ) : null}

      <span title={nextRunTitle(background)}>
        {t('map.background')}
        {background
          ? background.paused
            ? t('map.background.paused')
            : t('map.background.running')
          : t('map.background.unknown')}
      </span>

      <button
        type="button"
        className="btn btn-ghost h-5 px-1.5 py-0 text-[12px]"
        onClick={onSync}
        disabled={syncing}
        title={t('map.sync.title')}
      >
        {syncing ? t('map.syncing') : t('map.syncNow')}
      </button>
    </footer>
  )
}

/** 「后台维护」 tooltip: the nearest scheduled task, if any. */
function nextRunTitle(background: BackgroundStatus | null): string {
  if (!background) return t('map.nextRun.unknown')
  const entries = Object.entries(background.nextRun ?? {})
    .filter(([, at]) => typeof at === 'number' && at > 0)
    .sort((a, b) => a[1] - b[1])
  if (entries.length === 0) {
    return background.paused ? t('map.nextRun.paused') : t('map.nextRun.none')
  }
  const [task, at] = entries[0]
  return t('map.nextRun.at', { task, at: new Date(at).toLocaleString('zh-CN') })
}

export default StatusBar
