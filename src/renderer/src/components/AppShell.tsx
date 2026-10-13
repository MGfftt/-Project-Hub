import { useCallback, useEffect, useState } from 'react'
import type { BackgroundStatus, TrayState } from '@shared/types'
import { useTree } from '@renderer/stores/tree'
import { useEvents } from '@renderer/stores/events'
import { useUi } from '@renderer/stores/ui'
import {
  flattenVisible,
  indexOfId,
  rootIdOf
} from '@renderer/lib/tree'
import TreePanel from '@renderer/components/TreePanel'
import Timeline from '@renderer/components/Timeline'
import DetailPanel from '@renderer/components/DetailPanel'
import StatusBar from '@renderer/components/StatusBar'
import EmptyState from '@renderer/components/EmptyState'
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
  const leftWidth = useUi((s) => s.leftWidth)
  const rightWidth = useUi((s) => s.rightWidth)
  const detailOpen = useUi((s) => s.detailOpen)
  const dialog = useUi((s) => s.dialog)
  const dialogNodeId = useUi((s) => s.dialogNodeId)

  const [confirmState, setConfirmState] = useState<PendingConfirm | null>(null)

  /* --- preferences -------------------------------------------------------- */
  useEffect(() => {
    void useUi.getState().hydrate()
  }, [])

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
            .then(() => useUi.getState().setStatus('已开始重新扫描', 'info'))
            .catch(() => useUi.getState().setStatus('重新扫描失败', 'error'))
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
              if (res.ok) ui2.setStatus('已打开文件夹', 'info')
              else ui2.setStatus(res.error ?? '打开文件夹失败', 'error')
            })
            .catch(() => useUi.getState().setStatus('打开文件夹失败', 'error'))
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
          const name = node?.display_name || node?.name || '该节点'
          setConfirmState({
            message: `确定将「${name}」从库中移除吗？磁盘上的文件夹不会被删除。`,
            onConfirm: () => {
              void window.hub?.nodes
                .remove(selected)
                .then(() => {
                  useTree.getState().bump()
                  useUi.getState().setStatus('已从库中移除', 'info')
                })
                .catch(() => useUi.getState().setStatus('移除失败', 'error'))
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
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <div className="flex min-h-0 flex-1">
        <aside
          className="flex min-h-0 shrink-0 flex-col border-r"
          style={{ width: leftWidth, borderColor: 'var(--border)' }}
          aria-label="项目树"
        >
          <TreePanel />
        </aside>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整项目树宽度"
          tabIndex={0}
          className="resize-handle focus-ring"
          onPointerDown={resizeLeft}
          onKeyDown={(e) => {
            const ui = useUi.getState()
            if (e.key === 'ArrowLeft') ui.setLeftWidth(Math.max(LEFT_MIN, ui.leftWidth - 16), true)
            if (e.key === 'ArrowRight') ui.setLeftWidth(Math.min(LEFT_MAX, ui.leftWidth + 16), true)
          }}
        />

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="主视图">
          {mainView === 'timeline' ? (
            <Timeline />
          ) : (
            <EmptyState
              title="选择一个项目"
              description="从左侧项目树中单击一个节点，即可查看它的改动时间线、热力图与属性。"
            />
          )}
        </main>

        {detailOpen ? (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整详情面板宽度"
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
              className="flex min-h-0 shrink-0 flex-col border-l"
              style={{ width: rightWidth, borderColor: 'var(--border)' }}
              aria-label="节点详情"
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
          title="从库中移除"
          message={confirmState.message}
          confirmLabel="移除"
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
