## v0.1.11 — 后台 CLI 与窗口关闭修复 / Background CLI and window shutdown

- 隐藏 SDK 启动的 DeepSeek Harness CLI 后台控制台。控制 UI 仍以正常图形窗口启动，避免重新引入黑框问题；用户主动运行 `Harness CLI.cmd` 时仍可使用交互终端。
- 控制窗、模型页和 API 页关闭前，会先解除自己的 Windows owner 和 Electron 父窗口关系。控制窗先等待绑定辅助进程退出，防止关闭过程中重新挂接 Codex；配置页禁止最小化。
- 关闭流程只修改 DSH 窗口，不向 Codex 发送最小化、恢复或焦点操作。确认停用后的子代理停止、聊天通知与后续调用拒绝逻辑保持有效；维护退出不会停用服务。
- SDK 兼容补丁通过 pnpm 固定，在 CLI 核心包中提供原文与 SHA-256，便于审查与复现。

### 安装与升级

运行 `dsh-mcp-0.1.11-setup-win-x64.exe`，升级后重启 Codex。安装器从本 GitHub Release 下载程序和固定版本的 **DeepSeek Harness CLI 核心包**，并验证 SHA-256。升级保留 API 凭据、模型、预算与用户数据。本版仍为预发布，安装包暂未签名。

手动安装需下载**两个 ZIP**并解压至同一目录，然后运行 `Initialize.cmd` 和 `Connect to Codex.cmd`。CLI 核心来自官方 `deepseek-ai/deepseek-harness` 对应的 npm 包，并包含上述本地兼容补丁；不是 DeepSeek 官方二进制安装包。项目源码采用 MIT，依赖保留各自许可。

验证范围：实际 SDK/CLI 无控制台启动与正常退出；真实原生确认框、刚操作过的模型/API 页和控制窗关闭；正常、最大化、最小化测试宿主的状态保持；本地模拟任务和安装升级检查。用户报告的 Codex 偶发最小化尚未稳定复现，本次针对关闭时仍保留窗口归属链的路径进行修补，不能把测试通过视为该偶发问题已完全复现并消除。测试不调用付费模型，也不向真实聊天发送通知。

## English

- The SDK now starts the background Harness CLI with `windowsHide: true`. The Electron GUI keeps its normal startup behavior; launching `Harness CLI.cmd` manually remains interactive.
- Control, model and API windows release their native owner and Electron parent before destruction. Control shutdown waits for the owner helper to exit first, preventing it from reattaching Codex during teardown. Configuration windows cannot be minimized.
- Shutdown changes only DSH windows and sends no minimize, restore or focus operation to Codex. Confirmed service shutdown still stops agents, notifies affected chats and rejects subsequent requests. Maintenance exits do not disable the service.
- The SDK change is a pinned pnpm compatibility patch, redistributed with its exact content and SHA-256 in the CLI core archive.

Run the Windows x64 installer and restart Codex after upgrading. It downloads both archives from this release and verifies SHA-256. User settings and data are preserved. This remains an unsigned prerelease. Manual installation requires **both ZIP files**, extracted together, followed by `Initialize.cmd` and `Connect to Codex.cmd`. Source is MIT; dependencies retain their licenses.

Validation covers the actual SDK/CLI console state and shutdown, real native confirmation dialogs, recently edited model/API pages, control shutdown and preservation of normal/maximized/minimized test host states, local mock tasks and installer upgrades. The intermittent Codex minimization report has not been consistently reproduced; this release repairs the ownership teardown path and regression tests do not establish that every occurrence has been eliminated. No paid model requests or real-chat test notifications are sent.
