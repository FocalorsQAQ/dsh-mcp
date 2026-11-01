Codex 请求身份路由修复 / Codex request identity routing — Windows x64

v0.1.5 修复 v0.1.4 与 Codex 实际启动方式的兼容问题。Codex 会在每次 MCP 请求的元数据中传聊天 ID，而不一定提供启动环境变量；旧版因此只展示工具、拒绝任务，并跳过自动打开窗口。现在按宿主请求身份路由到独立聊天服务，共享连接也会自动打开窗口。

身份不再需要模型填写；缺失、冲突或非法身份仍会被拒绝。返回的 `control.chat_id` 可核对实际调用聊天。每个聊天的任务、预算和限制继续独立，API/模型配置共用。共享全局清单不能针对尚未识别的聊天隐藏工具，但每个聊天的禁用和预算限制仍在代码中执行。

已用本机实际 Codex app-server 验证无 `CODEX_THREAD_ID` 的两聊天请求路由，并覆盖真实 Electron 无身份启动、模拟任务、禁用约束和断线重连；未调用付费模型。升级后需让 Codex 重新加载 dsh 连接。

Version 0.1.5 fixes the actual Codex startup path: chat identity arrives in MCP
request metadata, not necessarily in the process environment. Requests now route
to isolated chat services, and shared connections also auto-open the UI. Missing
or conflicting identity fails closed. Real Codex app-server integration is tested
without model turns. Reload dsh after upgrading.

本版保留 v0.1.4 的多连接架构：每个聊天使用独立后台服务，同一聊天的多个连接复用它，保留原有数据锁。

- 每个聊天独立任务、队列、预算、花费和并发设置，共用 API 密钥与模型配置。
- 控制窗增加“当前聊天”选择；悬浮球显示所选聊天实时并发。切换不会把旧表单写入另一个聊天。
- 连接断开不再终止其他连接或活动任务。没有 MCP 连接和活动任务时，后台服务默认空闲 60 秒后退出；重连恢复对应聊天记录。
- 启动时没有聊天 ID 的连接按每次请求中的宿主身份路由；请求也没有身份时只能查询共享模型，不能执行任务。
- 旧设置、API 配置、会话和账本保留。旧账本不自动分配到新聊天；新聊天仅继承旧用户策略作为初始值。

**升级后重启 Codex，让连接加载新版入口。** 任务仍受预算和超时限制；需要立即停止时使用中断或关闭代理。并发上限和预算按聊天执行，当前没有跨聊天总上限。详情见 [多聊天连接](https://github.com/FocalorsQAQ/dsh-mcp/blob/main/docs/multi-chat.md)。

This retains the independent per-chat services from v0.1.4. Each chat has one background service shared by
its stdio connections, with independent tasks, queues, budgets and limits.
API credentials and model settings remain shared. The desktop selector and
floating orb follow the selected chat. Disconnecting a client preserves other
connections and active tasks; idle services exit after 60 seconds by default.
Restart Codex after upgrading. Old state is retained separately and never
silently assigned to a chat. Calls without chat identity cannot execute tasks.

保留 v0.1.3 的悬浮球、双语言、Codex 同步打开窗口和旧版安装依赖链接修复。原有设置、API 配置和用户数据保留。

Codex 加载 dsh 时仍会自动打开悬浮窗，复用已有窗口且不抢焦点。可用 `"ui_auto_start": false` 关闭自动打开。

安装时默认勾选 **Connect dsh to Codex automatically**，会自动注册 MCP 服务；重启 Codex 即可加载。不需要另外安装 Codex CLI。原有设置会保留并备份，同名冲突不会被替换。卸载只移除安装器创建且未被用户修改的条目。手动安装可以运行 `Connect to Codex.cmd`。

The installer now registers dsh with Codex by default using the documented MCP configuration. Restart Codex to load it. Existing settings are preserved and backed up; conflicting entries are left unchanged. Uninstall removes only its own unchanged entry. ZIP users can run `Connect to Codex.cmd`. This configures an MCP server, not a marketplace plugin. See [official OpenAI documentation](https://learn.chatgpt.com/docs/extend/mcp).

DeepSeek Harness as Subagent provides collaboration-style external agents over
MCP, with task queues, pause/resume, concurrency controls, model routing,
host-enforced dual-currency budgets, Python billing, and a Simplified Chinese /
English floating control window.

源码采用 **MIT**。这是社区项目，不是 DeepSeek 或 OpenAI 官方产品。

验证覆盖单元测试、并行 MCP/SDK/CLI 本机模拟任务、活动任务跨断线、持久化重连、真实 Electron 聊天选择和共享配置、自动打开与悬浮球，以及安装升级/卸载保留数据。测试不调用付费模型。

### 下载与安装

- `dsh-mcp-0.1.5-setup-win-x64.exe`：在线安装器，从 GitHub 下载并校验程序和 CLI 核心包。
- `dsh-mcp-0.1.5-win-x64.zip`：已编译程序，包含 Node.js 和 Python。
- `deepseek-harness-cli-0.2.2-alpha.2-dsh-mcp-0.1.5-win-x64.zip`：必需的 DeepSeek Harness CLI、匹配 SDK、Electron 和其他运行依赖。
- `SHA256SUMS.txt` / `release-manifest.json`：哈希、版本与来源信息。

**手动安装必须同时下载两个 ZIP，解压到同一空文件夹，再运行 `Initialize.cmd`。只下载程序 ZIP 或源码不能直接运行。**

CLI 核心来自 [DeepSeek 官方 dsh 项目](https://github.com/deepseek-ai/deepseek-harness)，
固定版本 `0.2.2-alpha.2`。该官方 GitHub tag 未提供可直接下载的 CLI 二进制附件，
因此本 Release 将官方 npm 包与依赖重新分发为独立核心包。在线安装器从本仓库
GitHub Releases 拉取它作为执行核心，不会在安装时访问 npm 或其他下载站。
从源码安装则由 `pnpm install --frozen-lockfile` 下载必需的官方 CLI 和 SDK。

安装后自行配置 API 和模型；默认已自动注册 dsh，重启 Codex 即可。`codex-mcp.toml` 保留作为手动接入备用。
安装器保留已有 Codex 配置和用户数据。需要 Windows 10 2004+ / Windows 11 x64；
安装器尚未代码签名。详见 [中英文安装说明](https://github.com/FocalorsQAQ/dsh-mcp/blob/main/docs/install.md)。

### English

Use the online installer, or download **both ZIPs** and extract them to one empty
folder before running `Initialize.cmd`. The official DeepSeek Harness CLI is the
mandatory core. This release redistributes pinned official npm packages as a
separate CLI runtime archive; it is not an upstream-built binary. The installer
downloads all payloads from GitHub Releases and checks their SHA-256 hashes.

Node.js, Python and Electron are included. Add your own API keys/models and restart
Codex after automatic registration. `codex-mcp.toml` remains available for manual setup. Existing Codex settings and user data
are retained. Source builds require installing the CLI and matching SDK via
`pnpm install --frozen-lockfile`. MIT covers this project's source; bundled
dependencies retain their original licenses. This unsigned release is a
prerelease for Windows x64.
