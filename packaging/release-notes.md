## v0.1.9 — 启动跟随与确认停用 / Startup and service shutdown

- Codex 主窗口出现时即打开配置窗口，无需进入 work 或等待模型调用。当前用户的后台监听器随 Windows 登录启动；已有窗口会复用，不抢焦点。
- 移除悬浮球和最小化按钮，保留紧凑 / 展开模式。
- “关闭DSH as Subagent”移至展开窗口底部。确认后停止所有聊天中的运行中子代理和后代，清空待执行消息，并为受影响的请求聊天排入一条服务停用通知。
- 关闭后的 DSH 请求由服务端拒绝，`get_status` 仍可查询。重新打开窗口不会自动启用服务；需手动启用并发布新任务，已撤销的旧任务不会恢复。
- 停用状态和通知记录持久保存，重复关闭不会重复创建通知。通知沿用现有回传通道；使用 `codex_queue` 时仍需用户发布排队消息。

普通配置修改仍只影响后续提交。关闭服务是立即停止操作，可撤销正在使用的旧配置快照。API 凭据、模型配置、账本和用户数据在升级时保留。

### 安装与升级

运行 `dsh-mcp-0.1.9-setup-win-x64.exe`，升级后重启 Codex。安装器从本 GitHub Release 下载程序和固定版本的 **DeepSeek Harness CLI 核心包**，并验证 SHA-256。安装包暂未签名。

手动安装需下载**两个 ZIP**并解压至同一目录，然后运行 `Initialize.cmd` 和 `Connect to Codex.cmd`。仅下载程序 ZIP 无法运行代理。CLI 核心来自官方 `deepseek-ai/deepseek-harness` 对应的 npm 包，本项目负责整理分发，不是 DeepSeek 官方二进制安装包。

如果 Codex 提示审核钩子，请审查并允许 `Saving dsh task settings`；安装器不会代替用户信任钩子。没有提交快照的旧轮次会被拒绝。项目源码采用 MIT，依赖保留各自许可。

## English

The control window now follows the Codex desktop window immediately, before a work or an MCP request starts. A per-user Windows startup companion handles detection; an existing window is reused without taking focus. The floating orb and minimize action are removed; compact mode remains.

**Close DSH as Subagent** appears only at the bottom of the expanded window. Confirmation stops active agents and descendants across chats, clears pending messages, and queues one service-disabled notice per affected chat. Later DSH calls are rejected by the server, with `get_status` available. Reopen, explicitly enable, and submit a new task to use the service again; revoked turns stay blocked. Stop state and delivery records survive reconnects. The existing delivery channel is retained; `codex_queue` notices still require the user to publish the queued message.

Run the Windows x64 installer and restart Codex after upgrading. It downloads both application and matching CLI core archives from this release and verifies SHA-256. The installer is unsigned. Manual installs require **both ZIP files**, extracted together, followed by `Initialize.cmd` and `Connect to Codex.cmd`. Review the `Saving dsh task settings` hook in Codex when prompted; installation does not bypass trust. User configuration, encrypted credentials, and data are retained. Source is MIT; bundled dependencies retain their own licenses.

Validation covers unit tests, the packaged UI, startup before MCP, cross-chat service shutdown, actual Harness CLI tasks with local mock responses, and upgrade/uninstall data preservation. No paid model requests are used.
