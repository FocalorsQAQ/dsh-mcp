全局外包开关与聊天名称 / Global delegation switch and chat names — Windows x64

v0.1.6 将外包开关改为所有聊天共用。悬浮窗启动后即可读取和修改，无需主 agent 先调用工具。任务、队列、预算、费用和并发限制继续按聊天隔离；API/模型配置继续共用。

- 关闭后保留工具定义和历史上下文；连接提示、始终可用的 `get_status` 和被拒绝的调用会明确返回“外包已禁用”。其他外包调用和新的模型 API 请求立即被拦截；正在结算的请求保留账本，不自动退款或重放。
- 初始化指令要求模型外包前查询当前开关，不把缓存说明作为权限。**切换开关无需重启 Codex**；已有聊天在下一次状态查询或调用时收到最新提示，不依赖动态删除工具或修改聊天历史。
- 总开关保存于共享根目录的 outsourcing.json，使用独立版本号、跨进程写锁和原子替换。自定义 UI 可通过 OutsourcingSwitch 或可信控制 API 接入。
- 聊天选择器优先显示 Codex 本地索引中的聊天名称；重命名自动更新，重名或缺失标题时以短 ID 辅助区分。完整 UUID 仍用于路由和写入校验，聊天正文不会被读取或发送给模型。

The global switch works before any agent tool call. Tool definitions and history remain; get_status always reads the live state, and blocked calls return an explicit disabled notice. Existing chats receive updated status at their next query or call, without a restart or tool-list refresh. Tasks and budgets remain isolated per chat. Chat names are read locally by exact UUID and follow renames.

已验证真实 Codex 引擎的启动提示、同一连接上的禁用与重新启用、旧调用拦截，以及真实 Electron 中未建立聊天服务时的开关、聊天名称和独立预算。测试使用本机模拟接口，没有调用付费模型。

**升级后重启 Codex，让已有连接加载新版入口。** 原有设置、加密 API 配置、模型、会话和账本保留。旧根目录的外包启用偏好仅在首次建立总开关时迁移；旧聊天的 enabled 不再作为独立开关。

保留 v0.1.5 的请求元数据路由、v0.1.4 的多聊天服务和 v0.1.3 的悬浮球、双语言、自动打开窗口及安装依赖链接修复。可用 ui_auto_start:false 关闭自动打开。MCP 服务通过安装器默认注册到 Codex，全局 MCP 注册与插件市场列表是不同入口。

## 下载 / Downloads

- dsh-mcp-0.1.6-setup-win-x64.exe：在线安装器，从 GitHub 下载并校验程序和 CLI 核心包。
- dsh-mcp-0.1.6-win-x64.zip：已编译程序，包含 Node.js 和 Python。
- deepseek-harness-cli-0.2.2-alpha.2-dsh-mcp-0.1.6-win-x64.zip：必需的官方 DeepSeek Harness CLI、匹配 SDK、Electron 和其他依赖。
- SHA256SUMS.txt、release-manifest.json：校验值与来源信息。

手动安装必须下载两个 ZIP，按 [安装说明](https://github.com/FocalorsQAQ/dsh-mcp/blob/main/docs/install.md) 解压并初始化。源码安装使用 pnpm install 安装固定版本的官方 CLI 依赖。安装器从本项目 GitHub Release 获取核心包；核心来自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。本项目按 MIT 发布，第三方依赖保留其许可证和版权说明。
