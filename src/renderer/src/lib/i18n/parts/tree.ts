import type { Dict } from '../types'

/** TreePanel, NodeTree, NodeRow, ContextMenu. */
export const tree: Dict = {
  /* --- TreePanel toolbar ------------------------------------------------- */
  'tree.root': ['根目录', 'Root'],
  'tree.scannedCountOne': ['已扫描 {n} 个目录', 'Scanned {n} folder'],
  'tree.addRoot': ['添加根目录', 'Add root'],
  'tree.addRootTitle': [
    '添加根目录（扫描其中的项目）',
    'Add a root folder (scans the projects inside)'
  ],
  'tree.newGroupTitle': [
    '在当前选中项下新建虚拟分组',
    'Create a virtual group under the current selection'
  ],
  'tree.expandAll': ['展开全部', 'Expand all'],
  'tree.collapseAll': ['折叠全部', 'Collapse all'],
  'tree.rescan': ['重新扫描', 'Rescan'],
  'tree.rescanTitle': ['重新扫描根目录（Ctrl/Cmd + R）', 'Rescan the root folder (Ctrl/Cmd + R)'],

  /* --- scan progress ----------------------------------------------------- */
  'tree.scannedCount': ['已扫描 {n} 个目录', 'Scanned {n} folders'],

  /* --- §9.6 empty state -------------------------------------------------- */
  'tree.emptyTitle': ['还没有索引任何项目', 'Nothing indexed yet'],
  'tree.emptyDescription': [
    '添加一个根目录，程序会扫描其中的项目与文件夹。程序只读取磁盘，不会写入被索引的目录。',
    'Add a root folder and the app scans the projects and folders inside it. It only reads from disk and never writes to the folders it indexes.'
  ],
  'tree.emptyGlyph': ['项目库示意图', 'Project library illustration'],

  /* --- footer: 根目录管理 ------------------------------------------------ */
  'tree.rootManage': ['根目录管理（{n}）', 'Root folders ({n})'],
  'tree.noRoots': ['尚未添加根目录', 'No root folders yet'],
  'tree.enableRoot': ['启用 {path}', 'Enable {path}'],
  'tree.rootDepthAdded': ['深度 {depth} · 添加于 {time}', 'Depth {depth} · added {time}'],
  'tree.rescanRoot': ['重新扫描此根目录', 'Rescan this root folder'],
  'tree.rescanRootLabel': ['重新扫描 {path}', 'Rescan {path}'],
  'tree.removeRootHint': [
    '从库中移除（不会删除磁盘文件）',
    'Remove from library (disk files are not deleted)'
  ],
  'tree.removeLabel': ['移除 {path}', 'Remove {path}'],
  'tree.manualExpand': ['手动输入路径…', 'Enter a path manually…'],
  'tree.manualCollapse': ['收起手动输入', 'Hide manual entry'],
  'tree.pathPlaceholder': ['C:\\Users\\你\\Desktop\\项目', 'C:\\Users\\you\\Desktop\\projects'],
  'tree.rootPathLabel': ['根目录路径', 'Root folder path'],
  'tree.add': ['添加', 'Add'],

  /* --- footer: 改动热力图 ------------------------------------------------ */
  'tree.heatmap': ['改动热力图', 'Change heatmap'],

  /* --- confirmation dialogs ---------------------------------------------- */
  'tree.removeRoot': ['移除根目录', 'Remove root folder'],
  'tree.removeRootConfirm': [
    '移除「{path}」只会删除本程序中的索引记录，磁盘上的文件不会被修改。确认移除？',
    'Removing “{path}” only deletes the index entry in this app; the files on disk are left untouched. Remove it?'
  ],
  'tree.removeFromLibrary': ['从库中移除', 'Remove from library'],
  'tree.removeNodeConfirm': [
    '这只会删除本程序中的记录，磁盘上的文件不会被修改。确认移除？',
    'This only deletes the entry in this app; the files on disk are not touched. Remove it?'
  ],
  'tree.remove': ['移除', 'Remove'],

  /* --- status lines (setStatus) ------------------------------------------ */
  'tree.rootsLoadFailed': ['读取根目录失败：{error}', 'Could not read the root folders: {error}'],
  'tree.needPath': ['请输入一个文件夹路径', 'Enter a folder path'],
  'tree.rootAlready': ['这个文件夹已经是根目录了：{path}', 'This folder is already a root: {path}'],
  'tree.rootAdded': ['已添加根目录：{path}，正在扫描…', 'Root added: {path} — scanning…'],
  'tree.rootAddFailed': ['添加根目录失败：{error}', 'Could not add the root folder: {error}'],
  'tree.pickPrompt': ['请在系统窗口里选择一个文件夹…', 'Pick a folder in the system dialog…'],
  'tree.pickCancelled': [
    '没有选择文件夹。如果系统窗口没有出现，请用「手动输入路径」添加。',
    'No folder was picked. If the system dialog never appeared, add one with “Enter a path manually”.'
  ],
  'tree.pickFailed': [
    '打开文件夹选择框失败：{error}。可以改用「手动输入路径」。',
    'Could not open the folder picker: {error}. Use “Enter a path manually” instead.'
  ],
  'tree.needRoot': ['请先添加一个根目录', 'Add a root folder first'],
  'tree.scanDone': [
    '扫描完成：{projects} 个项目、{folders} 个文件夹，用时 {ms} ms',
    'Scan complete: {projects} projects, {folders} folders in {ms} ms'
  ],
  'tree.scanFailed': ['扫描失败：{error}', 'Scan failed: {error}'],
  'tree.newGroupName': ['新分组 {time}', 'New group {time}'],
  'tree.newGroup': ['新建分组', 'New group'],
  'tree.newGroupFailed': ['新建分组失败：{error}', 'Could not create the group: {error}'],
  'tree.groupCreated': [
    '已创建分组，可在右侧「属性」里改名称与标注',
    'Group created — rename it and add notes under “Properties” on the right'
  ],
  'tree.groupCreateFailed': ['创建分组失败：{error}', 'Could not create the group: {error}'],
  'tree.rootRemoved': [
    '已移除根目录：{path}（磁盘文件未做任何改动）',
    'Root removed: {path} (nothing on disk was changed)'
  ],
  'tree.rootRemoveFailed': ['移除根目录失败：{error}', 'Could not remove the root folder: {error}'],
  'tree.rootToggleFailed': [
    '切换根目录启用状态失败：{error}',
    'Could not change the root folder’s enabled state: {error}'
  ],
  'tree.nodeRemoved': [
    '已从库中移除（磁盘文件未做任何改动）',
    'Removed from the library (nothing on disk was changed)'
  ],
  'tree.removeFailed': ['移除失败：{error}', 'Could not remove it: {error}'],
  'tree.cannotOpenFolder': ['无法打开该文件夹', 'Could not open that folder'],
  'tree.openFailed': ['打开失败：{error}', 'Could not open it: {error}'],
  'tree.revealFailed': [
    '无法在文件管理器中显示：{error}',
    'Could not show it in the file manager: {error}'
  ],
  'tree.pathCopied': ['已复制路径到剪贴板', 'Path copied to the clipboard'],
  'tree.copyPathFailed': ['复制路径失败：{error}', 'Could not copy the path: {error}'],

  /* --- selected node summary --------------------------------------------- */
  'tree.selected': ['已选：{kind} · {name}', 'Selected: {kind} · {name}'],

  /* --- NodeRow (§9.2) ---------------------------------------------------- */
  'tree.expand': ['展开', 'Expand'],
  'tree.collapse': ['折叠', 'Collapse'],
  'tree.emptyNote': ['空白备注', 'Blank note'],
  'tree.virtualGroupNoPath': ['虚拟分组（无磁盘目录）', 'Virtual group (no folder on disk)'],
  'tree.clickHintNote': [
    '单击查看 · 双击展开或折叠',
    'Click to view · double-click to expand or collapse'
  ],
  'tree.clickHintFolder': [
    '单击查看 · 双击展开或打开目录',
    'Click to view · double-click to expand or open the folder'
  ],
  'tree.colorLabel': ['颜色：{color}', 'Color: {color}'],
  'tree.renameHint': [
    '仅在本程序中显示，不会修改磁盘目录名',
    'Shown only in this app — the folder on disk is never renamed'
  ],
  'tree.renameFieldLabel': ['重命名显示名称', 'Rename display name'],
  'tree.childCount': [
    '{n} 个直接子节点，展开即可看到',
    '{n} direct children — expand to see them'
  ],
  'tree.lastChanged': ['最近改动：{time}', 'Last changed: {time}'],
  'tree.rename': ['重命名', 'Rename'],
  'tree.renameTitle': [
    '重命名（程序内，不会修改磁盘目录名）',
    'Rename in app (the folder on disk keeps its name)'
  ],

  /* --- ContextMenu (§8.2) ------------------------------------------------ */
  'tree.openFolder': ['打开文件夹', 'Open folder'],
  'tree.revealInFileManager': ['在文件管理器中显示', 'Show in file manager'],
  'tree.copyPath': ['复制路径', 'Copy path'],
  'tree.viewChanges': ['查看改动', 'View changes'],
  'tree.properties': ['属性', 'Properties'],
  'tree.annotate': ['标注', 'Annotate'],
  'tree.renameInApp': ['重命名（程序内）', 'Rename (in app)'],
  'tree.renameHintMenu': [
    '仅修改程序内显示名，不会修改磁盘目录名',
    'Only the in-app display name changes — the folder on disk keeps its name'
  ],
  'tree.changeIcon': ['更改图标', 'Change icon'],
  'tree.newChildGroup': ['新建子分组', 'New child group'],
  'tree.removeFromGroup': ['移出分组', 'Remove from group'],
  'tree.removeFromGroupHint': [
    '移到该分组上一级，磁盘目录不变',
    'Moves one level above the group — nothing changes on disk'
  ],
  'tree.ungrouped': ['已移出分组', 'Removed from the group'],
  'tree.ungroupFailed': ['移出分组失败：{error}', 'Could not remove from the group: {error}'],
  'tree.menuLabel': ['{name} 的操作', '{name} actions'],
  'tree.virtualGroup': ['虚拟分组', 'Virtual group'],
  'tree.groupNoDiskPath': ['分组没有对应的磁盘目录', 'Groups have no folder on disk'],
  'tree.removeHint': [
    '仅从本程序移除，磁盘文件保持不变',
    'Removed from this app only — the files on disk stay put'
  ],

  /* --- ContextMenu colour row (§9.8) ------------------------------------- */
  'tree.color': ['颜色', 'Color'],
  'tree.nodeColor': ['节点颜色', 'Node color'],
  'tree.noCustomColor': ['不使用自定义颜色', 'No custom color'],

  /* --- NodeTree / NodeIcon / Skeleton ------------------------------------ */
  'tree.moveIntoSelf': [
    '不能把节点移动到它自己的子节点中',
    'A node cannot be moved into one of its own children'
  ],
  'tree.nodeMoved': ['已移动节点', 'Node moved'],
  'tree.moveFailed': ['移动失败：{error}', 'Could not move the node: {error}'],
  'tree.loadFailed': ['项目树加载失败：{error}', 'Could not load the project tree: {error}'],
  'tree.treeLabel': ['项目树', 'Project tree'],
  'tree.renameFailed': ['重命名失败：{error}', 'Could not rename it: {error}'],
  'tree.pathMissing': ['路径不存在', 'Path not found'],
  'tree.loading': ['加载中', 'Loading']
}
