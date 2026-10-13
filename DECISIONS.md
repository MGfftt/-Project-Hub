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

**Why.** `better-sqlite3` is built for exactly one ABI. Electron 33 embeds Node 20.18.3 (module ABI **130**), while this machine's plain `node` is v24.19.0 (ABI **137**) — two different numbers, so one binary can never satisfy both. Under plain `node` the Electron-ABI addon cannot be located:

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

---

## D-016 · `postinstall` fetches the prebuilt Electron addon instead of running `install-app-deps`

**Decision.** `scripts/rebuild-native.mjs` runs as `postinstall` (and as `npm run rebuild:native`). It reads the installed Electron version, runs `npm rebuild better-sqlite3 --foreground-scripts` with `npm_config_runtime=electron`, `npm_config_target=<electron version>`, `npm_config_disturl=https://electronjs.org/headers` and `npm_config_build_from_source=false`, then asks Electron itself to `require('better-sqlite3')` to prove the addon loads.

**Why.** A fresh `npm install` produces a **Node**-ABI addon, which the app — which only ever loads it from Electron — cannot use. The `node:sqlite` fallback of D-002 cannot cover the gap either:

```
$ ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe -e "require('node:sqlite')"
node 20.18.3 sqlite: NO - ERR_UNKNOWN_BUILTIN_MODULE
```

`node:sqlite` appears in Node 22.5, and Electron 33 ships 20.18.3. So without a correct addon the app dies on startup with `Could not locate the bindings file`, and no fallback exists inside Electron.

**Rejected alternative — `electron-builder install-app-deps`.** It is the conventional one-liner and `electron-builder` is already a devDependency, but it drives `node-gyp`, which demands a full MSVC/Xcode toolchain. On a machine without one it fails **and destroys the working prebuilt addon**:

```
Error: Could not find any Visual Studio installation to use
  ⨯ node-gyp failed to rebuild '…\node_modules\better-sqlite3'
$ ELECTRON_RUN_AS_NODE=1 electron.exe -e "require('better-sqlite3')"
LOAD_FAIL Could not locate the bindings file. Tried: …
```

`better-sqlite3`'s own installer prefers `prebuild-install`, which downloads a ready-made Electron binary and needs no compiler. Pinning `npm_config_build_from_source=false` guarantees it never falls through to `node-gyp`.

**Cost.** The script `spawnSync`s npm, and the exit status is deliberately **always 0**: a failing `postinstall` aborts `npm install` entirely and would leave the user with no dependencies at all. Failures print a loud banner with the manual command instead. `--ignore-scripts` installs skip it, so the README documents `npm run rebuild:native` as the recovery step.

---

## D-017 · Git's repository search is bounded to the node's own directory

**Decision.** `gitEnv()` takes the directory being queried and sets `GIT_CEILING_DIRECTORIES` to that directory's **parent**, so the ascent stops one level up. `gitFor(dir)` passes it. A node is therefore only ever treated as a repository if it has its own `.git`.

**Why.** Git searches parent directories for a repository. A project folder without `.git` that sits inside an unrelated repository — `monorepo/packages/docs`, or any plain folder under a repo — resolved to the **enclosing** repository, and `syncAllGit` imported that repository's entire history under the wrong node. The scanner already disagrees with that: `walk.ts:154` derives `meta.isGit` from `<dir>/.git` alone, so the sync layer was the inconsistent one. The symptom showed up as wrong timelines, wrong 查看改动, and the same commit attributed to several sibling nodes.

**Cost.** A subdirectory of a repository no longer inherits the parent's history. That is the intended behaviour — the scanner never classified such a directory as a git project in the first place — but it is a visible change for anyone who previously relied on the inherited view.

**Note on the ceiling value.** It must be absolute, and a single entry needs no list separator, which sidesteps the `:`-versus-`;` difference between POSIX and Windows. When the directory *is* a filesystem root, `dirname() === resolve()` and the variable is left unset.

**Guard.** `tests/unit/git.spec.ts` → 'a nested folder does not inherit the history of an enclosing repo (§14.1)' asserts that a folder inside a real repository reports `isRepo: false` and yields no log entries, while the enclosing repository itself stays readable.

---

## D-018 · The app icon is generated from code, and packaging has a no-sign fallback

**Decision.** `scripts/make-icon.mjs` draws the same three-hub mark the tray uses (`src/main/tray/icon.ts`) into an RGBA buffer with 4× supersampling, encodes PNGs through `node:zlib`, and wraps them in an ICO container written by hand. `npm run make:icon` regenerates `build/icon.ico` (16/24/32/48/64/128/256) and `build/icon.png`. No image library is added.

**Why.** §0.1 requires every dependency to justify itself, and the icon is geometry. Hand-writing the PNG and ICO containers costs about 120 lines of well-understood format code and keeps the dependency count where it is. Shipping Electron's default icon was not acceptable for an app that lives in the tray and on the desktop.

**Second decision in the same area.** `electron-builder.yml` is left exactly as a normal project would have it. On hosts where Windows cannot create symbolic links (no Developer Mode, no elevation), electron-builder's Windows sign stage cannot unpack `winCodeSign`: 7-Zip must recreate two macOS dylib symlinks inside it and fails with `Cannot create symbolic link : 客户端没有所需的特权`. That stage also performs the `rcedit` icon/metadata stamping, so the failure costs both the installer *and* the exe branding. `.builder.nosign.yml` covers that case — it extends the real config with `win.signAndEditExecutable: false`, after which the exe is stamped by a manual `rcedit` pass and the installer is built from the result with `--prepackaged`.

**Cost.** The workaround is three commands instead of one, and it is specific to this class of host. `npm run build:win` stays the single command everywhere else. Because the flag lives in a separate config file rather than the committed one, a build on an unrestricted machine keeps full stamping with no edits.

**Lesson.** A packaging failure that reports a *download* problem can still be a *privilege* problem: the archive was fine, the ability to extract it was not. Checking whether the produced exe carried the expected metadata (`ProductName: Electron` was the tell) located the real scope of the damage.

---

## D-019 · NFR-02 is not met: the renderer is not reclaimed while the window is open

**Decision.** Ship v2.0 with the renderer alive for as long as the app runs, and record the measured resident memory honestly as a miss (393.7 MB against a 220 MB budget) rather than re-labeling the budget or quietly omitting the row.

**Why.** The measurement is unambiguous and reproducible: the packaged `Project Hub.exe`, `--no-sandbox`, window open, sampled after 30 seconds idle, reports four processes — main ~152 MB, renderer ~107 MB, GPU and utility ~130 MB, total 393.7 MB. Idle CPU in the same run was 0.018% of 32 cores, so the miss is specifically memory, and it comes from Chromium rather than from application code: the main process holds the SQLite connection, the file watchers and the scheduler, none of which are large.

Two caveats make the number pessimistic, and neither is strong enough to claim the budget is met: this host has no usable GPU (so software rendering and its buffers are counted here) and the sample was taken with `--no-sandbox`, which changes how work is distributed across processes. That flag is now known to have been a workaround for *where the build sat*, not a property of the machine (see D-020), so the figure is a pessimistic upper bound for a second reason as well. A normal desktop would very likely be lower — but nothing measured supports "under 220 MB".

**The real fix, not taken here.** Reclaim the renderer while the app is hidden: destroy the window's `webContents` when it is closed to the tray and rebuild it on demand from the tray menu. The app is tray-resident by design (R6), and the window is hidden most of the time, so this is the natural shape — but it changes the lifecycle the renderer components rely on (stores rehydrate from scratch on every reveal, an in-flight inline rename or note draft would be lost), which makes it a product decision rather than an optimisation. It is left for a follow-up with the trade-off stated up front.

**Cost.** R5 ("low resource use") is only partly satisfied: CPU, disk and database all have wide margins (0.018% idle CPU; 19.37 MB against a 50 MB budget; 76 ms to scan 10,200 files), but resident memory does not. The README's performance table shows the failing row rather than hiding it, and the manual-acceptance list no longer asks a human to "check memory" as though the answer were unknown.

**Lesson.** A non-functional target that cannot be measured automatically is easy to leave as an aspiration. Running the packaged binary and reading the process table took ten minutes and turned an assumption into a number — which then had to be reported as a failure. That is the point of measuring it.

---

## D-020 · The shipped app needs no flags; the flags were an artifact of where it was built

**Decision.** Ship the unpacked build and the installer exactly as they are — with no `--no-sandbox` anywhere in the product, the shortcuts, or the launcher — and record that a Chromium application placed directly inside this session's workspace folder dies before JavaScript, while the same bytes run normally from any ordinary directory.

**Why.** A user ran `release\win-unpacked\Project Hub.exe` and reported nothing happening at all: no window, no error, no process left behind, and no `%APPDATA%\project-hub` directory. The Event Log showed `electron.exe` version `33.4.11.0` faulting with `0xc0000005`, and a direct spawn returned `-2147483645` (0x80000003 `STATUS_BREAKPOINT`). A marker probe settled the scope: a throwaway main process that wrote a file on its first line, plus `app.commandLine.appendSwitch('no-sandbox')`, produced **no marker file at all** — the process is gone before any JavaScript executes, so no in-app fix can exist. `--no-sandbox` was the only one of ten tested flags that made it start (`--disable-gpu`, `--disable-gpu-sandbox`, `--disable-crash-reporter`, and redirected stdio all failed; the same failure came from Explorer, Task Scheduler, and `Win32_Process.Create`).

**Root cause.** The build output lived under `C:\Users\41239\Desktop\文件整理`, a tool-managed tree whose ACLs are not ordinary user ACLs: `ffttmg\CodexSandboxUsers:(I)(OI)(CI)(RX)`, `Everyone:(I)(CI)(DENY)(DC)`, `Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)`, and a synthetic writer ACE for `S-1-4-325811806-472389683`. Copying the *same files* out of that tree made both the app and the installer work with no flags whatsoever — verified at `%LOCALAPPDATA%\Programs\Project Hub`, at `C:\Users\41239\PHTest`, and at the non-ASCII `%USERPROFILE%\文件整理测试\PH`. The last of those also rules out the non-ASCII path as a cause, which had been the leading hypothesis.

Two upstream explanations were checked and are *not* the whole story here: this Windows 11 build (`10.0.26300`) has a known Chromium sandbox-launch bug (GitHub Desktop [desktop/desktop#22306](https://github.com/desktop/desktop/issues/22306), Electron [electron/electron#54614](https://github.com/electron/electron/issues/54614)), but the workaround those threads recommend — `--disable-gpu-sandbox` — did not help, and granting the AppContainer SID (`icacls <dir> /grant "*S-1-15-2-2:(OI)(CI)(RX)" /T /C /Q`, 115 files) changed nothing.

**Installer note.** NSIS from inside the same tree either hung or exited `0xC0000005`; the identical installer copy, run with `TEMP` and `TMP` pointed at a clean folder, installed silently (exit 0) into `%LOCALAPPDATA%\Programs\Project Hub` and created Desktop and Start Menu shortcuts whose arguments are empty — the shipped app keeps its renderer sandbox.

**Cost.** Nothing in the product changed, so nothing was given up: the earlier `--no-sandbox` measurements (D-019) simply became a pessimistic upper bound rather than the only way to run the app. The real cost was diagnostic time, spent on the assumption that a packaged binary that fails in one place fails everywhere.

**Lesson.** "It runs on my machine" is a claim about a *location* as much as about a build. When a launch fails with no output, move the artifact to a neutral directory before writing a single line of product code — the reproducing difference may be the folder, not the program.


