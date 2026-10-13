/**
 * Markdown exporter (§15 "导出").
 *
 * A Project Hub export is a snapshot of the user's own organization: the tree
 * with in-app names, tags and annotations, plus the recent timeline. It is meant
 * to be read by a human, so it uses nested bullet lists and fenced blocks that
 * render anywhere — GitHub, Obsidian, VS Code preview.
 *
 * Isolation note: the exporter only *formats* data it is handed (already read
 * from the app database). It never opens a project folder.
 */
import type { HubEvent, NodeDetail, Root, TreeNode } from '../../shared/types'

export interface ExportInput {
  roots: Root[]
  nodes: NodeDetail[]
  events: HubEvent[]
  exportedAt?: string
  appVersion?: string
}

function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  done: '已完成',
  archived: '已归档'
}

const SOURCE_LABEL: Record<string, string> = {
  git: 'Git',
  fs: '文件',
  manual: '手动'
}

/** One line per node: the in-app name, the folder name, then the annotation. */
/** Only the annotation is needed to render a tree line. */
type NoteSource = { note_md?: string | null }

function nodeLines(node: TreeNode, byId: Map<number, NoteSource>, depth: number): string[] {
  const out: string[] = []
  const indent = '  '.repeat(depth)
  const title = node.display_name?.trim() || node.name
  const renamed = node.display_name?.trim() && node.display_name.trim() !== node.name ? ` _(${node.name})_` : ''
  const flags: string[] = []
  if (node.path_missing === 1) flags.push('⚠️ 路径缺失')
  if (node.status !== 'active') flags.push(STATUS_LABEL[node.status] ?? node.status)
  if (node.color) flags.push(node.color)
  const suffix = flags.length > 0 ? ` \`${flags.join(' · ')}\`` : ''
  const detail = byId.get(node.id)
  const tagText = node.tags.length > 0 ? ` ${node.tags.map((t) => `#${t}`).join(' ')}` : ''
  out.push(`${indent}- **${title}**${renamed}${suffix}${tagText}`)
  if (detail?.note_md?.trim()) {
    // Quotes keep a multi-line annotation inside one list item.
    const quoted = detail.note_md.trim().split(/\r?\n/).join(`\n${indent}  > `)
    out.push(`${indent}  > ${quoted}`)
  }
  for (const child of node.children ?? []) {
    out.push(...nodeLines(child, byId, depth + 1))
  }
  return out
}

/** Render the whole export as Markdown. */
export function toMarkdown(input: ExportInput): string {
  const { roots, nodes, events } = input
  const exportedAt = input.exportedAt ?? new Date().toISOString()
  const byId = new Map<number, NodeDetail>(nodes.map((n) => [n.id, n]))
  const forest: TreeNode[] = nodes.filter((n) => n.parent_id === null)
  const lines: string[] = []

  lines.push('# Project Hub 导出 / Export')
  lines.push('')
  lines.push(`> 导出时间 / Exported at: ${fmtDate(Date.parse(exportedAt))} (${exportedAt})`)
  if (input.appVersion) lines.push(`> 应用版本 / App version: ${input.appVersion}`)
  lines.push('')

  /* ---- summary ---- */
  const projects = nodes.filter((n) => n.kind === 'project').length
  const folders = nodes.filter((n) => n.kind === 'folder').length
  const groups = nodes.filter((n) => n.kind === 'group').length
  const gitRepos = nodes.filter((n) => {
    try {
      return Boolean((JSON.parse(n.meta?.isGit === undefined ? '{}' : JSON.stringify(n.meta)) as Record<string, unknown>)?.isGit)
    } catch {
      return false
    }
  }).length
  lines.push('## 概览 / Summary')
  lines.push('')
  lines.push('| 项目 / Metric | 值 / Value |')
  lines.push('| --- | --- |')
  lines.push(`| 根目录 / Roots | ${roots.length} |`)
  lines.push(`| 分组 / Groups | ${groups} |`)
  lines.push(`| 项目 / Projects | ${projects} |`)
  lines.push(`| 文件夹 / Folders | ${folders} |`)
  lines.push(`| Git 仓库 / Git repos | ${gitRepos} |`)
  lines.push(`| 事件 / Events | ${events.length} |`)
  lines.push(`| 磁盘占用 / Disk usage | ${fmtBytes(nodes.reduce((sum, n) => sum + (Number(n.meta?.diskSizeBytes ?? 0) || 0), 0))} |`)
  lines.push('')

  /* ---- roots ---- */
  if (roots.length > 0) {
    lines.push('## 已索引根目录 / Indexed roots')
    lines.push('')
    for (const root of roots) {
      const enabled = root.enabled ? '启用 / enabled' : '停用 / disabled'
      lines.push(`- \`${root.path}\` — ${enabled}, 最大深度 / max depth ${root.max_depth}`)
    }
    lines.push('')
  }

  /* ---- tree ---- */
  lines.push('## 项目树 / Tree')
  lines.push('')
  if (forest.length === 0) {
    lines.push('_（空）/ (empty)_')
  } else {
    for (const node of forest) lines.push(...nodeLines(node, byId, 0))
  }
  lines.push('')

  /* ---- timeline ---- */
  lines.push('## 变更时间线 / Timeline')
  lines.push('')
  if (events.length === 0) {
    lines.push('_（暂无事件）/ (no events)_')
  } else {
    lines.push('| 时间 / When | 节点 / Node | 来源 / Source | 摘要 / Summary | 变更 / Changes |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const event of events.slice(0, 500)) {
      const node = byId.get(event.node_id)
      const label = (node?.display_name?.trim() || node?.name || `#${event.node_id}`).replace(/\|/g, '\\|')
      const message = (event.message ?? '').replace(/\|/g, '\\|').slice(0, 120)
      const stat = `+${event.insertions} / −${event.deletions} (${event.file_count} 文件)`
      lines.push(
        `| ${fmtDate(event.occurred_at)} | ${label} | ${SOURCE_LABEL[event.source] ?? event.source} | ${message} | ${stat} |`
      )
    }
    if (events.length > 500) {
      lines.push('')
      lines.push(`_（仅显示最近 500 条，共 ${events.length} 条）/ (showing the most recent 500 of ${events.length})_`)
    }
  }
  lines.push('')

  lines.push('---')
  lines.push('')
  lines.push('由 Project Hub 生成 / Generated by Project Hub.')
  lines.push('')
  return lines.join('\n')
}

/**
 * A compact tree-only view, used by the "复制为 Markdown" action.
 *
 * `byId` and the top level are both derived from the array that was handed in, so
 * this works for the whole forest (`repo.tree()`) *and* for a single subtree. The
 * earlier version filtered on `parent_id === null` and left `byId` empty, which
 * dropped every annotation and produced nothing at all for a subtree.
 */
export function treeToMarkdown(nodes: Array<TreeNode & NoteSource>): string {
  const flat: TreeNode[] = []
  const walk = (list: TreeNode[]): void => {
    for (const n of list) {
      flat.push(n)
      if (n.children?.length) walk(n.children)
    }
  }
  walk(nodes)

  const byId: Map<number, NoteSource> = new Map(flat.map((n) => [n.id, n as NoteSource]))
  // The top level comes from the ORIGINAL slice, not from `flat`: flattening
  // first would put a child's id in the set and make its own parent look
  // non-root, so a single subtree rendered to nothing at all.
  const handedIn = new Set(nodes.map((n) => n.id))
  const forest = nodes.filter((n) => n.parent_id === null || !handedIn.has(n.parent_id))

  const lines = ['# Project Hub 项目树 / Tree', '']
  for (const node of forest) lines.push(...nodeLines(node, byId, 0))
  lines.push('')
  return lines.join('\n')
}
