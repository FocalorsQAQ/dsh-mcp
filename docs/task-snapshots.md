# 提交时配置快照 / Submission snapshots

从 0.1.7 起，控制窗编辑所有聊天共用的**后续任务默认设置**。没有 MCP 聊天服务、没有模型调用时也能保存。提交任务时才固定这轮配置，之后更改开关、预算、代理数量或模型选择，不影响已经提交的任务。

## 提交边界

安装注册在 Codex 用户配置中添加 `UserPromptSubmit` 命令钩子，执行 `packaging/prompt-hook.mjs --config <dsh.config.json>`。该钩子在模型处理用户任务前运行，保存开关、代理数量、二次外包限制、USD/CNY 预算及启用的模型和推理强度列表，并作为 developer context 提供给主模型。它不调用模型 API，不保存用户 prompt、聊天正文或密钥。

**首次安装需用户审查并信任该钩子。** 优先使用 Codex App 的审核弹窗，CLI 的 `/hooks` 是备用入口。Codex 会跳过新建或修改后尚未信任的定义；安装器只注册，不写信任记录，也不设置跳过审核的选项。若用户关闭了 hooks 功能，需要先重新启用。参见 [Codex 官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks)。可用安装目录的 `Review task hook.cmd` 打开 CLI 完成审查。

这里验证的是本地 Codex 执行流程；不承诺云端编排会执行本机命令钩子。没有有效快照时，dsh 拒绝执行外包，返回 `TASK_SNAPSHOT_REQUIRED`，不会在第一次工具调用时偷偷补拍快照。已开始的旧对话轮次需要重新提交任务。

`session_id` 在原生子代理中可能表示会话根，因此有 transcript 时只读首条 `session_meta.id` 确认准确聊天 ID；不按最近修改时间猜测聊天。`turn_id` 来自宿主提交事件。同一轮重复提交钩子不会替换旧快照，也不会清空预算。

## 存储与强制执行

- 共享默认配置：`<control_config_dir 或 data_dir>/outsourcing.json`，版本 2，`settings` 加独立递增 `revision`；兼容迁移旧总开关和旧根目录默认策略。
- 不可变快照：`task-snapshots/<chat UUID>/<turn UUID>.json`。原子保存并通过跨进程锁防止重复提交覆盖；`current.json` 仅用于查看，不能单独作为 MCP 请求身份依据。
- 每聊天账本：`data_dir/chats/<chat UUID>/state.json` 的 `control.rounds` 保存已使用快照和本轮花费，所有代理及后续消息按所属主模型轮次记账。
- MCP 用宿主请求元数据识别 chat/turn；未带 turn 时，按精确 chat UUID 查本机 Codex 记录。服务端对每个请求隔离轮次，交错运行的旧任务不会串用新设置。
- 每次付费请求仍先预留预算并持久化。`budget` 为逐币种 `min(本轮预算, 任务剩余额度)`，`available_budget` 再扣除相关已花费和在途预留。`null` 是无限额；`[0,0]` 禁止付费调用。没有汇率折算。
- 模型和推理强度按快照选择；模型勾选变化或从列表移除仅影响新提交。删除 API key 或改变其协议/地址会使旧来源失效，旧任务也不能绕过凭据撤销。
- 二次外包继承所属轮次及父代理模型来源，用户与主模型都须授权。跨轮排队的 followup 在真正开始时再次检查新轮的顶层代理数量限制。

全局默认开关不再是运行中任务的急停。关闭表示**以后提交的任务禁止外包**；当前代理仍可通过 MCP 的暂停、打断或关闭工具控制。

## UI 与第三方适配

`Dashboard(config)`（导出路径 `dsh-mcp/dashboard`）提供 `snapshot()`、`updateSettings(patch, revision)`、`subscribe()`、`start()`、`close()`。设置直接落盘，无需聊天连接；运行信息只订阅已有聊天服务，不创建代理。

`snapshot()` 返回 `global_control`、`runtime.online_count` 和 `runtime.works`。每个 work 含 `id`、可读 `title`、在线代理数组（`name`、`path`、`model`、`reasoning_effort`）。包含二次外包代理；断开服务后不沿用陈旧数量。标题来自精确 ID 的 Codex 名称索引，不读取聊天正文。无名称时显示工作区名称。

控制窗不再选择聊天，也不显示实时费用和 token 卡片。在线数量可展开 work 明细；悬浮球和最小化按钮已移除。账本仍采集用量，可通过原控制 API 读取。

独立嵌入者不提供 `codex_thread_id` 时可继续使用原 `beginRound` / `updateSettings` 接口；Codex 集成则必须使用上述提交快照流程。`UiClient` 保留读取单个服务和旧嵌入接口的兼容性，新 UI 应使用 Dashboard。

用户在配置窗确认“关闭DSH as Subagent”是即时撤销授权，优先于不可变快照。全局停用保存修订号并终止各聊天代理；重新启用后，修订号早于此次停用的快照继续拒绝，新提交才会获得授权。旧快照、账本和文件结果不会被改写或清零。

## English

Settings are always editable and apply to future submissions. The trusted local Codex `UserPromptSubmit` hook freezes one configuration per chat/turn before the model runs. Running tasks and their descendants retain their original budget and model selection. Repeated hooks cannot refresh the snapshot or reset spending. Missing snapshots fail closed.

User-confirmed service shutdown is an immediate revocation, overriding existing snapshots. It stops workers and notifies affected calling chats once. Re-enabling allows new submissions only; revoked turns and old agent handles stay blocked.

Review the installed hook with `/hooks` in the Codex CLI before submitting a new task. Registration does not trust it automatically. The dashboard aggregates online subagents across works, with names, models and reasoning efforts, and has no chat selector. Credentials remain outside snapshots; deleting a source still revokes access.
