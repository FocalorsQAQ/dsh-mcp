# 安装 / Installation

[下载 v0.1.2](https://github.com/FocalorsQAQ/dsh-mcp/releases/tag/v0.1.3)

## Windows 在线安装器

下载 `dsh-mcp-0.1.3-setup-win-x64.exe` 并运行。支持 Windows 10
2004 / Windows 11 x64，按当前用户安装，无需管理员权限。

**DeepSeek Harness CLI 是执行代理的核心，必须安装。** 安装器会从 GitHub
Releases 拉取本程序和固定版本的 CLI 核心运行包，并校验 SHA-256。核心来自
[官方 dsh 项目](https://github.com/deepseek-ai/deepseek-harness)，当前使用
`@deepseek-ai/dsh`、SDK 和 LLM 包 `0.2.2-alpha.2`。官方该 GitHub tag 没有可直接
下载的 CLI 二进制附件，所以本项目把官方 npm 包及依赖整理为独立的 Release
附件重新分发；它不是 DeepSeek 官方制作的二进制安装包。

安装时下载的程序和核心包均来自 `FocalorsQAQ/dsh-mcp` 的 GitHub Releases，
无需安装时访问 npm、nodejs.org 或 python.org。Node.js、Python 和 Electron
运行环境已经包含在这两个包内。首次安装需要网络连接。

安装过程中选择外包代理的工作区。安装完成后：

1. 打开开始菜单中的 **DeepSeek Harness as Subagent**。
2. 在 API 管理中添加自己的凭据，再添加并启用模型。
3. 安装时默认勾选 **Connect dsh to Codex automatically**，安装器会自动注册 `dsh`。
   重启 Codex 后即可加载工具，同时自动打开悬浮控制窗；已有窗口会复用且不抢焦点。
   如果取消自动接入，可运行开始菜单中的 **Connect to Codex**，或手动使用 `codex-mcp.toml`。
4. 可在控制窗底部切换简体中文 / English。

配置文件为安装目录中的 `dsh.config.json`。默认状态及加密凭据保存于
`%LOCALAPPDATA%\dsh-mcp\data`。卸载程序不删除凭据、会话和账本；重新安装也不会
覆盖现有配置。自动接入使用 `CODEX_HOME/config.toml`（未设置时使用 `~/.codex/config.toml`），
保留原有文字和其他配置，修改前在同目录保存备份。如果已有不同的 `dsh` 条目，
不会替换它；结果写入安装目录的 `codex-registration-result.json`。卸载仅移除安装器
自己添加且未被用户修改的条目。更换工作区时编辑 `workspace_root` 并重启 MCP 和控制窗。
回传聊天功能默认关闭，兼容的 Codex 宿主可按 `docs/completion-delivery.md` 单独启用。
如需关闭控制窗自动打开，在 `dsh.config.json` 中加入 `"ui_auto_start": false` 并重启 Codex。

### 从旧版本升级

v0.1.3 修复了覆盖安装 v0.1.2 时可能出现的 `CLI core initialization failed`。
新版本会验证并迁移安装目录内指向同名依赖包的旧链接，保留现有配置与数据。
即使 v0.1.2 已经复制文件后报错，也可以直接运行 v0.1.3 安装器修复，无需先删除数据目录。
初始化结果保存在安装目录的 `initialization-result.json`，详细错误也会写入 Setup Log。
普通文件夹、指向安装目录外的链接或无法确认所属包的链接会保留并报错，避免覆盖其他内容。

## 手动安装已编译程序

**只下载本程序 ZIP 不够，必须同时下载 DeepSeek Harness CLI 核心包。**

从同一个 Release 下载并校验 `SHA256SUMS.txt`：

- `dsh-mcp-0.1.3-win-x64.zip`：已编译的 MCP、UI、Node.js、Python。
- `deepseek-harness-cli-0.2.2-alpha.2-dsh-mcp-0.1.3-win-x64.zip`：官方 CLI、SDK 和运行依赖。

将两个 ZIP 解压到同一个空文件夹，运行 `Initialize.cmd`，再打开
`Control UI.cmd`。运行 `Connect to Codex.cmd` 可自动接入 Codex。初始化会恢复包依赖的目录链接，生成配置与 `codex-mcp.toml`；
不要在初始化前直接启动 CLI，也不要只解压核心包。目录链接和配置绑定安装位置，
因此请直接解压到最终位置；要移动时应重新解压两个 ZIP 到新位置再初始化。
`Harness CLI.cmd` 可直接运行核心 CLI。
用 `Initialize.cmd --workspace "D:\YourProject"` 指定工作区。

也可以把两个原始 ZIP 放在同一文件夹，通过安装器的 `/PACKAGEDIR="目录"`
参数进行离线安装；仍然验证安装器内固定的哈希。

## 从源码安装

源码不附带 CLI、依赖和本地状态。需要 Node.js 24.9+、pnpm 11 和 Python 3.10+：

```powershell
git clone https://github.com/FocalorsQAQ/dsh-mcp.git
cd dsh-mcp
pnpm install --frozen-lockfile
pnpm build
pnpm ui:build
pnpm doctor
```

`pnpm install` 会同时下载并安装锁定版本的官方 DeepSeek Harness CLI 和 SDK，
因此不需要再全局安装另一个版本，但不能跳过这一步。源码安装时依赖从 npm
获取，Electron 的安装脚本也会下载其官方运行时；这与上面的 GitHub 在线安装器不同。
编辑 `dsh.config.json` 设置工作区，运行 `pnpm ui` 打开控制窗口，并按
`config/codex.toml` 模板配置 MCP。不要上传 `.env`、`.dsh-mcp` 或个人密钥。

## English

Download the Windows x64 installer from the release linked above. It retrieves
both the compiled application and the pinned **DeepSeek Harness CLI core** from
this project's GitHub Releases and verifies SHA-256. The CLI is the required
agent execution core. It is redistributed from the official DeepSeek npm
packages, version `0.2.2-alpha.2`; the upstream GitHub tag does not provide a
ready-to-download CLI binary. This is a community repack, not an official
DeepSeek binary. Node.js, Python and Electron are included; installation does
not fetch additional packages from npm or runtime vendors.

For manual installation, download **both ZIP archives from the same release**,
extract them to the same empty folder and run `Initialize.cmd`. Downloading
only the application ZIP is insufficient: you must also download the
DeepSeek Harness CLI core archive. Then open `Control UI.cmd`, configure your
API keys and models. The installer registers dsh with Codex by default; restart
Codex to load the tools and automatically open the floating control window.
An existing window is reused without taking focus or restoring it from minimized state.
Set `"ui_auto_start": false` in `dsh.config.json` to disable automatic opening.
Manual ZIP users can run `Connect to Codex.cmd`.
Use `Initialize.cmd --workspace "D:\YourProject"` to select a workspace.

Registration preserves existing settings and creates a backup. A conflicting
existing `dsh` entry is left unchanged; check `codex-registration-result.json`
or merge `codex-mcp.toml` manually. Uninstall removes only an unchanged entry
created by this installer. User state and
encrypted credentials are kept in `%LOCALAPPDATA%\dsh-mcp\data`, outside the
program files, and are retained on uninstall. To build from source, install
Node.js 24.9+, pnpm 11 and Python 3.10+, then run the commands above.
`pnpm install` downloads the mandatory CLI and matching SDK automatically.
The UI supports Simplified Chinese and English.

Version 0.1.3 fixes upgrades from earlier releases, including installations left
in a mixed state after the v0.1.2 initialization error. Run the newer installer
over the existing location; settings and data are retained. Only verified links
between managed packages with matching package names are migrated. Initialization
details are written to `initialization-result.json` and the Setup Log.

This initial release targets Windows x64. MIT applies to this project's own
source; bundled third-party software retains its original licenses. See
`THIRD_PARTY_NOTICES.md` and the package inventory included with the core ZIP.
