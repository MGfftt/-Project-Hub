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
import { kindLabel, statusLabel, diskMetric } from '@renderer/lib/tree'
import { tagStyle } from '@renderer/lib/colors'
import { t } from '@renderer/lib/i18n'
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
      setError(t('detail.hubUnavailable'))
      return
    }
    void Promise.all([hub.nodes.stats(nodeId), hub.nodes.detail(nodeId)])
      .then(([nextStats, nextDetail]) => {
        if (!alive) return
        setStats(nextStats)
        setDetail(nextDetail)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : t('detail.statsLoadFailed'))
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
        setCopyHint(t('detail.copied'))
        setStatus(t('detail.pathCopied'), 'info')
        window.setTimeout(() => setCopyHint(null), 2000)
      })
      .catch(() => setStatus(t('detail.pathCopyFailed'), 'error'))
  }

  return (
    <Modal
      title={t('detail.statsTitle')}
      onClose={onClose}
      className="max-w-2xl"
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {t('detail.close')}
        </button>
      }
    >
      {error ? <p className="text-xs text-[var(--tone-error)]">{error}</p> : null}

      <Group title={t('detail.basic')}>
        <Row label={t('detail.name')} value={stats?.name ?? detail?.name ?? '…'} />
        <Row label={t('detail.displayName')} value={stats?.displayName ?? detail?.display_name ?? '—'} />
        <Row
          label={t('detail.path')}
          value={
            <span className="flex items-center gap-2">
              <span className="min-w-0 break-all font-mono text-[11px]" title={path ?? ''}>
                {path ?? '—'}
              </span>
              {path ? (
                <button type="button" className="btn h-5 shrink-0 px-1.5 py-0 text-[11px]" onClick={onCopy}>
                  {t('detail.copy')}
                </button>
              ) : null}
              {copyHint ? <span className="text-[11px] text-[var(--accent)]">{copyHint}</span> : null}
            </span>
          }
        />
        <Row label={t('detail.type')} value={stats ? kindLabel(stats.kind) : '…'} />
        <Row label={t('detail.status')} value={stats ? nodeStatusLabel(stats.status) : '…'} />
      </Group>

      <Group title={t('detail.disk')}>
        <Row label={t('detail.size')} value={diskMetric(path, stats?.diskSizeBytes ?? null, formatBytes)} />
        <Row label={t('detail.fileCount')} value={diskMetric(path, stats?.fileCount ?? null, formatCount)} />
        <Row
          label={t('detail.childCount')}
          value={stats ? formatCount(stats.childCount) : '…'}
        />
        <Row label={t('detail.createdAt')} value={formatDateTime(stats?.createdAt ?? null)} />
        <Row label={t('detail.modifiedAt')} value={formatDateTime(stats?.modifiedAt ?? null)} />
      </Group>

      <Group title="Git">
        <Row
          label={t('detail.isRepo')}
          value={stats ? (stats.isGitRepo ? t('detail.yes') : t('detail.no')) : '…'}
        />
        <Row label={t('detail.gitRemote')} value={stats?.gitRemote || '—'} />
        <Row label={t('detail.gitBranch')} value={stats?.gitBranch || '—'} />
      </Group>

      <Group title={t('detail.changes')}>
        <Row label={t('detail.firstEvent')} value={formatDateTime(stats?.firstEventAt ?? null)} />
        <Row label={t('detail.lastEvent')} value={formatDateTime(stats?.lastEventAt ?? null)} />
        <Row
          label={t('detail.eventTotal')}
          value={
            stats
              ? t('detail.eventTotalValue', {
                  count: formatCount(stats.eventCount),
                  relative: formatRelativeTime(stats.lastEventAt)
                })
              : '…'
          }
        />
        <Row
          label={t('detail.totalDelta')}
          value={stats ? formatDelta(stats.totalInsertions, stats.totalDeletions) : '…'}
        />
      </Group>

      <Group title={t('detail.annotations')}>
        <Row
          label={t('detail.tags')}
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
        <Row label={t('detail.noteLength')} value={formatNoteLength(detail?.note_md ?? '')} />
      </Group>
    </Modal>
  )
}

/** `NodeStats.status` is a plain string, so the label map is local and total. */
function nodeStatusLabel(status: string): string {
  switch (status) {
    case 'active':
    case 'paused':
    case 'done':
    case 'archived':
      return statusLabel(status)
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
