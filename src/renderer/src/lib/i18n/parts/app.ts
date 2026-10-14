import type { Dict } from '../types'

/**
 * Chrome shared by the whole shell: window-level actions, tabs, the generic
 * dialog buttons.
 */
export const app: Dict = {
  /* --- the tab strip and the column labels (AppShell) -------------------- */
  'app.tab.map': ['全景图', 'Map'],
  'app.tab.overview': ['概览', 'Overview'],
  'app.tab.timeline': ['改动时间线', 'Timeline'],
  'app.tab.mapTitle': [
    '把整个项目库画成一棵树，不需要先选中节点',
    'Draws the whole library as one tree — no selection needed'
  ],
  'app.properties': ['属性', 'Properties'],
  'app.propertiesTitle': [
    '显示或隐藏右侧属性面板（状态、图标、标签）',
    'Show or hide the properties panel (status, icon, tags)'
  ],
  'app.settings': ['设置', 'Settings'],
  'app.settingsTitle': ['打开设置（Ctrl+,）', 'Open settings (Ctrl+,)'],
  'app.treeLabel': ['项目树', 'Project tree'],
  'app.treeResizeLabel': ['调整项目树宽度', 'Resize the project tree'],
  'app.mainViewLabel': ['主视图', 'Main view'],
  'app.mainViewTabsLabel': ['主视图切换', 'Main view tabs'],
  'app.detailLabel': ['节点详情', 'Node details'],
  'app.detailResizeLabel': ['调整详情面板宽度', 'Resize the details panel'],

  /* --- §9.11 the window's own buttons (the frame is hidden) --------------- */
  'win.minimize': ['最小化', 'Minimise'],
  'win.maximize': ['最大化', 'Maximise'],
  'win.restore': ['向下还原', 'Restore'],
  'win.close': ['关闭', 'Close'],

  /* --- §8.5 shortcuts and their status lines ----------------------------- */
  'app.rescanStarted': ['已开始重新扫描', 'Rescan started'],
  'app.rescanFailed': ['重新扫描失败', 'Rescan failed'],
  'app.folderOpened': ['已打开文件夹', 'Folder opened'],
  'app.folderOpenFailed': ['打开文件夹失败', 'Could not open the folder'],
  'app.nodeFallback': ['该节点', 'this node'],
  'app.removeConfirm': [
    '确定将「{name}」从库中移除吗？磁盘上的文件夹不会被删除。',
    'Remove “{name}” from the library? The folder on disk will not be deleted.'
  ],
  'app.removeDialogTitle': ['从库中移除', 'Remove from library'],
  'app.removeConfirmLabel': ['移除', 'Remove'],
  'app.removedFromLibrary': ['已从库中移除', 'Removed from the library'],
  'app.removeFailed': ['移除失败', 'Remove failed'],

  /* --- the renderer stores (stores/tree.ts) ------------------------------ */
  'app.treeLoadFailed': ['读取项目树失败', 'Could not read the project tree'],
  'app.hubUnavailable': ['window.hub 不可用', 'window.hub is unavailable']
}
