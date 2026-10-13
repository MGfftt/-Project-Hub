# Project Hub · 项目整理与改动可视化工具

> **一句话定义**：一个低资源占用、常驻系统托盘的桌面应用，把散落在磁盘各处的项目文件夹聚合进一棵可以自由重组的树，支持标注、程序内命名与自定义图标，用时间线可视化改动历史，单击节点即可打开它的文件夹。
>
> **One-line definition**: a low-footprint, system-tray-resident desktop app that aggregates scattered project folders into a freely re-composable tree, supports annotation, in-app naming and custom icons, visualises change history on a timeline, and opens a node's folder with a single click.

[中文](#中文文档) · [English](#english-documentation)

---

## 中文文档

### 1. 这个程序解决什么问题

代码和文档散落在 `D:\work`、`~/projects`、`E:\备份\2023` 这样的目录里。它们之间的归属关系（哪些属于同一个产品、哪些在做同一件事）只存在于你的记忆里，文件系统本身表达不了。于是：

- 想不起来某个项目放在哪，只能靠 Everything 似的全文搜索；
- 想不起来某个项目上次改了什么，只能挨个 `cd` 进去 `git log`；
- 想把三个目录标记为「同一个产品」，只能改名或者建软链接。

Project Hub 把**归属关系**和**元数据**从文件系统里独立出来：磁盘目录一个字节都不动，而树上的一切——分组、别名、图标、标签、标注——都保存在应用自己的数据库里。

### 2. 六项硬性需求

这六条是不可协商的验收条件（对应项目书 R1–R6）。任何一条不满足，整个阶段即判定失败。

| 编号 | 需求 | 实现方式 | 验证 |
| --- | --- | --- | --- |
| **R1** | 图形化展示，清晰可读 | Tailwind + CSS 变量主题，正文对比度 ≥ 4.5:1，次要信息 ≥ 3:1 且 ≥ 12px；行高 32px（紧凑 26px）；深浅色主题 | `src/renderer/src/styles.css`、`src/renderer/src/components/*` |
| **R2** | 单击树节点打开文件夹 | 单击 = 选中 + `shell.openFolder`；虚拟分组与路径缺失的节点只选中不打开；`clickToOpen` 设置可关闭单击打开 | `src/renderer/src/components/NodeTree.tsx`、`src/main/ipc/main.ts` |
| **R3** | 右键节点 → 查看改动 / 属性 / 标注 | 冻结顺序的右键菜单；查看改动跳到时间线并锁定该节点子树；属性弹窗分「基本/磁盘/Git/改动/标注」 | `src/renderer/src/components/ContextMenu.tsx`、`dialogs/StatsDialog.tsx` |
| **R4** | 文件夹程序内改名 + 改图标 | 只写 `nodes.display_name` / `icon_type` / `icon_value`，**从不重命名磁盘目录**；别名上限 64 字符；图标支持自动/内置/Emoji/导入图片四条来源 | `src/main/ipc/main.ts`、`src/renderer/src/components/dialogs/IconPicker.tsx` |
| **R5** | 低资源占用 | 空闲时无轮询；文件监视走 chokidar 事件；扫描/体积计算/git 读取全部在 `worker_threads` 里；`externalizeDepsPlugin` 保证原生模块不进打包产物 | 见下方「性能预算实测」 |
| **R6** | 后台常驻，便于增量维护 | 托盘常驻，关闭窗口只隐藏；调度器用递归 `setTimeout` 而非 `setInterval`；窗口隐藏时任务间隔自动拉长（≥3×）；电池供电时暂停 `acOnly` 任务；系统繁忙时延后 | `src/main/background/scheduler.ts`、`src/main/background/tasks.ts` |

### 3. 数据隔离保证（最重要的一条）

> **本程序从不向被索引的项目目录写入任何文件。**

这不是一句口号，而是由结构保证的：

1. **所有写入都经过同一个收口函数**。`src/main/utils/fsops.ts` 是唯一的写文件入口，它只接受应用自己数据目录下的路径。
2. **数据库只在 `userData` 里**。`app.getPath('userData')/data.db`，绝不落在项目里。
3. **渲染进程无法构造文件路径**。渲染进程只能提交整数 `nodeId`；路径由主进程用 `src/main/ipc/anchor.ts` 解析。`anchor.paths.icon()` / `background()` 会拒绝任何 `..` 或不含在 store 目录内的文件名。
4. **有对抗性测试守着**。`tests/unit/isolation.spec.ts` 在扫描、写标注、写图标、生成缩略图、读 git、写日志前后，对整个被索引目录做逐字节哈希比对，任何多出来的字节都会让测试失败。

细节见 [`docs/DATA-ISOLATION.md`](docs/DATA-ISOLATION.md)。

### 4. 快速开始

```bash
# 需要 Node >= 20 与 git（读取历史用）
npm install

# 开发模式（Vite HMR + Electron）
npm run dev

# 生产构建：先双端类型检查，再打三个 bundle
npm run build

# 单元测试
npm run test:unit

# 完整门禁：类型检查 + 测试 + 构建
npm run gate:v2
```

**启动入口是 `src/main/index.ts`**（主进程），构建后对应 `out/main/index.cjs`，即 `package.json` 的 `main` 字段 —— Electron 从这里拉起整个应用。渲染进程入口是 `src/renderer/index.html`，预加载脚本是 `src/preload/index.ts`。

除 `npm run dev` 外，也可以直接运行已构建的产物：

```bash
npm run build
npm start                                  # 等价于 electron-vite preview
# 或直接用 Electron 二进制打开本目录
./node_modules/electron/dist/electron.exe .
```

> **`npm install` 会自动重建原生依赖。** `better-sqlite3` 是按 ABI 编译的：Electron 33 内嵌 Node 20.18.3（ABI 130），而系统 `node` 可能是 ABI 137。装错 ABI 的二进制会让应用在启动时直接崩溃，且 Electron 内部**没有** `node:sqlite` 回退可用。`postinstall` 会调用 `scripts/rebuild-native.mjs` 拉取对应 Electron 的预编译二进制（无需编译器）。若你用了 `npm install --ignore-scripts`，请补跑一次：
>
> ```bash
> npm run rebuild:native
> ```

打包安装包：

```bash
npm run build:win     # Windows → release/Project Hub-2.0.0-win-x64.exe
npm run build:mac     # macOS
npm run build:linux   # Linux
```

安装包会创建桌面与开始菜单快捷方式，也可以直接使用免安装目录 `release/win-unpacked/`（双击里面的 `Project Hub.exe` 即可运行）。

应用图标不是二进制素材，而是由代码画出来的：`scripts/make-icon.mjs` 复用托盘那枚三节点标记，4 倍超采样后手写 PNG 与 ICO 容器，产物落在 `build/icon.ico`。改图标只需改脚本再跑一次：

```bash
npm run make:icon
```

> **在无法创建符号链接的 Windows 上打包。** 若系统未开启「开发者模式」且当前 shell 没有管理员权限，electron-builder 的签名阶段无法解包 `winCodeSign`（7-Zip 需要在其中还原两个 macOS dylib 符号链接，会报 `Cannot create symbolic link : 客户端没有所需的特权`）。该阶段同时负责写入 exe 的图标与版本信息，所以失败会同时丢掉安装包**和** exe 的品牌信息。此时改用：
>
> ```bash
> npm run build:win:nosign
> ```
>
> 它会依次：跳过签名阶段打包免安装目录 → 用 rcedit 补上图标与版本信息 → 用已盖好章的目录生成 NSIS 安装包。三条命令都封装在 `scripts/pack-win.mjs` 里，产物同样是 `release/Project Hub-2.0.0-win-x64.exe`。
>
> 该脚本还会把 electron-builder 的下载缓存从 `%LOCALAPPDATA%` 改到项目的 `.cache/`，并把 `7zip-bin` 自带的 `7za.exe` 加进 `PATH` —— 这两件事在受限机器上都会致命。若网络需要代理，先设置标准代理变量（app-builder 是 Go 程序，会读 `HTTPS_PROXY`）：
>
> ```bash
> HTTPS_PROXY=http://127.0.0.1:7897 npm run build:win:nosign
> ```
>
> 仓库自带的 `electron-builder.yml` 不含任何 workaround，换一台机器直接 `npm run build:win` 即可获得完整效果。

### 5. 性能预算实测

`npm run bench:scan` 会在真实扫描器与真实数据库上跑一遍项目书 §12 的预算项，并把结果打印成 `BENCH_RESULT`。

| 编号 | 指标 | 预算 | 实测 | 结论 |
| --- | --- | --- | --- | --- |
| NFR-05 | 扫描 10,000 个文件 | < 3,000 ms | **76 ms**（10,200 文件 / 200 个项目 / 211 目录） | ✅ 约 40× 余量 |
| NFR-09 | 1,000 个项目 + 100,000 条改动 | < 50 MB | **19.37 MB** | ✅ 约 2.6× 余量 |
| NFR-03 | 空闲 CPU | < 0.3% | **0.018%**（32 核，8 秒采样） | ✅ 约 17× 余量 |
| NFR-02 | 常驻内存 | < 220 MB | **393.7 MB**（4 个进程，窗口打开） | ❌ **未达标，约 1.8×** |

渲染进程产物在把 `lucide-react` 的命名空间导入换成静态图标表之后，从 **1,618.94 kB 降到 713.08 kB**（见 `DECISIONS.md` D-011），直接服务于 NFR-01 冷启动预算。

> **关于 NFR-02。** 上表内存数字来自打包后的 `Project Hub.exe`（`release/win-unpacked/`），在本机以 `--no-sandbox` 启动、窗口打开、空闲 30 秒后采样。它**超出预算约 1.8 倍**，需要如实记录：Electron 的 Chromium 自身就占掉大头，四个进程里主进程约 152 MB、渲染进程约 107 MB、GPU/工具进程合计约 130 MB。本机没有可用的 GPU、且必须关闭 Chromium 沙箱，这两个因素都会让内存高于正常桌面环境，因此这个数字**偏悲观**，但也**没有证据表明正常环境能降到 220 MB 以内**。若要真正达标，需要走「窗口隐藏后回收渲染进程」的路线（窗口关闭即 `webContents` 释放、只在需要时重建），这是产品决策而非小改动 —— 记在 `DECISIONS.md` D-019，未在本版实施。

其余预算项（NFR-04 空闲磁盘 I/O 近零）需要长时间挂机观察，见「手动验收」。

### 6. 目录结构

```
project-hub/
├─ src/
│  ├─ main/                    主进程
│  │  ├─ index.ts              启动：单实例锁、userData、数据库、IPC、托盘、窗口、调度器
│  │  ├─ db/                   schema.sql（DDL 单一真源）/ schema.ts / sqlite.ts（驱动收口）/ repo.ts（全部 SQL）
│  │  ├─ scanner/              目录遍历（walk.ts）、项目标记识别（markers.ts）、入库（index.ts）
│  │  ├─ services/             缩略图、git 只读封装、Markdown 导出
│  │  ├─ background/           调度器（递归 setTimeout）与具体任务
│  │  ├─ worker/               worker_threads 池 + scan/git/size 三个 worker 入口
│  │  ├─ ipc/                  anchor.ts（路径收口）、main.ts（全部 IPC handler）
│  │  ├─ tray/                 托盘图标（SVG → nativeImage）
│  │  └─ utils/                路径、哈希、日志、文件操作、电源
│  ├─ preload/                 contextBridge，暴露 window.hub
│  ├─ renderer/                React 界面
│  │  └─ src/
│  │     ├─ components/        树、时间线、热力图、搜索、详细信息、对话框
│  │     ├─ stores/            zustand：ui / tree / events / settings
│  │     └─ lib/               格式化、配色、图标推断
│  └─ shared/                  主/渲染共享的纯数据与纯函数（types、channels、icons、match）
├─ tests/unit/                 171 个单元测试，含对抗性数据隔离测试
├─ scripts/                    基准、fixture 生成、schema 同步、图标生成、编码修复、打包兜底
├─ build/                      icon.ico / icon.png（由 scripts/make-icon.mjs 生成，非二进制素材）
├─ docs/                       数据隔离说明、渲染进程接口契约
├─ electron-builder.yml        打包配置
└─ .builder.nosign.yml         无符号链接权限环境的打包兜底（见第 4 节）
```

### 7. 手动验收（需要真实桌面会话）

以下项目无法在无头环境自动化，需要人工确认：

1. **R1 / 视觉**：深浅色主题切换；正文对比度；选中态（`#3b82f61a` 背景 + 2px 蓝色左边条）；`archived` 状态图标去饱和。
2. **R2 / 单击打开**：单击一个真实项目节点，文件管理器应打开该目录；路径缺失的节点应在状态栏显示「路径不存在」。
3. **R3 / 右键菜单**：九项顺序与可用性；「查看改动」应切到时间线并带上面包屑与「清除过滤」。
4. **R6 / 托盘**：关闭窗口应隐藏而非退出；托盘菜单可暂停/继续后台维护、立即同步 Git；退出需从托盘菜单走。
5. **NFR-04**：挂机观察磁盘 I/O 是否接近零（本版用递归 `setTimeout` 而非轮询，理论上应为零）。内存与 CPU 已实测，见第 5 节。

### 8. 已知偏差

所有与项目书不同但有意为之的决定，都记录在 [`DECISIONS.md`](DECISIONS.md)，包括驱动回退策略、任务名与间隔的调整、内置图标集与 §8.4 冻结清单的对应关系。

---

## English Documentation

### 1. What problem this solves

Code and documents live in scattered places: `D:\work`, `~/projects`, `E:\backup\2023`. The relationships between them — which ones belong to the same product, which ones do the same job — exist only in your memory; the filesystem cannot express them. So you end up full-text searching for a project you forgot the location of, `cd`-ing into repositories one by one to recall what changed, and renaming directories or creating symlinks just to mark three folders as "the same product".

Project Hub pulls **ownership** and **metadata** out of the filesystem. Not a single byte inside your project folders changes; the groups, aliases, icons, tags and annotations live in the app's own database.

### 2. The six hard requirements

These are non-negotiable acceptance conditions (R1–R6 in the project book). Failing any one fails the whole phase.

| ID | Requirement | How it is met | Where |
| --- | --- | --- | --- |
| **R1** | Graphical display, clearly legible | Tailwind + CSS-variable theming, body contrast ≥ 4.5:1, secondary info ≥ 3:1 and ≥ 12px, 32px rows (26px compact), light and dark themes | `src/renderer/src/styles.css`, `src/renderer/src/components/*` |
| **R2** | Single click on a tree node opens its folder | Click = select + `shell.openFolder`; virtual groups and missing paths select only; the `clickToOpen` setting can turn open-on-click off | `src/renderer/src/components/NodeTree.tsx`, `src/main/ipc/main.ts` |
| **R3** | Right-click a node → view changes / properties / annotation | A context menu with a frozen item order; "view changes" switches to the timeline and locks the filter to that node's subtree; properties opens a dialog grouped 基本/磁盘/Git/改动/标注 | `src/renderer/src/components/ContextMenu.tsx`, `dialogs/StatsDialog.tsx` |
| **R4** | In-app rename + icon change for folders | Only `nodes.display_name` / `icon_type` / `icon_value` are written — the disk directory is **never** renamed. Aliases cap at 64 characters; icons come from auto, built-in, emoji or an imported image | `src/main/ipc/main.ts`, `src/renderer/src/components/dialogs/IconPicker.tsx` |
| **R5** | Low resource use | No polling when idle; watching is event-driven via chokidar; scanning, sizing and git reads all run in `worker_threads`; `externalizeDepsPlugin` keeps native modules out of the bundle | see "Measured performance budget" |
| **R6** | Background-resident, easy incremental maintenance | Tray-resident; closing the window hides it; the scheduler uses a recursive `setTimeout` rather than `setInterval`; intervals stretch by ≥ 3× while the window is hidden; `acOnly` tasks pause on battery; ticks defer when the machine is busy | `src/main/background/scheduler.ts`, `src/main/background/tasks.ts` |

### 3. The data-isolation guarantee

> **This app never writes any file into an indexed project folder.**

That is not a slogan; it is structural:

1. **Every write goes through one funnel.** `src/main/utils/fsops.ts` is the only file-writing entry point, and it only accepts paths under the app's own data directory.
2. **The database lives only in `userData`**: `app.getPath('userData')/data.db`, never inside a project.
3. **The renderer cannot construct a filesystem path.** It submits integer `nodeId`s; the main process resolves paths through `src/main/ipc/anchor.ts`. `anchor.paths.icon()` / `background()` reject any filename containing `..` or escaping the store directory.
4. **Adversarial tests guard it.** `tests/unit/isolation.spec.ts` hashes the entire indexed tree byte-by-byte before and after scanning, annotating, setting icons, generating thumbnails, reading git and writing logs. Any extra byte fails the suite.

Details in [`docs/DATA-ISOLATION.md`](docs/DATA-ISOLATION.md).

### 4. Getting started

```bash
# Requires Node >= 20 and git (for history)
npm install

# Dev mode (Vite HMR + Electron)
npm run dev

# Production build: both typechecks, then the three bundles
npm run build

# Unit tests
npm run test:unit

# Full gate: typecheck + tests + build
npm run gate:v2
```

**The startup entry point is `src/main/index.ts`** (the main process). Built, it becomes `out/main/index.cjs` — the `main` field in `package.json`, which is what Electron boots. The renderer entry is `src/renderer/index.html`; the preload script is `src/preload/index.ts`.

Beyond `npm run dev`, you can run the built output directly:

```bash
npm run build
npm start                                  # same as electron-vite preview
# or hand the directory to the Electron binary
./node_modules/electron/dist/electron.exe .
```

> **`npm install` rebuilds the native dependency for you.** `better-sqlite3` is ABI-specific: Electron 33 embeds Node 20.18.3 (ABI 130) while your system `node` may be ABI 137. An addon built for the wrong ABI makes the app die on startup, and there is **no** `node:sqlite` fallback available inside Electron. `postinstall` runs `scripts/rebuild-native.mjs`, which fetches the prebuilt binary for your Electron version — no compiler required. If you installed with `npm install --ignore-scripts`, run it yourself:
>
> ```bash
> npm run rebuild:native
> ```

Packaging:

```bash
npm run build:win     # Windows → release/Project Hub-2.0.0-win-x64.exe
npm run build:mac     # macOS
npm run build:linux   # Linux
```

The installer creates desktop and Start Menu shortcuts; `release/win-unpacked/` is a portable copy you can run directly by double-clicking `Project Hub.exe`.

The application icon is not a binary asset — it is drawn by code. `scripts/make-icon.mjs` reuses the three-hub mark from the tray, supersamples it 4×, and writes the PNG and ICO containers by hand into `build/icon.ico`. To change the icon, edit that script and re-run:

```bash
npm run make:icon
```

> **Packaging on Windows without symlink privileges.** If Developer Mode is off and the shell is not elevated, electron-builder's sign stage cannot unpack `winCodeSign`: 7-Zip has to recreate two macOS dylib symlinks inside it and fails with `Cannot create symbolic link`. That same stage writes the exe icon and version strings, so the failure costs both the installer *and* the exe branding. Use:
>
> ```bash
> npm run build:win:nosign
> ```
>
> It packs the app with the sign stage disabled, stamps the exe through app-builder's built-in rcedit, then builds the NSIS installer from the stamped directory. All three steps live in `scripts/pack-win.mjs` and produce the same `release/Project Hub-2.0.0-win-x64.exe`.
>
> The committed `electron-builder.yml` contains no workaround: on an unrestricted machine, `npm run build:win` alone gives the full result.

### 5. Measured performance budget

`npm run bench:scan` exercises the §12 budget items against the real scanner and the real database layer, and prints a `BENCH_RESULT` line.

| ID | Metric | Budget | Measured | Verdict |
| --- | --- | --- | --- | --- |
| NFR-05 | Scan 10,000 files | < 3,000 ms | **76 ms** (10,200 files / 200 projects / 211 dirs) | ✅ ~40× headroom |
| NFR-09 | 1,000 projects + 100,000 events | < 50 MB | **19.37 MB** | ✅ ~2.6× headroom |
| NFR-03 | Idle CPU | < 0.3% | **0.018%** (32 cores, 8 s sample) | ✅ ~17× headroom |
| NFR-02 | Idle RSS | < 220 MB | **393.7 MB** (4 processes, window open) | ❌ **missed, ~1.8× over** |

Replacing the `lucide-react` namespace import with a static icon table shrank the renderer bundle from **1,618.94 kB to 713.08 kB** (see `DECISIONS.md` D-011), which directly serves the NFR-01 cold-start budget.

> **On NFR-02.** The memory figure above comes from the packaged `Project Hub.exe` (`release/win-unpacked/`), launched with `--no-sandbox`, window open, sampled after 30 seconds idle. It is **about 1.8× over budget** and is recorded as such: Chromium itself accounts for most of it — of the four processes, main is ~152 MB, the renderer ~107 MB, and the GPU/utility processes ~130 MB together. This host has no usable GPU and requires the Chromium sandbox to be disabled, both of which push memory above a normal desktop, so the number is **pessimistic** — but there is **no evidence that a normal desktop would come in under 220 MB**. Truly meeting the budget means reclaiming the renderer process while the window is hidden (destroy `webContents` on close, rebuild on demand), which is a product decision rather than a small change. Recorded as `DECISIONS.md` D-019 and not implemented in this version.

The remaining budget (NFR-04 near-zero idle disk I/O) needs a long idle observation — see "Manual acceptance".

### 6. Directory layout

```
project-hub/
├─ src/
│  ├─ main/                    main process
│  │  ├─ index.ts              boot: single-instance lock, userData, DB, IPC, tray, window, scheduler
│  │  ├─ db/                   schema.sql (single DDL source) / schema.ts / sqlite.ts (driver funnel) / repo.ts (all SQL)
│  │  ├─ scanner/              directory walk (walk.ts), project markers (markers.ts), indexing (index.ts)
│  │  ├─ services/             thumbnails, read-only git wrapper, Markdown export
│  │  ├─ background/           scheduler (recursive setTimeout) and the concrete tasks
│  │  ├─ worker/               worker_threads pool + scan/git/size worker entries
│  │  ├─ ipc/                  anchor.ts (path funnel), main.ts (every IPC handler)
│  │  ├─ tray/                 tray icon (SVG → nativeImage)
│  │  └─ utils/                paths, hashing, logging, file ops, power
│  ├─ preload/                 contextBridge, exposes window.hub
│  ├─ renderer/                React UI
│  │  └─ src/
│  │     ├─ components/        tree, timeline, heatmap, search, detail panel, dialogs
│  │     ├─ stores/            zustand: ui / tree / events / settings
│  │     └─ lib/               formatting, colours, icon inference
│  └─ shared/                  pure data and pure functions shared by main and renderer
├─ tests/unit/                 171 unit tests, including the adversarial isolation suite
├─ scripts/                    benchmarks, fixture generation, schema sync, icon generation, encoding repair, packaging fallback
├─ build/                      icon.ico / icon.png (generated by scripts/make-icon.mjs, not binary assets)
├─ docs/                       data-isolation notes, renderer interface contract
├─ electron-builder.yml        packaging config
└─ .builder.nosign.yml         packaging fallback for hosts without symlink privileges (see section 4)
```

### 7. Manual acceptance (needs a real desktop session)

These cannot be automated headlessly and need a human:

1. **R1 / visuals**: switching light and dark themes; body contrast; the selected row (`#3b82f61a` background + 2px blue left bar); `archived` icons desaturating.
2. **R2 / open on click**: clicking a real project node should open that directory in the file manager; a node whose path vanished should report 「路径不存在」 in the status bar.
3. **R3 / context menu**: the nine items, their order and their availability; "view changes" should switch to the timeline with a breadcrumb and a 「清除过滤」 affordance.
4. **R6 / tray**: closing the window should hide, not quit; the tray menu pauses/resumes background maintenance and syncs git on demand; quitting goes through the tray menu.
5. **NFR-04**: leave it idle and watch disk I/O stay near zero (this build uses recursive `setTimeout` instead of polling, so it should be). Memory and CPU are measured — see section 5.

### 8. Known deviations

Every deliberate difference from the project book is recorded in [`DECISIONS.md`](DECISIONS.md): the driver fallback strategy, adjusted task names and intervals, and how the built-in icon set maps onto the frozen §8.4 list.

---

## License

[MIT](LICENSE)
