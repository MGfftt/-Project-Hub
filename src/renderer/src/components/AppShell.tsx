import { useCallback, useEffect, useState } from 'react'
import { SlidersHorizontal, Settings } from 'lucide-react'
import type { BackgroundStatus, TrayState } from '@shared/types'
import { useTree } from '@renderer/stores/tree'
import { useEvents } from '@renderer/stores/events'
import { useUi } from '@renderer/stores/ui'
import { t } from '@renderer/lib/i18n'
import {
  descendantIds,
  flattenVisible,
  indexOfId,
  rootIdOf
} from '@renderer/lib/tree'
import TreePanel from '@renderer/components/TreePanel'
import Timeline from '@renderer/components/Timeline'
import ProjectMap from '@renderer/components/ProjectMap'
import NodeOverview from '@renderer/components/NodeOverview'
import DetailPanel from '@renderer/components/DetailPanel'
import StatusBar from '@renderer/components/StatusBar'
import SettingsDialog from '@renderer/components/dialogs/SettingsDialog'
import StatsDialog from '@renderer/components/dialogs/StatsDialog'
import IconPicker from '@renderer/components/dialogs/IconPicker'
import ConfirmDialog from '@renderer/components/dialogs/ConfirmDialog'

/* ---------------------------------------------------------------------------
 * AppShell — the three-column frame (§9.1) plus everything that is global:
 *   · one subscription to the six main-process broadcast channels;
 *   · the §8.5 keyboard map;
 *   · the drag handles that resize the two side columns;
 *   · the active dialog.
 *
 * The shell owns no tree data of its own: it reads the forest from `useTree`
 * and the view/selection from `useUi`.
 * ------------------------------------------------------------------------ */

const LEFT_MIN = 240
const LEFT_MAX = 480
const RIGHT_MIN = 280
const RIGHT_MAX = 520

interface PendingConfirm {
  message: string
  onConfirm(): void
}

export function AppShell(): JSX.Element {
  const mainView = useUi((s) => s.mainView)
  const setMainView = useUi((s) => s.setMainView)
  const detailOpen = useUi((s) => s.detailOpen)
  const setDetailOpen = useUi((s) => s.setDetailOpen)
  const selectedId = useUi((s) => s.selectedId)
  const nodeById = useTree((s) => s.byId)
  const selected = selectedId == null ? null : (nodeById.get(selectedId) ?? null)
  const leftWidth = useUi((s) => s.leftWidth)
  const rightWidth = useUi((s) => s.rightWidth)
  const dialog = useUi((s) => s.dialog)
  const dialogNodeId = useUi((s) => s.dialogNodeId)

  const [confirmState, setConfirmState] = useState<PendingConfirm | null>(null)

  /* --- preferences -------------------------------------------------------- */
  useEffect(() => {
    void useUi.getState().hydrate()
  }, [])

  /* --- the forest ---------------------------------------------------------- */
  /* The first read of the tree has to come from here. The main process only
   * broadcasts `tree:updated` after a scan or a mutation, so a renderer that
   * starts without one (a reload, or a start whose startup scan has already
   * finished) would otherwise sit on an empty tree until the next rescan. */
  useEffect(() => {
    void useTree.getState().load()
  }, [])

  /* --- the timeline's scope follows the selection -------------------------- */
  /* 改动时间线 always shows the selection's whole subtree: click one project and
   * you see that project alone, click a group (or any folder) and you see every
   * node inside it, and with nothing selected you see the entire workspace.
   * Applied while the timeline is on screen — it is the only consumer, and this
   * keeps a selection click on the map from reloading 5000 rows in the
   * background. Reading `byId` through `getState()` keeps the effect keyed on the
   * selection alone, so an unrelated rescan cannot overwrite the user's choice. */
  useEffect(() => {
    if (mainView !== 'timeline') return
    const tree = useTree.getState()
    const node = selectedId == null ? null : (tree.byId.get(selectedId) ?? null)
    useEvents.getState().setScope(node ? descendantIds(node, tree.byId) : null)
  }, [selectedId, mainView])

  /* --- broadcast channels ------------------------------------------------- */
  useEffect(() => {
    const hub = window.hub
    if (!hub) return
    const offs: Array<() => void> = []

    offs.push(
      hub.on('tree:updated', () => {
        void useTree.getState().load()
      })
    )
    offs.push(
      hub.on('events:appended', () => {
        if (useUi.getState().mainView === 'timeline') void useEvents.getState().load()
      })
    )
    offs.push(
      hub.on('scan:progress', (payload) => {
        useTree.getState().setScanProgress(payload as Parameters<
          ReturnType<typeof useTree.getState>['setScanProgress']
        >[0])
      })
    )
    offs.push(
      hub.on('task:status', (payload) => {
        useUi.getState().setBackground(payload as BackgroundStatus)
      })
    )
    offs.push(
      hub.on('window:visibility', () => {
        /* no user-visible effect: the main process owns hide/show */
      })
    )
    offs.push(
      hub.on('tray:state', (payload) => {
        useUi.getState().setTray(payload as TrayState)
      })
    )

    return () => {
      for (const off of offs) off()
    }
  }, [])

  /* --- §8.5 keyboard map -------------------------------------------------- */
  /* eslint-disable react-hooks/exhaustive-deps -- reads stores via getState() */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      const ui = useUi.getState()
      const tree = useTree.getState()

      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        document.getElementById('hub-search')?.focus()
        return
      }
      if (mod && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        const rootId = rootIdOf(tree.byId, ui.selectedId)
        if (rootId !== null) {
          void window.hub?.roots
            .rescan(rootId)
            .then(() => useUi.getState().setStatus(t('app.rescanStarted'), 'info'))
            .catch(() => useUi.getState().setStatus(t('app.rescanFailed'), 'error'))
        }
        return
      }
      if (mod && e.key === ',') {
        e.preventDefault()
        ui.openDialog('settings')
        return
      }
      if (mod) return

      const rows = flattenVisible(tree.nodes, tree.open)
      const selected = ui.selectedId

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault()
          const at = indexOfId(rows, selected)
          const next = rows[Math.min(rows.length - 1, at + 1)] ?? rows[0]
          if (next) moveSelection(next.node.id)
          break
        }
        case 'ArrowUp': {
          e.preventDefault()
          const at = indexOfId(rows, selected)
          const next = rows[Math.max(0, at - 1)] ?? rows[0]
          if (next) moveSelection(next.node.id)
          break
        }
        case 'ArrowRight': {
          if (selected === null) break
          e.preventDefault()
          tree.setOpen(selected, true)
          break
        }
        case 'ArrowLeft': {
          if (selected === null) break
          e.preventDefault()
          const row = rows.find((r) => r.node.id === selected)
          if (row && row.expanded) tree.setOpen(selected, false)
          else if (row?.node.parent_id != null) moveSelection(row.node.parent_id)
          break
        }
        case 'Enter': {
          if (selected === null) break
          e.preventDefault()
          void window.hub?.shell
            .openFolder(selected)
            .then((res) => {
              const ui2 = useUi.getState()
              if (res.ok) ui2.setStatus(t('app.folderOpened'), 'info')
              else ui2.setStatus(res.error ?? t('app.folderOpenFailed'), 'error')
            })
            .catch(() => useUi.getState().setStatus(t('app.folderOpenFailed'), 'error'))
          break
        }
        case 'F2': {
          if (selected === null) break
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('hub:rename', { detail: selected }))
          break
        }
        case 'Delete': {
          if (selected === null) break
          e.preventDefault()
          const node = tree.byId.get(selected)
          const name = node?.display_name || node?.name || t('app.nodeFallback')
          setConfirmState({
            message: t('app.removeConfirm', { name }),
            onConfirm: () => {
              void window.hub?.nodes
                .remove(selected)
                .then(() => {
                  useTree.getState().bump()
                  useUi.getState().setStatus(t('app.removedFromLibrary'), 'info')
                })
                .catch(() => useUi.getState().setStatus(t('app.removeFailed'), 'error'))
            }
          })
          break
        }
        case ' ': {
          if (selected === null) break
          e.preventDefault()
          tree.toggleOpen(selected)
          break
        }
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  /* eslint-enable react-hooks/exhaustive-deps */

  /* --- drag handles ------------------------------------------------------- */
  const resizeLeft = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const setLeftWidth = useUi.getState().setLeftWidth
    const onMove = (move: PointerEvent): void => setLeftWidth(move.clientX)
    const onUp = (up: PointerEvent): void => {
      setLeftWidth(up.clientX, true)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const resizeRight = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const setRightWidth = useUi.getState().setRightWidth
    const onMove = (move: PointerEvent): void => setRightWidth(window.innerWidth - move.clientX)
    const onUp = (up: PointerEvent): void => {
      setRightWidth(window.innerWidth - up.clientX, true)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--shell-bg)] text-[var(--text)]">
      <div className="flex min-h-0 flex-1">
        <aside
          className="glass-panel flex min-h-0 shrink-0 flex-col overflow-hidden border-r bg-[var(--surface)]"
          style={{ width: leftWidth, borderColor: 'var(--border)' }}
          aria-label={t('app.treeLabel')}
        >
          <TreePanel />
        </aside>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('app.treeResizeLabel')}
          tabIndex={0}
          className="resize-handle focus-ring"
          onPointerDown={resizeLeft}
          onKeyDown={(e) => {
            const ui = useUi.getState()
            if (e.key === 'ArrowLeft') ui.setLeftWidth(Math.max(LEFT_MIN, ui.leftWidth - 16), true)
            if (e.key === 'ArrowRight') ui.setLeftWidth(Math.min(LEFT_MAX, ui.leftWidth + 16), true)
          }}
        />

        <main
          className="glass-panel flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface)]"
          aria-label={t('app.mainViewLabel')}
        >
          {/* The tab strip keeps the middle column tied to the selection: a
              plain click on a tree node lands on 概览 instead of the old
              "选择一个项目" placeholder, which read as "nothing happened". */}
          <div
            role="tablist"
            aria-label={t('app.mainViewTabsLabel')}
            className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5"
            style={{ borderColor: 'var(--border)' }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={mainView === 'map'}
              className={mainView === 'map' ? 'btn btn-primary' : 'btn btn-ghost'}
              title={t('app.tab.mapTitle')}
              onClick={() => setMainView('map')}
            >
              {t('app.tab.map')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mainView === 'overview'}
              className={mainView === 'overview' ? 'btn btn-primary' : 'btn btn-ghost'}
              onClick={() => setMainView('overview')}
            >
              {t('app.tab.overview')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mainView === 'timeline'}
              className={mainView === 'timeline' ? 'btn btn-primary' : 'btn btn-ghost'}
              onClick={() => setMainView('timeline')}
            >
              {t('app.tab.timeline')}
            </button>
            {selected ? (
              <span className="ml-2 truncate text-[var(--font-minor)] text-[var(--text-dim)]">
                {selected.display_name || selected.name}
              </span>
            ) : null}
            <span className="flex-1" />
            <button
              type="button"
              data-open-settings
              className="btn btn-ghost"
              title={t('app.settingsTitle')}
              onClick={() => useUi.getState().openDialog('settings')}
            >
              <Settings size={14} aria-hidden />
              {t('app.settings')}
            </button>
            <button
              type="button"
              className={detailOpen ? 'btn btn-primary' : 'btn btn-ghost'}
              aria-pressed={detailOpen}
              title={t('app.propertiesTitle')}
              onClick={() => setDetailOpen(!detailOpen)}
            >
              <SlidersHorizontal size={14} aria-hidden />
              {t('app.properties')}
            </button>
          </div>

          {mainView === 'timeline' ? (
            <Timeline />
          ) : mainView === 'overview' && selected ? (
            <NodeOverview node={selected} />
          ) : (
            <ProjectMap />
          )}
        </main>

        {detailOpen ? (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('app.detailResizeLabel')}
              tabIndex={0}
              className="resize-handle focus-ring"
              onPointerDown={resizeRight}
              onKeyDown={(e) => {
                const ui = useUi.getState()
                if (e.key === 'ArrowLeft')
                  ui.setRightWidth(Math.min(RIGHT_MAX, ui.rightWidth + 16), true)
                if (e.key === 'ArrowRight')
                  ui.setRightWidth(Math.max(RIGHT_MIN, ui.rightWidth - 16), true)
              }}
            />
            <aside
              className="glass-panel flex min-h-0 shrink-0 flex-col overflow-hidden border-l bg-[var(--surface)]"
              style={{ width: rightWidth, borderColor: 'var(--border)' }}
              aria-label={t('app.detailLabel')}
            >
              <DetailPanel />
            </aside>
          </>
        ) : null}
      </div>

      <StatusBar />

      {dialog === 'settings' ? <SettingsDialog onClose={closeDialog} /> : null}
      {dialog === 'stats' && dialogNodeId !== null ? (
        <StatsDialog nodeId={dialogNodeId} onClose={closeDialog} />
      ) : null}
      {dialog === 'icon' && dialogNodeId !== null ? (
        <IconPicker nodeId={dialogNodeId} onClose={closeDialog} />
      ) : null}

      {confirmState ? (
        <ConfirmDialog
          title={t('app.removeDialogTitle')}
          message={confirmState.message}
          confirmLabel={t('app.removeConfirmLabel')}
          danger
          onConfirm={() => {
            confirmState.onConfirm()
            setConfirmState(null)
          }}
          onCancel={() => setConfirmState(null)}
        />
      ) : null}
    </div>
  )
}

function closeDialog(): void {
  useUi.getState().closeDialog()
}

/** §8.5 — shortcuts never fire while the user is typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  )
}

function moveSelection(id: number): void {
  const ui = useUi.getState()
  ui.select(id)
  useTree.getState().setFocus(id)
}

export default AppShell
