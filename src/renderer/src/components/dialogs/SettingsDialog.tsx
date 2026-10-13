import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { SETTING_KEYS } from '@shared/types'
import type { AppInfo, BackgroundImage } from '@renderer/env'
import type { ThemePref } from '@renderer/lib/theme'
import { formatBytes, formatDateTime, formatDuration, formatRelativeTime } from '@renderer/lib/format'
import { useUi } from '@renderer/stores/ui'
import Modal from '@renderer/components/dialogs/Modal'

/* ---------------------------------------------------------------------------
 * SettingsDialog — 外观 / 交互 / 后台维护 / 数据 / 数据隔离 / 关于.
 *
 * The 数据隔离 section is deliberately the plainest prose in the app: it is the
 * answer to "does this touch my projects?" and it must not be paraphrased away.
 * ------------------------------------------------------------------------ */

export interface SettingsDialogProps {
  onClose(): void
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePref; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' }
]

const TASK_LABELS: Record<string, string> = {
  rescan: '重新扫描',
  'git-sync': 'Git 同步',
  snapshot: '数据库快照',
  prune: '清理旧记录',
  'size-sweep': '大小补算'
}

export function SettingsDialog({ onClose }: SettingsDialogProps): JSX.Element {
  const theme = useUi((s) => s.theme)
  const setTheme = useUi((s) => s.setTheme)
  const compactMode = useUi((s) => s.compactMode)
  const setCompactMode = useUi((s) => s.setCompactMode)
  const clickToOpen = useUi((s) => s.clickToOpen)
  const setClickToOpen = useUi((s) => s.setClickToOpen)
  const background = useUi((s) => s.background)
  const setBackground = useUi((s) => s.setBackground)
  const setStatus = useUi((s) => s.setStatus)

  const [info, setInfo] = useState<AppInfo | null>(null)
  const [image, setImage] = useState<BackgroundImage | null>(null)
  const [hideToTray, setHideToTray] = useState(true)
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [busy, setBusy] = useState(false)

  /* --- initial load: app info, settings flags, background image ------------ */
  useEffect(() => {
    let alive = true
    const hub = window.hub
    if (!hub) return
    void Promise.all([
      hub.app.info(),
      hub.settings.all(),
      hub.settings.background.current(),
      hub.background.status()
    ])
      .then(([nextInfo, all, current, status]) => {
        if (!alive) return
        setInfo(nextInfo)
        setHideToTray(all[SETTING_KEYS.hideToTray] !== 'false')
        setAutoLaunch(all[SETTING_KEYS.autoLaunch] === 'true')
        setImage(current)
        setBackground(status)
      })
      .catch(() => {
        if (alive) setStatus('读取设置失败', 'error')
      })
    return () => {
      alive = false
    }
  }, [setBackground, setStatus])

  const writeSetting = useCallback(
    (key: string, value: string): void => {
      void window.hub?.settings
        .set(key, value)
        .catch(() => setStatus('保存设置失败', 'error'))
    },
    [setStatus]
  )

  const onChooseBackground = useCallback((): void => {
    const hub = window.hub
    if (!hub) return
    setBusy(true)
    void hub.settings.background
      .choose()
      .then((res) => {
        if (res.ok && res.image) {
          setImage(res.image)
          setStatus('已设置背景图片', 'info')
        } else if (res.error) {
          setStatus(res.error, 'error')
        }
      })
      .finally(() => setBusy(false))
  }, [setStatus])

  const onClearBackground = useCallback((): void => {
    const hub = window.hub
    if (!hub) return
    setBusy(true)
    void hub.settings.background
      .clear()
      .then(() => {
        setImage({ filename: null, origin: null, bytes: null })
        setStatus('已清除背景图片', 'info')
      })
      .catch(() => setStatus('清除背景图片失败', 'error'))
      .finally(() => setBusy(false))
  }, [setStatus])

  const onTogglePause = useCallback((): void => {
    const hub = window.hub
    if (!hub) return
    const paused = background?.paused ?? false
    const action = paused ? hub.background.resume() : hub.background.pause()
    setBusy(true)
    void action
      .then(() => hub.background.status())
      .then((status) => {
        setBackground(status)
        setStatus(status.paused ? '后台维护已暂停' : '后台维护已继续', 'info')
      })
      .catch(() => setStatus('切换后台维护状态失败', 'error'))
      .finally(() => setBusy(false))
  }, [background, setBackground, setStatus])

  const onToggleAutoLaunch = useCallback(
    (next: boolean): void => {
      setAutoLaunch(next)
      void window.hub?.app
        .setAutoLaunch(next)
        .then((ok) => {
          writeSetting(SETTING_KEYS.autoLaunch, ok ? 'true' : 'false')
          setStatus(ok ? '已开启开机自启' : '已关闭开机自启', 'info')
        })
        .catch(() => {
          setAutoLaunch(!next)
          setStatus('设置开机自启失败', 'error')
        })
    },
    [setStatus, writeSetting]
  )

  const nextRuns = background ? Object.entries(background.nextRun) : []

  return (
    <Modal
      title="设置"
      onClose={onClose}
      className="max-w-2xl"
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          完成
        </button>
      }
    >
      <Section title="外观">
        <Field label="主题">
          <div className="flex gap-1" role="radiogroup" aria-label="主题">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={theme === opt.value}
                className={`btn h-6 px-2 py-0 text-[11px] ${theme === opt.value ? 'btn-primary' : ''}`}
                onClick={() => setTheme(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="紧凑模式">
          <Toggle
            checked={compactMode}
            onChange={setCompactMode}
            label="使用 26px 行高"
          />
        </Field>
        <Field label="背景图片">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--text-dim)]">
              {image?.filename
                ? `${image.filename}${image.bytes === null ? '' : ` · ${formatBytes(image.bytes)}`}`
                : '未设置'}
            </span>
            <button type="button" className="btn h-6 px-2 py-0 text-[11px]" disabled={busy} onClick={onChooseBackground}>
              选择图片
            </button>
            <button
              type="button"
              className="btn h-6 px-2 py-0 text-[11px]"
              disabled={busy || !image?.filename}
              onClick={onClearBackground}
            >
              清除
            </button>
          </div>
        </Field>
      </Section>

      <Section title="交互">
        <Field label="双击打开文件夹">
          <Toggle
            checked={clickToOpen}
            onChange={(next) => {
              setClickToOpen(next)
              setStatus(
                next ? '已开启双击打开文件夹' : '已关闭双击打开，双击只用于展开与折叠',
                'info'
              )
            }}
            label="双击打开文件夹"
          />
        </Field>
        <Field label="关闭时隐藏到托盘">
          <Toggle
            checked={hideToTray}
            onChange={(next) => {
              setHideToTray(next)
              writeSetting(SETTING_KEYS.hideToTray, next ? 'true' : 'false')
            }}
            label="关闭窗口时隐藏到托盘"
          />
        </Field>
        <Field label="开机自启">
          <Toggle checked={autoLaunch} onChange={onToggleAutoLaunch} label="开机自启" />
        </Field>
      </Section>

      <Section title="后台维护">
        <Field label="状态">
          <div className="flex items-center gap-2">
            <span className={`tag ${background?.paused ? 'tag-warn' : 'tag-ok'}`}>
              {background === null ? '读取中…' : background.paused ? '已暂停' : '运行中'}
            </span>
            <button type="button" className="btn h-6 px-2 py-0 text-[11px]" disabled={busy} onClick={onTogglePause}>
              {background?.paused ? '继续' : '暂停'}
            </button>
          </div>
        </Field>
        <Field label="下次运行">
          {nextRuns.length === 0 ? (
            <span className="text-[11px] text-[var(--text-dim)]">暂无计划</span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {nextRuns.map(([task, at]) => (
                <li key={task} className="text-[11px] text-[var(--text-dim)]">
                  {TASK_LABELS[task] ?? task}：
                  <span className="text-[var(--text)]">{formatRelativeTime(at)}</span>
                  <span className="text-[var(--text-dim)]">（{formatDuration(at - Date.now())}后）</span>
                </li>
              ))}
            </ul>
          )}
        </Field>
        {background?.onBattery ? (
          <Field label="电源">
            <span className="text-[11px] text-[var(--tone-warn)]">当前由电池供电，后台维护已自动降速</span>
          </Field>
        ) : null}
      </Section>

      <Section title="数据">
        <Field label="数据目录">
          <code className="break-all text-[11px]">{info?.userData ?? '…'}</code>
        </Field>
        <Field label="数据库">
          <code className="break-all text-[11px]">{info?.dbPath ?? '…'}</code>
        </Field>
        <Field label="存储引擎 / schema">
          <span className="text-[11px]">
            {info ? `${info.driver} · schema v${info.schemaVersion}` : '…'}
          </span>
        </Field>
        <Field label="规模">
          <span className="text-[11px]">
            {info
              ? `${info.roots} 个根目录 · ${info.nodes} 个节点 · ${info.events} 条改动`
              : '…'}
          </span>
        </Field>
      </Section>

      <Section title="数据隔离">
        <p className="text-xs leading-5 text-[var(--text)]">
          <b>所有数据都保存在本程序的 userData 目录内。</b>
          被索引的项目文件夹始终是只读的：标注、显示名、图标、标签、笔记与改动记录只写入本程序的
          userData 目录。
        </p>
        <p className="mt-1 text-xs leading-5 text-[var(--text-dim)]">
          <b style={{ color: 'var(--st-active)' }}>本程序从不向被索引的项目目录写入任何文件。</b>
        </p>
        <p className="mt-1 text-[11px] leading-5 text-[var(--text-dim)]">
          扫描、Git 历史读取与文件监视都以只读方式访问项目目录，不会新增、修改或删除其中的任何内容。
        </p>
      </Section>

      <Section title="关于">
        <Field label="版本">
          <span className="text-[11px]">
            Project Hub {info?.version ?? '…'}（Electron {info?.electron ?? '—'} · Node {info?.node ?? '—'}）
          </span>
        </Field>
        <Field label="平台">
          <span className="text-[11px]">{info?.platform ?? '—'}</span>
        </Field>
        <Field label="当前时间">
          <span className="text-[11px]">{formatDateTime(Date.now())}</span>
        </Field>
      </Section>
    </Modal>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-dim)]">
        {title}
      </h3>
      <div className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--border)' }}>
        {children}
      </div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div
      className="flex items-start gap-3 border-b px-2.5 py-2 last:border-b-0"
      style={{ borderColor: 'var(--border)' }}
    >
      <span className="w-28 shrink-0 pt-0.5 text-[11px] text-[var(--text-dim)]">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange(next: boolean): void
  label: string
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[11px] text-[var(--text)]">
      <input
        type="checkbox"
        className="focus-ring h-3.5 w-3.5 accent-[var(--accent)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      {checked ? '开启' : '关闭'}
    </label>
  )
}

export default SettingsDialog
