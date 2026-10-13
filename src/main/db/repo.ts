/**
 * All SQL for Project Hub lives here (§7.6).
 *
 * Rules enforced below:
 *  - statements are `prepare()`d once at module scope, never inside loops
 *  - every batch write is wrapped in `db.transaction()`
 *  - `listEvents` always honours a `limit` (default 500)
 */
import { getDb, type DB } from './index.js'
import { normalizePath, pathKey } from '../utils/path.js'
import type {
  DayCount,
  EventRecord,
  EventSource,
  HubEvent,
  IconAsset,
  NodeKind,
  NodeRecord,
  NodeStatus,
  Root,
  SearchHit,
  TaskStateRow,
  TreeNode
} from '@shared/types.js'

export interface UpsertNodeInput {
  root_id: number | null
  parent_id: number | null
  name: string
  path: string | null
  kind: NodeKind
  sort_order?: number
  status?: NodeStatus
}

export interface EventInsert {
  node_id: number
  source: EventSource
  ref: string | null
  message: string | null
  author: string | null
  occurred_at: number
  file_count?: number
  insertions?: number
  deletions?: number
  files_json?: string
}

const now = (): number => Date.now()

/** better-sqlite3 typings are loose; keep the casts in one place. */
const rows = <T>(v: unknown): T[] => v as T[]
const row = <T>(v: unknown): T | undefined => (v as T | undefined) ?? undefined

let cachedDb: DB | null = null

function dbh(): DB {
  // Repo is written against the process singleton, but tests may swap it.
  const db = getDb()
  if (db !== cachedDb) {
    cachedDb = db
    statements = buildStatements(db)
  }
  return db
}

let statements: ReturnType<typeof buildStatements>

function buildStatements(db: DB) {
  return {
    // --- roots
    insertRoot: db.prepare(
      `INSERT INTO roots (path, enabled, max_depth, added_at) VALUES (?, 1, ?, ?)
       ON CONFLICT(path) DO UPDATE SET enabled = 1`
    ),
    rootById: db.prepare(`SELECT * FROM roots WHERE id = ?`),
    rootByPath: db.prepare(`SELECT * FROM roots WHERE path = ?`),
    rootByPathCI: db.prepare(`SELECT * FROM roots WHERE lower(path) = lower(?) LIMIT 1`),
    listRoots: db.prepare(`SELECT * FROM roots ORDER BY added_at ASC`),
    deleteRoot: db.prepare(`DELETE FROM roots WHERE id = ?`),
    setRootEnabled: db.prepare(`UPDATE roots SET enabled = ? WHERE id = ?`),
    setRootDepth: db.prepare(`UPDATE roots SET max_depth = ? WHERE id = ?`),
    enabledRoots: db.prepare(`SELECT * FROM roots WHERE enabled = 1`),

    // --- nodes
    upsertNode: db.prepare(
      `INSERT INTO nodes (root_id, parent_id, name, path, kind, sort_order, status, created_at, updated_at)
       VALUES (@root_id, @parent_id, @name, @path, @kind, @sort_order, @status, @ts, @ts)
       ON CONFLICT(root_id, path) DO UPDATE SET
         parent_id  = excluded.parent_id,
         name       = excluded.name,
         kind       = CASE WHEN nodes.kind = 'project' THEN nodes.kind ELSE excluded.kind END,
         updated_at = @ts`
    ),
    // Upsert for virtual groups (path IS NULL) — UNIQUE(root_id, path) does not
    // apply to NULL paths, so group identity is (root_id, parent_id, name).
    groupByName: db.prepare(
      `SELECT * FROM nodes WHERE kind = 'group' AND name = ? AND parent_id IS ? LIMIT 1`
    ),
    maxSiblingSort: db.prepare(`SELECT MAX(sort_order) AS m FROM nodes WHERE parent_id IS ?`),
    insertGroup: db.prepare(
      `INSERT INTO nodes (root_id, parent_id, name, path, kind, status, sort_order, created_at, updated_at)
       VALUES (NULL, ?, ?, NULL, 'group', 'active', ?, ?, ?)`
    ),
    // A note is a virtual node too: it carries no disk path, so the scanner's
    // `path IS NOT NULL` filters never see it and a rescan cannot disturb it.
    insertNote: db.prepare(
      `INSERT INTO nodes (root_id, parent_id, name, path, kind, status, sort_order,
                          icon_type, icon_value, meta, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'note', 'active', ?, 'emoji', '📝', ?, ?, ?)`
    ),
    updateNoteText: db.prepare(`UPDATE nodes SET meta = ?, name = ?, updated_at = ? WHERE id = ?`),
    nodeById: db.prepare(`SELECT * FROM nodes WHERE id = ?`),
    nodeByPath: db.prepare(`SELECT * FROM nodes WHERE path = ?`),
    nodeByRootPath: db.prepare(`SELECT * FROM nodes WHERE root_id = ? AND path = ?`),
    listNodes: db.prepare(`SELECT * FROM nodes ORDER BY sort_order ASC, name ASC`),
    listNodesByRoot: db.prepare(`SELECT * FROM nodes WHERE root_id = ? ORDER BY sort_order ASC, name ASC`),
    listChildNodes: db.prepare(`SELECT * FROM nodes WHERE parent_id IS ? ORDER BY sort_order ASC, name ASC`),
    descendants: db.prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
       ) SELECT id FROM sub`
    ),
    updateNodeFields: db.prepare(
      `UPDATE nodes SET display_name = ?, status = ?, color = ?, priority = ?,
         sort_order = ?, note_md = ?, tags = ?, icon_type = ?, icon_value = ?,
         meta = ?, name = ?, updated_at = ?
       WHERE id = ?`
    ),
    updateIdentity: db.prepare(
      `UPDATE nodes SET display_name = ?, icon_type = ?, icon_value = ?, updated_at = ? WHERE id = ?`
    ),
    updateMeta: db.prepare(`UPDATE nodes SET meta = ?, updated_at = ? WHERE id = ?`)
    ,
    updatePlacement: db.prepare(
      `UPDATE nodes SET parent_id = ?, root_id = ?, sort_order = ?, updated_at = ? WHERE id = ?`
    ),
    deleteNode: db.prepare(`DELETE FROM nodes WHERE id = ?`),
    markMissing: db.prepare(`UPDATE nodes SET path_missing = ?, updated_at = ? WHERE id = ?`),
    existingPaths: db.prepare(
      `SELECT id, path, kind, meta FROM nodes WHERE root_id = ? AND path IS NOT NULL`
    ),
    pathExists: db.prepare(`SELECT 1 AS ok FROM nodes WHERE id = ? AND path IS NOT NULL LIMIT 1`),
    missingCandidates: db.prepare(
      `SELECT * FROM nodes WHERE root_id = ? AND path IS NOT NULL AND path_missing = 0`
    ),
    // Tombstones: a removed directory is remembered per root so the next scan
    // does not walk the disk and insert the very same folder back.
    insertHidden: db.prepare(
      `INSERT OR IGNORE INTO hidden_paths (root_id, path, added_at) VALUES (?, ?, ?)`
    ),
    hiddenPaths: db.prepare(`SELECT path FROM hidden_paths WHERE root_id = ?`),
    clearHidden: db.prepare(`DELETE FROM hidden_paths WHERE root_id = ?`),
    gitNodes: db.prepare(
      `SELECT n.* FROM nodes n
        WHERE n.kind = 'project' AND n.path IS NOT NULL AND n.path_missing = 0`
    ),
    maxDepthGuard: db.prepare(
      `WITH RECURSIVE up(id, depth) AS (
         SELECT id, 0 FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.parent_id, up.depth + 1 FROM nodes n JOIN up ON n.id = up.id
          WHERE n.parent_id IS NOT NULL AND up.depth < 64
       ) SELECT MAX(depth) AS d FROM up`
    ),

    // --- events
    insertEvent: db.prepare(
      `INSERT OR IGNORE INTO events
         (node_id, source, ref, message, author, occurred_at, file_count, insertions, deletions, files_json)
       VALUES (@node_id, @source, @ref, @message, @author, @occurred_at, @file_count, @insertions, @deletions, @files_json)`
    ),
    eventsByNode: db.prepare(
      `SELECT * FROM events WHERE node_id = ? ORDER BY occurred_at DESC LIMIT ?`
    ),
    eventsRange: db.prepare(
      `SELECT * FROM events WHERE occurred_at BETWEEN ? AND ? ORDER BY occurred_at ASC LIMIT ?`
    ),
    eventStats: db.prepare(
      `SELECT COUNT(*) AS c, MIN(occurred_at) AS first, MAX(occurred_at) AS last,
              COALESCE(SUM(insertions),0) AS ins, COALESCE(SUM(deletions),0) AS del
         FROM events WHERE node_id IN (SELECT value FROM json_each(?))`
    ),
    eventStatsSingle: db.prepare(
      `SELECT COUNT(*) AS c, MIN(occurred_at) AS first, MAX(occurred_at) AS last,
              COALESCE(SUM(insertions),0) AS ins, COALESCE(SUM(deletions),0) AS del
         FROM events WHERE node_id = ?`
    ),
    allEventsForHeatmap: db.prepare(
      `SELECT occurred_at, insertions, deletions FROM events
        WHERE occurred_at BETWEEN ? AND ? AND node_id IN (SELECT value FROM json_each(?))`
    ),
    eventsForExport: db.prepare(`SELECT * FROM events ORDER BY occurred_at ASC LIMIT ?`),

    // --- snapshots
    deleteSnapshotsForNode: db.prepare(`DELETE FROM snapshots WHERE node_id = ?`),
    upsertSnapshot: db.prepare(
      `INSERT INTO snapshots (node_id, rel_path, mtime, size, hash) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(node_id, rel_path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, hash = excluded.hash`
    ),
    snapshotsForNode: db.prepare(`SELECT * FROM snapshots WHERE node_id = ?`),
    snapshotEntry: db.prepare(`SELECT * FROM snapshots WHERE node_id = ? AND rel_path = ?`),
    deleteSnapshotEntry: db.prepare(`DELETE FROM snapshots WHERE node_id = ? AND rel_path = ?`),
    staleSnapshots: db.prepare(
      `DELETE FROM snapshots WHERE node_id NOT IN (SELECT id FROM nodes)`
    ),

    // --- git cursors
    getCursor: db.prepare(`SELECT * FROM git_cursors WHERE node_id = ?`),
    setCursor: db.prepare(
      `INSERT INTO git_cursors (node_id, last_hash, synced_at) VALUES (?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET last_hash = excluded.last_hash, synced_at = excluded.synced_at`
    ),

    // --- icons
    insertIcon: db.prepare(
      `INSERT OR REPLACE INTO icon_assets (filename, origin, bytes, added_at) VALUES (?, ?, ?, ?)`
    ),
    listIcons: db.prepare(`SELECT * FROM icon_assets ORDER BY added_at DESC`),
    iconByFilename: db.prepare(`SELECT * FROM icon_assets WHERE filename = ?`),
    deleteIcon: db.prepare(`DELETE FROM icon_assets WHERE filename = ?`),
    usedIconFilenames: db.prepare(
      `SELECT DISTINCT icon_value AS v FROM nodes WHERE icon_type = 'image' AND icon_value IS NOT NULL`
    ),

    // --- settings
    getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
    setSetting: db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ),
    allSettings: db.prepare(`SELECT key, value FROM settings`),

    // --- task state
    getTask: db.prepare(`SELECT * FROM task_state WHERE task = ?`),
    setTask: db.prepare(
      `INSERT INTO task_state (task, last_run, next_run, meta) VALUES (?, ?, ?, ?)
       ON CONFLICT(task) DO UPDATE SET last_run = excluded.last_run, next_run = excluded.next_run, meta = excluded.meta`
    ),
    allTasks: db.prepare(`SELECT * FROM task_state`),

    // --- search
    searchNodes: db.prepare(
      `SELECT * FROM nodes
        WHERE display_name LIKE @q OR name LIKE @q OR path LIKE @q
           OR tags LIKE @q OR note_md LIKE @q
        ORDER BY CASE WHEN display_name LIKE @q THEN 0 ELSE 1 END, name ASC
        LIMIT @limit`
    ),
    countNodes: db.prepare(`SELECT COUNT(*) AS c FROM nodes`),
    countEvents: db.prepare(`SELECT COUNT(*) AS c FROM events`)
  }
}

function parseTags(json: string | null): string[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/**
 * The scanner's fingerprint for a node (`marker`, `projectKind`, `isGit`,
 * `depth`, `mtime`). It travels with the tree so the renderer can choose an
 * `auto` icon from the marker (§9.3) and draw the map without a second query.
 */
function parseMeta(json: string | null): Record<string, unknown> {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The node's `name` for a note is a one-line excerpt; the body lives in `meta.text`. */
export function noteTitle(text: string): string {
  const firstLine = (text ?? '').split(/\r?\n/)[0].trim()
  if (!firstLine) return '新备注'
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}

export function toTreeNode(n: NodeRecord): TreeNode {
  return {
    id: n.id,
    root_id: n.root_id,
    parent_id: n.parent_id,
    name: n.name,
    display_name: n.display_name,
    path: n.path,
    kind: n.kind,
    status: n.status,
    color: n.color,
    priority: n.priority,
    sort_order: n.sort_order,
    tags: parseTags(n.tags),
    icon_type: n.icon_type,
    icon_value: n.icon_value,
    path_missing: n.path_missing,
    meta: parseMeta(n.meta),
    created_at: n.created_at,
    updated_at: n.updated_at
  }
}

export function toHubEvent(e: EventRecord): HubEvent {
  let files: string[] = []
  try {
    const v = JSON.parse(e.files_json || '[]')
    files = Array.isArray(v) ? v.map(String) : []
  } catch {
    files = []
  }
  return { ...e, files }
}

/**
 * Patch accepted by `repo.updateNode`. `tags` and `meta` arrive in their WIRE
 * form (an array / a plain object) and are JSON-encoded exactly once here, so
 * callers never handle the on-disk text representation.
 */
export type NodePatchInput = Partial<
  Pick<
    NodeRecord,
    | 'display_name'
    | 'status'
    | 'color'
    | 'priority'
    | 'sort_order'
    | 'note_md'
    | 'icon_type'
    | 'icon_value'
    | 'name'
  >
> & {
  tags?: string[]
  meta?: Record<string, unknown>
}

/**
 * Canonical on-disk form of a path (§7.1): a relative/`~` input is resolved to
 * an absolute path with normalised separators. The original casing is preserved
 * so the UI shows the real path; case-insensitive identity is handled by
 * `pathIndex()` (built from `pathKey`) and by the `lower(path)` lookups below.
 */
function canon(path: string | null | undefined): string | null {
  if (path === null || path === undefined || path === '') return null
  return normalizePath(path)
}

export const repo = {
  // ------------------------------------------------------------------ roots
  addRoot(path: string, maxDepth = 4): Root {
    const d = dbh()
    const stored = canon(path) ?? ''
    // `path` is stored with its original casing, so a folder re-added with a
    // different casing would otherwise become a second root: check
    // case-insensitively first (NTFS is case-insensitive, §14.3).
    const existing = row<Root>(statements.rootByPathCI.get(stored))
    if (existing) {
      const tx = d.transaction(() => {
        statements.insertRoot.run(stored, maxDepth, now())
        return row<Root>(statements.rootById.get(existing.id))
      })
      return tx() as Root
    }
    const tx = d.transaction(() => {
      statements.insertRoot.run(stored, maxDepth, now())
      return row<Root>(statements.rootByPath.get(stored))
    })
    return tx() as Root
  },
  getRoot(id: number): Root | undefined {
    dbh()
    return row<Root>(statements.rootById.get(id))
  },
  getRootByPath(path: string): Root | undefined {
    dbh()
    return row<Root>(statements.rootByPath.get(canon(path) ?? ''))
  },
  listRoots(): Root[] {
    dbh()
    return rows<Root>(statements.listRoots.all())
  },
  listEnabledRoots(): Root[] {
    dbh()
    return rows<Root>(statements.enabledRoots.all())
  },
  removeRoot(id: number): void {
    const d = dbh()
    // nodes cascade; events and snapshots cascade again from nodes (FK ON DELETE CASCADE)
    d.transaction(() => {
      statements.deleteRoot.run(id)
    })()
  },
  setRootEnabled(id: number, enabled: boolean): void {
    dbh()
    statements.setRootEnabled.run(enabled ? 1 : 0, id)
  },
  setRootDepth(id: number, depth: number): void {
    dbh()
    statements.setRootDepth.run(depth, id)
  },

  // ------------------------------------------------------------------ nodes
  /** Insert-or-update by (root_id, path); returns the row id. */
  upsertNode(input: UpsertNodeInput): number {
    const d = dbh()
    const path = canon(input.path)
    const existing = row<NodeRecord>(statements.nodeByRootPath.get(input.root_id, path))
    if (existing) {
      statements.upsertNode.run({
        root_id: input.root_id,
        parent_id: input.parent_id,
        name: input.name,
        path,
        kind: input.kind,
        sort_order: input.sort_order ?? existing.sort_order,
        status: input.status ?? existing.status,
        ts: now()
      })
      return existing.id
    }
    const info = statements.upsertNode.run({
      root_id: input.root_id,
      parent_id: input.parent_id,
      name: input.name,
      path,
      kind: input.kind,
      sort_order: input.sort_order ?? 0,
      status: input.status ?? 'active',
      ts: now()
    })
    return Number(info.lastInsertRowid)
  },

  createGroup(name: string, parentId: number | null): number {
    dbh()
    const existing = row<NodeRecord>(statements.groupByName.get(name, parentId))
    if (existing) return existing.id
    const ts = now()
    // A new group is appended after its existing siblings, so it shows up at the
    // bottom of its level instead of tying with `sort_order = 0` rows.
    const max = row<{ m: number | null }>(statements.maxSiblingSort.get(parentId))
    const info = statements.insertGroup.run(parentId, name, Number(max?.m ?? -1) + 1, ts, ts)
    return Number(info.lastInsertRowid)
  },

  /**
   * Create a note attached to `parentId` (or floating at the top level when
   * null). Notes are how the map gets annotated: they point at a project or a
   * group without pretending to be a directory on disk.
   */
  createNote(parentId: number | null, text = ''): number {
    dbh()
    const parent = parentId === null ? undefined : row<NodeRecord>(statements.nodeById.get(parentId))
    if (parentId !== null && !parent) throw new Error(`[repo] parent node ${parentId} not found`)
    // Inherit the parent's root so the note disappears with it (ON DELETE CASCADE)
    // and so per-root tree queries keep it next to what it annotates.
    const rootId = parent?.root_id ?? null
    const ts = now()
    const max = row<{ m: number | null }>(statements.maxSiblingSort.get(parentId))
    const info = statements.insertNote.run(
      rootId,
      parentId,
      noteTitle(text),
      Number(max?.m ?? -1) + 1,
      JSON.stringify({ text }),
      ts,
      ts
    )
    return Number(info.lastInsertRowid)
  },

  setNoteText(id: number, text: string): void {
    dbh()
    const cur = row<NodeRecord>(statements.nodeById.get(id))
    if (!cur) throw new Error(`[repo] node ${id} not found`)
    if (cur.kind !== 'note') throw new Error(`[repo] node ${id} is not a note`)
    const meta = parseMeta(cur.meta)
    meta.text = text
    statements.updateNoteText.run(JSON.stringify(meta), noteTitle(text), now(), id)
  },

  getNode(id: number): NodeRecord | undefined {
    dbh()
    return row<NodeRecord>(statements.nodeById.get(id))
  },
  getNodeByPath(path: string): NodeRecord | undefined {
    dbh()
    return row<NodeRecord>(statements.nodeByPath.get(canon(path) ?? ''))
  },
  listNodes(): TreeNode[] {
    dbh()
    return rows<NodeRecord>(statements.listNodes.all()).map(toTreeNode)
  },
  listNodesByRoot(rootId: number): TreeNode[] {
    dbh()
    return rows<NodeRecord>(statements.listNodesByRoot.all(rootId)).map(toTreeNode)
  },
  /** Build the forest from a flat listing (single pass, no N+1 queries). */
  tree(): TreeNode[] {
    return buildTree(repo.listNodes())
  },
  treeByRoot(rootId: number): TreeNode[] {
    return buildTree(repo.listNodesByRoot(rootId))
  },
  descendantIds(id: number): number[] {
    dbh()
    return rows<{ id: number }>(statements.descendants.all(id)).map((r) => r.id)
  },
  depthOf(id: number): number {
    dbh()
    const r = row<{ d: number | null }>(statements.maxDepthGuard.get(id))
    return Number(r?.d ?? 0)
  },
  updateNode(id: number, patch: NodePatchInput): void {
    const d = dbh()
    d.transaction(() => {
      const cur = row<NodeRecord>(statements.nodeById.get(id))
      if (!cur) throw new Error(`[repo] node ${id} not found`)
      statements.updateNodeFields.run(
        patch.display_name !== undefined ? patch.display_name : cur.display_name,
        patch.status ?? cur.status,
        patch.color !== undefined ? patch.color : cur.color,
        patch.priority ?? cur.priority,
        patch.sort_order ?? cur.sort_order,
        patch.note_md !== undefined ? patch.note_md : cur.note_md,
        patch.tags !== undefined ? JSON.stringify(patch.tags) : cur.tags,
        patch.icon_type ?? cur.icon_type,
        patch.icon_value !== undefined ? patch.icon_value : cur.icon_value,
        patch.meta !== undefined ? JSON.stringify(patch.meta) : cur.meta,
        patch.name ?? cur.name,
        now(),
        id
      )
    })()
  },
  setIdentity(id: number, displayName: string | null, iconType: string, iconValue: string | null): void {
    dbh()
    statements.updateIdentity.run(displayName, iconType, iconValue, now(), id)
  },
  setMeta(id: number, meta: Record<string, unknown>): void {
    dbh()
    statements.updateMeta.run(JSON.stringify(meta), now(), id)
  },
  markMissing(id: number, missing: boolean): void {
    dbh()
    statements.markMissing.run(missing ? 1 : 0, now(), id)
  },

  /**
   * Re-parent a node. `root_id` follows the new parent; a NULL parent means the
   * node becomes a virtual root (root_id = NULL, path preserved).
   * Cycles and depth>64 are rejected.
   */
  moveNode(id: number, parentId: number | null, index: number): void {
    const d = dbh()
    d.transaction(() => {
      const node = row<NodeRecord>(statements.nodeById.get(id))
      if (!node) throw new Error(`[repo] node ${id} not found`)
      if (parentId === id) throw new Error('[repo] cannot move a node into itself')
      if (parentId !== null) {
        const desc = rows<{ id: number }>(statements.descendants.all(id)).map((r) => r.id)
        if (desc.includes(parentId)) throw new Error('[repo] cannot move a node into its own descendant')
        const parent = row<NodeRecord>(statements.nodeById.get(parentId))
        if (!parent) throw new Error(`[repo] parent ${parentId} not found`)
      }
      const depthBelow = repo.subtreeDepth(id)
      const depthAbove = parentId === null ? 0 : repo.depthOf(parentId) + 1
      if (depthAbove + depthBelow > 64) throw new Error('[repo] move would exceed max depth 64')

      const parentRow = parentId === null ? undefined : row<NodeRecord>(statements.nodeById.get(parentId))
      /* `root_id` records which disk root discovered the node — it is what makes
       * `(root_id, path)` unique to the scanner. A virtual group carries no
       * root_id, so letting it flow into the child would clash with `UNIQUE`
       * (NULLs are distinct in SQLite) and the next scan would insert a second
       * node for the same folder. Keep the node's own root instead. */
      const newRootId = parentId === null ? node.root_id : (parentRow?.root_id ?? node.root_id)

      // Re-index siblings around the insertion point.
      const siblings = rows<NodeRecord>(statements.listChildNodes.all(parentId)).filter((n) => n.id !== id)
      const clamped = Math.max(0, Math.min(index, siblings.length))
      const ordered = [...siblings.slice(0, clamped), node, ...siblings.slice(clamped)]
      statements.updatePlacement.run(parentId, newRootId, clamped, now(), id)
      ordered.forEach((sib, i) => {
        if (sib.sort_order !== i) statements.updatePlacement.run(sib.parent_id, sib.root_id, i, now(), sib.id)
      })
      // Children inherit the new root_id for path uniqueness semantics.
      if (newRootId !== node.root_id) {
        for (const child of rows<NodeRecord>(statements.listChildNodes.all(id))) {
          statements.updatePlacement.run(child.parent_id, newRootId, child.sort_order, now(), child.id)
        }
      }
    })()
  },

  subtreeDepth(id: number): number {
    const all = rows<{ id: number; parent_id: number | null }>(
      getDb().prepare(`SELECT id, parent_id FROM nodes`).all()
    )
    const childrenOf = new Map<number, number[]>()
    for (const n of all) {
      if (n.parent_id == null) continue
      const arr = childrenOf.get(n.parent_id) ?? []
      arr.push(n.id)
      childrenOf.set(n.parent_id, arr)
    }
    let max = 0
    const stack: Array<[number, number]> = [[id, 0]]
    while (stack.length) {
      const [cur, depth] = stack.pop()!
      if (depth > max) max = depth
      for (const c of childrenOf.get(cur) ?? []) stack.push([c, depth + 1])
    }
    return max
  },

  reindexChildren(parentId: number | null, orderedIds: number[]): void {
    const d = dbh()
    d.transaction(() => {
      orderedIds.forEach((id, i) => {
        const n = row<NodeRecord>(statements.nodeById.get(id))
        if (!n) return
        statements.updatePlacement.run(parentId, n.root_id, i, now(), id)
      })
    })()
  },

  /**
   * Remove a node from the library.
   *
   * A node that maps to a real directory also leaves a tombstone for its root:
   * deleting the row alone is not enough, because the next scan walks the disk
   * and inserts the same folder straight back. Groups have `path === null` and
   * are never recreated by a scan, so they need no tombstone. Removing the root
   * clears the tombstones with it (ON DELETE CASCADE), which is why "remove the
   * root and add it again" restores the nodes.
   */
  deleteNode(id: number): void {
    const db = dbh()
    const target = row<{ root_id: number | null; path: string | null }>(statements.nodeById.get(id))
    const tx = db.transaction(() => {
      if (target && target.root_id != null && target.path) {
        statements.insertHidden.run(target.root_id, target.path, now())
      }
      statements.deleteNode.run(id)
    })
    tx()
  },

  /** Paths a user removed under this root; the scanner skips them and their subtree. */
  hiddenPaths(rootId: number): Set<string> {
    dbh()
    const out = new Set<string>()
    for (const r of rows<{ path: string }>(statements.hiddenPaths.all(rootId))) out.add(pathKey(r.path))
    return out
  },

  /** Paths currently tracked for a root, used for incremental scan diffs. */
  pathIndex(rootId: number): Map<string, number> {
    dbh()
    const out = new Map<string, number>()
    for (const r of rows<{ id: number; path: string | null }>(statements.existingPaths.all(rootId))) {
      if (r.path) out.set(pathKey(r.path), r.id)
    }
    return out
  },

  /**
   * The same rows as `pathIndex`, but reporting what the last scan recorded about
   * each node. A rescan compares against these so a folder that *gained* a marker
   * (someone ran `git init` in it) is re-classified instead of keeping its old
   * fingerprint forever.
   */
  scannedIndex(rootId: number): Map<string, { id: number; kind: string; meta: Record<string, unknown> }> {
    dbh()
    const out = new Map<string, { id: number; kind: string; meta: Record<string, unknown> }>()
    for (const r of rows<{ id: number; path: string | null; kind: string; meta: string | null }>(
      statements.existingPaths.all(rootId)
    )) {
      if (!r.path) continue
      let meta: Record<string, unknown> = {}
      try {
        meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {}
      } catch {
        meta = {}
      }
      out.set(pathKey(r.path), { id: r.id, kind: r.kind, meta })
    }
    return out
  },
  missingCandidates(rootId: number): NodeRecord[] {
    dbh()
    return rows<NodeRecord>(statements.missingCandidates.all(rootId))
  },
  gitProjects(): NodeRecord[] {
    dbh()
    return rows<NodeRecord>(statements.gitNodes.all())
  },
  hasPath(id: number): boolean {
    dbh()
    return Boolean(row<{ ok: number }>(statements.pathExists.get(id)))
  },

  // ----------------------------------------------------------------- events
  insertEvents(list: EventInsert[]): number {
    if (list.length === 0) return 0
    const d = dbh()
    let inserted = 0
    d.transaction(() => {
      for (const e of list) {
        const info = statements.insertEvent.run({
          node_id: e.node_id,
          source: e.source,
          ref: e.ref ?? null,
          message: e.message ?? null,
          author: e.author ?? null,
          occurred_at: e.occurred_at,
          file_count: e.file_count ?? 0,
          insertions: e.insertions ?? 0,
          deletions: e.deletions ?? 0,
          files_json: e.files_json ?? '[]'
        })
        inserted += info.changes
      }
    })()
    return inserted
  },
  listEvents(filter: {
    nodeIds?: number[]
    sources?: EventSource[]
    from?: number
    to?: number
    limit?: number
    offset?: number
  }): HubEvent[] {
    const d = dbh()
    const limit = Math.min(filter.limit ?? 500, 5000)
    const offset = filter.offset ?? 0
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.nodeIds && filter.nodeIds.length > 0) {
      clauses.push(`node_id IN (SELECT value FROM json_each(?))`)
      params.push(JSON.stringify(filter.nodeIds))
    }
    if (filter.sources && filter.sources.length > 0) {
      clauses.push(`source IN (${filter.sources.map(() => '?').join(',')})`)
      params.push(...filter.sources)
    }
    if (filter.from != null) {
      clauses.push(`occurred_at >= ?`)
      params.push(filter.from)
    }
    if (filter.to != null) {
      clauses.push(`occurred_at <= ?`)
      params.push(filter.to)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const sql = `SELECT * FROM events ${where} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`
    params.push(limit, offset)
    const stmt = d.prepare(sql)
    return rows<EventRecord>(stmt.all(...params)).map(toHubEvent)
  },
  eventsInRange(from: number, to: number, limit = 5000): HubEvent[] {
    dbh()
    return rows<EventRecord>(statements.eventsRange.all(from, to, limit)).map(toHubEvent)
  },
  eventStats(nodeIds: number[]): {
    count: number
    first: number | null
    last: number | null
    insertions: number
    deletions: number
  } {
    dbh()
    const r =
      nodeIds.length === 1
        ? row<Record<string, number | null>>(statements.eventStatsSingle.get(nodeIds[0]))
        : row<Record<string, number | null>>(statements.eventStats.get(JSON.stringify(nodeIds)))
    return {
      count: Number(r?.c ?? 0),
      first: r?.first == null ? null : Number(r.first),
      last: r?.last == null ? null : Number(r.last),
      insertions: Number(r?.ins ?? 0),
      deletions: Number(r?.del ?? 0)
    }
  },
  /** Single-node aggregate; avoids the `json_each` round trip for one node. */
  eventStatsSingle(nodeId: number): {
    count: number
    first: number | null
    last: number | null
    insertions: number
    deletions: number
  } {
    dbh()
    const r = row<Record<string, number | null>>(statements.eventStatsSingle.get(nodeId))
    return {
      count: Number(r?.c ?? 0),
      first: r?.first == null ? null : Number(r.first),
      last: r?.last == null ? null : Number(r.last),
      insertions: Number(r?.ins ?? 0),
      deletions: Number(r?.del ?? 0)
    }
  },
  /** Buckets by LOCAL calendar day (§13 heatmap). */
  dailyCounts(from: number, to: number, nodeIds: number[]): DayCount[] {
    dbh()
    const raw = rows<{ occurred_at: number; insertions: number; deletions: number }>(
      nodeIds.length === 0
        ? getDb()
            .prepare(
              `SELECT occurred_at, insertions, deletions FROM events WHERE occurred_at BETWEEN ? AND ?`
            )
            .all(from, to)
        : statements.allEventsForHeatmap.all(from, to, JSON.stringify(nodeIds))
    )
    const map = new Map<string, DayCount>()
    for (const e of raw) {
      const day = localDay(e.occurred_at)
      const cur = map.get(day) ?? { day, count: 0, insertions: 0, deletions: 0 }
      cur.count += 1
      cur.insertions += Number(e.insertions) || 0
      cur.deletions += Number(e.deletions) || 0
      map.set(day, cur)
    }
    return [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
  },
  listEventsForExport(limit = 200_000): EventRecord[] {
    dbh()
    return rows<EventRecord>(statements.eventsForExport.all(limit))
  },

  // -------------------------------------------------------------- snapshots
  replaceSnapshots(
    nodeId: number,
    entries: Array<{ rel_path: string; mtime: number; size: number; hash?: string | null }>
  ): void {
    const d = dbh()
    d.transaction(() => {
      statements.deleteSnapshotsForNode.run(nodeId)
      for (const e of entries) {
        statements.upsertSnapshot.run(nodeId, e.rel_path, e.mtime, e.size, e.hash ?? null)
      }
    })()
  },
  snapshots(nodeId: number): Array<{ rel_path: string; mtime: number; size: number; hash: string | null }> {
    dbh()
    return rows(statements.snapshotsForNode.all(nodeId))
  },
  getSnapshotEntry(nodeId: number, relPath: string) {
    dbh()
    return row<{ rel_path: string; mtime: number; size: number; hash: string | null }>(
      statements.snapshotEntry.get(nodeId, relPath)
    )
  },
  putSnapshotEntry(nodeId: number, relPath: string, mtime: number, size: number): void {
    dbh()
    statements.upsertSnapshot.run(nodeId, relPath, mtime, size, null)
  },
  removeSnapshotEntry(nodeId: number, relPath: string): void {
    dbh()
    statements.deleteSnapshotEntry.run(nodeId, relPath)
  },
  pruneSnapshots(): number {
    dbh()
    return statements.staleSnapshots.run().changes
  },

  // -------------------------------------------------------------------- git
  /** Last synced commit for a node, or null when it has never been synced. */
  getCursor(nodeId: number): string | null {
    dbh()
    const r = row<{ last_hash: string | null }>(statements.getCursor.get(nodeId))
    return r?.last_hash ?? null
  },
  setCursor(nodeId: number, hash: string | null): void {
    dbh()
    statements.setCursor.run(nodeId, hash, now())
  },

  // ------------------------------------------------------------------ icons
  addIconAsset(filename: string, origin: string | null, bytes: number | null): IconAsset {
    dbh()
    statements.insertIcon.run(filename, origin, bytes, now())
    return row<IconAsset>(statements.iconByFilename.get(filename)) as IconAsset
  },
  listIconAssets(): IconAsset[] {
    dbh()
    return rows<IconAsset>(statements.listIcons.all())
  },
  removeIconAsset(filename: string): void {
    dbh()
    statements.deleteIcon.run(filename)
  },
  usedIconFilenames(): string[] {
    dbh()
    return rows<{ v: string }>(statements.usedIconFilenames.all()).map((r) => r.v)
  },

  // --------------------------------------------------------------- settings
  getSetting(key: string): string | null {
    dbh()
    const r = row<{ value: string }>(statements.getSetting.get(key))
    return r ? r.value : null
  },
  setSetting(key: string, value: string): void {
    dbh()
    statements.setSetting.run(key, value)
  },
  allSettings(): Record<string, string> {
    dbh()
    const out: Record<string, string> = {}
    for (const r of rows<{ key: string; value: string }>(statements.allSettings.all())) out[r.key] = r.value
    return out
  },

  // -------------------------------------------------------------- task state
  getTaskState(task: string): TaskStateRow | null {
    dbh()
    return row<TaskStateRow>(statements.getTask.get(task)) ?? null
  },
  setTaskState(task: string, lastRun: number | null, nextRun: number | null, meta: Record<string, unknown> = {}): void {
    dbh()
    statements.setTask.run(task, lastRun, nextRun, JSON.stringify(meta))
  },
  allTaskStates(): TaskStateRow[] {
    dbh()
    return rows<TaskStateRow>(statements.allTasks.all())
  },

  // ----------------------------------------------------------------- search
  searchNodes(q: string, limit = 100): SearchHit[] {
    dbh()
    const needle = `%${q}%`
    const found = rows<NodeRecord>(statements.searchNodes.all({ q: needle, limit }))
    return found.map((n) => {
      const tags = parseTags(n.tags)
      let matchedOn = 'name'
      let snippet = n.path ?? n.name
      const lower = q.toLowerCase()
      if (n.display_name && n.display_name.toLowerCase().includes(lower)) {
        matchedOn = 'display_name'
        snippet = n.display_name
      } else if (tags.some((t) => t.toLowerCase().includes(lower))) {
        matchedOn = 'tag'
        snippet = tags.filter((t) => t.toLowerCase().includes(lower)).join(', ')
      } else if (n.path && n.path.toLowerCase().includes(lower)) {
        matchedOn = 'path'
        snippet = n.path
      } else if (n.note_md && n.note_md.toLowerCase().includes(lower)) {
        matchedOn = 'note'
        const idx = n.note_md.toLowerCase().indexOf(lower)
        snippet = n.note_md.slice(Math.max(0, idx - 30), idx + 60).replace(/\s+/g, ' ')
      }
      return {
        nodeId: n.id,
        kind: n.kind,
        name: n.name,
        displayName: n.display_name,
        path: n.path,
        matchedOn,
        snippet
      }
    })
  },

  counts(): { nodes: number; events: number } {
    dbh()
    return {
      nodes: Number(row<{ c: number }>(statements.countNodes.get())?.c ?? 0),
      events: Number(row<{ c: number }>(statements.countEvents.get())?.c ?? 0)
    }
  }
}

export function localDay(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Flat list -> forest. O(n). */
export function buildTree(flat: TreeNode[]): TreeNode[] {
  const byId = new Map<number, TreeNode>()
  for (const n of flat) byId.set(n.id, { ...n, children: [] })
  const roots: TreeNode[] = []
  for (const n of flat) {
    const self = byId.get(n.id)!
    const parent = n.parent_id == null ? undefined : byId.get(n.parent_id)
    if (parent) parent.children!.push(self)
    else roots.push(self)
  }
  const sortRec = (list: TreeNode[]): void => {
    list.sort((a, b) =>
      a.sort_order !== b.sort_order ? a.sort_order - b.sort_order : a.name.localeCompare(b.name)
    )
    for (const n of list) if (n.children?.length) sortRec(n.children)
  }
  sortRec(roots)
  /* A childless node is a leaf everywhere except for groups: react-arborist
   * decides `isLeaf` with `!Array.isArray(children)` (node-api.js:51) and only a
   * node it considers *internal* offers the "drop inside" target
   * (dnd/compute-drop.js:86). Without this an empty group cannot be dragged into
   * until it already has a child. */
  for (const n of byId.values()) {
    if (n.children && n.children.length === 0 && n.kind !== 'group') delete n.children
  }
  return roots
}

export type Repo = typeof repo
