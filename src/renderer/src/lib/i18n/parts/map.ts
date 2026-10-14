import type { Dict } from '../types'

/** ProjectMap, Timeline, Heatmap, StatusBar. */
export const map: Dict = {
  /* --- ProjectMap: header, legend, zoom ---------------------------------- */
  'map.hint': [
    '单击卡片查看，点箭头展开，拖动卡片可换父节点',
    'Click a card to open it, the arrow to expand, drag a card to change its parent'
  ],
  'map.addNote': ['添加备注', 'Add a note'],
  'map.addNote.title': ['在当前选中的节点下添加一条备注', 'Add a note under the selected node'],
  'map.addNote.selectFirst': [
    '先选一个节点，备注就会挂在它下面',
    'Select a node first — the note hangs under it'
  ],
  'map.addNote.added': [
    '已添加备注，写好内容后它会挂在这个节点下面',
    'Note added — write something and it hangs under this node'
  ],
  'map.addNote.failed': ['添加备注失败：{error}', 'Could not add the note: {error}'],
  'map.zoomOut': ['缩小', 'Zoom out'],
  'map.zoomIn': ['放大', 'Zoom in'],
  'map.fitWidth': ['适应宽度', 'Fit to width'],

  /* --- ProjectMap: an empty library -------------------------------------- */
  'map.empty.title': ['还没有任何项目', 'No projects yet'],
  'map.empty.hintLead': [
    '用左上角的「根目录」按钮添加一个文件夹，它就会作为一棵树出现在这里。 文件夹里有没有 Git 都可以 —— 之后再 ',
    'Use the root-folder button at the top left to add a folder and it appears here as a tree. Git or no Git inside — run '
  ],
  'map.empty.hintTail': ['，下一次扫描也会认出来。', ' later and the next scan picks it up.'],

  /* --- ProjectMap: cards and the drag ghost ------------------------------ */
  'map.moved': ['已移动节点', 'Node moved'],
  'map.moveFailed': ['移动失败：{error}', 'Could not move the node: {error}'],
  'map.expand': ['展开（{n} 个子节点）', 'Expand ({n} children)'],
  'map.expandOne': ['展开（{n} 个子节点）', 'Expand ({n} child)'],
  'map.collapse': ['收起', 'Collapse'],
  'map.collapsedCount': ['已收起 {n} 个子节点', '{n} children hidden'],
  'map.collapsedCountOne': ['已收起 {n} 个子节点', '{n} child hidden'],
  'map.childCount': ['{n} 个子节点', '{n} children'],
  'map.childCountOne': ['{n} 个子节点', '{n} child'],
  'map.noteTooltip': ['备注：{text}', 'Note: {text}'],
  'map.note.blank': ['（空白）', '(blank)'],
  'map.groupTooltip': ['{name}（虚拟分组）', '{name} (virtual group)'],
  'map.note.emptyText': ['空白备注', 'Empty note'],
  'map.node': ['节点', 'Node'],
  'map.ghost.drag': ['拖到另一个节点上', 'Drop it on another node'],
  'map.ghost.release': ['松开即可移入', 'Release to move it in'],

  /* --- Timeline: zoom levels, sources and range presets ------------------ */
  'map.zoomLevel.day': ['日', 'Day'],
  'map.zoomLevel.week': ['周', 'Week'],
  'map.zoomLevel.month': ['月', 'Month'],
  'map.zoomLevel.quarter': ['季', 'Quarter'],
  'map.zoomLevel.year': ['年', 'Year'],
  'map.source.git': ['Git', 'Git'],
  'map.source.fs': ['文件', 'Files'],
  'map.source.manual': ['手动', 'Manual'],
  'map.range.last7': ['最近 7 天', 'Last 7 days'],
  'map.range.last30': ['最近 30 天', 'Last 30 days'],
  'map.range.last90': ['最近 90 天', 'Last 90 days'],
  'map.range.all': ['全部', 'All'],

  /* --- Timeline: header, lanes and the event list ------------------------ */
  'map.timeline.label': ['变更时间线', 'Change timeline'],
  'map.timeline.breadcrumb': ['面包屑', 'Breadcrumb'],
  'map.timeline.title': ['时间线', 'Timeline'],
  'map.timeline.selectedNode': ['已选节点', 'Selected node'],
  'map.timeline.allProjects': ['全部项目', 'All projects'],
  'map.timeline.clearFilter': ['清除过滤', 'Clear filter'],
  'map.timeline.range': ['时间范围', 'Time range'],
  'map.timeline.zoom': ['缩放级别', 'Zoom level'],
  'map.timeline.zoomTooltip': ['缩放：{label}（{pattern}）', 'Zoom: {label} ({pattern})'],
  'map.timeline.laneHeader': ['节点 / 最近改动', 'Node / last change'],
  'map.timeline.showingRecent': ['仅显示最近 {n} 条', 'Showing only the newest {n}'],
  'map.timeline.emptyTitle': ['该项目暂无改动记录', 'No changes recorded for this project yet'],
  'map.timeline.emptyNotGit': [
    '该节点不是 Git 仓库，无法同步提交记录。',
    'This node is not a Git repository, so commits cannot be synced.'
  ],
  'map.timeline.emptyHint': ['同步 Git 后即可查看提交历史。', 'Sync Git to browse the commit history.'],
  'map.timeline.cluster': ['{n} 次改动 · 点击放大', '{n} changes · click to zoom in'],
  'map.timeline.clusterAria': ['{n} 次改动，点击放大查看', '{n} changes, click to zoom in'],
  'map.timeline.emptyFiltered': [
    '当前筛选条件下没有改动记录',
    'No changes match the current filter'
  ],
  'map.timeline.eventList': ['事件列表', 'Event list'],
  'map.timeline.searchLabel': ['搜索改动', 'Search changes'],
  'map.timeline.searchPlaceholder': ['搜索提交信息或文件…', 'Search commit messages or files…'],
  'map.timeline.wheelHint': [
    'Ctrl + 滚轮缩放 · Shift + 滚轮横向滚动',
    'Ctrl + wheel to zoom · Shift + wheel to scroll sideways'
  ],

  /* --- shared by the timeline's axis, dots and list ---------------------- */
  'map.noCommitMessage': ['（无提交信息）', '(no commit message)'],
  'map.eventStats': [
    '{source} · {n} 个文件 · +{ins} / -{del}',
    '{source} · {n} files · +{ins} / -{del}'
  ],
  'map.ariaSeparator': ['，', ', '],
  'map.changeCount': ['{n} 条改动', '{n} changes'],
  'map.changeCountOne': ['{n} 条改动', '{n} change'],
  'map.fileCount': ['{n} 个文件', '{n} files'],
  'map.projectCount': ['{n} 个项目', '{n} projects'],
  'map.moreFiles': ['+{n} 个文件', '+{n} more files'],

  /* --- Heatmap ----------------------------------------------------------- */
  'map.heatmap.label': ['改动热力图', 'Change heatmap'],
  'map.heatmap.year': ['年份', 'Year'],
  'map.heatmap.total': ['{n} 次改动', '{n} changes'],
  'map.heatmap.totalOne': ['{n} 次改动', '{n} change'],
  'map.heatmap.empty': ['该时间段暂无改动', 'No changes in this period'],
  'map.heatmap.gridLabel': ['{year} 年改动热力图', 'Change heatmap for {year}'],
  'map.heatmap.cell': [
    '{day} · {n} 次改动 · +{ins} / -{del}',
    '{day} · {n} changes · +{ins} / -{del}'
  ],
  'map.heatmap.cellEmpty': ['{day} · 0 次改动', '{day} · 0 changes'],
  'map.heatmap.less': ['少', 'Less'],
  'map.heatmap.more': ['多', 'More'],
  'map.weekday.mon': ['一', 'Mon'],
  'map.weekday.wed': ['三', 'Wed'],
  'map.weekday.fri': ['五', 'Fri'],
  'map.month.jan': ['1月', 'Jan'],
  'map.month.feb': ['2月', 'Feb'],
  'map.month.mar': ['3月', 'Mar'],
  'map.month.apr': ['4月', 'Apr'],
  'map.month.may': ['5月', 'May'],
  'map.month.jun': ['6月', 'Jun'],
  'map.month.jul': ['7月', 'Jul'],
  'map.month.aug': ['8月', 'Aug'],
  'map.month.sep': ['9月', 'Sep'],
  'map.month.oct': ['10月', 'Oct'],
  'map.month.nov': ['11月', 'Nov'],
  'map.month.dec': ['12月', 'Dec'],

  /* --- StatusBar --------------------------------------------------------- */
  'map.statusBar': ['状态栏', 'Status bar'],
  'map.scanning': ['已扫描 {n} 个', 'Scanned {n}'],
  'map.summary.title': ['根目录 · 节点 · 改动', 'Roots · nodes · changes'],
  'map.summary': [
    '{roots} 个根目录 · {nodes} 个节点 · {events} 条改动',
    '{roots} roots · {nodes} nodes · {events} changes'
  ],
  'map.summary.loading': ['正在读取库信息…', 'Reading library info…'],
  'map.sync.done': [
    '已同步 {synced} 个仓库，新增 {events} 条改动',
    'Synced {synced} repositories with {events} new changes'
  ],
  'map.sync.doneEmpty': [
    '已同步 {synced} 个仓库，没有新的改动',
    'Synced {synced} repositories, no new changes'
  ],
  'map.sync.failed': ['同步 Git 历史失败，请稍后再试', 'Could not sync the Git history — try again later'],
  'map.sync.title': ['立即同步所有 Git 仓库', 'Sync every Git repository now'],
  'map.syncing': ['同步中…', 'Syncing…'],
  'map.syncNow': ['立即同步 Git', 'Sync Git now'],
  'map.nextRun.unknown': ['后台维护状态未知', 'Background maintenance status unknown'],
  'map.nextRun.paused': ['后台维护已暂停', 'Background maintenance paused'],
  'map.nextRun.none': ['暂无排定的维护任务', 'No maintenance scheduled'],
  'map.nextRun.at': ['下次维护：{task} · {at}', 'Next maintenance: {task} · {at}'],
  'map.pathMissing': ['路径不存在', 'Path missing'],
  'map.unread.title': [
    '窗口隐藏期间新增的改动',
    'Changes that arrived while the window was hidden'
  ],
  'map.unread': ['{n} 条未读', '{n} unread'],
  'map.battery': ['电池供电，已降速', 'On battery — throttled'],
  'map.battery.title': [
    '当前由电池供电，后台维护已降速',
    'Running on battery; background maintenance is throttled'
  ],
  'map.background': ['后台维护：', 'Background maintenance: '],
  'map.background.paused': ['已暂停', 'Paused'],
  'map.background.running': ['运行中', 'Running'],
  'map.background.unknown': ['未知', 'Unknown']
}
