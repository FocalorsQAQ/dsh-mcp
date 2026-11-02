# 多聊天连接

共享 MCP 连接按宿主请求元数据中的精确 chat ID 路由。每个聊天有独立服务、任务注册表、消息队列、回传和费用账本；同一聊天的多个连接复用服务，空闲时释放进程，重连恢复持久状态。API/模型配置和下一轮默认设置共享。

从 0.1.7 起，Codex `UserPromptSubmit` 在模型运行前保存 chat/turn 对应的不可变配置。MCP 从 `_meta` 的 thread/turn 字段识别所属任务，不接受模型填写的预算轮次参数；turn 缺失时按精确聊天 ID 读取本地记录。无有效快照即拒绝外包，不以首次工具调用时间代替提交时间。详见 [配置快照与钩子审核](task-snapshots.md)。

默认开关、预算和模型配置变化只影响随后提交的任务。原任务及其所有外部子代理继续使用原快照。每聊天账本包含多个主模型轮次，原轮次的迟到费用仍计入原轮次和聊天累计任务花费，不因连接更换或 followup 清零。不同聊天不共享预算池；没有全局总花费上限。

工具清单保持稳定，关闭快照下 `get_status` 提示“外包已禁用”，其余调用在服务端被拒绝。不会清除上下文或靠动态删除工具表示权限。工具的展示说明可能被 Codex 缓存，提交上下文和请求约束才是本轮依据。

控制窗不再选择聊天。它随时编辑共享默认值，并订阅所有已有聊天服务汇总在线数量；展开后按 work 名称显示子代理、模型和推理强度。已移除悬浮球和最小化按钮。名称只从本地 `session_index.jsonl` 按精确 UUID 解析，不读取聊天正文。

数据隔离不复制项目：主模型用 `create_workspace` 注册已有目录或创建新目录，以 `spawn_agent.workspace_id` 选择。注册按聊天保存；开启“仅限主 agent 工作区”时，快照中的提交目录成为该轮权限边界。子代理继承父代理的工作区和目录范围，主模型继续协调并行文件修改。详见 [工作区管理](workspaces.md)。

## 验证

`test:multi-client` 使用真实 MCP、Harness SDK/CLI 与本机模拟模型测试隔离、快照、断线续跑和重连。`test:dashboard-ui` 测试无服务时修改预算、跨 work 明细、名称更新和紧凑模式。`test:startup-watcher` 验证不依赖 MCP 的桌面启动。`test:task-hook` 在独立 Codex 测试目录验证提交时机及上下文注入。均不调用付费模型。

## English

Each chat owns its agent service, workspace registrations and ledger; provider configuration and defaults are shared. A trusted submission hook captures immutable chat/turn settings before model execution, including the workspace restriction. Subsequent edits affect future submissions only. Missing snapshots fail closed. The dashboard aggregates active agents across works without choosing a chat. The main caller can register projects; children inherit the selected workspace and cannot expand their parent scope.
