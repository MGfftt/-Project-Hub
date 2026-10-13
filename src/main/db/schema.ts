/**
 * Embedded copy of schema.sql.
 *
 * electron-vite bundles `src/main/index.ts` and the worker entries separately;
 * reading schema.sql from disk at runtime would depend on the packaged layout.
 * A generated TS module keeps migrations deterministic in dev, in `out/` and
 * inside an asar archive.
 *
 * Regenerate with: `node scripts/sync-schema.mjs`
 */
export const SCHEMA_SQL = `-- Project Hub — data model v1 (§6.1 DDL, frozen)
-- NOTE: every table below lives in the app's OWN userData database.
-- The scanner only ever reads indexed project folders; nothing is ever written
-- back into a user project directory. See docs/DATA-ISOLATION.md.

CREATE TABLE IF NOT EXISTS roots (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  max_depth  INTEGER NOT NULL DEFAULT 4,
  added_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id           INTEGER PRIMARY KEY,
  root_id      INTEGER REFERENCES roots(id) ON DELETE CASCADE,
  parent_id    INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  display_name TEXT,                            -- R4 程序内命名
  path         TEXT,                            -- 虚拟分组为 NULL
  kind         TEXT NOT NULL,                   -- group|project|folder
  status       TEXT NOT NULL DEFAULT 'active',  -- active|paused|done|archived
  color        TEXT,
  priority     INTEGER DEFAULT 0,
  sort_order   INTEGER DEFAULT 0,
  note_md      TEXT DEFAULT '',
  tags         TEXT DEFAULT '[]',
  meta         TEXT DEFAULT '{}',
  icon_type    TEXT DEFAULT 'auto',             -- R4: auto|lucide|emoji|image
  icon_value   TEXT,
  path_missing INTEGER DEFAULT 0,               -- 外部移动/删除标记
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(root_id, path)
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_path   ON nodes(path);
CREATE INDEX IF NOT EXISTS idx_nodes_kind   ON nodes(kind);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,              -- git|fs|manual
  ref         TEXT,
  message     TEXT,
  author      TEXT,
  occurred_at INTEGER NOT NULL,
  file_count  INTEGER DEFAULT 0,
  insertions  INTEGER DEFAULT 0,
  deletions   INTEGER DEFAULT 0,
  files_json  TEXT DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_events_node_time ON events(node_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_time      ON events(occurred_at DESC);
-- Dedupe guard: a given commit is inserted at most once per node.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique_ref
  ON events(node_id, source, ref) WHERE ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS snapshots (
  node_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  mtime    INTEGER NOT NULL,
  size     INTEGER NOT NULL,
  hash     TEXT,
  PRIMARY KEY (node_id, rel_path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS git_cursors (
  node_id    INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  last_hash  TEXT,
  synced_at  INTEGER
);

CREATE TABLE IF NOT EXISTS icon_assets (
  id         INTEGER PRIMARY KEY,
  filename   TEXT NOT NULL UNIQUE,
  origin     TEXT,
  bytes      INTEGER,
  added_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 后台调度状态（R6）
CREATE TABLE IF NOT EXISTS task_state (
  task       TEXT PRIMARY KEY,   -- 'git_sync' | 'fs_scan' | 'vacuum'
  last_run   INTEGER,
  next_run   INTEGER,
  meta       TEXT DEFAULT '{}'
);

-- 用户主动移除的路径（墓碑）。删除一个已经落库的目录只删掉这一行是不够的：
-- 下一次扫描会从磁盘再把它建回来。这里记住路径，扫描时连同它的子目录一起跳过。
-- 移除根目录时随 roots 级联清理，所以「移除根目录再重新添加」可以恢复。
CREATE TABLE IF NOT EXISTS hidden_paths (
  root_id  INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (root_id, path)
) WITHOUT ROWID;
`
