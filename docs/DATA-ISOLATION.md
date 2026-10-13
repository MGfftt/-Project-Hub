# 数据隔离 · Data Isolation

> **本程序从不向被索引的项目目录写入任何文件。**
>
> **This application never writes any file into an indexed project folder.**

This document explains how that guarantee is implemented, why it is structural rather than a convention, and how it is verified.

本文说明这条保证是如何实现的、为什么它是结构性的而不是约定俗成的，以及如何验证。

---

## 1. 数据放在哪里 · Where the data lives

Everything the app creates lives under Electron's `userData` directory:

| 路径 · Path | 内容 · Contents |
| --- | --- |
| `<userData>/data.db` | SQLite 数据库：根目录、节点、事件、快照、git 游标、图标资产、设置、任务状态 |
| `<userData>/thumbnails/` | 缩略图缓存，文件名为 `sha1(absPath\|mtime\|size).slice(0,20)-<edge>.png` |
| `<userData>/backgrounds/` | 用户选择的界面背景图 |
| `<userData>/background.json` | 背景图的元数据（文件名、来源、字节数） |
| `<userData>/logs/app.log` | 应用日志 |
| `<userData>/icon-assets/` | 用户导入的图标图片 |

`userData` resolves to:

| 平台 · Platform | 位置 · Location |
| --- | --- |
| Windows | `%APPDATA%\project-hub\` |
| macOS | `~/Library/Application Support/project-hub/` |
| Linux | `~/.config/project-hub/` |

The database path is additionally surfaced in the UI (设定 → 数据) and over IPC as `app.info().dbPath`, so it is always discoverable.

数据库路径也会在界面（设置 → 数据）与 IPC（`app.info().dbPath`）中显示，随时可查。

---

## 2. 三道结构性防线 · Three structural defences

### 2.1 唯一写入收口 · One write funnel

`src/main/utils/fsops.ts` is the only module in the codebase that opens a file for writing. Every other module that needs to persist bytes calls into it:

| 函数 · Function | 作用 · Purpose |
| --- | --- |
| `ensureDir(dir)` | 创建目录 |
| `writeJsonAtomic(file, value)` | 先写临时文件再 `rename`，避免半截文件 |
| `copyIntoStore(source, destDir, keepExt)` | 把用户选择的文件复制进 store，返回 `<uuid><ext>` |
| `trashFile(file)` | 删除 |
| `removeFileQuiet(file)` | 尽力删除，失败不抛 |
| `resolveInside(base, relPath)` | **纯函数**：把一个文件名解析进 `base`，拒绝 `..`、绝对路径与 NUL |

The funnel writes wherever it is told, so the discipline is that **its callers only ever pass a path under `userData`**. That discipline is enforced at the next layer.

收口函数本身照传入路径写，因此纪律是「调用方只传 `userData` 下的路径」——这条纪律由下一层强制。

### 2.2 路径授权点 · Path authorisation

`src/main/ipc/anchor.ts` is the only way a native path becomes reachable from the renderer:

```ts
createAnchor({ thumbsDir, backgroundsDir, appDir }): Anchor
  anchor.paths.node(id)          // 整数 id -> 数据库里的路径（只读）
  anchor.paths.icon(filename)    // 文件名 -> userData/icon-assets/…，越界返回 null
  anchor.paths.background(name)  // 文件名 -> userData/backgrounds/…，越界返回 null
  anchor.paths.indexed(candidate)// 仅当 candidate 落在某个已注册根目录内才返回它
  anchor.isInsideIndexedRoot(p)
```

**The renderer never sends a path.** Every node operation (`openFolder`, `revealFolder`, `copyPath`, `stats`, `thumb`, `openFile`) takes an **integer node id**, and the main process resolves it through the database. A malicious or buggy renderer therefore has no vocabulary for naming a file outside the store.

**渲染进程从不发送路径。** 所有节点操作（打开、定位、复制路径、属性、缩略图、打开文件）都只传**整数节点 id**，由主进程通过数据库解析。

`resolveInside()` rejects:

- 任何含 `..` 段的路径（`'.../../x'` 归一化后会回到 `base` 内，因此按段判定，而不是按归一化结果）；
- 任何绝对路径（`/etc/passwd`、`C:\Windows\win.ini`、`\\?\C:\…`）；
- 任何含 NUL 字节的路径。

### 2.3 只读的扫描与 git · Read-only scanning and git

The scanner (`src/main/scanner/`) only ever calls `readdir`, `stat` and `readFile` on indexed directories. It never creates, renames or deletes anything there — not even a cache file. Thumbnails are derived by reading the source image and writing the result into `userData/thumbnails/`; the source is never touched.

扫描器对索引目录只调用 `readdir` / `stat` / `readFile`，绝不创建、重命名或删除任何东西——连缓存文件也不放。

The git wrapper (`src/main/services/git.ts`) is read-only by construction (see `DECISIONS.md` D-013) and runs with `GIT_OPTIONAL_LOCKS=0`, so reading history cannot take an index lock and interfere with a build or commit in another window.

git 封装从构造上就是只读的，并以 `GIT_OPTIONAL_LOCKS=0` 运行，因此读历史不会占用索引锁。

---

## 3. 为什么这不是「默认约定」 · Why this is not a default convention

A rule that says "be careful not to write there" is broken by the first contributor who is in a hurry. Making the guarantee structural means breaking it takes deliberate work:

- There is one function that writes, and it has no notion of "a project folder".
- The renderer has no type in its IPC surface that accepts a path for a node operation — it would not compile.
- The scanner and git modules have no write APIs in scope (no `writeFile`, no `mkdir`, no `rm` imported in the scanner at all).

一条「小心别写进去」的规矩，会在第一个赶时间的人手上失效。把保证做成结构性的，意味着破坏它需要刻意为之。

---

## 4. 如何验证 · How it is verified

### 4.1 对抗性哈希测试 · Adversarial hashing

`tests/unit/isolation.spec.ts` walks the entire indexed tree before an operation and after it, recording `{size, mtimeMs, sha1}` for every file, and requires the diff to be empty.

```ts
const before = hashTree(projectRoot)
// …扫描 / 写标注 / 设图标 / 生成缩略图 / 读 git / 写日志…
expect(diffTrees(before, hashTree(projectRoot))).toEqual([])
```

Covered operations: full scan, incremental rescan, annotation + tags + status write, custom icon selection, thumbnail generation, git history read, log-sink write, snapshot recording.

### 4.2 IPC 边界测试 · IPC boundary tests

`tests/unit/ipc.spec.ts` asserts that:

- `shell.openFile(nodeId, relPath)` rejects `../../etc/passwd`, `..\..\windows\win.ini`, `/etc/passwd`, `\windows\system32`;
- `nodes.setIcon` rejects `C:\Windows\win.ini` and `../../secret.png`, accepting only `auto`, `emoji`, or a path that already resolves inside the store;
- no handler receives a raw filesystem path for a node operation.

### 4.3 运行 · Running them

```bash
npm run test:unit
```

The isolation file is `tests/unit/isolation.spec.ts`. It fails loudly — with an `created:`/`modified:`/`deleted:` line naming the exact file — if a single byte lands in the wrong place.

---

## 5. 例外与边界 · Exceptions and boundaries

- **The user can still change their own files.** `shell.openFile` opens a file inside an indexed project in the OS default application. That is a *read* from the app's perspective, but the application it launches (an editor) may of course write — an explicit user action, not the app's doing.
- **`nodes.relocate` changes the app's own record of a path, never the disk.** If a project moved, the user re-points the node; nothing is moved on disk.
- **Removing a root removes database rows, never directories.** `roots.remove(id)` cascades to that root's nodes, events and snapshots. The folders themselves are untouched.
- **`shell.openFolder` / `revealFolder`** hand a path to the OS. The file manager may create `desktop.ini` / `.DS_Store` of its own accord; that is the OS, not this app.
