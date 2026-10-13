import { useCallback, useEffect, useState } from 'react'
import type { BackgroundStatus } from '@shared/types'
import type { AppInfo } from '@renderer/env'
import { useUi } from '@renderer/stores/ui'
import { useTree } from '@renderer/stores/tree'
import { useEvents } from '@renderer/stores/events'
import { formatCount } from '@renderer/lib/format'

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
            ? `已同步 ${formatCount(result.synced)} 个仓库，新增 ${formatCount(result.newEvents)} 条改动`
            : `已同步 ${formatCount(result.synced)} 个仓库，没有新的改动`,
          'info'
        )
      })
      .catch(() => ui.setStatus('同步 Git 历史失败，请稍后再试', 'error'))
      .finally(() => setSyncing(false))
  }, [sync])

  const selected = selectedId === null ? undefined : byId.get(selectedId)
  const pathMissing = selected?.path_missing === 1
  const hiddenCount = tray ? tray.unreadEvents : 0

  return (
    <footer
      className="flex min-h-[26px] flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-0.5 text-[12px] leading-5"
      style={{ borderColor: 'var(--border)', backgroundColor: 'var(--panel)', color: 'var(--text-dim)' }}
      aria-label="状态栏"
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
            已扫描 {formatCount(scanProgress.scanned)} 个
          </span>
          {scanProgress.current ? (
            <span className="max-w-[14rem] truncate" title={scanProgress.current}>
              {scanProgress.current}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="truncate" title="根目录 · 节点 · 改动">
          {info
            ? `${formatCount(info.roots)} 个根目录 · ${formatCount(info.nodes)} 个节点 · ${formatCount(info.events)} 条改动`
            : '正在读取库信息…'}
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
          路径不存在
        </span>
      ) : null}

      {hiddenCount > 0 ? (
        <span title="窗口隐藏期间新增的改动">{formatCount(hiddenCount)} 条未读</span>
      ) : null}

      {background?.onBattery ? <span title="当前由电池供电，后台维护已降速">电池供电，已降速</span> : null}

      <span title={nextRunTitle(background)}>
        后台维护：{background ? (background.paused ? '已暂停' : '运行中') : '未知'}
      </span>

      <button
        type="button"
        className="btn btn-ghost h-5 px-1.5 py-0 text-[12px]"
        onClick={onSync}
        disabled={syncing}
        title="立即同步所有 Git 仓库"
      >
        {syncing ? '同步中…' : '立即同步 Git'}
      </button>
    </footer>
  )
}

/** 「后台维护」 tooltip: the nearest scheduled task, if any. */
function nextRunTitle(background: BackgroundStatus | null): string {
  if (!background) return '后台维护状态未知'
  const entries = Object.entries(background.nextRun ?? {})
    .filter(([, at]) => typeof at === 'number' && at > 0)
    .sort((a, b) => a[1] - b[1])
  if (entries.length === 0) return background.paused ? '后台维护已暂停' : '暂无排定的维护任务'
  const [task, at] = entries[0]
  return `下次维护：${task} · ${new Date(at).toLocaleString('zh-CN')}`
}

export default StatusBar
