import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { NodeDetail, NodeStats } from '@shared/types'
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDelta,
  formatNoteLength,
  formatRelativeTime
} from '@renderer/lib/format'
import { kindLabel } from '@renderer/lib/tree'
import { tagStyle } from '@renderer/lib/colors'
import { useUi } from '@renderer/stores/ui'
import Modal from '@renderer/components/dialogs/Modal'

/* ---------------------------------------------------------------------------
 * StatsDialog — the 属性 dialog (§8.2). Field groups and their order are frozen:
 * 基本 / 磁盘 / Git / 改动 / 标注. Disk metrics arrive asynchronously from the
 * size worker, so `diskSizeBytes === null` reads 「计算中…」 rather than 0 B.
 * ------------------------------------------------------------------------ */

export interface StatsDialogProps {
  nodeId: number
  onClose(): void
}

export function StatsDialog({ nodeId, onClose }: StatsDialogProps): JSX.Element {
  const [stats, setStats] = useState<NodeStats | null>(null)
  const [detail, setDetail] = useState<NodeDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copyHint, setCopyHint] = useState<string | null>(null)
  const setStatus = useUi((s) => s.setStatus)

  useEffect(() => {
    let alive = true
    setStats(null)
    setDetail(null)
    setError(null)
    const hub = window.hub
    if (!hub) {
      setError('window.hub 不可用')
      return
    }
    void Promise.all([hub.nodes.stats(nodeId), hub.nodes.detail(nodeId)])
      .then(([nextStats, nextDetail]) => {
        if (!alive) return
        setStats(nextStats)
        setDetail(nextDetail)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : '读取属性失败')
      })
    return () => {
      alive = false
    }
  }, [nodeId])

  const path = stats?.path ?? detail?.path ?? null
  const onCopy = (): void => {
    const hub = window.hub
    if (!hub || !path) return
    void hub.shell
      .copyPath(nodeId)
      .then(() => {
        setCopyHint('已复制')
        setStatus('已复制路径', 'info')
        window.setTimeout(() => setCopyHint(null), 2000)
      })
      .catch(() => setStatus('复制路径失败', 'error'))
  }

  return (
    <Modal
      title="属性"
      onClose={onClose}
      className="max-w-2xl"
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          关闭
        </button>
      }
    >
      {error ? <p className="text-xs text-[var(--tone-error)]">{error}</p> : null}

      <Group title="基本">
        <Row label="名称" value={stats?.name ?? detail?.name ?? '…'} />
        <Row label="显示名" value={stats?.displayName ?? detail?.display_name ?? '—'} />
        <Row
          label="路径"
          value={
            <span className="flex items-center gap-2">
              <span className="min-w-0 break-all font-mono text-[11px]" title={path ?? ''}>
                {path ?? '—'}
              </span>
              {path ? (
                <button type="button" className="btn h-5 shrink-0 px-1.5 py-0 text-[11px]" onClick={onCopy}>
                  复制
                </button>
              ) : null}
              {copyHint ? <span className="text-[11px] text-[var(--accent)]">{copyHint}</span> : null}
            </span>
          }
        />
        <Row label="类型" value={stats ? kindLabel(stats.kind) : '…'} />
        <Row label="状态" value={stats ? nodeStatusLabel(stats.status) : '…'} />
      </Group>

      <Group title="磁盘">
        <Row
          label="大小"
          value={
            stats === null || stats.diskSizeBytes === null
              ? '计算中…'
              : formatBytes(stats.diskSizeBytes)
          }
        />
        <Row
          label="文件数"
          value={stats === null || stats.fileCount === null ? '计算中…' : formatCount(stats.fileCount)}
        />
        <Row label="子节点数" value={stats ? formatCount(stats.childCount) : '…'} />
        <Row label="创建时间" value={formatDateTime(stats?.createdAt ?? null)} />
        <Row label="修改时间" value={formatDateTime(stats?.modifiedAt ?? null)} />
      </Group>

      <Group title="Git">
        <Row label="是否仓库" value={stats ? (stats.isGitRepo ? '是' : '否') : '…'} />
        <Row label="远程" value={stats?.gitRemote || '—'} />
        <Row label="分支" value={stats?.gitBranch || '—'} />
      </Group>

      <Group title="改动">
        <Row label="首次事件" value={formatDateTime(stats?.firstEventAt ?? null)} />
        <Row label="末次事件" value={formatDateTime(stats?.lastEventAt ?? null)} />
        <Row
          label="事件总数"
          value={
            stats ? `${formatCount(stats.eventCount)}（最近 ${formatRelativeTime(stats.lastEventAt)}）` : '…'
          }
        />
        <Row label="累计增删" value={stats ? formatDelta(stats.totalInsertions, stats.totalDeletions) : '…'} />
      </Group>

      <Group title="标注">
        <Row
          label="标签"
          value={
            stats && stats.tags.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {stats.tags.map((tag) => (
                  <span key={tag} className="tag" style={tagStyle(tag)} title={tag}>
                    {tag}
                  </span>
                ))}
              </span>
            ) : (
              '—'
            )
          }
        />
        <Row label="笔记字数" value={formatNoteLength(detail?.note_md ?? '')} />
      </Group>
    </Modal>
  )
}

/** `NodeStats.status` is a plain string, so the label map is local and total. */
function nodeStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return '活跃'
    case 'paused':
      return '暂停'
    case 'done':
      return '已完成'
    case 'archived':
      return '已归档'
    default:
      return status || '—'
  }
}

function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {  return (
    <section className="mb-3 last:mb-0">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-dim)]">
        {title}
      </h3>
      <dl className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--border)' }}>
        {children}
      </dl>
    </section>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div
      className="flex items-start gap-3 border-b px-2.5 py-1.5 last:border-b-0"
      style={{ borderColor: 'var(--border)' }}
    >
      <dt className="w-20 shrink-0 text-[11px] leading-5 text-[var(--text-dim)]">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-xs leading-5 text-[var(--text)]">{value}</dd>
    </div>
  )
}

export default StatsDialog
