## v0.1.10 — 工作区管理与控制窗修复 / Workspaces and control window fixes

- 新增 `create_workspace`、`list_workspaces` 和 `spawn_agent.workspace_id`。主 agent 可接入已有本机项目或创建目录，不再受安装时默认 `workspace_root` 限制；注册记录按聊天保存。
- 新增“仅限主 agent 工作区”权限开关，默认关闭。开启后，创建目录和执行任务都必须位于主 agent 本轮提交的工作区内；代码会检查真实路径、目录链接和恢复后的任务。外包子代理只能继承父代理的工作区，不能自行扩大范围。
- 修复 Codex 退出时后台启动监听器随之消失的问题。监听器独立运行，MCP 连接时也会检查并恢复它；手动关闭控制窗后，同一次 Codex 运行期间保持关闭，重启 Codex 后自动打开。
- 修复控制窗启动后只剩黑框或不可见的问题。Electron 图形进程使用正常窗口启动方式，仍保留 Codex owned window、不占任务栏和自动启动不抢焦点的行为。
- 升级保留 API 凭据、模型、预算与用户数据。重新打开窗口不会自动启用已停用的服务；需打开“启用外包”并提交新任务，已撤销的旧任务不会恢复。

### 安装与升级

运行 `dsh-mcp-0.1.10-setup-win-x64.exe`，升级后重启 Codex。安装器从本 GitHub Release 下载程序和固定版本的 **DeepSeek Harness CLI 核心包**，并验证 SHA-256。本版仍为预发布，安装包暂未签名。

手动安装需下载**两个 ZIP**并解压至同一目录，然后运行 `Initialize.cmd` 和 `Connect to Codex.cmd`。仅下载程序 ZIP 无法运行代理。CLI 核心来自官方 `deepseek-ai/deepseek-harness` 对应的 npm 包，本项目负责整理分发，不是 DeepSeek 官方二进制安装包。

如果 Codex 提示审核钩子，请审查并允许 `Saving dsh task settings`；安装器不会代替用户信任钩子。项目源码采用 MIT，依赖保留各自许可。

验证：165 项测试全部通过；实际安装包通过 v0.1.9 升级、窗口重开与启动监听器恢复、跨聊天停用、工作区权限、真实 Harness CLI 的本地模拟任务和卸载保留数据检查。没有调用付费模型或向真实聊天发送测试通知。

## English

- `create_workspace` and `list_workspaces` let the main agent register existing local projects or create directories, then select one through `spawn_agent.workspace_id`. Registrations persist per chat without changing the installation default.
- The optional **Restrict to main-agent workspace** switch defaults to off. When enabled, registration and execution stay inside the host-bound directory captured at submission. Real-path checks reject link escapes and replaced roots. Children inherit their parent's workspace and cannot expand it.
- The Windows startup companion now survives Codex termination and is checked and repaired when MCP connects. A manual close is respected for the current Codex process; restarting Codex opens the window again.
- Fixed the blank or invisible control window caused by applying a hidden startup flag to Electron. The window remains owned by Codex, absent from the taskbar, and does not take focus during automatic startup.
- User settings, encrypted credentials, models, budgets and data are retained on upgrade. Reopening the window does not enable a stopped service; explicitly enable it and submit a new task. Revoked turns remain blocked.

Run the Windows x64 installer and restart Codex after upgrading. It downloads both the application and matching CLI core archives from this release and verifies SHA-256. This remains an unsigned prerelease. Manual installs require **both ZIP files**, extracted together, followed by `Initialize.cmd` and `Connect to Codex.cmd`. Review the `Saving dsh task settings` hook in Codex if prompted; installation does not bypass trust. Source is MIT; bundled dependencies retain their own licenses.

Validation: all 165 tests passed, along with the packaged upgrade from v0.1.9, window reopen and startup recovery, cross-chat shutdown, workspace permissions, actual Harness CLI tasks with local mock responses, and uninstall data preservation. No paid model requests or real-chat test notifications were sent.
