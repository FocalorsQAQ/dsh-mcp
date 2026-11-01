# 多聊天连接 / Multiple chats

v0.1.4 的默认 MCP 入口为 `packaging/launch-server.mjs`。Codex 的全局工具发现、不同聊天以及同一聊天的重复连接可以同时使用它。

## 连接与存储

```text
Codex 聊天 A 的 stdio 连接 1 ─┐
Codex 聊天 A 的 stdio 连接 2 ─┴─ A 的后台服务 → data/chats/<A>/
Codex 聊天 B 的 stdio 连接 ───── B 的后台服务 → data/chats/<B>/
全局工具发现（无聊天 ID）────── 只读目录服务 → data/chats/discovery/
                         共用 API/模型配置 → model_config_dir 或 data/
```

聊天身份按 `--session-id`、`CODEX_THREAD_ID`、配置中的 `codex_thread_id` 顺序选择，必须是 UUID。没有 ID 时进入 `discovery`：可列出工具和模型，执行、跟进或控制代理会返回 `SESSION_REQUIRED`，不会自动打开窗口。不能根据最近活动猜测聊天，也不能把多个聊天配置成同一个固定 ID。

每个聊天有独立的 `AgentManager`、数据锁、任务注册表、消息队列、回传记录、预算账本和控制设置。同一聊天的多个连接复用它；不同聊天不能通过 `read_agent` 等工具读取彼此的任务。`max_concurrent_agents`、`max_agents`、本轮预算和任务总预算均按聊天执行，没有跨聊天的总并发或总费用上限。USD 和 CNY 分别累计，不做汇率转换。用户轮次仍由可信宿主的 `beginRound` 标识；新连接和重连不会重置预算。

API 密钥和模型配置共用 `model_config_dir`，默认是根 `data_dir`。UI 的“当前聊天”切换任务控制和费用视图，悬浮球显示所选聊天并发；API/模型窗口仍管理同一套共享配置。数据隔离不会创建独立工作区：代理继续使用指定工作区，主模型仍需协调并行文件修改。

## 生命周期

stdio 进程只是连接适配器，后台服务通过仅监听 `127.0.0.1` 的随机端口提供 MCP。每代服务产生认证令牌，发现文件只保存在本机聊天目录。令牌不传给 UI 页面或写入日志。目录中的 `session.json` 仅保存 ID、工作区、创建时间和进程 ID，供自定义 UI 发现聊天；不是存活证明。

断开任意一个连接不会关闭其他连接。即使最后一个连接断开，运行中的任务也继续执行，并受已有预算和任务超时限制；需要停止时使用 `interrupt_agent` 或 `close_agent`。没有 MCP 连接且没有活动任务时，服务默认空闲 60 秒后退出。`session_idle_timeout_ms` 可设为 1000–1800000 毫秒；UI 订阅不阻止空闲退出。

重连自动启动或复用对应服务，从原聊天目录恢复账本和代理记录，不自动重放中断的任务。显式结束服务时清理它的工作进程。恢复仍使用原来的进程身份校验和排他锁，不通过删除活跃锁来允许并发。见 [崩溃恢复](recovery.md)。

相同聊天不能同时使用不同版本或不同有效配置。检测到仍有旧服务时返回 `SESSION_CONFIG_CHANGED`，需结束旧 MCP 连接，等待无任务的服务空闲退出后重连；升级后建议重启 Codex。不要手工删锁绕过检查。

这些边界约束 MCP 与控制 API，不隔离同一系统账户的任意本地程序。目录与认证文件应留在可信本机位置。

## 升级与兼容

旧版根目录的 `state.json`、会话和账本保留，不猜测它们属于哪个聊天，不复制旧任务和费用。新聊天仅继承旧保存的用户控制策略作为初始值；之后各自独立。旧策略损坏时拒绝启动，避免悄悄取消预算限制。UI 会把根目录条目标为“升级前的会话”；旧服务退出后该条目显示离线。

其他 MCP 客户端可传入稳定的聊天 UUID：

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

Clients without a chat ID are discovery-only and cannot execute tasks. Other MCP
hosts must pass a stable `--session-id <UUID>`. Closing a connection does not stop
other clients or active tasks. With no clients and no active tasks, the service
exits after 60 seconds by default. Reconnection retains that chat's records and
never resets budgets or automatically replays interrupted inputs. Existing root
state is retained separately during upgrades; only its control policy is used as
the initial policy for new chats. `--single-session` retains the earlier exclusive
single-client behavior.
