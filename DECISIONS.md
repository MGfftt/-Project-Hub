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

## D-005 · The built-in icon set is 46 hand-authored glyphs, not §8.4's 60 lucide names

**Decision.** `src/shared/icons.ts` ships 46 glyphs as raw SVG path data and is the first source consulted for any icon. The remaining names in the frozen §8.4 list are resolved from a static table in `src/renderer/src/lib/lucideIcons.ts` (see D-011).

**Why.** The book's §0.1 requires every dependency to justify itself. ~4 kB of path data removes lucide-react from the icon paint path entirely, so drawing a tree of 5,000 rows never touches the library. The 46 glyphs cover the names the auto-inference rules actually produce.

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

**Decision.** `README.md` carries full Chinese and English sections. Code comments are English. The app's own strings were Chinese-only, with Chinese as the shipped default — **superseded by D-027, which adds English and lets the user switch.**

**Why.** The project book is written in Chinese and its acceptance cases quote Chinese UI text verbatim (「路径不存在」, 「该项目暂无改动记录」, 「仅在本程序中显示，不会修改磁盘目录名」). Keeping Chinese as the default keeps those acceptance cases valid. The README is bilingual because the request explicitly asked for both.

**Cost.** At the time there was no i18n framework, so an English UI would have required a real extraction pass; the book listed no localisation requirement, so it was out of scope for v1. D-027 is that extraction pass.

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

---

## D-021 · The tree is keyed by strings, the middle column follows the selection, and the third column starts hidden

**Decision.** Fix the three renderer defects a user reported together, and keep the fixes in the renderer only: stringify every react-arborist identity, make the middle column a real page for the selected node with the overview as the default tab, and ship the property column folded behind an 属性 toggle rather than open beside a column that repeats it.

**Why.** The report was one sentence with three parts — clicking 分组 blanked the window, the display "should be a tree", and clicking a node "has no interaction or response". All three reproduced, and each had a different cause:

1. **The blank window was an infinite update loop, not a bad node.** `useTree.load()` force-opens every top-level node, so every load produced a *new* `open` object; `NodeTree`'s replay effect then called `api.open`/`api.close` for the rows whose state differed, react-arborist routes *every* such call through `onToggle`, and `handleToggle` wrote back the **inverse** of the store value. The two chased each other until React aborted with "Maximum update depth exceeded" (minified React error #185 in the production bundle) and unmounted the root — a blank window with no error boundary anywhere to catch it. The fix is two lines of intent: a `syncing` ref makes the replay one-way, and `handleToggle` records `api.isOpen(id)` — the library's post-change state — instead of inverting the store.
2. **A click selected nothing because react-arborist only round-trips string identities.** Its `identify()` passes a string straight through, reads `.id` off a `NodeApi`, and for anything else runs the accessor again. With `idAccessor="id"` the ids stayed numbers, so a click's `TreeApi.select()` → `setSelection({ ids: [4] })` → `identify(4)` re-ran the accessor against the *number*, produced `undefined`, and stored `{ undefined }`. The row painted as selected while `onSelect` reported an empty list, so the app-level selection never moved — which is exactly "clicking does nothing". `idAccessor={(node) => String(node.id)}` fixes it. The library's own error text ("props.idAccessor must return a string") was the clue that had been in the codebase all along.
3. **"No response" was also a product gap, not just a bug.** `select()` only set `selectedId`; `mainView` started at `'tree'` and only 查看改动 ever changed it, so a plain click left the middle column showing a placeholder. There is now a `MainView = 'overview' | 'timeline'` pair with a tab strip, and `NodeOverview` — identity, actions, eight figures and the node's own foldable subtree — is what a click lands on.
4. **Clarity.** The right column had been open by default and repeated the overview's name/kind/path rows side by side, so the window read as two half-empty copies of the same information. It now starts folded behind 属性, the overview's member list is a genuine indent-guided tree rather than a flat list, and its header distinguishes direct children from the whole subtree ("1 直接 · 共 2").

**Evidence.** Each claim was verified in the running app over the Chrome DevTools Protocol, driven by real `Input.dispatchMouseEvent` clicks — a synthetic `MouseEvent` on the row demonstrably does *not* reproduce the defect, which is why an earlier round of probes wrongly concluded the click handler never ran. After the fixes: clicking a row sets `aria-selected` and fills the middle column; clicking 分组 leaves the tree intact and shows the new group's overview; the twisty toggles a branch; the member tree folds and unfolds; the 属性 toggle opens and closes the third column.

**Cost.** Nothing was removed: the timeline (and its context-menu entry) is unchanged, the right column keeps every editing control it had, and the 172 unit tests still pass. The keyboard map is unchanged. The risk taken is that the middle column is now stateful per node (its fold state is per-mount), which is the intended reading — the scroll position of the left tree is unaffected.

**Lesson.** A widget library's identity contract is not a detail. "Must return a string" was documented, load-bearing, and violated by a one-word prop; the symptom it produced — a row that paints as selected while the app never hears about it — pointed at the click handler for two rounds of probing before the prop was read. The cheap move was to read the library's own `identify()` and believe its error message.

---

## D-022 · A marker-less folder is a project, the map is the default view, and one click only selects

**Decision.** Five changes from the same user report, all of them about what the product *does* rather than what it crashes on:

1. A single click **never** opens a folder. It selects the node and shows its overview; 打开目录 stays a button on that page. Opening a folder moves to the double click, and then only for a leaf with no children to expand.
2. With nothing selected, the middle pane is a **workspace map** — the whole tree drawn left-to-right as cards joined by connectors, zoomable, expandable in place.
3. The timeline's scope **follows the selection**: a project shows its own changes, a group or folder shows every node in its subtree, and nothing selected shows everything.
4. Adding a root folder makes **that folder a project even without a marker**; the walker still descends into it, so a plain folder can hold other projects.
5. A marker that appears (or disappears) later is picked up by the next scan: `git init` inside an already-indexed folder promotes it, deleting `.git` demotes it.

**Why.** The user's words were "点击这个节点的时候，会打开这个文件夹的同时会调用出它的属性" — a click was doing two things at once, one of them destructive of context (an Explorer window stealing focus) and the other desired. The same message asked for something graphical in the largest pane ("整个项目会像是一个树一样展示在用户面前"), complained that the timeline showed every node's changes no matter what was selected, and reported the scanner's hardest usability edge: "必须是带有git文件的文件夹" — a folder could not be a project until it already contained a repository, which is backwards for a tool people use to *organise* projects they are about to start.

**Why these shapes.** (1) The click/double-click split keeps both gestures on one input with no modifier, and the existing 260 ms timer already distinguished them; making the single click *not* open a folder is what removes the ambiguity. (2) The map is computed, not hand-placed: a tidy left-to-right tree layout (each leaf gets a row, a parent is centred on its children) beats a force graph here because the data is already a tree and users need to *find* a node, not admire it. (3) Scoping the timeline to `descendantIds(selection)` makes "a group is a saved filter" true in the one place where it matters. (4)/(5) Making the root a node in its own right is what lets a marker-less folder be a project at all — and, once it is a node, the existing fingerprint comparison can re-classify it, so `git init` needs no new code path.

**Evidence.** Verified over CDP against the real app: the default view renders 6 cards with the 项目/分组/目录 counter and no console errors; a click on a map card switches to 概览 with the node's path and figures and never opens a folder; after `mkdir plain/.git` plus a rescan, the node's `kind` flips `folder` → `project` and `meta.marker` becomes `.git`; with a node selected the timeline header reads 时间线 / src with a 清除过滤 chip instead of the whole workspace. 173 unit tests pass (one rewritten to assert the new promote *and* demote behaviour, one added for the marker-less root).

**Cost.** `TreeNode` now carries `meta` (five small keys), which also fixes a latent bug: `treeIcons.markerOf()` had always read `meta.marker` through a cast, and `toTreeNode()` had never sent it, so every `auto` icon had silently fallen through to the name rules. Scans still write one row per directory; the extra write happens only when a fingerprint actually changes. `repo.pathIndex()` is still there for callers that only need ids, with `scannedIndex()` beside it for the scanner.

**Lesson.** The scanner's rule — "a project is a folder with a marker" — was a reasonable *detection* heuristic that had leaked into the *product model*, where it turned into "you cannot add a folder until it is already a repository". The fix was not a better detector but anchoring the model on what the user did (they added this folder) and letting detection refine it afterwards. A heuristic should be allowed to say "not yet"; it should not be allowed to say "not allowed".


## D-023 · Removing a node is remembered, and adding a root never depends on the system dialog

**Decision.** Two fixes from one report ("删除节点或组的时候没法删除，当重新打开的时候还会出现" and "当添加根目录选择文件夹时，无法添加"):

1. Deleting a node writes a **tombstone** — `hidden_paths(root_id, path)`. The scanner loads that set per root and skips the path *and its whole subtree*. Removing the root deletes the tombstones with it (`ON DELETE CASCADE`), so re-adding the root restores the nodes.
2. Adding a root no longer depends on the native folder picker: the 根目录管理 footer gained a 手动输入路径… box, a folder that is already a root now says so instead of appearing to do nothing, and a pick that returns nothing tells the user where the box is.

**Why.** (1) Reproduced over CDP against the real app: delete `alpha/src` (id 5), the tree drops it, then `roots.rescan` **re-inserts it**. `repo.deleteNode` was never wrong — the scanner walks the disk, the directory is still there, and the row was the only place the removal was known. (2) In an automated session `dialog.showOpenDialog` never settled: the promise stayed pending and no dialog window was ever created, while `roots.add(path)` answered immediately. A path can always be typed; a native dialog cannot always be shown.

**Why a tombstone table and not a `hidden` column.** There is no row left to put the column on — the row is what gets deleted. Keeping the row with a flag would have to be excluded from `pathIndex`, `scannedIndex`, `missingCandidates`, `gitNodes`, the size sweep and the tree query, and one forgotten `WHERE` would resurrect the node somewhere else. A per-root path set is smaller, leaves every existing query honest, and lives exactly as long as the root it belongs to.

**Evidence.** Unit: three added cases in `tests/unit/scanner.spec.ts` — a removed node stays removed across a rescan; the subtree disappears with it and nothing is orphaned at the top level (that is the failure mode of filtering only the node itself: children get re-inserted with `parent_id = null` and surface as roots); removing the root clears the tombstones and re-adding restores the node. 176 tests pass. Over CDP, before the fix a rescan brought `src` back, after the fix the tree stays `rxfixture | alpha | beta | docs`; the manual box adds a folder, answers 这个文件夹已经是根目录了 on a repeat, and 添加根目录失败：… 路径不存在 on a typo.

**Cost.** One extra table, and no migration: the schema is applied with `CREATE TABLE IF NOT EXISTS` on every open, so an existing database picks it up on the next launch. A tombstoned directory is still walked and only filtered while writing — a root full of tombstones pays a little extra I/O, which is the right trade against skipping subtrees the user may un-hide later. `deleteNode` became a transaction instead of one statement.

**Lesson.** In an app that mirrors the disk, "delete" is two operations: forget this row, and never look at this path again. The second one needs somewhere to live, and every place that reads the table has to agree about it. The deliberate way back matters too — cascading the tombstones with the root gives users an obvious undo without a hidden-flag query.

---

## D-024 · The tray icon is drawn in-process, the tree keeps its placement, and the map can be annotated

**Context.** A round of use found four separate defects: Task Manager (and the notification area) showed no icon for the app; dragging a project into a group and restarting produced a second copy of that project; a project could not be dragged into an empty group at all; and the workspace map could only display, never hold a note.

**1. The icon never existed at runtime.** `src/main/tray/icon.ts` built the tray image with `nativeImage.createFromDataURL('data:image/svg+xml;base64,…')`. Electron's `nativeImage` **decodes PNG only** — the same call with `image/svg+xml` returns an empty image, silently. The tray therefore fell back to a transparent placeholder, which is exactly the blank square the user photographed in the notification area. `scripts/make-icon.mjs` was a build-time script and never had a runtime counterpart.

**Decision.** Add `src/main/icon/render.ts`: a dependency-free rasteriser and PNG encoder (own CRC32, `zlib.deflateSync`) that draws the same three-hub mark as `src/main/tray/icon.ts` always intended. `createTrayIcon()` now feeds it straight into `nativeImage.createFromBuffer` and adds a 2× representation; `createAppIcon()` supplies a 256px window icon so the taskbar and Alt-Tab do not fall back to Electron's default either. The pure module is also reachable from Node (`node --experimental-strip-types`) for eyeballing a render.

**Why not keep the SVG.** `nativeImage` is the only image type `Tray` accepts, and it has no SVG decoder. Shipping a pre-rendered PNG would mean a binary in the repo and a second source of truth next to `make-icon.mjs`; the rasteriser is ~150 lines and both paths (tray, window) read from it.

**Side effect — the ICO.** The build-time writer wrapped *all* seven sizes as PNG entries. GDI+ (which Task Manager, the file-properties dialog and `ExtractAssociatedIcon` use) decodes PNG entries only up to 48px and threw `Requested range extends past the end of the array` on 64/128/256. `encodeIco` now emits a classic 32-bit DIB (BITMAPINFOHEADER, doubled height, bottom-up BGRA, empty AND mask) for every size below 256 and keeps the PNG entry only for 256, which is the format's own rule. `build/icon.ico` went from 14,933 to 108,690 bytes.

**2. A move used to delete the node's root.** `repo.moveNode` set `root_id = parentRow.root_id`, and a virtual group has `root_id = NULL`. `UNIQUE(root_id, path)` treats NULLs as distinct, so the moved node no longer occupied its `(root, path)` slot and the next scan inserted a *second* row for the same folder. Two fixes: `moveNode` keeps the node's own `root_id` when the parent has none, and `applyBatch` no longer writes `parent_id` at all when refreshing a known node. Placement is the user's decision; only `kind`/`meta`/`path_missing` come from the disk.

**3. An empty group was a leaf.** `buildTree` deleted empty `children` arrays. react-arborist computes `isLeaf` as `!Array.isArray(children)` and only an *internal* node exposes the "drop inside" target, so a group could not receive a drop until it already had a child. Empty arrays are now kept for `kind === 'group'`; the map's expander still checks `children.length > 0`, so nothing looks expandable that is not.

**4. Notes.** A note is a node with `kind = 'note'`, no path, `icon_type = 'emoji'`, `icon_value = '📝'`, and its body in `meta.text`; the row's `name` is a one-line excerpt so the tree and the map can label it without loading a body. It is created from the map toolbar or any overview page, attached to whatever is selected. No new table and no migration: `kind` was already a free-text column, `meta` was already carried on the wire, and every scanner query filters on `path IS NOT NULL`, so a rescan cannot disturb a note. The body auto-saves 600ms after typing stops and on blur.

**Evidence.** `npm run typecheck` and `npm run test:unit` (176 tests) exit 0. Over CDP against the real UI: an empty group reports `children: []`; moving `alpha` (id 2) into a group keeps `root_id: 1` and leaves exactly one row for that path, before and after a rescan, with `parent_id` still the group; the note created by 添加备注 renders its own page and a typed body round-trips as `{"name":"第一行：这个是备注","text":"第一行：这个是备注\n第二行：测试自动保存"}`. No console errors in any step.

**Cost.** ~150 lines of image code that must stay in step with `make-icon.mjs`'s geometry (both draw the same mark; the shapes are duplicated by necessity — one runs in the build script, one in the main process). A group with no children now carries an empty array over IPC. Notes are one more virtual kind the renderer has to label in four places.

**Lesson.** `nativeImage.createFromDataURL` failing silently is the whole bug: an icon that is never set looks exactly like an icon that is set to nothing, and no log line distinguishes them. When a library accepts several input flavours, test the one you actually ship.

## D-025 · Cards drag between nodes on the map, every node carries a colour, and the forest loads itself on mount

**Context.** Two requests from a round of use: nodes should be draggable onto each other (the map could only display), and every node should be able to take a colour. Proving them turned up a third, unrelated defect in the renderer's startup.

**1. Dragging on the map.** The tree already had react-arborist's drag-and-drop; the map had none. The map now uses plain pointer events with `setPointerCapture`, a `DRAG_START_PX` threshold so that a click still selects, `document.elementFromPoint` to decide which card is under the cursor (`data-map-card`), and the very same `window.hub.nodes.move` the tree calls. Refusals: the dragged node itself, its own descendants (no cycles), and notes. Letting go over empty space is a deliberate no-op rather than a move to the top level — an accidental release over the background must not silently re-parent a project to the root.

**Why pointer events and not HTML5 DnD or react-dnd.** react-arborist owns the tree's backend, but the map is an absolutely-positioned layout where the drop target is literally "whichever card is under the cursor", which `elementFromPoint` answers in one line. A second react-dnd backend over the same DOM would have been more machinery for less control, and the HTML5 backend cannot render a live ghost label following the pointer.

**2. Colour.** `nodes.color` already existed in the schema and in `NodePatch`; nothing could set it. `src/renderer/src/lib/colors.ts` gained `NODE_COLORS` — ten named swatches plus a 默认 that clears — rendered once in the 属性 panel and again as the last row of the right-click menu (the menu stays open after a pick so colours can be compared side by side). The stored string never reaches a style unchecked: `nodeColorValue` validates it against the palette first, because the column is free TEXT that an older build or a hand-edited database could hold anything in, and interpolating it into `borderLeft`/`background` would be a CSS-injection path. An unknown value degrades to "no colour", i.e. the kind accent.

**Why a fixed palette rather than a colour picker.** A free picker yields values no legend, tooltip or status line can name, and the whole point of the colour is to make a family of related projects recognisable at a glance.

**3. The empty tree after a reload.** `AppShell` subscribed to `tree:updated` but never read the tree on mount, and the main process only emits that event as a side effect of something else (a scan, a git sync, a scheduled task). A renderer reload with nothing in flight therefore left the tree and the map empty until the next rescan — reachable through the default menu's 重新加载, which this app does not remove. Fixed with a one-shot `useEffect` calling `useTree.getState().load()`.

**Evidence.** 14 checks driven over CDP against the real UI, on an isolated `--user-data-dir`: a ghost label appears during the drag; the drag grabs the intended card; dropping `beta` on a group gives `parent_id: 5`; dropping a node onto its own child is refused (`parent_id: null`); the 属性 panel offers 11 colour buttons; a click persists `#3b82f6` and it is visible on both the tree row and the map card; 默认 clears it to `null`; the context menu offers the same 11 and a green pick persists as `#22c55e`; no uncaught renderer errors. `npm run typecheck`, `npm test` (176 tests) and `npm run build` all exit 0.

*Note for anyone re-running this:* in this session Electron only starts with `--no-sandbox --disable-gpu`; without them `electron.exe` exits before `app.requestSingleInstanceLock()` and no debuggable page ever appears. `--user-data-dir` is honoured, which is what makes the isolated probe safe.

**Cost.** Roughly seventy lines of pointer bookkeeping on the map, which now depends on `data-map-card` staying stable, plus one more free-text column the renderer has to degrade gracefully. The menu grew to eleven actions and a swatch row, so it is now tall enough to be clamped (`max-h`/`overflow-auto`) on a short window.

**Lesson.** An event-driven cache needs a bootstrapping read. `tree:updated` was emitted correctly at every site and the window was still blank, because nothing ever asked for the first state — the subscription answered "when it changes", never "what it is".

---

## D-026 · Pointer capture is taken on movement, not on press

**Context.** A user report: after the map cards became draggable, clicking a card no longer opened the node's page. The regression was intermittent enough that the first reading was "the click handler is flaky".

**Decision.** `setPointerCapture` on a map card now happens in `onCardPointerMove`, only once the pointer has travelled more than `DRAG_START_PX`, instead of in `onCardPointerDown`. The `onClick` that selects the node moved off the small label button and onto the card div itself, guarded by `justDragged`.

**Why.** `setPointerCapture` is not passive bookkeeping: Chromium retargets the compatibility mouse events to the capturing element, and the `click` event fires on the nearest common ancestor of `mousedown` and `mouseup`. With capture taken on press, both landed on the card div — which carried no click handler — so the child button's handler never ran. Whether it fired depended on capture winning the race against the first `pointermove`, which is exactly why it looked flaky rather than broken. Taking capture only when a drag actually starts leaves an ordinary click completely untouched, and hoisting the handler to the card removes the dependency on which descendant the pointer happened to be over.

**Evidence.** A CDP probe against the real UI: six presses in a row on the same map card all open the node page (`0 of 6 missed`); the properties column starts folded and follows the selection; a ghost label still appears mid-drag; a drag onto a group still sets `parent_id: 5`; a drag does not also select the card; no uncaught renderer errors. `npm run gate:v2` exit 0 (176 tests). Commit `14cd0d9`.

**Cost.** The card is now the click target, so every control inside it has to opt out with `data-map-nodrag` and `stopPropagation` on `pointerdown` — the pattern the expander and the `+N` pill already used.

**Lesson.** Pointer capture changes the event stream, not just the event target. Any element that takes capture on press has silently taken over the click for its whole subtree.

---

## D-027 · English is a second language behind a module-level `t()` and a remount

**Context.** A request to give the program English support. D-015 had recorded the opposite decision, with "no i18n framework" as the accepted cost.

**Decision.**

1. **A module-level `t(key, vars)` rather than a React context.** Strings are also needed outside components — `lib/format.ts`, `lib/tree.ts`, the stores, `setStatus` call sites — where a hook is not available. Reactivity comes from `useSyncExternalStore` in `useLang()`, and `src/renderer/src/App.tsx` renders `<AppShell key={lang} />`, so a language change throws the tree away and every call site re-reads the language.
2. **Messages are positional tuples**, `['中文', 'English']`, not two parallel dictionaries: a key that exists in one language and not the other cannot compile. A key that is missing at runtime returns itself and warns once, so an untranslated string is visible rather than plausible.
3. **One part file per area of the interface** (`parts/app|tree|detail|map|settings.ts`) so two people never edit the same table; `parts/index.ts` is frozen and must not be reordered.
4. **The setting is authoritative, a `localStorage` hint paints the first frame.** `language` lives in the settings table like everything else; `hub.lang` only exists so the first paint after a restart is not the wrong language for a frame.
5. **The main process has its own `src/main/i18n.ts` with no imports at all**, because the tray menu and the error dialogs cannot reach the renderer. `settings:set` calls `setLang`, and `onLangChange` re-renders the tray menu in place.
6. **`tCount(one, many, n)` where English needs a plural twin** (Chinese does not), with `{n}` still interpolated.
7. **A stored filesystem summary is re-rendered, not stored in a language.** The scanner writes `events.message` as `新建 3 · 修改 1`; `formatEventMessage(message, source)` rebuilds it from the same numbers at display time when `source === 'fs'`, and returns a git commit subject untouched. Rewriting the column was not an option — it would strand every existing row in whichever language created it — and neither was a schema change for three counters.
8. **Renderer tests live in `tests/renderer/`.** `tsconfig.node.json` now includes `tests/unit/**` rather than all of `tests/**`: a test that imports renderer code drags files the node project does not list into its program (TS6307) and would be checked without the DOM lib. `tsconfig.web.json` includes `tests/renderer/**` instead, and `test:unit` runs both directories (9 files, 188 tests).

**Why not a library.** `i18next` and friends bring a plugin system, a loader and a fallback chain for a dictionary that is a few hundred short strings in two languages; the whole runtime here is about sixty lines, and a positional tuple is a stronger correctness property than any of them give by default.

**Why English is not the default.** D-015's acceptance cases quote Chinese UI text verbatim, so the shipped default stays Chinese and English is opt-in from the Language row in Settings.

**Evidence.** `npm run gate:v2` exit 0 with 9 test files and 188 tests. `tests/renderer/i18n.spec.ts` asserts two structural properties of the tables — every key has a non-empty string in both halves, and no English half contains a CJK character — plus the count/plural behaviour and `formatEventMessage`'s refusal to touch a commit subject. A CDP probe against the installed build: the shell starts in Chinese with `document.documentElement.lang === 'zh-CN'`; after `hub.settings.set('language','en')` and a reload the placeholder reads `Search projects…`, `document.documentElement.lang === 'en'`, `localStorage['hub.lang'] === 'en'` and the tabs read `["Map","Overview","Timeline"]`; switching back restores `搜索项目…`; no uncaught renderer errors. Seven screenshots of both languages are in `docs/screenshots/` and embedded in `README.md` §10.

**Cost.** Two languages to keep in step, and about 2,900 CJK characters moved behind keys across six part files and two runtimes. Count-bearing English strings need a singular twin and a `tCount` call; translations are written as full sentences per key, so a sentence that only differs by a trailing space needs that space written into the entry (`settings.inDuration` is `' in {duration}'`).

**Lesson.** A language switch is really a remount. Because strings are resolved at call time from module scope, nothing re-renders by itself; keying the shell on the language is one line and removes the entire "some labels did not update" class of bug.

---

## D-028 · The heatmap measures its column; settings get a visible button

**Context.** Two defects reported against the shipped build, both about something being off-screen.

The year heatmap in the tree column was built with fixed 12px cells and a 2px gap: `COLS * STEP = 53 × 14 = 742px`. The column it lives in is 240–480px. Measured on the real database: `gridWidth 742`, `gridLeft 25`, `right 767`, while the flex row around it was `759px` wide inside a ~330px panel — the grid overflowed its container and the panel clipped it. Everything from roughly July onward was invisible, including *all* of the recent activity, so the heatmap looked empty exactly when a user had been busy. The month ticks were also printed at `col * STEP` with no collision rule, so in a 53-column year the week of Dec 28 carried a `12月` tick 14px from January's `1月` and the two drew on top of each other.

The settings dialog had no entry point in the interface at all — only the `Ctrl` + `,` shortcut — so a user looking for it had nowhere to click.

**Decision.**

1. **The cell size is derived from the column, not fixed.** `metricsFor(available)` walks `cell` down from 12 to `MIN_CELL = 4` and returns the first size whose `53 × (cell + gap) - gap` still fits the measured width; `gap` is `round(cell * 0.2)`, floored at 1px. A `ResizeObserver` on the wrapping `div.min-w-0.flex-1` re-derives it on every panel drag. Below 4px the grid stops being readable and the container scrolls instead — anchored to the right, because the newest weeks are the ones worth seeing.
2. **Month ticks thin out by a stride, not by a collision rule.** `stride = ceil(12 × LABEL_MIN_GAP / gridWidth)`, and only months where `getMonth() % stride === 0` get a tick. Skipping labels one at a time produces an irregular pattern (1月 2月 3月 5月 6月 8月…) because months are 4 or 5 columns long; a stride gives 1月 3月 5月 7月 9月 11月.
3. **A tick only belongs to a week that starts inside the shown year.** Otherwise the leading days of the previous December produce a `12月` at the far left which then collides with January — which is what the screenshot showed.
4. **A 设置 button in the toolbar**, carrying the same `Ctrl` + `,` hint in its tooltip.

**Why not just scroll.** Horizontal scrolling was the first instinct, but a year heatmap whose default view is the middle of July answers no question a user has; shrinking to fit keeps the whole year on screen, and the panel is resizable when more detail is wanted.

**Evidence.** Before: `gridWidth 742`, `scrollerClient 759`, `scrollerScroll 759`, labels `12月@25, 1月@39` (14px apart). After: `gridWidth 264`, `scrollerClient 286`, `scrollerScroll 286` (no overflow), labels `1月@30, 3月@70, 5月@115, 7月@160, 9月@205, 11月@245`. A screenshot of the real library shows the whole year with the September and October cells filled in. `npm run gate:v2` exit 0 (9 files, 188 tests); the seven README screenshots were re-captured because the toolbar changed.

**Cost.** Four-pixel cells are a glance, not a reading — the tooltip carries the numbers, and clicking a cell filters the timeline to that day. The metric is recomputed on every resize, so the grid is a `useMemo` keyed on `metrics.step` and each cell is still memoised.

**Lesson.** A fixed pixel size for a component that lives in a user-resizable column is a latent bug with a long fuse: it looks correct on the machine it was written on and clips on someone else's window. Measure the container.

---

## D-029 · The renderer paints the background picture, and frosted glass is a fourth theme

**Context.** Two complaints that turned out to share a cause. The first, "设置类型无法使用", was clarified on asking to mean the background image: `设置 → 外观 → 背景图片` copied the chosen file into `userData/backgrounds`, recorded it in `background.json` and displayed its file name — and nothing in the renderer ever read it back. Every other part of that feature already existed (`hub-media://` protocol handler, `toMediaUrl`, `img-src hub-media:` in the CSP, `anchor.paths.background` sandboxing, `settings.background.current()` returning a `url`), so the last link was the only one missing and picking a picture did nothing at all. The second request was for a 毛玻璃 (frosted glass) theme.

**Decision.**

1. **The renderer paints the picture, with a `localStorage` hint for the first frame.** `lib/wallpaper.ts` mirrors the `hub-media://` URL into `hub.wallpaper` and sets `--wallpaper` plus `data-wallpaper="1"` on `<html>`; `body` carries `background-image: var(--wallpaper, none)`, `background-size: cover`, `background-position: center`, `background-attachment: fixed`. `main.tsx` applies the hint synchronously and then corrects from `settings.background.current()`, exactly as the theme and the language already did. `BackgroundImage.url` had to be added to `env.d.ts` — the main process was returning it, untyped.
2. **Only `hub-media://` may reach a CSS `url()`.** `isSafeWallpaperUrl` rejects anything else, and anything over 4kB; quotes and backslashes are stripped before interpolation.
3. **Glass is a fourth theme value, not a second switch.** `ThemePref` gains `'glass'`. It resolves to light/dark exactly like `system` — so it follows the OS for text and borders — and additionally sets `data-glass="1"` on `<html>`. The tokens live in a separate `:root[data-glass='1']` layer stacked on top of either palette rather than duplicating both.
4. **A wallpaper implies glass.** `:root[data-wallpaper='1']` takes the same translucent tokens and a 16px blur, because an opaque panel in front of a picture is precisely the bug being fixed. `data-glass` alone raises the blur to 22px.
5. **Glass with no picture behind it gets an accent wash.** `:root[data-glass='1']:not([data-wallpaper='1']) body` paints two radial gradients mixed from `--accent`, since `backdrop-filter` over a flat colour blurs nothing at all.
6. **The three columns, the status bar and the modal carry `.glass-panel`**, which is the only place `backdrop-filter` is declared.

**Why not a transparency slider.** A slider is a continuous setting that has to be stored, clamped, migrated and explained, to express what is really a choice between two looks; a fourth radio in the row that already switches between 浅色 and 深色 costs one menu entry.

**Evidence.** Two CDP probes against the built app, both 11/11.

*Wallpaper*, with a picture seeded the way the main process leaves it: `--wallpaper` = `url("hub-media://local/…/backgrounds/bg.png")`, `body` `background-image` the same URL, `background-size cover`, `--panel rgba(255, 255, 255, 0.44)`, the tree `aside` computing `backdrop-filter: blur(16px) saturate(1.25)`; after clearing, `data-wallpaper` and `data-glass` are both gone and `body` paints `none`.

*Glass*, driven through the real dialog — the radio group reads back `浅色 / 深色 / 跟随系统 / 毛玻璃` (plus `中文 / English` in the language group), and clicking 毛玻璃 gives `data-glass="1"`, `data-theme-pref="glass"`, `--panel rgba(255, 255, 255, 0.44)` and `blur(22px) saturate(1.25)`; a restart reproduces all of it from the settings table; switching back to `light` removes the attribute and returns `--panel` to `#f9fafb`.

**Cost.** `backdrop-filter` on four surfaces is real GPU work, though only while a picture or glass is chosen. A `cover` background on `body` means a very large picture is decoded at full size; the store already copies rather than links the file, so the bytes are local.

**Lesson.** The feature was undone by a **second copy of its own validity list**. `stores/ui.ts:hydrate()` repeated the literal set of accepted theme values and rewrote anything it had not heard of back to `system`, so the glass preference applied correctly at boot and was silently reverted a moment later by the store. `isThemePref` exists so that the list lives in exactly one place; a whitelist that answers "is this one of ours?" must be called, never re-spelled.

---

## D-030 · A group row accepts a drop over its whole height, not just its middle 16 pixels

**Context.** Reported: dropping a project onto a group in the sidebar "有时候会无法添加" — at least sometimes the project would not go into the group. Reproduced with a root-level project and a virtual group: a drop released in the **top 15%** of the group's row left the project at the root instead of nesting it, while the same drop in the row's middle worked.

**Root cause.** react-arborist decides "insert as a sibling" versus "drop inside" from row height alone. `node_modules/react-arborist/dist/main/dnd/compute-drop.js`: `measureHover` computes `const pad = height / 4; const inMiddle = y > pad && y < height - pad`, and `computeDrop` nests only `if (node && node.isInternal && hover.inMiddle)`. On a 32px row that makes the middle **16px** mean "inside" while the top and bottom **8px** mean "reorder". The quarter-height padding is hardcoded and no prop exposes it. This is also what made the report sound intermittent: a group is only droppable-into over half its height, so aiming at the label's left edge, or anywhere in the upper or lower quarter, is read as a reorder that looks like nothing happened.

**Decision.**

1. **Intercept and replay, rather than fork the library.** A capture-phase listener on the tree container (`NodeTree.tsx:417`) watches both `dragover` **and** `drop`; when the pointer is inside a **group** row it calls `preventDefault()`/`stopPropagation()` on the original and re-dispatches an equivalent `DragEvent` on the same `[role="treeitem"]` row with `clientY = rect.top + rect.height / 2`. The library's own `computeDrop` then nests, and the existing `handleMove` does the rest.
2. **Both events must be replayed, not just `dragover`.** The HTML5 backend re-hovers on every `dragover` *and* again inside its own `onDrop` hook, so correcting only the drag-over still lets the drop decide from the real pointer y. The original must also keep its default prevented, or the browser never fires `drop` at all.
3. **A thin edge band still belongs to the library.** `GROUP_EDGE_BAND = 0.08` (`NodeTree.tsx:44`) leaves the row's outer 2.5px routed to react-arborist, so deliberately inserting a project immediately above or below a group stays possible.
4. **Groups only.** The interception is scoped to `node.data.kind === 'group'` (`NodeTree.tsx:273`). `isInternal` alone would also catch folders that contain subfolders and the root row, and every non-group row has to keep its top-half/bottom-half behaviour; the codebase already scopes "drop inside" to `kind === 'group'`.
5. **No refusal rule moved.** `isDescendant` (`NodeTree.tsx:312`) and the guard in `handleMove` (`NodeTree.tsx:334-336`, `t('tree.moveIntoSelf')` followed by a reload) are untouched, so a node still cannot be dropped into its own descendant.

**Why not patch `node_modules`.** A patched dependency is invisible to review, reverted by the next install, and would fix only this one tree; replaying the event uses a public surface — DOM events — and keeps every rule where it was.

**Evidence.** `.tmp/drag-probe.mjs` against the built app (Electron on port 9423, isolated `--user-data-dir`), with "before" produced by disabling the edge band in one temporary constant and rebuilding. Fixture: root 1, group 试验组 8, project `beta` 6, folder `delta` 4, folder `gamma` 3.

| dropped on | offset in the 32px row | parent_id before | after |
|---|---|---|---|
| 试验组 (group) | 5px (0.15) | **1** — the reported bug | **8** ✓ |
| 试验组 (group) | 16px (0.50) | 8 | 8 ✓ |
| 试验组 (group) | 27px (0.85) | 8 | 8 ✓ |
| 试验组 (group) | 1px (edge band) | 1 | 1 ✓ |
| `delta` (folder *with* a child) | 5px | 1 | 1 ✓ |
| `gamma` (folder, leaf) | 5px | 1 | 1 ✓ |

9/9 checks pass after, 8/9 before. `npm run typecheck` exit 0; `npm run test:unit` exit 0, 9 files / 188 tests.

**Cost.** One capture-phase listener pair on a container that already exists, and an effect that re-runs when the tree's rows change. The replay allocates one synthetic `DragEvent` per dragging frame over a group row — a few hundred bytes at pointer-move rate, and only while a drag is in flight.

**Lesson.** When a library derives a drop region from a hardcoded fraction of row height, the mismatch is invisible in the UI and only shows up as "sometimes it doesn't work", which is exactly the report that is easiest to dismiss. Here the target is semantically a container, so the whole row should mean "inside" and only a deliberate sliver should mean "order". A caveat worth keeping: in the test fixture the group was the last top-level row, where the library's `atBottom` branch returns `[node, undefined]` and degenerates into an append, so the bottom band already nested there — with another row below the group it would have shown the same bug, which this fix covers anyway.

---

## D-031 · The tree toolbar and the timeline measure their own containers

**Context.** Two more instances of the defect D-028 recorded for the heatmap, reported in the same message: the tree toolbar's rightmost buttons collided with the `全景图` tab ("刷新和全景图这两个按钮会重叠有时候"), and the change timeline was "太小了，基本上每个点都连在一起".

**Root cause — the toolbar.** The toolbar row (`TreePanel.tsx:338-390`) is a `flex` row of two labelled buttons, a `flex-1` spacer and three icon buttons. `.btn` (`styles.css:154-155`) carries `whitespace-nowrap`, so every button has a **min-content width it will never shrink below** and the `flex-1` spacer can only absorb whatever slack is left over. That row needs 277px; `LEFT_WIDTH_MIN = 240` (`stores/ui.ts:24`) lets the column be dragged narrower than that, and the column has no `overflow-hidden`, so the overflow simply paints over the neighbouring tab strip.

**Root cause — the timeline, two of them.** (a) The content width came from `BUCKET_PX[zoom]` alone — 40px per month bucket — so the default *last 30 days* + *month* produced 260px of content inside a 615px viewport, drawing the whole timeline in the left 42% of its own lane area with a fixed 6px dot. (b) Dots in one bucket were fanned by `step = px / (evs.length + 1)`, so four events in a 40px bucket landed **3px** apart and touched. A third defect hid behind those two: the `ResizeObserver` effect had `[]` dependencies and returned early on a null ref, and the scroll container is not rendered at all while `lanes.length === 0` — so the observer was never attached, `scrollWidth` stayed 0, and the lane was permanently clamped to its floor. That is why the first build typechecked, measured 260px and looked exactly like "the fix did not work".

**Decision.**

1. **The toolbar sheds its labels before it overflows.** `TOOLBAR_LABEL_MIN_WIDTH = 300` (`TreePanel.tsx:41-47`) read from `useUi((s) => s.leftWidth)` (`TreePanel.tsx:66`); below it the `添加根目录` and `分组` buttons render icon-only, keeping both their `title` tooltip and an `aria-label`, so the accessible name does not disappear with the text. `LEFT_WIDTH_MIN`/`LEFT_WIDTH_MAX` are unchanged: 300 clears the 277px requirement by 23px and sits below the 320px default, so labels remain at ordinary widths.
2. **The timeline derives one effective bucket width and every consumer reads it.** `effectiveBucketPx(available, bucketCount, zoom)` (`Timeline.tsx:103-106`) returns `Math.max(BUCKET_PX[zoom], available / bucketCount)`; `available` is `scrollWidth - LANE_LABEL_PX` measured by a `ResizeObserver` on `[data-testid="timeline-scroll"]`. All four consumers — the axis (`AxisStrip` now takes `px` as a prop), `slotOf`, dot placement and the cluster `x` — read that single number, so the axis and the dots cannot disagree. `BUCKET_PX[zoom]` survives as a *floor*, which keeps horizontal scrolling for genuinely wide content.
3. **The dot-versus-cluster decision is geometric, not a count.** `DOT_MIN_STEP = DOT + 2` (`Timeline.tsx:76`); a bucket renders individual dots only when `evs.length <= Math.floor(px / DOT_MIN_STEP) - 1` **and** `evs.length <= CLUSTER_THRESHOLD`, and otherwise becomes the numbered `ClusterMarker`. `CLUSTER_THRESHOLD` was deliberately not lowered.
4. **The measurement effect depends on the lanes existing** (`[lanes.length > 0]`) and sits below the `lanes` memo, so the ref it observes is populated by the time it runs; at the earlier position TypeScript rejected it outright (`TS2448: Block-scoped variable 'lanes' used before its declaration`).

**Why not lower `CLUSTER_THRESHOLD`.** A count threshold cannot know how wide the bucket is. The same eight events fit comfortably at 218px per bucket and collide at 40px, so any fixed number is wrong at one end of the zoom range — the test has to be geometric.

**Evidence.** Both probes ran against the built renderer in the real app at 1280×800, dSF 1.

*Toolbar*, with the column dragged to its floor via the resize handle's arrow keys:

| column width | toolbar `scrollWidth` / `clientWidth` | right edge of the last button vs the column edge |
|---|---|---|
| 240px, labels forced on | **277 / 239** — overflows | **276.7** > 240, overlapping the `全景图` tab (253–310) by 23.7px |
| 240px, shipped | **239 / 239** | **231.3** — 8.7px clear, no overlap |
| 304px, shipped | 303 / 303 | 295.3 |
| 320px (default), shipped | 319 / 319 | labels visible |

*Timeline*, default *last 30 days* + *month*:

| metric | before | after |
|---|---|---|
| `[data-testid="timeline-scroll"]` `clientWidth` | 615 | 615 |
| inner content width | **260** (42% of the lane) | **615** (100%) |
| per-bucket width `px` | **40** | **218** |
| dots / clusters | 13 dots overlapping | 12 dots, 0 clusters |
| `minGap` between consecutive dots | **3** (dots touching) | **31.07** |
| *day* × *last 90 days* | — | inner 2940px vs 615px viewport → scrolls, `minGap` 240px |

Burst case: seeding 60 commits onto a single day renders **0 dots and one cluster** reading `60 次改动，点击放大查看`, instead of an unreadable smear.

**Cost.** One `ResizeObserver` per timeline, and a re-derived width on every resize — cheap next to the layout it replaces. The toolbar branch adds a boolean to a component that already subscribes to `leftWidth` for its own width.

**Lesson.** D-028's lesson again, from two directions: a component inside a user-resizable column must measure that column rather than assume it, and "fits" is a property of the container, not of the component. The second lesson is about instrumenting the fix: a `ResizeObserver` wired to a ref that is still null fails **silently**, so the component keeps its fallback value forever — which is indistinguishable from the fix not working. When a measured value does not move after a change, check that the effect ran at all before doubting the arithmetic. Measure the container.

---

## D-032 · The picture fills the window, its average colour is the palette, and frosted glass becomes a switch

**Context.** D-029 shipped the picture and the glass, and the user rejected the result on sight: "图片和毛玻璃的图层是夹杂着的", and about the theme row, "浅色深色跟随系统与毛玻璃基本一样，这不都是毛玻璃吗？". They then specified the model in four answers: a panel may be a semi-transparent colour; the picture's average colour *is* the theme colour, each sub-interface being a translucent sheet of it; with a picture, light/dark follows that average automatically; with nothing painted, turning on frosted glass must behave like real glass you can see through.

**Root cause — the previous model was two models at once.** (a) `毛玻璃` was the fourth value of `ThemePref` (`lib/theme.ts:10`), so it was mutually exclusive with light/dark — an *effect over* a theme had been written as a *kind of* theme, which is exactly the question the user asked. (b) `:root[data-wallpaper='1']` swapped in the same translucent-white surface tokens as glass did, so choosing a picture silently forced the glass model on top of it. (c) Each sub-interface then painted its own translucent grey over the photograph while `.glass-panel` blurred the photograph itself by 16–22px, and because the columns stacked different numbers of those layers the result was the patchwork of soft blobs in the screenshot. (d) The picture was only `body`'s background while the shell root painted `--bg` at 60% white over it, so the picture was never the base layer at all.

**Decision.**

1. **The theme is light/dark/system again; glass is a switch.** `ThemePref` is `'light' | 'dark' | 'system'`; glass is a persisted boolean setting (`SETTING_KEYS.glass`, default `'false'`) with `applyGlass(enabled)`, `readStoredGlass()`, a `glass` slice in `stores/ui.ts` and `setGlass`, and its own row in the dialog. It layers over any theme.
2. **The picture is the base layer.** The shell root paints `--shell-bg` (`var(--bg)` normally, `transparent` once a picture or glass is on) and `body` keeps `background-image: var(--wallpaper)` with `cover` / `fixed`; the three columns and the status bar paint `--surface`, which is `transparent` by default, so light and dark look exactly as they did before.
3. **The tint is measured in the main process.** `tintOf()` (`src/main/ipc/main.ts`) decodes with `nativeImage.createFromPath(abs).resize({ width: 8, height: 8, quality: 'good' }).toBitmap()`, skips pixels with alpha < 8, and averages. Both `settings.background.current` and `.choose` return it as `tint`, and `BackgroundImage` in `env.d.ts` declares it.
4. **`lib/wallpaper.ts` owns the tint.** `applyWallpaper(url, tint)` writes `--tint` inline plus `data-wallpaper`/`data-tint`, mirrors `hub.wallpaper` and `hub.wallpaper.tint` for the first paint, and exposes `tintIsDark()` (below 0.5 brightness).
5. **With a picture, the picture decides light and dark.** Appearance is applied picture → glass → theme, and `resolveTheme` ignores the preference entirely while a tint is present: it reads dark/light off the tint's brightness and stamps `data-theme-auto='1'`, which the settings dialog surfaces as a hint and the `matchMedia` listener respects — the system is no longer followed while a picture is deciding.
6. **A picture is never blurred.** `backdrop-filter` is scoped to `:root[data-glass='1']:not([data-wallpaper='1']) .glass-panel`, and the sheets become `color-mix(in srgb, var(--tint) N%, transparent)`. With a picture the panels are *tinted* glass and the photograph stays crisp; frosted glass is what happens when there is no picture to blur. Dialogs take 68% of the tint instead of 44% so a modal stays readable over a photograph.
7. **Glass with no picture is given something to be seen through.** Under `rgba(255, 255, 255, 0.5)` sheets at `blur(30px) saturate(1.3)`, `body` paints a wash of two accent-coloured blobs, which is what makes it read as real frosted glass rather than a grey rectangle.

**Why not keep `毛玻璃` as a fourth theme.** A theme is a mutually exclusive choice; glass is an effect that composes with either of them. Encoding it as an enum value made "light *and* glass" unrepresentable, which is precisely what the user noticed. **Why not derive the surfaces per-pixel from the image.** The renderer never sees the file's pixels — it gets a `hub-media://` URL — and one measured colour keeps the whole thing to `color-mix()` in CSS. **Why not blur a picture slightly.** The user ruled it out explicitly ("而不是和毛玻璃涂层相重叠"); with a picture the panels are the interface, and the photograph is the content.

**Evidence.** `.tmp/appearance-probe.mjs` seeds an isolated `--user-data-dir` with a 192px ramp whose average is exactly `#abc2d0`, launches the built app, and reads the tokens out of the live DOM: **15/15**, including `tint: "#aac1cf"` (the channel order is asserted — `toBitmap()` is BGRA, and a swap is invisible to the eye but not to this check), `data-wallpaper/tint/themeAuto` all `1`, the shell transparent, the columns `color(srgb 0.666667 0.756863 0.811765 / 0.58)` — the tint at 58% — `backdrop-filter: none` with glass off, `glass: '1'` persisted after the dialog's checkbox is clicked, `blur(30px) saturate(1.3)` plus the wash after the picture is cleared, and zero renderer errors. A second run with a real 826KB photograph (Windows `ThemeA\img20.jpg`) turned the interface **dark** on its own — the tint check and the brightness check "fail" in that run because they are written against the ramp's known average, which is the point of the ramp. Screenshots of both runs are in `.tmp/appearance-shots/`.

**Cost.** One `nativeImage` decode per settings read (the resize makes the averaging trivial), a fourth persisted setting, and ~90 lines of token plumbing in `styles.css` that replaced ~45 lines of the previous attempt.

**Lesson.** An appearance feature is a small model, not a pile of CSS. The first version failed because it held two models of the same thing — the picture as an *underlay* and the glass as a *surface* — and let both apply at once, so every element painted a different number of translucent layers over the same photograph. The user's question ("这不都是毛玻璃吗") was a model check: anything that composes with a choice must not itself be a value of that choice, and a picture is a base layer, not another translucent surface. The second lesson is about the averaging: `toBitmap()` returns BGRA, so a red/blue swap produces a plausible-looking colour that passes every eyeball test and fails only against a picture with a known average.

## D-033 · Real frosted glass costs the native frame: the window must be transparent *and* frameless

**Context.** D-032 item 7 gave the no-picture glass "something to be seen through" — a wash of accent-coloured blobs painted on `body` behind translucent sheets. The user looked at it and said: "你这毛玻璃也不透明啊。？？？？？", and after the first repair attempt restated the goal: "我想实现的效果是在主界面的时候，它可以。透过应用半透明的看见后面的壁纸等其他应用。" They were right both times, for two different reasons. The first is structural: a page-level `backdrop-filter` only ever blurs what the page itself painted, so nothing outside the window can appear inside it. The second is Windows-specific: `backgroundMaterial: 'acrylic'` *does* blur the windows behind the app, but DWM's material pass does not sample the desktop **wallpaper**, so with the wallpaper as the backdrop the window renders as one nearly uniform pastel — measured with acrylic, mica and tabbed in turn (`.tmp/glass-shot/mat-acrylic.png`, `mat-mica.png`, `mat-tabbed.png`), all three indistinguishable, while the same window with a browser behind it blurs that browser correctly (`.tmp/glass-shot/glass2.png`).

**Decision.**

1. **The window is frameless and transparent.** `createWindow()` in `src/main/index.ts` builds it with `transparent: true`, `frame: false` and `backgroundColor: '#00000000'`. On Windows `transparent: true` is ignored while the window keeps a native frame: with `frame: true` and every page layer stripped to `rgba(0, 0, 0, 0)` the window was still opaque white (`.tmp/glass-shot/transparent-bare2.png`), and the identical page with `frame: false` shows the wallpaper (`.tmp/glass-shot/transparent-frameless.png`).
2. **The acrylic material rides on top of that transparency.** `applyWindowMaterial(win, acrylic)` still calls `win.setBackgroundMaterial('acrylic' | 'none')`, guarded by `materialSupported()` — Windows only, and `Number(release().split('.')[2]) >= MATERIAL_MIN_BUILD` with `MATERIAL_MIN_BUILD = 22621`. With a transparent window the material pass blurs the desktop itself: `.tmp/glass-shot/transparent-acrylic.png` shows the wallpaper soft and diffused behind the sheets, where the same frameless window without the material is crisp.
3. **The renderer still owns the switch.** `appearance:setMaterial` carries `{ glass, picture }`; `syncWindowMaterial(patch)` in `lib/wallpaper.ts` remembers the last state and pushes it, and is called from both `applyGlass` and `applyWallpaper`. A picture wins: with a picture the page paints its own backdrop, so the material becomes `'none'` and the picture stays crisp.
4. **The page is transparent only while glass is on and no picture is set.** The shell root paints `--shell-bg`, which stays `var(--bg)` — opaque — unless `:root[data-glass='1']:not([data-wallpaper='1'])`, so with the switch off the app looks exactly as it did before. The sheets stay as D-032 left them (`rgba(255, 255, 255, 0.32)` / `0.22` / `0.58`, dark twins mirroring), and the accent wash stays as the fallback look on a machine that cannot give acrylic.
5. **The app draws its own title bar.** Removing the frame removed the buttons, so `window:minimize`, `window:toggleMaximize`, `window:close` and `window:state` are new channels (`src/shared/channels.ts`, `src/preload/index.ts`, `HubApi` in both `src/shared/types.ts` and `src/renderer/src/env.d.ts`), `WindowControls.tsx` renders the three buttons at the right end of the tab strip, and the tab strip itself is the window's drag handle (`app-drag` in `styles.css`, with `app-no-drag` on every control inside it — without that a click on 全景图 would start a window drag). `window:close` calls `win.close()`, so §10.2 hide-to-tray is unchanged.
6. **Maximise is tracked by the main process.** On a layered window the compositor fills the screen without regard for the work area and `BrowserWindow.isMaximized()` does not reliably follow, so `toggleMaximizeWindow()` in `src/main/index.ts` keeps `windowMaximized` and `windowRestoreBounds`, filled `screen.getDisplayMatching(...).workArea`, and restores the remembered bounds; the `maximize`/`unmaximize` events keep the same flag and the `window:maximized` broadcast in step for the double-click-on-the-drag-strip path.
7. **The backdrop is put back whenever the window becomes visible.** Windows drops a window's material while the window is off screen, and asking again on the window event is too early — the compositor is not ready — so `reassertWindowMaterial()` in `src/main/ipc/main.ts` moves the state to `'none'` and back (a no-op change is ignored), and it is called from `show`, `restore`, `maximize`, `unmaximize` and both branches of `toggleMaximizeWindow()`. The reliable moment is the page's own, so the renderer repeats the request from a `visibilitychange` listener (`src/renderer/src/main.tsx`) over the new `appearance:reassert` channel.

**Why not keep the native frame.** It was tried first, and is what the previous revision of this entry shipped. The frame forces an opaque client area, so the wallpaper could never show through, and the user's actual request — the wallpaper and other applications visible through the main interface — was unsatisfiable that way. **Why not the Windows materials alone.** Acrylic, mica and tabbed all fail on the wallpaper (see Context); they are a tinted blur of the *window stack*, not a window. **Why not `titleBarStyle: 'hidden'` plus `titleBarOverlay`.** Not evaluated: the overlay is a system-drawn caption, and the question is exactly whether a system caption is compatible with `transparent: true`, which the frame test already answered in the negative for `frame: true`. The self-drawn chrome is a few dozen lines and is verified working.

**Evidence.** `.tmp/glass-shot/`: `transparent-bare2.png` (native frame kept, every page layer transparent — still opaque white), `transparent-frameless.png` (the same page with `frame: false` — the wallpaper shows through every column, crisp), `transparent-acrylic.png` (the same window with the material on — the wallpaper soft and diffused), `frameless-final.png` (the shipped look: no title bar, wallpaper visible and blurred behind the sheets). `.tmp/window-probe.mjs`, fresh profile with glass on: `dataset {themePref:'system', glass:'1'}`, three `[data-window-controls] button` elements with the group's right edge 8px inside the window, `shell` and `body` both `rgba(0, 0, 0, 0)`, and the round trip `window.state()` `false` → click → `true` with the bounds filling the work area → click → `false` with the bounds back at `(212, 122, 1282, 822)`.

**Cost.** The app pays for one blur the desktop compositor maintains behind it; the frame is gone, so there is no system shadow and no system rounded corners, the drag strip is smaller than a real title bar, resizing and snapping now go through Chromium's borderless hit-testing rather than a native border, and the main process has to keep the maximise state itself. Everything here is Windows-only: on Windows 10 `materialSupported()` is false, the window is still frameless and transparent, and the switch falls back to the accent wash behind the sheets.

**Lesson.** "透过玻璃看到后面的东西" is not a CSS problem — it is a window-compositor capability, and a page-level `backdrop-filter` can only blur what the page painted. The second lesson is that the OS material is not a substitute for transparency: acrylic blurs the window stack and nothing else, so a desktop that is "just the wallpaper" comes out as a flat tint, and the only way to see the wallpaper is `transparent: true` — which on Windows silently requires `frame: false`, a fact worth testing rather than assuming, because the failing combination looks like a CSS bug. The third is about the OS test: this machine reports `ProductName = "Windows 10 Pro"` while being build 26300 (Windows 11 26H2), so the material must be gated on the build number and never on the product name. The fourth is about evidence: `Page.captureScreenshot` can never show a window material (`PrintWindow` returns black for Electron too), and neither `Page.bringToFront` nor `hub.app.showWindow()` raises the window over a maximized browser — the only capture that proves any of it is a real screen grab (`Graphics.CopyFromScreen`) taken after pushing the foreground window to the bottom of the z-order with `SetWindowPos(..., HWND_BOTTOM, ...)`. The fifth is about a reported bug that will not reproduce: the user's machine lost the material after minimise → maximise and this one cannot be made to, so the honest response was to re-apply the state at the one moment the difference could matter — when the page is really on screen again — rather than to declare the code innocent. Measuring that took a controlled backdrop (a `file:///…/checker.html` checkerboard in an Edge `--app` window behind the app, read through 8x8 mean-|Δluminance| maps): with the material on and the checkerboard hidden by it, an interior difference of `0.0` means the material is there, which is how the "no measurable loss" conclusion was reached — and it is also why the verdict is "unreproduced, mitigated" and not "fixed".

## D-034 · Two wrong defaults in the detail panel: a null metric is not "still computing", and a letter is not an icon

**Context.** `User said (m10809)`: "当点击一个组，并选择查看它的属性，它的大小和文件数会一直显示在计算中。然后就是在属性中这个截图所显示的部分，它有部分字体显示不全。" Both were defaults, not failures. `nodes:stats` answers `diskSizeBytes: null, fileCount: null` for a node with no directory of its own (`src/main/ipc/main.ts`), and `DetailPanel.tsx` and `StatsDialog.tsx` both rendered a null as 「计算中…」 — a state that never ends, because for a group there is nothing to compute. The overview tab had it right: it handed the null to `formatBytes`, which returns EMPTY 「—」 (`src/renderer/src/lib/format.ts:38-48`), so two of the three surfaces disagreed with the third. The clipping had the same shape: the 图标 row drew `iconToken()` — the first character of the icon-type label, 自 for 自动 — inside a 24px chip, and CJK ink at `text-[11px]` with the default line box sits low enough to read as cut off.

**Decision.**

1. **`diskMetric(path, value, format)` in `src/renderer/src/lib/tree.ts` is the single answer**: `path === null` → 「—」 (a virtual node has nothing to measure), `value === null` → 「计算中…」 (a real directory still being measured), otherwise the formatted number. `DetailPanel.tsx` and `StatsDialog.tsx` both call it for 大小 and 文件数.
2. **The 图标 row draws `NodeIcon`** (`src/renderer/src/components/DetailPanel.tsx`, `size={14}`) — the same component the tree uses, including the auto glyph for 自动 — and `iconToken()` is deleted.

**Why not keep the placeholder letter.** A one-character stand-in is a second icon vocabulary that has to be maintained and re-checked at every size and font; the app already renders the real icon everywhere else.

**Evidence.** `.tmp/fixes-probe.mjs` (phases `up | seed | select <nodeId> | panel | eval | shot`), against a fresh `npx electron-vite build`: a group's panel reads `磁盘 / 大小 / — / 文件数 / — / 创建时间 … / 修改时间 …` and the project's reads `大小 / 51 B / 文件数 / 4`, so the two nulls are still told apart; the 图标 section's chip contains `["span","span","span","svg","path","path"]`; `.tmp/fixes-probe/shot-icon-project.png` shows the cube glyph where the clipped 自 used to be.

**Lesson.** "Pending" and "not applicable" are different values, and one `null` was carrying both: whichever helper decides which of the two it has must be the only one deciding, or three surfaces will disagree — which is exactly what the user saw, two of them waiting forever next to a third that was already printing 「—」. The second lesson is older: a text stand-in for a graphical thing clips the moment the box or the font changes, and the real thing was already in the codebase.




