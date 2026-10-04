# FreeBSD 打包注意事项

[English](freebsd-packaging-notes.md) | 中文

本文说明 FreeBSD 桌面包的构建方式，以及本 fork 在打通这条链路时踩过的每一个坑。改动 FreeBSD 打包路径之前请先读本文。

## 产物说明

`deepseek-harness-<版本>-freebsd-x64.pkg` 是原生 FreeBSD 包，不是把 Linux 包重新包装。安装到 `/usr/local`：

- `/usr/local/share/deepseek-harness/` —— electron-builder 组装出的应用程序（FreeBSD Electron 运行时 + `app.asar` + `resources/`）
- `/usr/local/bin/deepseek-harness` —— 指向应用可执行文件的符号链接
- `/usr/local/bin/dsh` —— 指向内置 CLI 启动器的符号链接
- `/usr/local/share/deepseek-harness/deepseek-harness-rg` —— ripgrep 侧车二进制（见下文）
- `/usr/local/share/applications/deepseek-harness.desktop` 与 hicolor 图标

包声明的运行时依赖直接取自已安装的 `electron44` 包的依赖表，因此安装端会解析出 Electron 构建与测试所针对的同一组库。

## 构建方式

GitHub 托管运行器没有 FreeBSD；工作流用 `vmactions/freebsd-vm` 启动一台 FreeBSD 15.1 虚拟机，在其中执行 `.github/linux-overlay/build-freebsd.sh`。脚本下载上游源码压缩包、应用与 Linux 工作流相同的 overlay，然后针对 FreeBSD Electron 分发目录以 `electron-builder --linux --dir` 组装。`freebsd-x64` 目标之所以走 electron-builder 的 Linux 路径，是因为 FreeBSD Electron 分发的目录布局与 Linux 相同；随后由 `apps/desktop/scripts/freebsd-package.ts` 把组装出的目录做成 pkg(8) 包。

FreeBSD Electron 分发来自 tagattie 的 FreeBSD-Electron releases（`electron44-44.3.0-freebsd15-amd64.pkg`），在 workflow 中以 SHA-256 固化。升级时 URL、版本与哈希必须同时更新。

## 踩坑清单

### FreeBSD 版 Electron 在“自 spawn”时崩溃

以 `ELECTRON_RUN_AS_NODE` 启动的 Electron 进程再 spawn 可执行文件自身时，调用方会被杀掉：分发内嵌的启动补丁会向这类子进程注入 crashpad 环境，但 FreeBSD 构建裁剪了 crashpad 支持，注入过程抛出 `TypeError: t is not a function`。上游报告：tagattie/FreeBSD-Electron#169。

本 fork 的绕过方式见 `apps/desktop/scripts/node-bin/child-process-hook.cjs`：FreeBSD 上 Node stub 以 `--require` 加载该 hook，它把这类 spawn 精确改道回 stub（一个 shell 脚本，因此补丁的 `file === process.execPath` 判断永远不会命中）。stub 启动的后代进程同样带 hook，因此每一层都被覆盖。Host 进程启动与 runtime 冒烟都经该 stub。

### pnpm 拒绝 FreeBSD 的 optional 依赖

sharp 的 FreeBSD 变体（`@img/sharp-freebsd-wasm32`）在 registry 上存在、lockfile 也能解析，但 pnpm 在 FreeBSD 上拒绝链接它（JavaScript 的 `optionalDependencies` 路径会过滤掉它；直接依赖、`file:` override 与 `supportedArchitectures` 都改变不了这一点）。运行时只在真正处理图片时才加载 sharp，因此该平台不随包分发，冒烟中如实报告 `sharp: false`。同一次安装也不会放置 `node-addon-require-builtin` 的 FreeBSD 绑定；profile 解析器改用已暴露的 internal `require` 获取那些内部模块。

### npm 的 `pkg` 遮蔽系统 pkg(8)

在构建树内，`node_modules/.bin` 排在 `PATH` 最前，而 JavaScript 的 `pkg` 包（Node 打包工具）占用了这个名字。任何需要调用 pkg 的代码都必须使用绝对路径 `/usr/sbin/pkg`（以及 `/usr/bin/tar`），否则会跑到错误的工具。

### FreeBSD 15 的包数据库是 SQLite

`/var/db/pkg/<name>-<version>/+MANIFEST` 已不存在；读取已安装包元数据请走 `pkg query`（例如 `pkg query -e '%n = electron44' '%dn %do %dv'`）。

### Office 引擎集为空的刻意设计

LibreOffice kit 声明其全部引擎（包括 WASM 引擎）仅支持 Linux、macOS 与 Windows，并在 Office 功能运行时拒绝 FreeBSD。因此运行时不分发任何引擎，打包后的 Host 以显式 `cli: false` 解析 kit CLI（技能报告“已禁用”），打包步骤也把引擎闭包视为空集，而不是在缺失目录上失败。

### 构建链路中的若干硬性约定

- `node-pty` 在此平台从源码编译（它不发布 FreeBSD 预编译）；本 fork 的 pnpm patch 把其 `pty_close_inherited_fds` 的条件拓宽到 FreeBSD 才使其可行。
- FreeBSD 上的 runtime 安装改用宿主 Node 而不是打包的 Electron，因为 koffi 的安装探测会 spawn 当前可执行文件，从而撞上自 spawn 崩溃。
- Linux 工作流使用的 lockfile 会在构建过程中被打补丁（`apply.mjs`）：被替换的 entry 清单与被编辑的 node-pty patch 需要匹配的 importer 条目与 `patchedDependencies` 哈希，除此之外构建树保留上游 lockfile。

## 包验收方式

```sh
sudo pkg install ./deepseek-harness-<version>-freebsd-x64.pkg
dsh --version   # prints the release version; runs the Electron runtime in Node mode
```

完整校验还包括用 `pkg info -F` 回读包元数据，并运行桌面冒烟（工作流每次构建都会执行这两步）。

## 当前限制

- 无 Office 转换：kit 不提供 FreeBSD 引擎（见上文）。
- 无图片处理：sharp 的 FreeBSD 变体无法安装（见上文）。
- 无 Python 运行时载荷、无沙箱：工作区依赖与进程约束功能报告不可用；内置 Node 与 pnpm 仍可用。
