自动接入 Codex / Automatic Codex setup — Windows x64

安装时默认勾选 **Connect dsh to Codex automatically**，会自动注册 MCP 服务；重启 Codex 即可加载。不需要另外安装 Codex CLI。原有设置会保留并备份，同名冲突不会被替换。卸载只移除安装器创建且未被用户修改的条目。手动安装可以运行 `Connect to Codex.cmd`。

The installer now registers dsh with Codex by default using the documented MCP configuration. Restart Codex to load it. Existing settings are preserved and backed up; conflicting entries are left unchanged. Uninstall removes only its own unchanged entry. ZIP users can run `Connect to Codex.cmd`. This configures an MCP server, not a marketplace plugin. See [official OpenAI documentation](https://learn.chatgpt.com/docs/extend/mcp).

DeepSeek Harness as Subagent provides collaboration-style external agents over
MCP, with task queues, pause/resume, concurrency controls, model routing,
host-enforced dual-currency budgets, Python billing, and a Simplified Chinese /
English floating control window.

源码采用 **MIT**。这是社区项目，不是 DeepSeek 或 OpenAI 官方产品。

发布前已通过 126 项测试及真实安装器、安装后 MCP/CLI 任务、双语界面和卸载保留数据检查；任务测试使用本地模拟模型，没有产生 API 费用。

### 下载与安装

- `dsh-mcp-0.1.1-setup-win-x64.exe`：在线安装器，从 GitHub 下载并校验程序和 CLI 核心包。
- `dsh-mcp-0.1.1-win-x64.zip`：已编译程序，包含 Node.js 和 Python。
- `deepseek-harness-cli-0.2.2-alpha.2-dsh-mcp-0.1.1-win-x64.zip`：必需的 DeepSeek Harness CLI、匹配 SDK、Electron 和其他运行依赖。
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
