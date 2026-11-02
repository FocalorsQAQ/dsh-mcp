# dsh 悬浮控制窗

初版使用 Electron 45、React 19、TypeScript 和 Vite 8。深色悬浮窗支持拖动、紧凑模式和窗口位置记忆；已移除悬浮球模式和最小化按钮。Windows 下不占任务栏，通过 Win32 `GWLP_HWNDPARENT` 归属于 Codex 主窗口，不使用全局置顶。API 密钥按钮已接入独立的配置管理窗口；模型按钮已接入 [模型配置窗口](model-management.md)。已保存的 API key 不回传或展示，详见 [API 配置管理](api-management.md)。

窗口标题为 DeepSeek Harness as Subagent。控制窗仅展示汇总在线代理状态，费用和 token 仍在账本中采集。预算以 USD 与 CNY 两个独立金额编辑。

代理设置中的“仅限主 agent 工作区”默认关闭，允许主 agent 接入或创建任意本机目录；开启后限制在主 agent 提交目录及其子目录。与其他配置一样只影响后续提交，由服务端强制检查。已有任务保留原权限。

界面支持简体中文与英文。在控制窗底部的语言下拉框选择，控制窗、API 配置窗、模型配置窗立即同步，保留未保存的表单输入。没有连接 MCP 时也能切换；选择保存在当前项目的 `<data_dir>/desktop/window.json`，重启后恢复。新打开的模型验证确认框也使用所选语言。

文案分别位于 `resources/locales/zh-CN.json` 和 `resources/locales/en-US.json`，语言名称与列表在 `resources/languages.json`。添加语言时登记列表、提供同键名 JSON 并重新构建；缺失翻译回退到中文，资源支持 `{name}` 占位符。错误提示通过资源映射，不直接显示后端错误文案。API 名称、模型 ID 等用户填写的数据保持原样。

启动时可通过 `DSH_UI_LOCALE=en-US` 或 `DSH_UI_LOCALE=zh-CN` 覆盖已保存的选择；未指定时默认采用已保存语言，首次使用默认中文。语言只改变桌面显示，不改变模型、预算、计费币种或 MCP 工具协议。`pnpm test:i18n-ui` 验证切换、持久化和英文布局，不调用付费模型。

Win32 归属辅助进程只修改控制窗自身，识别桌面 Codex（含 OpenAI.Codex 包下的 ChatGPT.exe），找不到时保持普通非置顶隐藏任务栏窗口并定期重试。多个 Codex 窗口优先选择前台窗口，否则选择一个可见主窗口；绑定后保持稳定。Codex 最小化时所属窗口遵循 Windows 的归属行为。关闭 Codex 可能连同控制窗关闭，MCP 生命周期仍独立。控制窗关闭后，可再次执行启动命令打开。

## 启动

当前 Windows 集成注册一个用户级桌面监听器。它通过 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 在登录时无窗口启动，并每 500 毫秒检查当前桌面会话的 Codex 主窗口；检测到桌面进程的新实例后，立即启动控制窗，不必进入 work、建立 MCP 连接或发出模型请求。Electron 自身初始化仍需少量时间。普通 Codex CLI 和其他 ChatGPT 应用不会触发。

Electron 界面进程必须使用 `windowsHide: false`，由 `BrowserWindow` 控制初始显示与焦点；后台 Node/Python/PowerShell 辅助进程才隐藏启动。对 Electron 设置隐藏启动会让 Windows 的首次显示调用仍保持隐藏，可能出现空框或无法操作的旧画面。启动脚本的输出只表示请求已发送；窗口是否可见须独立验证。回归测试使用实际 `scripts/start-ui.mjs` 连续关闭、重开，避免直接运行 Electron 绕过安装路径。

监听器使用按安装位置和配置区分的 Windows 命名互斥锁。每个 Codex 进程实例只触发一次，并比较进程创建时间以处理 PID 复用。相同 `data_dir` 的 Electron 单实例锁防止窗口重复；自动启动不抢焦点。手动关闭后，本次 Codex 运行期间保持关闭，下一次 Codex 桌面进程启动时重新打开；窗口恢复不会自动解除用户停用状态。已处理的进程实例会持久保存，监听器自身重启也不会反复弹窗。

安装器或 `Connect to Codex.cmd` 自动注册并启动监听器；卸载只删除本安装拥有且未被用户修改的启动项，并停止监听器。不会改写 Codex 快捷方式或程序文件。状态写入配置文件旁的 `ui-startup-status.json`，只包含进程身份、启动时间及错误代码，不读取聊天内容。`ui_auto_start: false` 会被监听器动态读取以关闭自动打开；该设置不关闭已打开窗口。源码运行前需先构建 UI。

安装及恢复启动通过现有 Windows 桌面启动监听器，避免继承 Codex 的随进程退出清理规则。MCP 初始化时会检查监听器的实时就绪事件，不能仅凭“已注册”文件跳过启动；监听器已退出时自动恢复，正常运行时不会干扰手动关闭的窗口。如果桌面启动通道不可用，记录诊断并回退到直接打开窗口。该恢复不修改外包开关、预算或 API 配置。

尚未注册桌面监听器的源码/手动安装仍保留 MCP 初始化时打开窗口的兼容路径。隔离安装测试可传 `/UISTARTUP=0`，命令行注册可用 `--no-ui-startup` 跳过 Windows 启动项；这不会改变 MCP 或提交快照配置。

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

展开窗口后，底部显示“关闭DSH as Subagent”；标题栏和紧凑模式没有关闭按钮。点击后需要确认，默认选中取消。窗口系统的关闭操作也走同一确认流程。确认会先原子保存全局服务停用状态，再停止所有聊天的外包代理、撤销待执行消息，并按受影响的请求聊天各排队发送一条停用通知。完成的聊天不会被无关通知唤醒。后端保留 MCP 连接和工具清单，以 `OUTSOURCING_DISABLED` 拒绝请求；`get_status` 仍可读取停用原因。

服务停用优先于提交快照，与仅修改下一轮配置的普通开关不同。每个服务既监听停用状态，也在工具调用及每次模型请求前检查；子代理也受同一限制。停止失败时保留占用并重试清理，控制窗不会把未确认退出显示为成功。重开窗口并打开“启用外包”后，只允许新提交的任务；旧轮次和旧代理句柄不会恢复。用量、已产生的费用和已完成的文件修改保留。

停用通知独立于 `notify_on_completion`，使用原有精确聊天绑定和回传记录去重。App 工具通道可直接发布；显式使用 `codex_queue` 时仍是待发送队列。发送失败或结果不明会记录在本地回传账本，不把未知结果自动重发；停用和拒绝请求不依赖消息发送成功。安装维护用 `--quit` 只重启界面，不代表用户停用服务。

控制窗直接编辑后续任务的共享默认设置，不依赖任何聊天或模型先调用工具。开关、顶层代理数量、二次外包开关/深度/数量和两种预算均可预先保存。API 和模型管理窗口照常使用。

提交任务时通过已审查的 Codex `UserPromptSubmit` 钩子截取快照；之后编辑不会改变运行中的任务。首次使用时优先在 Codex App 的钩子审核弹窗中审查并允许 dsh；CLI `/hooks` 是备用入口。完整边界见 [配置快照](task-snapshots.md)。

窗口不再提供聊天选择。在线数量汇总所有已连接 work，点击展开 work 名称及其每个在线子代理的名称、模型和推理强度。名称从本地 Codex 索引读取并跟随重命名；无标题时回退为工作区名。没有在线代理时显示 0；服务断开后排除其陈旧数据。标题索引和代理信息仅在本地显示。

## 自定义界面

推荐使用 `Dashboard` 控制抽象层，避免直接解析代理状态文件。见 [控制层](control-layer.md)。Electron 主进程负责本地配置和鉴权连接，renderer 不接触密钥或连接令牌。

## English

The Windows companion opens the control panel when the Codex desktop window starts, before entering a work or connecting MCP. It runs hidden at user logon and is launched through the existing Windows desktop so it survives Codex's process cleanup. MCP initialization checks a live readiness event and recovers a missing listener. Manual closure lasts for the current Codex process generation, including listener recovery; restarting Codex opens the panel again without re-enabling a stopped outsourcing service. Uninstall removes only its owned startup entry. The floating orb and minimize button have been removed; compact mode remains. Settings, submission snapshots, aggregate online details and both languages remain available.
