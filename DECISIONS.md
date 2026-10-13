# Decisions · 决策记录

The project book (§0.1) freezes the tech stack, the data model and the IPC interface, and requires that any detail it does **not** specify be resolved by least surprise and recorded here.

项目书 §0.1 冻结了技术选型、数据模型与 IPC 接口；未规定的细节按「最小意外」原则决定，并记录在本文件中。

Each entry states the decision, the reason, and what it costs.

---

## D-001 · Data isolation is enforced by a write funnel, not by convention

**Decision.** The app has exactly one file-writing entry point (`src/main/utils/fsops.ts`) and one path-authorisation point (`src/main/ipc/anchor.ts`). The renderer submits integer `nodeId`s; it can never name a filesystem path. Annotation, tags, icons, notes, thumbnails, the SQLite database and logs all live under `app.getPath('userData')`.

**Why.** §0.2's first prohibition is that annotation data must never pollute an indexed project folder. A rule that depends on every future contributor remembering it will eventually be broken. Making it structural — one funnel, no path from the renderer — means breaking it requires actively editing the funnel.

**Cost.** Two indirections (id → path, filename → store path) on every file-touching operation, and a small amount of extra IPC for operations that naively would take a path.

**Guard.** `tests/unit/isolation.spec.ts` hashes the whole indexed tree before and after each operation and requires an empty diff. `tests/unit/ipc.spec.ts` additionally asserts that no handler accepts a raw path for a node operation.

See [`docs/DATA-ISOLATION.md`](docs/DATA-ISOLATION.md).

---

## D-002 · A driver shim: `better-sqlite3` in production, `node:sqlite` as the fallback

**Decision.** `src/main/db/sqlite.ts` probes for `better-sqlite3` at load time and, when the native addon cannot be loaded, falls back to Node's built-in `node:sqlite` (`DatabaseSync`) behind a `better-sqlite3`-compatible surface. It exports `driverName` so the running driver is observable (Settings → 数据 shows it).

**Why.** `better-sqlite3` is built for the Electron ABI (137 / Electron 33). Under plain `node` (v24.19.0, ABI 137 but a different runtime) the addon cannot be located:

```
Error: Could not locate the bindings file.
Tried: …\build\Release\better_sqlite3.node, …\compiled\24.19.0\win32\x64\better_sqlite3.node,
       …\lib\binding\node-v137-win32-x64\better_sqlite3.node
```

Vitest runs under plain Node, so without the fallback the entire DB layer — and every annotation, event and cursor assertion — would be untestable. Both drivers speak identical SQL, so `schema.sql`, `repo.ts` and every test are literally unchanged across them.

**Cost.** Two code paths in one module, and the constant risk that they diverge. See D-008, which is exactly that risk materialising.

---

## D-003 · Three deliberate additions to the frozen §6.1 DDL

**Decision.** `src/main/db/schema.sql` matches the project book's DDL plus:

1. `IF NOT EXISTS` on every `CREATE` (idempotent schema application).
2. A partial unique index: `CREATE UNIQUE INDEX idx_events_unique_ref ON events(node_id, source, ref) WHERE ref IS NOT NULL`.
3. `WITHOUT ROWID` on `snapshots` (its primary key is the natural `(node_id, rel_path)`).

**Why.** (2) is the load-bearing one. §7.3 requires that a second git sync of the same commits add **0** events. With the index, that guarantee is structural — `INSERT OR IGNORE` cannot duplicate a commit for a node — instead of depending on cursor bookkeeping being correct after a force-push, a rebase or a `gc`. The `WHERE ref IS NOT NULL` clause exempts filesystem events, which have no meaningful `ref`.

**Cost.** Filesystem events with a `NULL` ref are unconstrained (intended); a future source that reuses a `ref` string for different content would collide.

---

## D-004 · Task names and intervals differ from §10.2

**Decision.** The scheduler runs five tasks — `rescan` (30 min), `git-sync` (10 min), `snapshot` (5 min), `prune` (24 h, AC only), `size-sweep` (24 h, AC only) — instead of §10.2's `git_sync` (30 min), `vacuum` (24 h) and `prune_snapshots` (12 h).

**Why.**
- **Renaming**: the codebase is TypeScript; `git-sync` matches the `SETTING_KEYS.lastGitSyncAt` and tray-menu vocabulary.
- **`git-sync` at 10 min rather than 30**: R6 asks for "easy incremental maintenance" and `git log` is cheap and cursor-driven, so a shorter interval keeps the timeline fresh without measurable cost.
- **`rescan` and `snapshot` are additions.** §10.2 assumes the filesystem watcher alone keeps the tree current, but a watcher can miss changes made while the app was not running. `rescan` reconciles the tree, and `snapshot` acts as a safety net that diffs each root when the watcher was silent.
- **`size-sweep` is intentionally a lazy no-op.** The book's `vacuum` was replaced because a full-disk size sweep on a schedule is exactly the runaway background process §10.2 forbids. Disk size is computed on demand when a node's properties are opened, and cached in `nodes.meta`.

**Cost.** Two more task rows in `task_state` than the book lists, and a schedule the book's table does not describe.

---

## D-005 · The built-in icon set is 45 hand-authored glyphs, not §8.4's 60 lucide names

**Decision.** `src/shared/icons.ts` ships 45 glyphs as raw SVG path data and is the first source consulted for any icon. The remaining names in the frozen §8.4 list are resolved from a static table in `src/renderer/src/lib/lucideIcons.ts` (see D-011).

**Why.** The book's §0.1 requires every dependency to justify itself. ~4 kB of path data removes lucide-react from the icon paint path entirely, so drawing a tree of 5,000 rows never touches the library. The 45 glyphs cover the names the auto-inference rules actually produce.

**Cost.** Two icon vocabularies. `lib/treeIcons.ts` decides which one applies, and `inferAutoIcon()` documents the substitutions (`folder-tree` → `layers`, `folder-code` → `file-code`, `alert-triangle` → the amber warning glyph).

---

## D-006 · Initial window is 1280×820, not §9.1's 1440×900

**Decision.** `createWindow()` opens at 1280×820 with a 940×620 minimum.

**Why.** 1440×900 does not fit a 1366×768 laptop, which is a large share of the target audience; an oversized initial window would open partially off-screen. The layout itself still honours §9.1's column widths (left 320px, centre flex, right 360px, both resizable).

**Cost.** A visible difference from the spec's stated default. Recorded here rather than silently changed.

---

## D-007 · Thumbnails and imported images are served over `hub-media://`, not base64

**Decision.** A privileged custom protocol `hub-media://local/<encoded path>` streams thumbnail and icon files from the app's store directory. `protocol.handle` validates that the requested path resolves inside `thumbnails/`, `backgrounds/` or the icon store, then delegates to `net.fetch(pathToFileURL(...))`.

**Why.** Base64 data URLs would inflate every IPC reply by ~33% and hold entire images in the renderer's JS heap for the lifetime of the component. `net.fetch` gives streaming, `Range` support and MIME detection with zero dependencies.

**Cost.** The protocol must be registered before `app.whenReady()` and is renderer-visible, so the path check in the handler is security-relevant and covered by `tests/unit/ipc.spec.ts`.

---

## D-008 · `pragma()` must match `better-sqlite3` exactly — a real divergence bug

**Decision.** `NodeSqliteDatabase.pragma(source, options)` returns an **array of row objects** unless `{ simple: true }` is passed, exactly like `better-sqlite3`.

**Why.** The first implementation unwrapped single-column pragmas to a scalar. `verifyOrRebuild` in `src/main/db/index.ts` reads `PRAGMA integrity_check` as `check[0].integrity_check === 'ok'`, so on the fallback driver `check` was the string `'ok'`, `Array.isArray` was false, and **every healthy existing database was declared corrupt and parked as `<db>.corrupt-<ts>`**. The bug was invisible in production (better-sqlite3 was always used there) and invisible in tests (fresh databases take the create path, which skips `verifyOrRebuild`) — it surfaced only when reopening an existing file under `node:sqlite`.

**Cost.** `tests/unit/db.spec.ts` had to be corrected: it had been asserting the shim's unwrapped form, which is why it passed while the bug lived. A regression test now reopens a healthy database and requires `recoveredFrom` to be undefined.

**Lesson.** When a compatibility shim exists, its semantics must be specified by the thing it emulates, not by whichever caller happened to be written first.

---

## D-009 · Heatmap days are bucketed in local time, in JavaScript

**Decision.** `repo.dailyCounts()` fetches rows in a range and buckets them with `localDay(ts)`, which uses the local date parts. It does not use SQLite's `date()`.

**Why.** SQLite's `date()` is UTC. For a user in UTC+8, activity at 23:30 local would land on the next day's cell — a visible, confusing bug in the one view whose entire purpose is "what did I do each day". A heatmap is inherently a local-calendar artefact.

**Cost.** Bucketing happens in JS rather than in SQL, so the range query returns more rows than the number of output buckets. Acceptable: the heatmap reads at most the requested window.

---

## D-010 · No ESLint; `gate:v2` is typecheck + tests + build

**Decision.** The dependency list has no ESLint. `gate:v2` runs `npm run typecheck && npm run test:unit && npm run build`.

**Why.** §0.1 caps the dependency count and requires each one to justify itself. TypeScript in `strict` mode with `noUnusedLocals`, `noUnusedParameters` and `noFallthroughCasesInSwitch` enabled on the web project covers the class of errors a linter would have caught in this codebase, without a second toolchain to install and keep in sync.

**Cost.** No stylistic enforcement. An earlier `package.json` referenced a `lint` script that did not exist; `gate:v2` was pointing at it, so the gate would have failed on a missing script rather than on a real problem. That reference was removed.

---

## D-011 · Icons are imported by name, never as a namespace

**Decision.** `src/renderer/src/lib/lucideIcons.ts` lists the icon components the app may use and imports each by name. Nothing does `import * as Lucide from 'lucide-react'`.

**Why.** `lucide-react` exports **5,234** components. A namespace import is opaque to tree-shaking, so the first build pulled the entire library into the renderer bundle: **1,618.94 kB**. Naming the icons explicitly brought it to **713.08 kB** — a 56% reduction that directly serves NFR-01 (cold start to interactive in under 1.5 s) and R5. A `lucide` node whose stored name is outside the table falls back to the inferred auto glyph, so an unknown name still renders.

**Cost.** A new icon requires one line in the table. That is the intended trade: the §8.4 list is frozen, so the table is a closed set.

---

## D-013 · The git wrapper is read-only by construction

**Decision.** `src/main/services/git.ts` issues only `checkIsRepo`, `status`, `getRemotes`, `log` and `rev-parse`, and runs every command with `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `GIT_CONFIG_NOSYSTEM=1`.

**Why.** R3 only needs to *view* history; the app must never be able to mutate a user's repository as a side effect of reading it. `GIT_OPTIONAL_LOCKS=0` stops git from taking index locks, so reading history cannot interfere with a build or a commit happening in another window. `tests/unit/git.spec.ts` asserts that the source contains no mutating git verb.

**Incident worth recording.** An earlier version passed `config: ['core.quotepath=false', 'credential.helper=']` to `simple-git`, intending to neutralise credential prompts. `simple-git` refuses that outright:

```
Configuring credential.helper is not permitted without enabling allowUnsafeCredentialHelper
```

That threw inside `gitFor()`, which made `checkIsRepo()` fail, which made `probeRepo()` report `isRepo: false` for a real repository and cascaded into every real-repo assertion. The empty credential helper was both unnecessary (the environment hardening above already disables prompts) and actively harmful. It was removed.

---

## D-014 · Benchmarks run the real TypeScript sources under plain Node

**Decision.** `scripts/alias-hooks.mjs` registers a module-resolution hook, so `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/bench-scan.mts` executes `src/main/**` directly — the same code the app runs — with the `node:sqlite` driver, without a build step.

**Why.** The alternative was to benchmark a hand-written reimplementation of the scanner, which measures the benchmark rather than the product. Running the real modules also means a bug in the scanner shows up in the benchmark run.

**Cost.** A dev-only loader with three sharp edges, all documented in the file: `--import` does not register hooks by itself (`module.register()` is required); the hook must not return an explicit `format` (Node must keep inferring `module-typescript`, or type annotations become syntax errors); and candidates must be checked with `statSync(t).isFile()` because `existsSync` is true for directories.

---

## D-015 · UI strings are Chinese; documentation and comments are bilingual or English

**Decision.** Every user-visible string in the app is Simplified Chinese. `README.md` carries full Chinese and English sections. Code comments are English.

**Why.** The project book is written in Chinese and its acceptance cases quote Chinese UI text verbatim (「路径不存在」, 「该项目暂无改动记录」, 「仅在本程序中显示，不会修改磁盘目录名」). Changing those strings would break the acceptance cases. The README is bilingual because the request explicitly asked for both.

**Cost.** No i18n framework, so an English UI would require a real extraction pass. Out of scope for v1 (the book lists no localisation requirement).
