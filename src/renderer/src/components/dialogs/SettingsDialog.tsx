import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { SETTING_KEYS } from '@shared/types'
import type { AppInfo, BackgroundImage } from '@renderer/env'
import type { ThemePref } from '@renderer/lib/theme'
import { formatBytes, formatDateTime, formatDuration, formatRelativeTime } from '@renderer/lib/format'
import { getLang, LANGUAGES, setLang, t, type Lang } from '@renderer/lib/i18n'
import { applyWallpaper } from '@renderer/lib/wallpaper'
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

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePref; key: string }> = [
  { value: 'light', key: 'settings.themeLight' },
  { value: 'dark', key: 'settings.themeDark' },
  { value: 'system', key: 'settings.themeSystem' },
  /* §9.11 — frosted glass follows the system for light/dark and only makes the
     surfaces translucent, so it reads as a fourth choice in this row. */
  { value: 'glass', key: 'settings.themeGlass' }
]

const TASK_LABELS: Record<string, string> = {
  rescan: 'settings.taskRescan',
  'git-sync': 'settings.taskGitSync',
  snapshot: 'settings.taskSnapshot',
  prune: 'settings.taskPrune',
  'size-sweep': 'settings.taskSizeSweep'
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
  /* §9.10 — the language currently in force; picking one remounts the shell. */
  const [lang, setLangState] = useState<Lang>(() => getLang())

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
        if (alive) setStatus(t('error.settingsLoad'), 'error')
      })
    return () => {
      alive = false
    }
  }, [setBackground, setStatus])

  const writeSetting = useCallback(
    (key: string, value: string): void => {
      void window.hub?.settings
        .set(key, value)
        .catch(() => setStatus(t('error.settingsSave'), 'error'))
    },
    [setStatus]
  )

  /**
   * §9.10 — switching language is immediate (the shell remounts through
   * `App.tsx`) and persisted, so the choice survives a restart and reaches the
   * main process, which relabels the tray menu.
   */
  const onPickLanguage = useCallback(
    (next: Lang): void => {
      setLangState(next)
      setLang(next)
      writeSetting(SETTING_KEYS.language, next)
    },
    [writeSetting]
  )

  /**
   * §9.11 — the picture is painted the moment it is chosen. Before this the
   * dialog only recorded a file name, so picking one looked like nothing
   * happened until (never) the next launch.
   */
  const onChooseBackground = useCallback((): void => {
    const hub = window.hub
    if (!hub) return
    setBusy(true)
    void hub.settings.background
      .choose()
      .then((res) => {
        if (res.ok && res.image) {
          setImage(res.image)
          applyWallpaper((res.image as { url?: string }).url ?? null)
          setStatus(t('settings.backgroundSet'), 'info')
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
        applyWallpaper(null)
        setStatus(t('settings.backgroundCleared'), 'info')
      })
      .catch(() => setStatus(t('settings.backgroundClearFailed'), 'error'))
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
        setStatus(
          status.paused ? t('settings.maintenancePaused') : t('settings.maintenanceResumed'),
          'info'
        )
      })
      .catch(() => setStatus(t('settings.maintenanceToggleFailed'), 'error'))
      .finally(() => setBusy(false))
  }, [background, setBackground, setStatus])

  const onToggleAutoLaunch = useCallback(
    (next: boolean): void => {
      setAutoLaunch(next)
      void window.hub?.app
        .setAutoLaunch(next)
        .then((ok) => {
          writeSetting(SETTING_KEYS.autoLaunch, ok ? 'true' : 'false')
          setStatus(ok ? t('settings.autoLaunchOn') : t('settings.autoLaunchOff'), 'info')
        })
        .catch(() => {
          setAutoLaunch(!next)
          setStatus(t('settings.autoLaunchFailed'), 'error')
        })
    },
    [setStatus, writeSetting]
  )

  const nextRuns = background ? Object.entries(background.nextRun) : []

  return (
    <Modal
      title={t('settings.title')}
      onClose={onClose}
      className="max-w-2xl"
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {t('settings.done')}
        </button>
      }
    >
      <Section title={t('settings.appearance')}>
        <Field label={t('settings.theme')}>
          <div className="flex gap-1" role="radiogroup" aria-label={t('settings.theme')}>
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={theme === opt.value}
                className={`btn h-6 px-2 py-0 text-[11px] ${theme === opt.value ? 'btn-primary' : ''}`}
                onClick={() => setTheme(opt.value)}
              >
                {t(opt.key)}
              </button>
            ))}
          </div>
        </Field>
        <Field label={t('settings.compactMode')}>
          <Toggle
            checked={compactMode}
            onChange={setCompactMode}
            label={t('settings.compactModeHint')}
          />
        </Field>
        <Field label={t('settings.background')}>
          <div className="flex items-center gap-2">
            <span
              data-background-preview
              aria-hidden
              className="h-6 w-10 shrink-0 rounded border"
              style={{
                borderColor: 'var(--border)',
                backgroundColor: 'var(--hover)',
                backgroundImage: image?.url ? `url("${image.url}")` : 'none',
                backgroundSize: 'cover',
                backgroundPosition: 'center'
              }}
            />
            <span className="text-[11px] text-[var(--text-dim)]">
              {image?.filename
                ? `${image.filename}${image.bytes === null ? '' : ` · ${formatBytes(image.bytes)}`}`
                : t('settings.notSet')}
            </span>
            <button type="button" className="btn h-6 px-2 py-0 text-[11px]" disabled={busy} onClick={onChooseBackground}>
              {t('settings.chooseImage')}
            </button>
            <button
              type="button"
              className="btn h-6 px-2 py-0 text-[11px]"
              disabled={busy || !image?.filename}
              onClick={onClearBackground}
            >
              {t('settings.clear')}
            </button>
          </div>
        </Field>
        <p className="px-2 pb-1 text-[11px] leading-5 text-[var(--text-dim)]">
          {t('settings.backgroundHint')}
        </p>
        <Field label={t('settings.language')}>
          <div className="flex gap-1" role="radiogroup" aria-label={t('settings.languageHint')}>
            {LANGUAGES.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={lang === opt.id}
                className={`btn h-6 px-2 py-0 text-[11px] ${lang === opt.id ? 'btn-primary' : ''}`}
                onClick={() => onPickLanguage(opt.id)}
              >
                {opt.native}
              </button>
            ))}
          </div>
        </Field>
      </Section>

      <Section title={t('settings.interaction')}>
        <Field label={t('settings.doubleClickOpen')}>
          <Toggle
            checked={clickToOpen}
            onChange={(next) => {
              setClickToOpen(next)
              setStatus(
                next ? t('settings.doubleClickOpenOn') : t('settings.doubleClickOpenOff'),
                'info'
              )
            }}
            label={t('settings.doubleClickOpen')}
          />
        </Field>
        <Field label={t('settings.hideToTray')}>
          <Toggle
            checked={hideToTray}
            onChange={(next) => {
              setHideToTray(next)
              writeSetting(SETTING_KEYS.hideToTray, next ? 'true' : 'false')
            }}
            label={t('settings.hideToTrayHint')}
          />
        </Field>
        <Field label={t('settings.autoLaunch')}>
          <Toggle
            checked={autoLaunch}
            onChange={onToggleAutoLaunch}
            label={t('settings.autoLaunch')}
          />
        </Field>
      </Section>

      <Section title={t('settings.maintenance')}>
        <Field label={t('settings.status')}>
          <div className="flex items-center gap-2">
            <span className={`tag ${background?.paused ? 'tag-warn' : 'tag-ok'}`}>
              {background === null
                ? t('settings.loading')
                : background.paused
                  ? t('settings.statusPaused')
                  : t('settings.statusRunning')}
            </span>
            <button type="button" className="btn h-6 px-2 py-0 text-[11px]" disabled={busy} onClick={onTogglePause}>
              {background?.paused ? t('settings.resume') : t('settings.pause')}
            </button>
          </div>
        </Field>
        <Field label={t('settings.nextRun')}>
          {nextRuns.length === 0 ? (
            <span className="text-[11px] text-[var(--text-dim)]">{t('settings.noPlan')}</span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {nextRuns.map(([task, at]) => (
                <li key={task} className="text-[11px] text-[var(--text-dim)]">
                  {t('settings.nextRunTask', {
                    task: TASK_LABELS[task] ? t(TASK_LABELS[task]) : task
                  })}
                  <span className="text-[var(--text)]">{formatRelativeTime(at)}</span>
                  <span className="text-[var(--text-dim)]">
                    {t('settings.inDuration', { duration: formatDuration(at - Date.now()) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Field>
        {background?.onBattery ? (
          <Field label={t('settings.power')}>
            <span className="text-[11px] text-[var(--tone-warn)]">{t('settings.onBattery')}</span>
          </Field>
        ) : null}
      </Section>

      <Section title={t('settings.data')}>
        <Field label={t('settings.dataDir')}>
          <code className="break-all text-[11px]">{info?.userData ?? '…'}</code>
        </Field>
        <Field label={t('settings.database')}>
          <code className="break-all text-[11px]">{info?.dbPath ?? '…'}</code>
        </Field>
        <Field label={t('settings.engine')}>
          <span className="text-[11px]">
            {info
              ? t('settings.engineValue', { driver: info.driver, version: info.schemaVersion })
              : '…'}
          </span>
        </Field>
        <Field label={t('settings.scaleLabel')}>
          <span className="text-[11px]">
            {info
              ? t('settings.scale', { roots: info.roots, nodes: info.nodes, events: info.events })
              : '…'}
          </span>
        </Field>
      </Section>

      <Section title={t('settings.isolation')}>
        <p className="text-xs leading-5 text-[var(--text)]">
          <b>{t('settings.isolationLead')}</b>
          {t('settings.isolationBody')}
        </p>
        <p className="mt-1 text-xs leading-5 text-[var(--text-dim)]">
          <b style={{ color: 'var(--st-active)' }}>{t('settings.isolationNever')}</b>
        </p>
        <p className="mt-1 text-[11px] leading-5 text-[var(--text-dim)]">
          {t('settings.isolationScan')}
        </p>
      </Section>

      <Section title={t('settings.about')}>
        <Field label={t('settings.version')}>
          <span className="text-[11px]">
            {t('settings.versionValue', {
              version: info?.version ?? '…',
              electron: info?.electron ?? '—',
              node: info?.node ?? '—'
            })}
          </span>
        </Field>
        <Field label={t('settings.platform')}>
          <span className="text-[11px]">{info?.platform ?? '—'}</span>
        </Field>
        <Field label={t('settings.currentTime')}>
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
      {checked ? t('settings.on') : t('settings.off')}
    </label>
  )
}

export default SettingsDialog
