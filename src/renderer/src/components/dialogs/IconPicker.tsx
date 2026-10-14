import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IconDef } from '@shared/icons'
import type { IconAsset, IconType } from '@shared/types'
import { EMOJI_PALETTE } from '@renderer/lib/emoji'
import { t } from '@renderer/lib/i18n'
import { useTree } from '@renderer/stores/tree'
import { useUi } from '@renderer/stores/ui'
import Modal from '@renderer/components/dialogs/Modal'

/* ---------------------------------------------------------------------------
 * IconPicker — §8.3. Three tabs, all of which end in `hub.nodes.setIcon(nodeId,
 * type, value)`:
 *   自动   the inference result plus 「恢复自动」 (`'auto'`, null);
 *   内置   the frozen built-in set (`'lucide'`, icon name);
 *   自定义 emoji (`'emoji'`) or an imported image (`'image'`).
 * ------------------------------------------------------------------------ */

export interface IconPickerProps {
  nodeId: number
  onClose(): void
}

type Tab = 'auto' | 'builtin' | 'custom'

const TAB_LABELS: ReadonlyArray<{ id: Tab; key: string }> = [
  { id: 'auto', key: 'settings.tabAuto' },
  { id: 'builtin', key: 'settings.tabBuiltin' },
  { id: 'custom', key: 'settings.tabCustom' }
]

/** Local mirror of the main process' `auto` inference, used for the preview. */
function inferIconName(name: string, kind: string): string {
  const lower = name.toLowerCase()
  if (kind !== 'project' && kind !== 'folder') return 'folder'
  if (/(node|npm|package|deps)/.test(lower)) return 'package'
  if (/(git|repo)/.test(lower)) return 'git-branch'
  if (/(db|sql|database|schema)/.test(lower)) return 'database'
  if (/(server|api|backend|service)/.test(lower)) return 'server'
  if (/(cli|shell|terminal|script)/.test(lower)) return 'terminal'
  return kind === 'project' ? 'package' : 'folder'
}

export function IconPicker({ nodeId, onClose }: IconPickerProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('auto')
  const [defs, setDefs] = useState<IconDef[]>([])
  const [customAssets, setCustomAssets] = useState<IconAsset[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const node = useTree((s) => s.byId.get(nodeId))
  const setStatus = useUi((s) => s.setStatus)

  useEffect(() => {
    let alive = true
    const hub = window.hub
    if (!hub) return
    void Promise.all([hub.icons.defs(), hub.icons.listCustom()])
      .then(([nextDefs, assets]) => {
        if (!alive) return
        setDefs(nextDefs)
        setCustomAssets(assets)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : t('settings.iconLoadFailed'))
      })
    return () => {
      alive = false
    }
  }, [])

  const apply = useCallback(
    (type: IconType, value: string | null, okText: string): void => {
      const hub = window.hub
      if (!hub) return
      setBusy(true)
      void hub.nodes
        .setIcon(nodeId, type, value)
        .then(() => {
          useTree.getState().bump()
          setStatus(okText, 'info')
          onClose()
        })
        .catch(() => setStatus(t('settings.iconSetFailed'), 'error'))
        .finally(() => setBusy(false))
    },
    [nodeId, onClose, setStatus]
  )

  const autoName = node ? inferIconName(node.name, node.kind) : 'folder'
  const autoDef = useMemo(() => defs.find((d) => d.name === autoName), [defs, autoName])

  const visibleDefs = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return defs
    return defs.filter((d) => d.name.toLowerCase().includes(q))
  }, [defs, query])

  const onImport = useCallback((): void => {
    const hub = window.hub
    if (!hub) return
    setBusy(true)
    void hub.nodes
      .importIcon(nodeId)
      .then((res) => {
        if (!res.ok) {
          setStatus(res.error ?? t('settings.iconImportFailed'), 'error')
          return
        }
        useTree.getState().bump()
        setStatus(t('settings.iconImported'), 'info')
        onClose()
      })
      .catch(() => setStatus(t('settings.iconImportFailed'), 'error'))
      .finally(() => setBusy(false))
  }, [nodeId, onClose, setStatus])

  return (
    <Modal title={t('settings.iconPickerTitle')} onClose={onClose} className="max-w-md">
      <div className="mb-3 flex gap-1" role="tablist" aria-label={t('settings.iconSource')}>
        {TAB_LABELS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`btn h-6 px-2.5 py-0 text-[11px] ${tab === item.id ? 'btn-primary' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {t(item.key)}
          </button>
        ))}
      </div>

      {error ? <p className="mb-2 text-xs text-[var(--tone-error)]">{error}</p> : null}

      {tab === 'auto' ? (
        <div className="flex flex-col items-center gap-3 py-4">
          <span className="text-[11px] text-[var(--text-dim)]">
            {t('settings.iconInfer')}
          </span>
          <span className="flex h-12 w-12 items-center justify-center rounded-[8px] border" style={{ borderColor: 'var(--border)' }}>
            <Glyph def={autoDef} fallbackName={autoName} size={28} />
          </span>
          <span className="text-xs text-[var(--text)]">{autoDef?.name ?? autoName}</span>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => apply('auto', null, t('settings.iconAutoRestored'))}
          >
            {t('settings.iconRestoreAuto')}
          </button>
        </div>
      ) : null}

      {tab === 'builtin' ? (
        <div className="flex flex-col gap-2">
          <input
            className="input focus-ring h-7 w-full text-xs"
            placeholder={t('settings.iconSearchPlaceholder')}
            value={query}
            aria-label={t('settings.iconSearchLabel')}
            onChange={(e) => setQuery(e.target.value)}
          />
          {visibleDefs.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-[var(--text-dim)]">
              {defs.length === 0 ? t('settings.iconLoading') : t('settings.iconNoMatch')}
            </p>
          ) : (
            <div className="grid grid-cols-6 gap-1">
              {visibleDefs.map((def) => (
                <button
                  key={def.name}
                  type="button"
                  title={def.name}
                  aria-label={def.name}
                  disabled={busy}
                  className="focus-ring flex h-10 items-center justify-center rounded-[6px] border hover:[background-color:var(--hover)]"
                  style={{ borderColor: 'var(--border)' }}
                  onClick={() => apply('lucide', def.name, t('settings.iconSet', { name: def.name }))}
                >
                  <Glyph def={def} fallbackName={def.name} size={20} />
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {tab === 'custom' ? (
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 text-[11px] text-[var(--text-dim)]">{t('settings.emoji')}</p>
            <div className="grid grid-cols-8 gap-1">
              {EMOJI_PALETTE.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={t('settings.useEmoji', { emoji })}
                  disabled={busy}
                  className="focus-ring flex h-8 items-center justify-center rounded-[6px] border text-base hover:[background-color:var(--hover)]"
                  style={{ borderColor: 'var(--border)' }}
                  onClick={() => apply('emoji', emoji, t('settings.iconSet', { name: emoji }))}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1 text-[11px] text-[var(--text-dim)]">
              {t('settings.importedImages')}
            </p>
            {customAssets.length === 0 ? (
              <p className="text-[11px] text-[var(--text-dim)]">{t('settings.none')}</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {customAssets.map((asset) => (
                  <li key={asset.id} className="text-[11px] text-[var(--text-dim)]">
                    {asset.filename}
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="btn mt-2" disabled={busy} onClick={onImport}>
              {t('settings.importFromFile')}
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

/** Renders `IconDef.path` (+ `extra`) as an inline stroke SVG. */
function Glyph({
  def,
  fallbackName,
  size
}: {
  def: IconDef | undefined
  fallbackName: string
  size: number
}): JSX.Element {
  if (!def) {
    return (
      <span className="text-[10px] text-[var(--text-dim)]" title={fallbackName}>
        {fallbackName.slice(0, 2)}
      </span>
    )
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={def.path} />
      {def.extra ? <path d={def.extra} /> : null}
    </svg>
  )
}

export default IconPicker
