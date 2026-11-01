# dsh 悬浮控制窗

初版使用 Electron 45、React 19、TypeScript 和 Vite 8。深色悬浮窗支持拖动、悬浮球、紧凑模式和窗口位置记忆。Windows 下不占任务栏，通过 Win32 `GWLP_HWNDPARENT` 归属于 Codex 主窗口，不使用全局置顶。API 密钥按钮已接入独立的配置管理窗口；模型按钮已接入 [模型配置窗口](model-management.md)。已保存的 API key 不回传或展示，详见 [API 配置管理](api-management.md)。

窗口标题为 DeepSeek Harness as Subagent。控制窗仅展示汇总在线代理状态，费用和 token 仍在账本中采集。预算以 USD 与 CNY 两个独立金额编辑。

界面支持简体中文与英文。在控制窗底部的语言下拉框选择，控制窗、API 配置窗、模型配置窗立即同步，保留未保存的表单输入。没有连接 MCP 时也能切换；选择保存在当前项目的 `<data_dir>/desktop/window.json`，重启后恢复。新打开的模型验证确认框也使用所选语言。

文案分别位于 `resources/locales/zh-CN.json` 和 `resources/locales/en-US.json`，语言名称与列表在 `resources/languages.json`。添加语言时登记列表、提供同键名 JSON 并重新构建；缺失翻译回退到中文，资源支持 `{name}` 占位符。错误提示通过资源映射，不直接显示后端错误文案。API 名称、模型 ID 等用户填写的数据保持原样。

启动时可通过 `DSH_UI_LOCALE=en-US` 或 `DSH_UI_LOCALE=zh-CN` 覆盖已保存的选择；未指定时默认采用已保存语言，首次使用默认中文。语言只改变桌面显示，不改变模型、预算、计费币种或 MCP 工具协议。`pnpm test:i18n-ui` 验证切换、持久化和英文布局，不调用付费模型。

Win32 归属辅助进程只修改控制窗自身，识别桌面 Codex（含 OpenAI.Codex 包下的 ChatGPT.exe），找不到时保持普通非置顶隐藏任务栏窗口并定期重试。多个 Codex 窗口优先选择前台窗口，否则选择一个可见主窗口；绑定后保持稳定。Codex 最小化时所属窗口遵循 Windows 的归属行为。关闭 Codex 可能连同控制窗关闭，MCP 生命周期仍独立。控制窗被最小化或关闭后，可再次执行启动命令恢复。

## 启动

从 v0.1.2 开始，Windows 上的 MCP 服务在客户端完成初始化时默认自动打开悬浮窗。安装后重启 Codex，加载 dsh 时即可显示；不需要额外设置 Windows 开机启动项。`--doctor`、`--help` 和单纯启动但尚未连接客户端的 stdio 进程不会弹窗。

同一个 `data_dir` 使用 Electron 单实例锁，重复自动启动会保留现有窗口和最小化状态，不抢焦点。首次自动打开也不抢焦点。手动启动仍会显示、恢复并聚焦已有窗口。关闭控制窗不会停止 MCP；同一个 MCP 进程不会反复把已关闭的窗口弹回来，重启 MCP 后可以再次自动打开。不同 `data_dir` 的窗口仍独立。

可以在 MCP 使用的 `dsh.config.json` 中设置 `"ui_auto_start": false` 并重启 MCP，关闭自动打开。旧配置无需增加字段，Windows 默认开启；其他系统默认关闭。自动打开使用 MCP 实际生效的工作区、数据目录和配置文件；UI 启动异常不会导致 MCP 工具不可用。源码运行前需先执行 `pnpm ui:build`。

也可以在项目目录手动运行：

```powershell
pnpm ui
```

已经构建后，可直接启动：

```powershell
node scripts/start-ui.mjs
```

使用另一个项目配置：

```powershell
node scripts/start-ui.mjs --config D:/path/to/dsh.config.json
```

控制窗与 MCP 必须使用相同的配置和根 `data_dir`。MCP 启动配置使用 `packaging/launch-server.mjs`，无需把 Electron 配置成 MCP 命令。更新代码后需要重启已有 dsh MCP 连接，让它加载新的 UI 连接服务；`config/codex.toml` 是现有接入样例。

## 随时配置与在线明细

控制窗直接编辑后续任务的共享默认设置，不依赖任何聊天或模型先调用工具。开关、顶层代理数量、二次外包开关/深度/数量和两种预算均可预先保存。API 和模型管理窗口照常使用。

提交任务时通过已审查的 Codex `UserPromptSubmit` 钩子截取快照；之后编辑不会改变运行中的任务。安装完成后，首次使用须在 Codex CLI 的 `/hooks` 审查并信任钩子。完整边界见 [配置快照](task-snapshots.md)。

窗口不再提供聊天选择。在线数量汇总所有已连接 work，点击展开 work 名称及其每个在线子代理的名称、模型和推理强度。名称从本地 Codex 索引读取并跟随重命名；无标题时回退为工作区名。没有在线代理时显示 0；服务断开后排除其陈旧数据。标题索引和代理信息仅在本地显示。

## 悬浮球

点击最小化变为 72 像素悬浮球，显示所有 work 的在线代理总数（包含二次外包）。可拖动；点击展开，位置和窗口尺寸保持。关闭 UI 不结束代理任务。Win32 owned window 和隐藏任务栏行为保持。

## 自定义界面

推荐使用 `Dashboard` 控制抽象层，避免直接解析代理状态文件。见 [控制层](control-layer.md)。Electron 主进程负责本地配置和鉴权连接，renderer 不接触密钥或连接令牌。

## English

The floating panel edits defaults for future task submissions, even before any MCP chat service exists. The submission hook freezes each turn's configuration. The panel has no chat selector or spending/token widgets. Its expandable online count groups agents by work name and shows agent names, models and reasoning efforts. The floating orb displays the aggregate count. Chinese and English remain available across all management windows.
