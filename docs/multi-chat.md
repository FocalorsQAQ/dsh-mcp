# 多聊天连接 / Multiple chats

默认 MCP 入口为 `packaging/launch-server.mjs`。v0.1.5 同时支持启动时绑定聊天和在每次请求的宿主元数据中绑定聊天。Codex 的全局工具发现、不同聊天以及同一聊天的重复连接可以同时使用它。

## 连接与存储

```text
Codex 聊天 A 的 stdio 连接 1 ─┐
Codex 聊天 A 的 stdio 连接 2 ─┴─ A 的后台服务 → data/chats/<A>/
Codex 聊天 B 的 stdio 连接 ───── B 的后台服务 → data/chats/<B>/
无启动聊天 ID 的共享连接 ────── 元数据路由服务 → data/chats/discovery/
                               └─ 按请求中的聊天 ID 接入 A / B 服务
                         共用 API/模型配置 → model_config_dir 或 data/
```

启动身份按 `--session-id`、`CODEX_THREAD_ID`、配置中的 `codex_thread_id` 顺序选择，必须是 UUID。没有启动 ID 时进入共享路由服务：每次工具请求读取宿主提供的 `_meta.threadId` / `_meta.thread_id`；也兼容 `x-codex-turn-metadata` 中的同名字段。身份缺失时仅允许共享模型查询，任务操作返回 `SESSION_REQUIRED`。冲突、非法 UUID 或与固定连接不一致的身份被拒绝。模型参数没有聊天路由选项，不能用 `source_thread_id` 等任务参数替换调用身份，也不根据最近活动猜测聊天。

本机 Codex 实测会在请求元数据中提供聊天 ID，启动环境变量中没有该值。因此不应只用手动设置 `CODEX_THREAD_ID` 的客户端验证兼容性。`scripts/test-codex-host.mjs` 用真实 Codex app-server 和隔离配置验证这一路径，不执行模型轮次或调用模型 API。

共享连接也会按 `ui_auto_start` 打开控制窗。v0.1.6 将外包开关提升为所有聊天共用的总开关，保存于根目录 `outsourcing.json`（可通过 `control_config_dir` 指定独立目录）。窗口直接使用控制层读取和修改它，不需要任何代理先调用工具。初始化 instructions 和工具说明包含当前状态快照；`get_status` 始终可用，每次读取最新开关，不启动聊天服务或模型。关闭后其他工具仍在清单中，但调用返回 `OUTSOURCING_DISABLED` 和“外包已禁用”提示。任务调用和每次付费请求同步读取开关，不能靠缓存工具或旧子代理绕过。

切换时更新说明并发送标准 MCP `notifications/tools/list_changed` 通知；支持刷新的客户端可立即更新说明。本机测试的 Codex 26.1027.3384.0 会缓存已建立连接的工具说明，因此**运行时保留稳定工具清单，不尝试删除历史或清理模型上下文**。初始化指令要求代理外包前调用 `get_status`，不能把旧说明当作当前权限；已有聊天在下一次查询或调用时收到最新禁用提示。开关不依赖描述刷新，无需重启；它不会向所有聊天另发用户消息，也不承诺直接插入正在生成的模型上下文。升级程序后仍应重启 Codex 以加载新版服务。

除 `get_status` 外，首次带聊天身份的调用仍按需启动对应聊天服务；此前可以使用总开关、API 和模型窗口，而所选聊天的任务与用量等待连接。全局清单不包含某个聊天的预算，调用结果的 `control.chat_id`、预算和限制属于实际调用聊天。

每个聊天有独立的 `AgentManager`、数据锁、任务注册表、消息队列、回传记录、预算账本及除总开关外的控制设置。同一聊天的多个连接复用它；不同聊天不能通过 `read_agent` 等工具读取彼此的任务。`max_concurrent_agents`、`max_agents`、本轮预算和任务总预算均按聊天执行，没有跨聊天的总并发或总费用上限。USD 和 CNY 分别累计，不做汇率转换。用户轮次仍由可信宿主的 `beginRound` 标识；新连接和重连不会重置预算。

API 密钥和模型配置共用 `model_config_dir`，默认是根 `data_dir`。UI 的“当前聊天”切换任务控制和费用视图，悬浮球显示所选聊天并发；API/模型窗口仍管理同一套共享配置。数据隔离不会创建独立工作区：代理继续使用指定工作区，主模型仍需协调并行文件修改。

聊天标签按精确 UUID 从 Codex 的本地 `session_index.jsonl` 读取 `thread_name`，约一秒刷新一次；不读取聊天正文、不向外发送标题。重名时加短 ID 区分，标题缺失时回退到短 ID/工作区。选择和写入仍以完整 UUID 校验。

## 生命周期

stdio 进程只是连接适配器，后台服务通过仅监听 `127.0.0.1` 的随机端口提供 MCP。每代服务产生认证令牌，发现文件只保存在本机聊天目录。令牌不传给 UI 页面或写入日志。目录中的 `session.json` 仅保存 ID、工作区、创建时间和进程 ID，供自定义 UI 发现聊天；不是存活证明。

断开任意一个连接不会关闭其他连接。即使最后一个连接断开，运行中的任务也继续执行，并受已有预算和任务超时限制；需要停止时使用 `interrupt_agent` 或 `close_agent`。没有 MCP 连接且没有活动任务时，服务默认空闲 60 秒后退出。`session_idle_timeout_ms` 可设为 1000–1800000 毫秒；UI 订阅不阻止空闲退出。

重连自动启动或复用对应服务，从原聊天目录恢复账本和代理记录，不自动重放中断的任务。共享路由会释放空闲的内部连接，不中止已启动的任务。显式结束聊天服务时清理它的工作进程。恢复仍使用原来的进程身份校验和排他锁，不通过删除活跃锁来允许并发。见 [崩溃恢复](recovery.md)。

相同聊天不能同时使用不同版本或不同有效配置。检测到仍有旧服务时返回 `SESSION_CONFIG_CHANGED`，需结束旧 MCP 连接，等待无任务的服务空闲退出后重连；升级后建议重启 Codex。不要手工删锁绕过检查。

这些边界约束 MCP 与控制 API，不隔离同一系统账户的任意本地程序。目录与认证文件应留在可信本机位置。

## 升级与兼容

旧版根目录的 `state.json`、会话和账本保留，不猜测它们属于哪个聊天，不复制旧任务和费用。新聊天仅继承旧保存的用户控制策略作为初始值；之后各自独立。旧策略损坏时拒绝启动，避免悄悄取消预算限制。UI 会把根目录条目标为“升级前的会话”；旧服务退出后该条目显示离线。

不能提供请求元数据的其他 MCP 客户端可在启动时传入稳定的聊天 UUID：

```powershell
node packaging/launch-server.mjs --config dsh.config.json --session-id 10000000-0000-4000-8000-000000000001
```

仅需原有单连接行为的可信宿主可使用 `--single-session`。它直接使用指定的 `data_dir`，断开连接会停止服务和工作进程，仍不允许多个进程争用同一目录。`--doctor` 不启动服务、不调用模型。

## 验证

`pnpm test:multi-client` 使用真实 MCP、官方 SDK/CLI 和本机模拟模型，覆盖并行发现与聊天连接、同聊天复用、独立任务和预算、跨聊天读取拒绝、认证失败、活动任务跨断线、空闲清理和持久化重连。`pnpm test:session-ui` 使用真实 Electron 验证切换、旧页面写入拒绝、预算隔离、共享 API/模型和悬浮球。均不调用付费模型。

## English

The default launcher multiplexes each chat's stdio clients onto one authenticated
local background service. Different chat UUIDs have independent tasks, queues,
budgets, limits and state under `data_dir/chats/<UUID>/`. API credentials and model
configuration remain shared. The desktop selector and orb follow the selected
chat; working directories are still explicitly configured and may be shared.

Codex supplies caller identity in request metadata rather than startup environment
variables. Version 0.1.5 routes each call using that identity and opens the UI on
shared-connection initialization. Calls without identity can only query shared
models and the global status. Invalid or conflicting identities fail closed; no
model argument selects the calling chat. Version 0.1.6 keeps a stable inventory:
get_status always reads the live shared switch, and other calls return an explicit
disabled notice when off. Instructions require a status check before delegation;
cached tool descriptions do not grant permission. No history is removed. Existing
chats receive the updated notice at their next status query or call, without a
restart or an unsolicited chat message. Chat budgets remain independently enforced.
Hosts without request metadata must pass a stable `--session-id <UUID>`.
Closing a connection does not stop
other clients or active tasks. With no clients and no active tasks, the service
exits after 60 seconds by default. Reconnection retains that chat's records and
never resets budgets or automatically replays interrupted inputs. Existing root
state is retained separately during upgrades; only its control policy is used as
the initial policy for new chats. `--single-session` retains the earlier exclusive
single-client behavior.
