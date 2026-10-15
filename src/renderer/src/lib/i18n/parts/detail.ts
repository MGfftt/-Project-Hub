import type { Dict } from '../types'

/** DetailPanel, NodeOverview, StatsDialog. */
export const detail: Dict = {
  /* --- the three frozen tabs, shared by the sections they open ----------- */
  'detail.overview': ['概览', 'Overview'],
  'detail.changes': ['改动', 'Changes'],
  'detail.annotations': ['标注', 'Annotations'],

  /* --- field-group and field labels shared with the 属性 dialog ---------- */
  'detail.basic': ['基本', 'Basics'],
  'detail.disk': ['磁盘', 'Disk'],
  'detail.name': ['名称', 'Name'],
  'detail.displayName': ['显示名', 'Display name'],
  'detail.path': ['路径', 'Path'],
  'detail.type': ['类型', 'Type'],
  'detail.status': ['状态', 'Status'],
  'detail.actions': ['操作', 'Actions'],
  'detail.size': ['大小', 'Size'],
  'detail.fileCount': ['文件数', 'Files'],
  'detail.childCount': ['子节点数', 'Child count'],
  'detail.children': ['子节点', 'Children'],
  'detail.createdAt': ['创建时间', 'Created'],
  'detail.modifiedAt': ['修改时间', 'Modified'],
  'detail.gitRemote': ['远程', 'Remote'],
  'detail.gitBranch': ['分支', 'Branch'],
  'detail.gitBranchStat': ['Git 分支', 'Git branch'],
  'detail.icon': ['图标', 'Icon'],
  'detail.color': ['颜色', 'Colour'],
  'detail.nodeColor': ['节点颜色', 'Node colour'],
  'detail.tags': ['标签', 'Tags'],
  'detail.note': ['笔记', 'Note'],
  'detail.computing': ['计算中…', 'Calculating…'],

  /* --- icon types (shown beside the icon preview chip) ------------------- */
  'detail.iconAuto': ['自动', 'Auto'],
  'detail.iconLucide': ['内置', 'Built-in'],
  'detail.iconEmoji': ['表情', 'Emoji'],
  'detail.iconImage': ['图片', 'Image'],

  /* --- DetailPanel: no selection ---------------------------------------- */
  'detail.noSelection': ['未选择节点', 'No node selected'],
  'detail.noSelectionHint': ['在左侧项目树中选择一个节点', 'Select a node in the project tree on the left'],
  'detail.tablistLabel': ['节点详情', 'Node details'],

  /* --- DetailPanel: status-bar reports ---------------------------------- */
  'detail.detailLoadFailed': ['读取节点详情失败', 'Could not read the node details'],
  'detail.noteSaveFailed': ['保存笔记失败', 'Could not save the note'],
  'detail.tagSaveFailed': ['保存标签失败', 'Could not save the tags'],
  'detail.nameRestored': ['已恢复磁盘名称', 'Reverted to the on-disk name'],
  'detail.nameUpdated': ['已更新显示名', 'Display name updated'],
  'detail.nameUpdateFailed': ['更新显示名失败', 'Could not update the display name'],
  'detail.statusChanged': ['状态已改为{status}', 'Status changed to {status}'],
  'detail.statusUpdateFailed': ['更新状态失败', 'Could not update the status'],
  'detail.colorReset': ['已恢复默认颜色', 'Reverted to the default colour'],
  'detail.colorChanged': ['颜色已改为{color}', 'Colour changed to {color}'],
  'detail.colorUpdateFailed': ['更新颜色失败', 'Could not update the colour'],
  'detail.pathCopied': ['已复制路径', 'Path copied'],
  'detail.pathCopiedHere': ['路径已复制', 'Path copied'],
  'detail.pathCopyFailed': ['复制路径失败', 'Could not copy the path'],
  'detail.revealed': ['已在文件管理器中打开', 'Opened in the file manager'],
  'detail.revealFailed': ['打开文件管理器失败', 'Could not open the file manager'],
  'detail.syncDone': ['同步完成，新增 {n} 条改动', 'Sync complete, {n} new changes'],
  'detail.syncDoneEmpty': ['同步完成，无新增改动', 'Sync complete, no new changes'],

  /* --- DetailPanel: 概览 ------------------------------------------------- */
  'detail.virtualNode': ['虚拟节点，没有对应的磁盘目录', 'Virtual node — no matching folder on disk'],
  'detail.copyPath': ['复制路径', 'Copy path'],
  'detail.revealInManager': ['在文件管理器中显示', 'Show in file manager'],
  'detail.changeIcon': ['更改图标', 'Change icon'],
  'detail.noCustomColor': ['不使用自定义颜色', 'No custom colour'],

  /* --- DetailPanel: 改动 ------------------------------------------------- */
  'detail.sourceFilter': ['改动来源筛选', 'Change source filter'],
  'detail.sourceAll': ['全部', 'All'],
  'detail.sourceGitOnly': ['仅 Git', 'Git only'],
  'detail.sourceFilesOnly': ['仅 文件', 'Files only'],
  'detail.noChangesTitle': ['该项目暂无改动记录', 'No changes recorded for this project'],
  'detail.noChangesHint': [
    '先同步 Git 历史，或用文件监视记录之后的改动',
    'Sync the Git history first, or let the file watcher record later changes'
  ],
  'detail.syncNow': ['立即同步 Git', 'Sync Git now'],
  'detail.noChanges': ['暂无改动记录', 'No changes yet'],
  'detail.recentChanges': ['最近的改动', 'Recent changes'],
  'detail.noCommitMessage': ['无提交信息', 'No commit message'],
  'detail.eventFiles': ['{n} 个文件', '{n} files'],
  'detail.eventFilesOne': ['{n} 个文件', '{n} file'],
  'detail.syncing': ['正在同步 Git…', 'Syncing Git…'],

  /* --- DetailPanel: 标注 ------------------------------------------------- */
  'detail.notePlaceholder': ['支持 Markdown，输入后自动保存…', 'Markdown supported, saved automatically as you type…'],
  'detail.noteLocalOnly': [
    '标注只保存在本程序的数据库中，不会写入项目目录',
    'Annotations live only in this app’s database and are never written to the project folder'
  ],
  'detail.save': ['保存', 'Save'],
  'detail.removeTag': ['移除标签 {tag}', 'Remove tag {tag}'],
  'detail.addTagPlaceholder': ['添加标签…', 'Add a tag…'],
  'detail.addTag': ['添加标签', 'Add tag'],
  'detail.tagHint': [
    '按 Enter 添加标签，按 Backspace 删除最后一个标签',
    'Press Enter to add a tag, Backspace to delete the last one'
  ],

  /* --- NodeOverview: identity and member tree --------------------------- */
  'detail.collapseBranch': ['折叠这一支', 'Collapse this branch'],
  'detail.expandBranch': ['展开这一支', 'Expand this branch'],
  'detail.renamed': ['已重命名为「{name}」', 'Renamed to “{name}”'],
  'detail.renameReset': ['已恢复磁盘目录名', 'Reverted to the on-disk folder name'],
  'detail.groupCreated': ['已创建「{name}」', 'Created “{name}”'],
  'detail.newGroupName': ['新分组 {time}', 'New group {time}'],
  'detail.groupCreateFailed': ['新建分组失败：{error}', 'Could not create the group: {error}'],
  'detail.noteAdded': ['已添加备注，在中间栏直接写内容即可', 'Note added — write its text in the middle column'],
  'detail.noteAddFailed': ['添加备注失败：{error}', 'Could not add the note: {error}'],
  'detail.renameDisplayName': ['重命名显示名称', 'Rename display name'],
  'detail.diskName': ['磁盘名：{name}', 'On-disk name: {name}'],
  'detail.pathMissing': ['路径不存在', 'Path not found'],
  'detail.noteNodePath': [
    '备注节点（只保存在本地数据库里，不指向磁盘文件）',
    'Note node (kept only in the local database, not pointing at a file on disk)'
  ],
  'detail.virtualGroupPath': [
    '虚拟分组（没有对应的磁盘目录，只用来归类其它节点）',
    'Virtual group (no folder on disk — it only files other nodes)'
  ],
  'detail.noteBody': ['备注内容', 'Note body'],
  'detail.saving': ['保存中…', 'Saving…'],
  'detail.saved': ['已保存', 'Saved'],
  'detail.autosave': ['自动保存', 'Autosave'],
  'detail.noteEmptyPlaceholder': [
    '写点什么：这个项目是做什么的、下一步做什么、为什么先放下…',
    'Write something: what this project is for, what comes next, why you set it aside…'
  ],

  /* --- NodeOverview: actions -------------------------------------------- */
  'detail.noDiskFolder': ['该节点没有对应的磁盘目录', 'This node has no folder on disk'],
  'detail.openInFileManager': ['在系统文件管理器中打开', 'Open in the system file manager'],
  'detail.openFolderFailed': ['打开文件夹失败', 'Could not open the folder'],
  'detail.openFolder': ['打开目录', 'Open folder'],
  'detail.showInFolder': ['在文件夹中显示', 'Show in folder'],
  'detail.rename': ['重命名', 'Rename'],
  'detail.newSubgroup': ['新建子分组', 'New subgroup'],
  'detail.addNoteHint': ['在这个节点下挂一条备注', 'Attach a note under this node'],
  'detail.addNote': ['添加备注', 'Add note'],
  'detail.stats': ['统计', 'Stats'],

  /* --- NodeOverview: the stat strip ------------------------------------- */
  'detail.diskScanHint': ['磁盘扫描统计', 'From the disk scan'],
  'detail.diskUsage': ['占用空间', 'Disk usage'],
  'detail.counting': ['统计中…', 'Counting…'],
  'detail.diskUsageHint': ['磁盘占用由后台任务计算', 'Disk usage is computed by a background task'],
  'detail.eventCount': ['改动次数', 'Changes'],
  'detail.lastChange': ['最近改动', 'Last change'],
  'detail.totalChanges': ['累计变更', 'Cumulative changes'],
  'detail.addedAt': ['加入时间', 'Added'],
  'detail.groupContents': ['分组内容', 'Group contents'],
  'detail.memberCountOnly': ['（{n}）', '({n})'],
  'detail.memberCountDirect': ['（{direct} 直接 · 共 {total}）', '({direct} direct · {total} total)'],
  'detail.groupEmpty': [
    '这个分组还是空的。把项目树里的节点拖到分组上方，就会归入这里。',
    'This group is empty. Drop a node from the project tree onto it to file it here.'
  ],
  'detail.noChildren': ['没有子节点。', 'No children.'],

  /* --- StatsDialog ------------------------------------------------------ */
  'detail.statsTitle': ['属性', 'Properties'],
  'detail.close': ['关闭', 'Close'],
  'detail.copy': ['复制', 'Copy'],
  'detail.copied': ['已复制', 'Copied'],
  'detail.hubUnavailable': ['window.hub 不可用', 'window.hub is unavailable'],
  'detail.statsLoadFailed': ['读取属性失败', 'Could not read the properties'],
  'detail.isRepo': ['是否仓库', 'Repository'],
  'detail.yes': ['是', 'Yes'],
  'detail.no': ['否', 'No'],
  'detail.firstEvent': ['首次事件', 'First event'],
  'detail.lastEvent': ['末次事件', 'Last event'],
  'detail.eventTotal': ['事件总数', 'Total events'],
  'detail.eventTotalValue': ['{count}（最近 {relative}）', '{count} (latest {relative})'],
  'detail.totalDelta': ['累计增删', 'Total insertions / deletions'],
  'detail.noteLength': ['笔记字数', 'Note length']
}
