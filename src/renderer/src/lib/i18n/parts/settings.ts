import type { Dict } from '../types'

/**
 * SettingsDialog, ConfirmDialog, IconPicker, Modal.
 *
 * The 数据隔离 section keeps its full sentences here on purpose: it is the answer
 * to "does this touch my projects?", so it is stored as prose, not reassembled
 * from fragments.
 */
export const settings: Dict = {
  /* --- the dialog frame (Modal, ConfirmDialog, buttons) ------------------ */
  'settings.title': ['设置', 'Settings'],
  'settings.done': ['完成', 'Done'],
  'settings.close': ['关闭', 'Close'],
  'settings.closeHint': ['关闭（Esc）', 'Close (Esc)'],
  'settings.confirm': ['确认', 'Confirm'],
  'settings.cancel': ['取消', 'Cancel'],
  'settings.on': ['开启', 'On'],
  'settings.off': ['关闭', 'Off'],

  /* --- section headings -------------------------------------------------- */
  'settings.appearance': ['外观', 'Appearance'],
  'settings.interaction': ['交互', 'Interaction'],
  'settings.maintenance': ['后台维护', 'Background maintenance'],
  'settings.data': ['数据', 'Data'],
  'settings.isolation': ['数据隔离', 'Data isolation'],
  'settings.about': ['关于', 'About'],

  /* --- 外观 -------------------------------------------------------------- */
  'settings.theme': ['主题', 'Theme'],
  'settings.themeLight': ['浅色', 'Light'],
  'settings.themeDark': ['深色', 'Dark'],
  'settings.themeSystem': ['跟随系统', 'Follow system'],
  'settings.themeGlass': ['毛玻璃', 'Frosted glass'],
  'settings.language': ['语言', 'Language'],
  'settings.languageHint': ['界面语言', 'Interface language'],
  'settings.compactMode': ['紧凑模式', 'Compact mode'],
  'settings.compactModeHint': ['使用 26px 行高', 'Use a 26px row height'],
  'settings.background': ['背景图片', 'Background image'],
  'settings.chooseImage': ['选择图片', 'Choose image'],
  'settings.clear': ['清除', 'Clear'],
  'settings.notSet': ['未设置', 'Not set'],
  'settings.backgroundHint': [
    '选好之后立刻生效：三个栏位会变成半透明，图片透在后面；想要更明显的玻璃感，把主题选成「毛玻璃」。',
    'Takes effect immediately: the three columns turn translucent so the picture shows through. Pick the “Frosted glass” theme for a stronger effect.'
  ],
  'settings.backgroundSet': ['已设置背景图片', 'Background image set'],
  'settings.backgroundCleared': ['已清除背景图片', 'Background image cleared'],
  'settings.backgroundClearFailed': ['清除背景图片失败', 'Could not clear the background image'],

  /* --- 交互 -------------------------------------------------------------- */
  'settings.doubleClickOpen': ['双击打开文件夹', 'Double-click opens the folder'],
  'settings.doubleClickOpenOn': ['已开启双击打开文件夹', 'Double-click to open is on'],
  'settings.doubleClickOpenOff': [
    '已关闭双击打开，双击只用于展开与折叠',
    'Double-click to open is off; double-click only expands and collapses'
  ],
  'settings.hideToTray': ['关闭时隐藏到托盘', 'Hide to tray when closing'],
  'settings.hideToTrayHint': ['关闭窗口时隐藏到托盘', 'Hide to the tray when the window closes'],
  'settings.autoLaunch': ['开机自启', 'Launch at login'],
  'settings.autoLaunchOn': ['已开启开机自启', 'Launch at login is on'],
  'settings.autoLaunchOff': ['已关闭开机自启', 'Launch at login is off'],
  'settings.autoLaunchFailed': ['设置开机自启失败', 'Could not change launch at login'],

  /* --- 后台维护 ---------------------------------------------------------- */
  'settings.status': ['状态', 'Status'],
  'settings.loading': ['读取中…', 'Reading…'],
  'settings.statusPaused': ['已暂停', 'Paused'],
  'settings.statusRunning': ['运行中', 'Running'],
  'settings.resume': ['继续', 'Resume'],
  'settings.pause': ['暂停', 'Pause'],
  'settings.maintenancePaused': ['后台维护已暂停', 'Background maintenance paused'],
  'settings.maintenanceResumed': ['后台维护已继续', 'Background maintenance resumed'],
  'settings.maintenanceToggleFailed': [
    '切换后台维护状态失败',
    'Could not change the background maintenance state'
  ],
  'settings.nextRun': ['下次运行', 'Next run'],
  'settings.noPlan': ['暂无计划', 'Nothing scheduled'],
  'settings.nextRunTask': ['{task}：', '{task}: '],
  'settings.inDuration': ['（{duration}后）', ' in {duration}'],
  'settings.taskRescan': ['重新扫描', 'Rescan'],
  'settings.taskGitSync': ['Git 同步', 'Git sync'],
  'settings.taskSnapshot': ['数据库快照', 'Database snapshot'],
  'settings.taskPrune': ['清理旧记录', 'Prune old records'],
  'settings.taskSizeSweep': ['大小补算', 'Backfill sizes'],
  'settings.power': ['电源', 'Power'],
  'settings.onBattery': [
    '当前由电池供电，后台维护已自动降速',
    'Running on battery; background maintenance has slowed down automatically'
  ],

  /* --- 数据 -------------------------------------------------------------- */
  'settings.dataDir': ['数据目录', 'Data directory'],
  'settings.database': ['数据库', 'Database'],
  'settings.engine': ['存储引擎 / schema', 'Storage engine / schema'],
  'settings.engineValue': ['{driver} · schema v{version}', '{driver} · schema v{version}'],
  'settings.scale': [
    '{roots} 个根目录 · {nodes} 个节点 · {events} 条改动',
    '{roots} roots · {nodes} nodes · {events} changes'
  ],
  'settings.scaleLabel': ['规模', 'Scale'],

  /* --- 数据隔离 ---------------------------------------------------------- */
  'settings.isolationLead': [
    '所有数据都保存在本程序的 userData 目录内。',
    'All data is stored inside the userData directory of this program.'
  ],
  'settings.isolationBody': [
    '被索引的项目文件夹始终是只读的：标注、显示名、图标、标签、笔记与改动记录只写入本程序的 userData 目录。',
    'Indexed project folders are always read-only: annotations, display names, icons, tags, notes and change records are written only to the userData directory of this program.'
  ],
  'settings.isolationNever': [
    '本程序从不向被索引的项目目录写入任何文件。',
    'This program never writes any file into an indexed project folder.'
  ],
  'settings.isolationScan': [
    '扫描、Git 历史读取与文件监视都以只读方式访问项目目录，不会新增、修改或删除其中的任何内容。',
    'Scanning, Git history reads and file watching all access project folders read-only; nothing in them is added, changed or deleted.'
  ],

  /* --- 关于 -------------------------------------------------------------- */
  'settings.version': ['版本', 'Version'],
  'settings.versionValue': [
    'Project Hub {version}（Electron {electron} · Node {node}）',
    'Project Hub {version} (Electron {electron} · Node {node})'
  ],
  'settings.platform': ['平台', 'Platform'],
  'settings.currentTime': ['当前时间', 'Current time'],

  /* --- IconPicker -------------------------------------------------------- */
  'settings.iconPickerTitle': ['选择图标', 'Choose an icon'],
  'settings.iconSource': ['图标来源', 'Icon source'],
  'settings.tabAuto': ['自动', 'Auto'],
  'settings.tabBuiltin': ['内置', 'Built-in'],
  'settings.tabCustom': ['自定义', 'Custom'],
  'settings.iconInfer': ['根据名称与类型推断', 'Inferred from the name and kind'],
  'settings.iconRestoreAuto': ['恢复自动', 'Restore automatic'],
  'settings.iconAutoRestored': ['已恢复自动图标', 'Automatic icon restored'],
  'settings.iconSearchPlaceholder': ['搜索图标名称…', 'Search icon names…'],
  'settings.iconSearchLabel': ['搜索内置图标', 'Search built-in icons'],
  'settings.iconLoading': ['加载中…', 'Loading…'],
  'settings.iconNoMatch': ['没有匹配的图标', 'No matching icons'],
  'settings.iconSet': ['已设置图标：{name}', 'Icon set: {name}'],
  'settings.iconSetFailed': ['设置图标失败', 'Could not set the icon'],
  'settings.iconLoadFailed': ['读取图标失败', 'Could not read the icons'],
  'settings.iconImportFailed': ['导入图标失败', 'Could not import the icon'],
  'settings.iconImported': ['已导入图标', 'Icon imported'],
  'settings.useEmoji': ['使用 {emoji}', 'Use {emoji}'],
  'settings.emoji': ['Emoji', 'Emoji'],
  'settings.importedImages': ['已导入的图片', 'Imported images'],
  'settings.none': ['暂无', 'None'],
  'settings.importFromFile': ['从文件导入', 'Import from a file']
}
