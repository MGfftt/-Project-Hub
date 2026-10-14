/* ---------------------------------------------------------------------------
 * i18n (§9.10) — the main process's own message table.
 *
 * The renderer has its own table (`src/renderer/src/lib/i18n`); this one covers
 * what only the main process renders: the tray menu and tooltip, the native
 * file pickers, the boot failure box, and the errors the IPC handlers throw
 * back at the UI.
 *
 * The language is read once from the `settings` table during boot and updated
 * from the `settings:set` handler, so the tray menu follows a change made in the
 * settings dialog without a restart. Listeners are notified through
 * `onLangChange` — the tray rebuild is registered there.
 * ------------------------------------------------------------------------ */

export type Lang = 'zh' | 'en'

type Entry = readonly [zh: string, en: string]
type Dict = Record<string, Entry>

const MESSAGES: Dict = {
  /* --- tray ------------------------------------------------------------- */
  'tray.tooltipPaused': ['（已暂停）', ' (paused)'],
  'tray.tooltipEvents': [' · {n} 条新变更', ' · {n} new changes'],
  'tray.show': ['显示 Project Hub', 'Show Project Hub'],
  'tray.hide': ['隐藏窗口', 'Hide window'],
  'tray.resume': ['继续后台维护', 'Resume background maintenance'],
  'tray.pause': ['暂停后台维护', 'Pause background maintenance'],
  'tray.syncGit': ['立即同步 Git 历史', 'Sync Git history now'],
  'tray.indexed': ['已索引 {n} 个节点', 'Indexed {n} nodes'],
  'tray.watchingOn': ['文件监视：开启（{n} 个根目录）', 'File watching: on ({n} roots)'],
  'tray.watchingOff': ['文件监视：关闭', 'File watching: off'],
  'tray.quit': ['退出', 'Quit'],

  /* --- boot ------------------------------------------------------------- */
  'app.bootFailed': ['Project Hub 启动失败', 'Project Hub failed to start'],

  /* --- native pickers --------------------------------------------------- */
  'dialog.addRoot': ['选择要纳入 Project Hub 的根目录', 'Pick a folder to add as a root'],
  'dialog.pickIcon': ['选择图标图片', 'Choose an icon image'],
  'dialog.pickBackground': ['选择背景图片', 'Choose a background image'],
  'dialog.pickRelocate': ['选择该项目新的位置', 'Choose the project’s new location'],
  'dialog.images': ['图片', 'Images'],
  'dialog.allFiles': ['所有文件', 'All files'],

  /* --- IPC errors ------------------------------------------------------- */
  'ipc.emptyPath': ['路径为空', 'The path is empty'],
  'ipc.pathMissing': ['路径不存在', 'That path does not exist'],
  'ipc.nodeMissing': ['节点不存在', 'That node does not exist'],
  'ipc.iconOutsideData': ['图标不在应用的数据目录内', 'The icon is not inside the app data directory'],
  'ipc.notAnImage': ['不是支持的图片格式', 'Not a supported image format'],
  'ipc.newGroup': ['新分组', 'New group'],
  'ipc.relocated': ['重新定位：{from} → {to}', 'Relocated: {from} → {to}'],
  'ipc.noFolder': ['该节点没有关联文件夹', 'This node has no folder'],
  'ipc.folderMissing': [
    '文件夹不存在（可能已被移动或删除）',
    'The folder is gone (it may have been moved or deleted)'
  ],
  'ipc.unknownTask': ['未知的后台任务：{task}', 'Unknown background task: {task}'],
  'ipc.rootMissing': ['根目录不存在', 'That root does not exist'],

  /* --- root validation (`assertIndexableRoot`) -------------------------- */
  'root.empty': ['路径为空', 'The path is empty'],
  'root.filesystemRoot': [
    '不能把文件系统根目录作为索引根',
    'A whole filesystem root cannot be indexed'
  ],
  'root.missing': ['路径不存在', 'That path does not exist'],
  'root.home': ['不建议索引整个用户目录', 'Indexing your entire home folder is not advisable'],

  /* --- node names created by the app ----------------------------------- */
  'node.newNote': ['新备注', 'New note']
}

const listeners = new Set<() => void>()
let current: Lang = 'zh'

export function getLang(): Lang {
  return current
}

/** Anything that is not exactly `en` reads as Chinese — the app's own default. */
export function setLang(lang: string | null | undefined): void {
  const next: Lang = lang === 'en' ? 'en' : 'zh'
  const changed = next !== current
  current = next
  if (changed) for (const listener of listeners) listener()
}

/** Called after a language change so menus can rebuild in the new language. */
export function onLangChange(listener: () => void): void {
  listeners.add(listener)
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const entry = MESSAGES[key]
  if (!entry) return key
  let text = entry[current === 'en' ? 1 : 0]
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}
