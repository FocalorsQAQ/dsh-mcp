实时并发悬浮球与升级修复 / Floating orb and upgrade repair — Windows x64

最小化按钮改为收起到悬浮球，显示实时总并发数（包含子代理）。支持拖动并记住位置、点击展开、离线状态和中英文。反复收起展开会保留面板内容与尺寸，后台任务继续运行。

The minimize button now collapses the panel to a floating orb showing live total
concurrency, including child agents. Drag it to move, click to restore; position
is saved and disconnected counts show a dash. Both languages are supported.

v0.1.3 修复旧版覆盖安装时的 `CLI core initialization failed`。此前旧依赖链接保留下来，而新版依赖包目录已经改变，导致初始化被中止。现在安装器会验证并迁移同一安装目录内、属于同名依赖包的链接；失败时恢复原链接。普通目录、外部链接和不同包的链接不会被覆盖。

已经遇到 v0.1.2 初始化错误的用户，可直接运行本版安装器修复。原有设置、API 配置和用户数据保留；不需要删除数据目录或重新输入密钥。初始化结果写入 `initialization-result.json`，详细错误也会进入 Setup Log。

Version 0.1.3 fixes `CLI core initialization failed` during upgrades. Verified
links between managed packages are migrated to the new layout, with rollback if
a replacement fails. Existing settings and user data are retained. This also
repairs installations left in a mixed state by a failed v0.1.2 upgrade. Errors
are recorded in `initialization-result.json` and the Setup Log.

Codex 加载 dsh 时仍会自动打开悬浮窗，复用已有窗口且不抢焦点。可用 `"ui_auto_start": false` 关闭自动打开。

安装时默认勾选 **Connect dsh to Codex automatically**，会自动注册 MCP 服务；重启 Codex 即可加载。不需要另外安装 Codex CLI。原有设置会保留并备份，同名冲突不会被替换。卸载只移除安装器创建且未被用户修改的条目。手动安装可以运行 `Connect to Codex.cmd`。

The installer now registers dsh with Codex by default using the documented MCP configuration. Restart Codex to load it. Existing settings are preserved and backed up; conflicting entries are left unchanged. Uninstall removes only its own unchanged entry. ZIP users can run `Connect to Codex.cmd`. This configures an MCP server, not a marketplace plugin. See [official OpenAI documentation](https://learn.chatgpt.com/docs/extend/mcp).

DeepSeek Harness as Subagent provides collaboration-style external agents over
MCP, with task queues, pause/resume, concurrency controls, model routing,
host-enforced dual-currency budgets, Python billing, and a Simplified Chinese /
English floating control window.

源码采用 **MIT**。这是社区项目，不是 DeepSeek 或 OpenAI 官方产品。

验证包含单元测试、真实 MCP 自动打开 Electron、重复打开与最小化保留、手动恢复、关闭自动打开，以及安装包内运行和卸载保留数据检查；测试不调用付费模型。

### 下载与安装

- `dsh-mcp-0.1.3-setup-win-x64.exe`：在线安装器，从 GitHub 下载并校验程序和 CLI 核心包。
- `dsh-mcp-0.1.3-win-x64.zip`：已编译程序，包含 Node.js 和 Python。
- `deepseek-harness-cli-0.2.2-alpha.2-dsh-mcp-0.1.3-win-x64.zip`：必需的 DeepSeek Harness CLI、匹配 SDK、Electron 和其他运行依赖。
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
