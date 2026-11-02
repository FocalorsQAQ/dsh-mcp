# 安装 / Installation

[下载 v0.1.11](https://github.com/FocalorsQAQ/dsh-mcp/releases/tag/v0.1.11)

## Windows 在线安装器

下载 `dsh-mcp-0.1.11-setup-win-x64.exe` 并运行。支持 Windows 10
2004 / Windows 11 x64，按当前用户安装，无需管理员权限。

**DeepSeek Harness CLI 是执行代理的核心，必须安装。** 安装器会从 GitHub
Releases 拉取本程序和固定版本的 CLI 核心运行包，并校验 SHA-256。核心来自
[官方 dsh 项目](https://github.com/deepseek-ai/deepseek-harness)，当前使用
`@deepseek-ai/dsh`、SDK 和 LLM 包 `0.2.2-alpha.2`。官方该 GitHub tag 没有可直接
下载的 CLI 二进制附件，所以本项目把官方 npm 包及依赖整理为独立的 Release
附件重新分发；它不是 DeepSeek 官方制作的二进制安装包。
本项目对 SDK 增加了隐藏后台 CLI 控制台的兼容补丁；补丁原文与哈希记录包含在核心包中。

安装时下载的程序和核心包均来自 `FocalorsQAQ/dsh-mcp` 的 GitHub Releases，
无需安装时访问 npm、nodejs.org 或 python.org。Node.js、Python 和 Electron
运行环境已经包含在这两个包内。首次安装需要网络连接。

安装过程中选择外包代理的默认工作区。主 agent 也可用 `create_workspace` 接入其他项目；若开启“仅限主 agent 工作区”，本轮所有工作区都必须在主 agent 目录内。详见[工作区管理](workspaces.md)。安装完成后：

1. 打开开始菜单中的 **DeepSeek Harness as Subagent**。
2. 在 API 管理中添加自己的凭据，再添加并启用模型。
3. 安装时默认勾选 **Connect dsh to Codex automatically**，安装器会自动注册 `dsh`。
   同时注册当前用户的桌面启动监听器：Codex 主窗口出现时即打开配置窗，无需进入 work；已有窗口会复用且不抢焦点。MCP 配置更新仍需重启 Codex 加载。
   如果取消自动接入，可运行开始菜单中的 **Connect to Codex**，或手动使用 `codex-mcp.toml`。
4. 可在控制窗底部切换简体中文 / English。

这是全局注册的 MCP 服务，可在 Codex 的 MCP 设置中查看，不是插件市场安装项。每个聊天独立任务和预算，共用 API、模型和下一轮默认配置。窗口汇总所有 work 的在线子代理，无需选择聊天。

提交事件快照需要审查 `dsh` 的 `UserPromptSubmit` 钩子。优先使用 Codex App 的“审核钩子”弹窗，勾选 `Saving dsh task settings` 并允许所选项；也可用安装目录的 `Review task hook.cmd` 打开 CLI 审查。安装器不自动信任脚本。若 hook 功能被关闭，需要先启用。之后发布新任务即可在模型运行前固定预算、开关和模型；没有快照的旧轮次会被拒绝。详见 [任务配置快照](task-snapshots.md)。

## 手动安装已编译程序

**只下载本程序 ZIP 不够，必须同时下载 DeepSeek Harness CLI 核心包。**

从同一个 Release 下载并校验 `SHA256SUMS.txt`：

- `dsh-mcp-0.1.11-win-x64.zip`：已编译的 MCP、UI、Node.js、Python。
- `deepseek-harness-cli-0.2.2-alpha.2-dsh-mcp-0.1.11-win-x64.zip`：官方 CLI、SDK 和运行依赖。

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
Codex to load the tools. A per-user background companion opens the floating
control window as soon as the Codex desktop window appears, before entering a work.
An existing window is reused without taking focus. There is no floating orb or minimize button.
Set `"ui_auto_start": false` in `dsh.config.json` to disable automatic opening.
Manual ZIP users can run `Connect to Codex.cmd`.
Use `Initialize.cmd --workspace "D:\YourProject"` to select a workspace.

Version 0.1.11 hides SDK-launched background CLI consoles. Control, API and model
windows detach their owner before closing; the control window also stops its
owner helper first. This avoids destroying windows while still linked to Codex.
The SDK compatibility patch is included in the core archive with a manifest hash.

Version 0.1.10 lets the main agent register other local projects with `create_workspace`
and select them using `spawn_agent.workspace_id`. The optional **Restrict to main-agent
workspace** setting is enforced for each submitted turn. The startup companion now survives
Codex restarts and preserves a manual close until the next Codex process starts. It also
fixes the blank control window caused by hiding Electron at process launch.

Registration preserves existing settings and creates a backup. A conflicting
existing `dsh` entry is left unchanged; check `codex-registration-result.json`
or merge `codex-mcp.toml` manually. Uninstall removes only an unchanged entry
created by this installer. User state and
encrypted credentials are kept in `%LOCALAPPDATA%\dsh-mcp\data`, outside the
program files, and are retained on uninstall. To build from source, install
Node.js 24.9+, pnpm 11 and Python 3.10+, then run the commands above.
`pnpm install` downloads the mandatory CLI and matching SDK automatically.
The UI supports Simplified Chinese and English.

Version 0.1.5 routes Codex calls by host-supplied request metadata, including
when startup has no chat environment variable, and auto-opens the UI. Each
chat has its own tasks, queues, limits and budgets; API/model settings are shared.
Use the dashboard to configure future tasks and inspect all online agents. Restart
Codex after upgrading. Old root state is retained separately and is not silently
assigned to a chat. This is a globally registered MCP server, not a marketplace
plugin. See [multiple chats](multi-chat.md).

Settings are captured at task submission using a local Codex UserPromptSubmit hook.
Review and allow `Saving dsh task settings` in the Codex App hook review dialog;
alternatively, run `Review task hook.cmd` and enter `/hooks` in the Codex CLI.
The installer registers the hook but never bypasses trust. Settings remain editable
without a running chat; changes apply to future tasks only. The UI aggregates all
online subagents and no longer selects a chat.

Version 0.1.9 adds **Close DSH as Subagent** at the bottom of the expanded window.
After confirmation, it stops active agents across chats and queues one service-disabled
notice for each affected chat. Subsequent requests are rejected, while `get_status`
remains available. Reopening the window does not enable the service: explicitly
enable it and submit a new task. Old task snapshots remain revoked. This is an
immediate stop action; the regular enablement switch still configures future tasks.

Version 0.1.3 fixes upgrades from earlier releases, including installations left
in a mixed state after the v0.1.2 initialization error. Run the newer installer
over the existing location; settings and data are retained. Only verified links
between managed packages with matching package names are migrated. Initialization
details are written to `initialization-result.json` and the Setup Log.

This initial release targets Windows x64. MIT applies to this project's own
source; bundled third-party software retains its original licenses. See
`THIRD_PARTY_NOTICES.md` and the package inventory included with the core ZIP.
