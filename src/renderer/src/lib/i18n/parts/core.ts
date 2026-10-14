import type { Dict } from '../types'

/**
 * Strings shared by everything: relative times, kind and status names, the
 * colour palette, the search box and the store error lines.
 *
 * These live together because more than one component reaches for them — the
 * colour swatches appear in both the detail panel and the right-click menu, and
 * `kind.group` is echoed in the tree, the map legend and the search results.
 */
export const core: Dict = {
  /* --- relative time and sizes (lib/format.ts) -------------------------- */
  'time.now': ['刚刚', 'just now'],
  'time.minutesAgo': ['{n} 分钟前', '{n} min ago'],
  'time.hoursAgo': ['{n} 小时前', '{n} h ago'],
  'time.daysAgo': ['{n} 天前', '{n} d ago'],
  'time.soon': ['即将', 'any moment'],
  'time.seconds': ['{n} 秒', '{n} s'],
  'time.minutes': ['{n} 分钟', '{n} min'],
  'time.hours': ['{n} 小时', '{n} h'],
  'time.days': ['{n} 天', '{n} d'],
  'note.chars': ['{n} 字', '{n} chars'],

  /* --- node kinds -------------------------------------------------------- */
  'kind.group': ['分组', 'Group'],
  'kind.project': ['项目', 'Project'],
  'kind.folder': ['目录', 'Folder'],
  'kind.note': ['备注', 'Note'],

  /* --- node statuses ----------------------------------------------------- */
  'status.active': ['活跃', 'Active'],
  'status.paused': ['暂停', 'Paused'],
  'status.done': ['已完成', 'Done'],
  'status.archived': ['已归档', 'Archived'],

  /* --- the colour palette (§9.8) ----------------------------------------- */
  'color.red': ['红', 'Red'],
  'color.orange': ['橙', 'Orange'],
  'color.yellow': ['黄', 'Yellow'],
  'color.green': ['绿', 'Green'],
  'color.cyan': ['青', 'Cyan'],
  'color.blue': ['蓝', 'Blue'],
  'color.purple': ['紫', 'Purple'],
  'color.pink': ['粉', 'Pink'],
  'color.brown': ['棕', 'Brown'],
  'color.gray': ['灰', 'Gray'],
  'color.none': ['默认', 'Default'],

  /* --- search box -------------------------------------------------------- */
  'search.placeholder': ['搜索项目…', 'Search projects…'],
  'search.label': ['搜索项目', 'Search projects'],
  'search.results': ['搜索结果', 'Search results'],
  'search.searching': ['搜索中…', 'Searching…'],
  'search.empty': ['没有匹配的项目', 'No matching projects'],
  'search.match.displayName': ['显示名', 'Display name'],
  'search.match.name': ['名称', 'Name'],
  'search.match.path': ['路径', 'Path'],
  'search.match.tag': ['标签', 'Tag'],
  'search.match.note': ['备注', 'Note'],

  /* --- store failures ---------------------------------------------------- */
  'error.settingsLoad': ['读取设置失败', 'Could not read the settings'],
  'error.settingsSave': ['保存设置失败', 'Could not save the setting'],
  'error.eventsLoad': ['读取改动记录失败', 'Could not read the change log'],
  'error.heatmapLoad': ['读取热力图失败', 'Could not read the heatmap'],
  'error.gitSync': ['同步 Git 失败', 'Git sync failed']
}
