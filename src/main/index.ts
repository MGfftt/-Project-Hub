/**
 * Main-process entry point.
 *
 * Responsibilities, in boot order (§10.1):
 *   1. single-instance lock and `--hidden` detection (tray-resident start)
 *   2. logging + `userData` layout (the *only* place the app writes its own state)
 *   3. SQLite bootstrap (WAL, schema, integrity check)
 *   4. IPC surface, tray, window, scheduler
 *
 * Traceability: nothing in this file (or any file it imports) writes into an
 * indexed project folder. Every path the app owns lives under `app.getPath('userData')`.
 */

import { app, BrowserWindow, Menu, Tray, nativeTheme, powerMonitor, protocol, net, screen } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, appendFile } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CH, type BroadcastChannel } from '../shared/channels'
import { SETTING_KEYS, type BackgroundStatus, type HubEvent, type ScanProgress, type TrayState } from '../shared/types'

import { closeDatabase, getDb, getUserVersion, initDatabase } from './db'
import { repo } from './db/repo'
import { driverName } from './db/sqlite'
import { registerIpcHandlers, reassertWindowMaterial, runScan, type IpcContext } from './ipc/main'
import { createAnchor, backgroundStoreDir, iconStoreDir, logDir } from './ipc/anchor'
import { Thumbnailer } from './services/thumbnailer'
import { SerialQueue, runningTaskNames } from './worker/pool'
import { Scheduler } from './background/scheduler'
import { registerAllTasks, syncAllGit, type TaskContext } from './background/tasks'
import { addLogSink, createLogger, setLogLevel, type LogLevel } from './utils/logger'
import { noteActivity } from './utils/power'
import { createAppIcon, createTrayIcon } from './tray/icon'
import { onLangChange, setLang, t } from './i18n'

const log = createLogger('boot')

/* ------------------------------------------------------------------ */
/* Single instance + start-hidden                                      */
/* ------------------------------------------------------------------ */

/**
 * `--hidden` is appended to the login-item command line (see `setAutoLaunch`), so
 * the app can boot straight to the tray without flashing a window on login.
 */
const START_HIDDEN = process.argv.includes('--hidden')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Another instance owns the DB; hand focus to it and exit before touching disk.
  app.quit()
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

/** Populated in `app.whenReady`; kept module-level so late calls can reach it. */
let userDataDir = ''
let thumbsDir = ''
let backgroundsDir = ''
let iconsDir = ''
let dbPath = ''
let appLogDir = ''

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let scheduler: Scheduler | null = null
let watcher: Awaited<ReturnType<typeof registerAllTasks>> = null
let ipcCtx: IpcContext | null = null
let isQuitting = false

/**
 * §9.11 window chrome. The frame is hidden, so these two are the whole title
 * bar: `windowMaximized` drives the icon, and `windowRestoreBounds` remembers
 * where the window was before it filled the work area. They are read by the
 * `window:*` channels through `IpcContext`.
 */
let windowMaximized = false
let windowRestoreBounds: Electron.Rectangle | null = null

/** Unread-event counter surfaced in the tray tooltip; reset when the window shows. */
let unreadEvents = 0
let lastGitSync = 0

const scanQueue = new SerialQueue()

/* ------------------------------------------------------------------ */
/* Broadcast plumbing                                                  */
/* ------------------------------------------------------------------ */

function send(channel: BroadcastChannel, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.webContents.send(channel, payload)
  } catch (err) {
    log.debug('broadcast failed', { channel, err: (err as Error).message })
  }
}

const broadcast = (channel: string, payload: unknown): void => send(channel as BroadcastChannel, payload)

function trayState(): TrayState {
  return {
    paused: scheduler?.isPaused() ?? false,
    unreadEvents,
    // `null` means "never synced"; 0 would be indistinguishable from a sync at
    // the epoch, and the UI shows "从未同步" for it.
    lastGitSync: lastGitSync > 0 ? lastGitSync : null,
    // A count, not a flag: the settings panel reports how many roots are watched.
    watching: watcher?.watchedRoots().length ?? 0
  }
}

function pushTrayState(): void {
  const state = trayState()
  send(CH.broadcast.trayState, state)
  if (tray) {
    const suffix = state.paused ? t('tray.tooltipPaused') : ''
    tray.setToolTip(
      `Project Hub${suffix}${state.unreadEvents > 0 ? t('tray.tooltipEvents', { n: state.unreadEvents }) : ''}`
    )
  }
}

/* ------------------------------------------------------------------ */
/* hub-media:// protocol                                               */
/* ------------------------------------------------------------------ */

/**
 * Thumbnails, imported icons and background images are served to the renderer over
 * a custom scheme restricted to the app's own store directories.
 *
 * Why not `file://`: the renderer runs with `webSecurity` on and no filesystem
 * access; a custom scheme keeps the boundary explicit and lets us add CSP/range
 * handling in one place. Anything outside the whitelisted roots is rejected.
 */
function registerMediaProtocol(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'hub-media',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
    }
  ])
}

function installMediaHandler(): void {
  const roots = [thumbsDir, iconsDir, backgroundsDir].filter(Boolean).map((p) => normalize(p) + sep)

  protocol.handle('hub-media', async (request) => {
    try {
      const url = new URL(request.url)
      const encoded = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (!encoded) return new Response('bad request', { status: 400 })

      const wanted = normalize(encoded)
      const allowed = roots.some((root) => (wanted + sep).startsWith(root) || wanted.startsWith(root))
      if (!allowed) {
        log.warn('hub-media blocked', { wanted })
        return new Response('forbidden', { status: 403 })
      }
      if (!existsSync(wanted)) return new Response('not found', { status: 404 })

      // `net.fetch` gives us streaming, Range support and correct MIME detection
      // without a dependency; `bypassCustomProtocolHandlers` avoids re-entry.
      return await net.fetch(pathToFileURL(wanted).toString(), { bypassCustomProtocolHandlers: true })
    } catch (err) {
      log.warn('hub-media failed', { err: (err as Error).message })
      return new Response('error', { status: 500 })
    }
  })
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

const preloadPath = join(__dirname, '../preload/index.cjs')

function createWindow(): BrowserWindow {
  const settings = safeSettings()
  const icon = createAppIcon()
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    // Without this the taskbar and Alt-Tab carry Electron's own icon in
    // development, where `process.execPath` is electron.exe.
    ...(icon.isEmpty() ? {} : { icon }),
    // §9.11 — the frosted-glass switch only means something if the window itself
    // can be seen through, and on Windows a transparent window has to be
    // frameless: the native frame forces an opaque client area. The tab strip
    // therefore draws its own minimise/maximise/close buttons, and the whole
    // surface stays opaque until `data-glass` turns the sheets translucent.
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    title: 'Project Hub',
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: true
    }
  })

  // §9.6: no in-app menu in production; keep the accelerators on macOS.
  if (process.platform !== 'darwin') win.setMenuBarVisibility(false)
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.getApplicationMenu() : null)

  win.once('ready-to-show', () => {
    // The spec wants an interactive frame ASAP; showing before `ready-to-show`
    // trades a flash of unstyled UI for a faster first paint, which §12 rejects.
    if (!START_HIDDEN && settings[SETTING_KEYS.firstHideTip] !== 'shown') win.show()
  })

  win.on('show', () => {
    unreadEvents = 0
    noteActivity()
    pushTrayState()
    send(CH.broadcast.windowVisibility, { visible: true })
    // §9.11 — the backdrop does not survive being hidden, so it comes back with
    // the window. Every path that makes the window visible again re-asserts it.
    reassertWindowMaterial(mainWindow)
  })

  win.on('restore', () => {
    noteActivity()
    reassertWindowMaterial(mainWindow)
  })

  win.on('hide', () => {
    noteActivity()
    pushTrayState()
    send(CH.broadcast.windowVisibility, { visible: false })
  })

  win.on('focus', () => noteActivity())

  // §9.11 — a layered window is maximised by the compositor without regard for
  // the work area, so a maximised app would cover the taskbar; the bounds are
  // pulled back to `workArea`. Double-clicking the drag strip takes this path.
  win.on('maximize', () => {
    windowMaximized = true
    const area = screen.getDisplayMatching(win.getBounds()).workArea
    win.setBounds(area)
    send(CH.broadcast.windowMaximized, { maximized: true })
    reassertWindowMaterial(mainWindow)
  })

  win.on('unmaximize', () => {
    windowMaximized = false
    windowRestoreBounds = null
    send(CH.broadcast.windowMaximized, { maximized: false })
    reassertWindowMaterial(mainWindow)
  })

  // §10.2: closing hides to tray instead of quitting, unless the user turned that
  // off in settings or is quitting from the tray menu.
  win.on('close', (event) => {
    if (isQuitting) return
    const hide = safeSettings()[SETTING_KEYS.hideToTray] !== 'false'
    if (hide) {
      event.preventDefault()
      win.hide()
    }
  })

  win.on('closed', () => {
    mainWindow = null
  })

  return win
}

/**
 * §9.11 — the tab strip's middle button.
 *
 * The renderer cannot call `win.maximize()` and trust it: on a layered window
 * the compositor ignores the work area and `isMaximized()` does not reliably
 * report the result, so the state is tracked here and the restored bounds are
 * remembered explicitly.
 */
function toggleMaximizeWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return

  if (windowMaximized) {
    const bounds = windowRestoreBounds
    windowMaximized = false
    windowRestoreBounds = null
    if (win.isMaximized()) win.unmaximize()
    if (bounds) win.setBounds(bounds)
    send(CH.broadcast.windowMaximized, { maximized: false })
    reassertWindowMaterial(win)
    return
  }

  windowRestoreBounds = win.getBounds()
  windowMaximized = true
  const area = screen.getDisplayMatching(windowRestoreBounds).workArea
  win.setBounds(area)
  send(CH.broadcast.windowMaximized, { maximized: true })
  reassertWindowMaterial(win)
}

function isWindowMaximized(): boolean {
  return windowMaximized
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
  }
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  unreadEvents = 0
  pushTrayState()
}

function toggleWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide()
  } else {
    showWindow()
  }
}

/* ------------------------------------------------------------------ */
/* Tray                                                                */
/* ------------------------------------------------------------------ */

function buildTray(): void {
  // A code-drawn icon keeps the bundle free of binary assets (§5) while still
  // looking deliberate; see `tray/icon.ts` for the two-tone "hub" glyph.
  tray = new Tray(createTrayIcon(nativeTheme.shouldUseDarkColors))
  tray.setToolTip('Project Hub')
  refreshTrayMenu()

  // Windows/Linux: left click opens the window (single-click affordance, R2).
  tray.on('click', () => showWindow())
  tray.on('double-click', () => showWindow())
  tray.on('right-click', () => refreshTrayMenu())

  nativeTheme.on('updated', () => {
    if (!tray) return
    tray.setImage(createTrayIcon(nativeTheme.shouldUseDarkColors))
  })

  // §9.10 — a language change made in the settings dialog relabels the menu.
  onLangChange(() => {
    pushTrayState()
    refreshTrayMenu()
  })
}

function refreshTrayMenu(): void {
  if (!tray) return
  const paused = scheduler?.isPaused() ?? false
  const state = trayState()
  const menu = Menu.buildFromTemplate([
    { label: t('tray.show'), click: () => showWindow() },
    { label: t('tray.hide'), click: () => mainWindow?.hide() },
    { type: 'separator' },
    {
      label: paused ? t('tray.resume') : t('tray.pause'),
      click: () => {
        const next = !(scheduler?.isPaused() ?? false)
        if (next) scheduler?.setPaused(true)
        else scheduler?.setPaused(false)
        repo.setSetting(SETTING_KEYS.pauseOnBattery, next ? 'true' : 'false')
        refreshTrayMenu()
        pushTrayState()
      }
    },
    {
      label: t('tray.syncGit'),
      click: () => {
        void (async () => {
          try {
            const res = await syncAllGit(200)
            lastGitSync = Date.now()
            repo.setSetting(SETTING_KEYS.lastGitSyncAt, String(lastGitSync))
            send(CH.broadcast.treeUpdated, { reason: 'git-sync' })
            if (res.newEvents > 0) {
              unreadEvents += res.newEvents
              send(CH.broadcast.eventsAppended, { count: res.newEvents })
            }
            pushTrayState()
            refreshTrayMenu()
          } catch (err) {
            log.warn('tray git sync failed', { err: (err as Error).message })
          }
        })()
      }
    },
    { type: 'separator' },
    {
      label: t('tray.indexed', { n: repo.counts().nodes }),
      enabled: false
    },
    {
      label: state.watching > 0 ? t('tray.watchingOn', { n: state.watching }) : t('tray.watchingOff'),
      enabled: false
    },
    { type: 'separator' },
    {
      label: t('tray.quit'),
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

/* ------------------------------------------------------------------ */
/* Settings helpers                                                    */
/* ------------------------------------------------------------------ */

/** Never throws: during boot the DB may legitimately be missing. */
function safeSettings(): Record<string, string> {
  try {
    const rows = repo.allSettings()
    return { ...rows }
  } catch {
    return {}
  }
}

function settingString(key: string, fallback: string): string {
  const value = safeSettings()[key]
  return value === undefined || value === '' ? fallback : value
}

function applyLogLevel(): void {
  const raw = (settingString('logLevel', process.env.PROJECT_HUB_LOG ?? 'info') || 'info') as LogLevel
  const level: LogLevel = ['debug', 'info', 'warn', 'error'].includes(raw) ? raw : 'info'
  setLogLevel(level)
}

/* ------------------------------------------------------------------ */
/* Background tasks                                                    */
/* ------------------------------------------------------------------ */

function taskContext(): TaskContext {
  return {
    scheduler: scheduler!,
    broadcast: {
      treeUpdated: () => {
        send(CH.broadcast.treeUpdated, { reason: 'task' })
        refreshTrayMenu()
      },
      eventsAppended: (events: HubEvent[]) => {
        if (events.length > 0 && mainWindow && !mainWindow.isVisible()) unreadEvents += events.length
        send(CH.broadcast.eventsAppended, events)
        pushTrayState()
      },
      scanProgress: (progress: ScanProgress) => send(CH.broadcast.scanProgress, progress)
    },
    isFirstRun: () => repo.listRoots().length === 0
  }
}

async function writeStartupLog(): Promise<void> {
  try {
    await mkdir(appLogDir, { recursive: true })
  } catch {
    /* logging is best-effort */
  }
  let queue: Promise<unknown> = Promise.resolve()
  addLogSink((line) => {
    // The sink is already fully formatted by `logger.emit`; we only append it.
    // Writes are serialised so interleaved lines cannot corrupt the file, and a
    // failure disables the sink rather than throwing on every later log call.
    const file = join(appLogDir, 'app.log')
    queue = queue
      .then(() => appendFile(file, line + '\n', 'utf8'))
      .catch(() => {
        /* disk full / permission: keep the console sink working */
      })
  })
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

registerMediaProtocol()

app.on('second-instance', () => {
  // A second launch is a user gesture: surface the window instead of ignoring it.
  showWindow()
})

app.on('window-all-closed', () => {
  // Tray-resident: the only way to quit is the tray menu or `app.quit()`.
  if (process.platform !== 'darwin' && isQuitting) app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  try {
    scheduler?.stop()
    if (watcher) void watcher.close()
  } catch (err) {
    log.debug('shutdown: watcher/scheduler', { err: (err as Error).message })
  }
  try {
    closeDatabase()
  } catch (err) {
    log.debug('shutdown: db', { err: (err as Error).message })
  }
})

// macOS: clicking the dock icon after the window was hidden should bring it back.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow()
    void loadRenderer(mainWindow)
  } else {
    showWindow()
  }
})

async function loadRenderer(win: BrowserWindow): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl && !app.isPackaged) {
    await win.loadURL(devUrl)
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function boot(): Promise<void> {
  userDataDir = app.getPath('userData')
  appLogDir = logDir(userDataDir)
  applyLogLevel()

  // Layout under userData — the app's whole world (data isolation, §4.3).
  thumbsDir = join(userDataDir, 'thumbnails')
  iconsDir = iconStoreDir(userDataDir)
  backgroundsDir = backgroundStoreDir(userDataDir)
  dbPath = join(userDataDir, 'data.db')

  await Promise.all([
    writeStartupLog(),
    mkdir(thumbsDir, { recursive: true }),
    mkdir(iconsDir, { recursive: true }),
    mkdir(backgroundsDir, { recursive: true })
  ])

  const opened = initDatabase({ path: dbPath })
  // §9.10 — read the language before anything that renders text is built.
  setLang(settingString(SETTING_KEYS.language, 'zh'))
  log.info('database ready', {
    path: dbPath,
    driver: driverName,
    schema: getUserVersion(getDb()),
    recoveredFrom: opened.recoveredFrom ?? null
  })

  installMediaHandler()

  const anchor = createAnchor({ thumbsDir, backgroundsDir, appDir: userDataDir })
  const thumbnailer = new Thumbnailer(thumbsDir)

  scheduler = new Scheduler({
    onStatus: (status: BackgroundStatus) => send(CH.broadcast.taskStatus, status),
    isOnBattery: () => isOnBattery(),
    isWindowHidden: () => !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()
  })
  // Pause state is persisted so a restart honours the user's last choice.
  if (settingString(SETTING_KEYS.pauseOnBattery, 'false') === 'true') scheduler.setPaused(true)

  ipcCtx = {
    anchor,
    thumbnailer,
    scheduler,
    userData: userDataDir,
    dbPath,
    thumbsDir,
    backgroundsDir,
    getWindow: () => mainWindow,
    toggleMaximizeWindow,
    windowMaximized: isWindowMaximized,
    broadcast,
    scanQueue
  }
  registerIpcHandlers(ipcCtx)

  mainWindow = createWindow()

  // Tasks are registered before the first paint so a long scan never blocks the UI.
  // `registerAllTasks` owns the watcher: folder hints are turned into `events`
  // rows there and pushed to the renderer through `ctx.broadcast`.
  watcher = await registerAllTasks(taskContext())
  scheduler.start()
  scheduler.setEnvironment({ windowHidden: !mainWindow.isVisible() })

  await loadRenderer(mainWindow)

  // First run with roots already configured (e.g. config restored): kick a scan
  // so the tree is not empty while the scheduler waits for its first tick.
  const roots = repo.listEnabledRoots()
  if (roots.length > 0 && repo.counts().nodes === 0) {
    void scanQueue.enqueue('startup-scan', async () => {
      for (const root of roots) {
        try {
          await runScan(ipcCtx!, root.id, true)
        } catch (err) {
          log.warn('startup scan failed', { rootId: root.id, err: (err as Error).message })
        }
      }
      send(CH.broadcast.treeUpdated, { reason: 'startup-scan' })
    })
  }

  if (roots.length > 0) {
    // Touch git history soon after boot (but off the critical path) so the
    // timeline has content on first open.
    setTimeout(() => void syncAllGit(80).catch(() => undefined), 4_000).unref()
  }

  lastGitSync = Number(settingString(SETTING_KEYS.lastGitSyncAt, '0')) || 0
  buildTray()
  refreshTrayMenu()
  pushTrayState()

  if (START_HIDDEN) log.info('started hidden (auto-launch)')
}

/* ------------------------------------------------------------------ */
/* Battery probe                                                       */
/* ------------------------------------------------------------------ */

/**
 * `powerMonitor.onBatteryPower` is undefined on some Linux builds, so fall back to
 * the method form and then to `false` (never skip maintenance just because the
 * probe is missing).
 */
function isOnBattery(): boolean {
  try {
    const mon = powerMonitor as unknown as { isOnBatteryPower?: () => boolean; onBatteryPower?: boolean }
    if (typeof mon.isOnBatteryPower === 'function') return mon.isOnBatteryPower()
    if (typeof mon.onBatteryPower === 'boolean') return mon.onBatteryPower
  } catch {
    /* not supported on this platform */
  }
  return false
}

function watchPower(): void {
  const update = (): void => {
    scheduler?.setEnvironment({ onBattery: isOnBattery() })
    refreshTrayMenu()
  }
  powerMonitor.on('on-ac', update)
  powerMonitor.on('on-battery', update)
  // Low-frequency safety net: `on-ac`/`on-battery` are not emitted on every platform.
  setInterval(() => {
    scheduler?.setEnvironment({ onBattery: isOnBattery() })
  }, 60_000).unref()
}

/* ------------------------------------------------------------------ */
/* Go                                                                  */
/* ------------------------------------------------------------------ */

if (gotLock) {
  void app.whenReady().then(async () => {
    try {
      await boot()
      watchPower()
    } catch (err) {
      log.error('boot failed', { err: (err as Error).message, stack: (err as Error).stack })
      // A boot failure that leaves no window is worse than a visible error, so
      // surface it instead of dying silently in the tray.
      const { dialog } = await import('electron')
      dialog.showErrorBox(t('app.bootFailed'), String((err as Error).stack ?? err))
      app.exit(1)
    }
  })
}

export { broadcast, showWindow, toggleWindow, isOnBattery, dbPath }

/** Kept for `scripts/doctor.mjs` style debugging: exposes resolved paths read-only. */
export function describeEnvironment(): Record<string, string | number | boolean> {
  return {
    userData: userDataDir,
    dbPath,
    thumbsDir,
    iconsDir,
    backgroundsDir,
    appLogDir,
    driver: driverName,
    schema: safeUserVersion(),
    roots: repo.listRoots().length,
    nodes: repo.counts().nodes,
    events: repo.counts().events,
    runningTasks: runningTaskNames().join(','),
    packaged: app.isPackaged,
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node
  }
}

function safeUserVersion(): number {
  try {
    return getUserVersion(getDb())
  } catch {
    return -1
  }
}

/** Re-exported for tests that import the entry module without booting Electron. */
export const __paths = {
  get userData(): string {
    return userDataDir
  },
  get db(): string {
    return dbPath
  },
  get icons(): string {
    return iconsDir
  }
}
