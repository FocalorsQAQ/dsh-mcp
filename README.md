# DeepSeek Harness as Subagent · dsh MCP

[MIT](LICENSE) · [Windows 下载](https://github.com/FocalorsQAQ/dsh-mcp/releases/tag/v0.1.4) · [安装说明 / Installation](docs/install.md)

**在线安装器从 GitHub 下载程序及 DeepSeek Harness CLI 核心运行包，并校验文件。手动安装必须同时下载程序 ZIP 与 CLI 核心 ZIP。** CLI 来自官方 dsh 项目，本项目将固定版本的官方 npm 包及其依赖重新分发为 GitHub Release 附件，详见[来源和安装方式](docs/install.md)。本项目为独立社区集成，非 DeepSeek 或 OpenAI 官方产品。

为 Codex 等 MCP 客户端提供接近 collaboration v2 的外部子代理接口。MCP 服务名为 **`dsh`**，底层通过官方 TypeScript SDK 启动 **DeepSeek Harness CLI 的 `sdk` profile**，每个代理拥有独立的持久会话和 Harness home。

新增独立的控制抽象层和 **Electron 悬浮控制窗**：用户开关、顶层并发、二次外包授权和上限、主代理用户轮次共享预算、跨轮总预算与用量记账。已加入 [API 配置管理](docs/api-management.md)，支持四种协议及密钥加密存储，并提供 [模型配置与验证](docs/model-management.md)。Windows 上默认在 Codex 连接 dsh 时自动打开控制窗，已有窗口会复用且不抢焦点；也可运行 `pnpm ui` 手动打开。设置 `"ui_auto_start": false` 可关闭自动打开。详见 [桌面控制窗](docs/desktop-control.md)和[控制层 v1](docs/control-layer.md)。**二次外包默认需要用户在界面或 `control.allow_secondary` 中授权。**

界面支持**简体中文 / English**。在控制窗底部切换，三个窗口即时同步并记住选择；未保存的表单输入会保留。启动时也可用 `DSH_UI_LOCALE=en-US` 指定英文。

点击最小化可收起为**悬浮球**，实时显示所选聊天的代理并发数（含二次外包）。拖动移动，点击展开；断线时显示离线状态。v0.1.4 修复多聊天与全局工具发现争抢数据目录的问题：每个聊天独立任务、队列和预算，共用 API/模型配置；控制窗可切换聊天。详见 [多聊天连接](docs/multi-chat.md)。

```text
Codex / MCP 客户端
  └─ dsh stdio 连接适配器（17 个工具，同一聊天复用一个后台服务）
       └─ 代理管理器：任务、消息队列、并发限制、状态和结果
            └─ 官方 Harness SDK → 官方 dsh CLI 子进程
                 └─ DeepSeek 官方 API + Harness 工作区工具
```

## 已实现的接口

| 工具 | 行为 |
| --- | --- |
| `spawn_agent` | 立即返回代理 ID 和 `/root/task_name` 路径，后台启动任务。支持 `message`、`cwd`、`model`、`reasoning_effort`、`context`、`parent`、`fork_turns`、`max_depth` 和 `max_children`。 |
| `list_model` | 返回当前已启用的可选模型 ID。 |
| `list_effort` | 输入 `model_id`，返回该模型按用户声明顺序保存的推理强度列表。 |
| `send_message` | 向运行中的代理排队，在当前轮结束后处理；向空闲代理发消息不唤醒它。 |
| `followup_task` | 运行中排队；空闲、失败或中断后启动新一轮，恢复原会话。此前排队消息按顺序先处理。 |
| `list_agents` | 查看状态、任务树、并发使用量和结果摘要；支持 `path_prefix`。 |
| `wait_agent` | 等待任意或指定代理的新事件，返回游标；支持 0–60000 ms，超时或取消等待不停止代理。 |
| `interrupt_agent` | 关闭运行进程并等待退出；保留会话和待处理消息，以便显式继续。已开始的输入不会自动重试。 |
| `read_agent` | 查看状态、最近事件、消息队列及分页结果；用 `next_offset` 读取长输出。 |
| `close_agent` | 停止进程、丢弃待处理消息并关闭该代理句柄；结果和会话日志保留。 |
| `batch_control` | 批量发消息、继续、中断或关闭；通过 `targets` 或 `path_prefix` 选择代理，逐项返回成功或错误。 |
| `set_concurrency` | 主代理运行中调整全局并发上限，范围 1–32；保存设置，降低时让已有任务自然完成。 |
| `pause_agent` | 当前轮结束后暂停，保留消息队列和会话，释放工作进程。 |
| `resume_agent` | 取消暂停或继续暂停的队列；不添加提示词，不重放已开始的输入。 |
| `manage_queue` | 查看、分页读取、编辑、删除、重排或清空待处理消息；写操作校验队列版本。 |
| `list_deliveries` | 主代理查看回传记录、状态和发送尝试历史。 |
| `retry_delivery` | 主代理显式重试回传，保留原消息、目标和传输方式。 |

`target` 接受代理 UUID、完整任务路径或不重复的短任务名。`parent` 指定 dsh 父代理；创建下一层需要父代理具有剩余深度和数量额度。状态包括 `starting`、`running`、`pausing`、`paused`、`stopping`、`idle`、`interrupted`、`failed`、`closed`；`finish_reason` 和 `error` 解释结束原因。

## 上游来源与版本

- [官方源码](https://github.com/deepseek-ai/deepseek-harness)的参考提交记录在 `upstream.lock.json`；该源码检出不随本仓库重复提交。
- 实际运行：官方 npm 发布的 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-sdk-client` **0.2.2-alpha.2**；MCP SDK **1.32.2**。依赖由 `pnpm-lock.yaml` 固定。
- GitHub master 与 npm 发布包的版本标签相同，但 master 已有尚未发布的 API 变化。本实现按**安装包的实际类型和行为**适配，从 `turn/end` 事件读取结束原因，不把版本号当作源码完全一致的证明。
- 本项目采用 MIT；上游是 MIT，保留其版权声明与许可证。其他运行依赖保留各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目没有修改上游源码。

## 安装、运行与接入 Codex

普通 Windows 用户请使用 [GitHub Release 安装包](https://github.com/FocalorsQAQ/dsh-mcp/releases/tag/v0.1.4)，其中已包含所需运行环境。以下是源码安装：需要 Node.js **24.9+**、pnpm 和 **Python 3.10+**；Python 计费模块只使用标准库。

计费公式已独立为 `billing/rules.py`，价格表为 `billing/prices.json` 与 `billing/openai-prices.json`。价格表保存后自动重载；可用 `pnpm prices:edit deepseek` / `pnpm prices:edit openai` 打开编辑器，`pnpm prices:check` 校验。可以在配置的 `billing.rules` 中指定自己的 Python 文件；预算、账本和异常处理仍由服务端执行。详见 [Python 自定义计费](docs/billing.md)。

```powershell
pnpm install --frozen-lockfile
pnpm run build
pnpm run doctor
```

`pnpm install` 同时下载并安装必需的 DeepSeek Harness CLI 与匹配 SDK；不能只下载本项目源码后跳过依赖安装。

编辑根目录 `dsh.config.json`：`workspace_root` 指定允许启动任务的项目根目录，`data_dir` 保存代理状态和会话。相对路径以配置文件所在目录为基准。默认工作区是本项目，默认最多并发 4 个代理，每轮最长 30 分钟。

将 `.env.example` 复制为 `.env`，在本机填写 `DEEPSEEK_API_KEY`；也可以由启动 Codex 的环境提供该变量。密钥不应放进工具参数或聊天消息。`.env` 已被忽略；下面的启动命令会读取它，已存在的环境变量优先。

```powershell
node --env-file-if-exists=.env packaging/launch-server.mjs --config dsh.config.json
```

这是 stdio 服务，启动后等待 MCP 请求；stdout 专供 JSON-RPC，诊断写入 stderr。`--doctor` 检查配置和依赖，不调用模型，也不打印密钥。

**Windows 安装版默认自动接入 Codex**，安装后重启 Codex 即可加载。它会备份配置并保留原有设置，遇到不同的同名 `dsh` 配置则提示手动处理。手动 ZIP 安装可运行 `Connect to Codex.cmd`。源码配置模板在 `config/codex.toml`：替换占位路径，再合并到用户配置或受信任项目的 `.codex/config.toml`。安装版也保留 `codex-mcp.toml` 供手动接入。

按 Codex 客户端的展示方式，工具通常以 `mcp__dsh__spawn_agent` 等名称出现。stdio 的 `command`、`args`、`cwd`、环境变量及超时配置依据 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

默认入口按 `CODEX_THREAD_ID` 绑定聊天，每个聊天的后台服务独占 `data_dir/chats/<聊天 UUID>/`，同一聊天的多个 stdio 连接复用该服务。不同聊天可共用根数据目录及 API/模型配置。没有聊天 ID 的连接仅用于工具发现，不能执行代理任务；其他 MCP 客户端需传 `--session-id <UUID>`。诊断或旧宿主可使用 `--single-session` 保留原来的单连接模式，独占所指定的数据目录。详见 [多聊天连接](docs/multi-chat.md)。

## 调用示例

以下是工具参数，实际调用使用客户端展示的 dsh 工具名称。

先通过 API/模型窗口保存并启用模型。`spawn_agent` 工具说明直接列出当前可选 ID；`list_model({})` 返回 ID 列表，`list_effort({"model_id":"gpt-5-mini"})` 返回按声明顺序保存的推理强度。创建时传 `model` 和 `reasoning_effort`，省略时使用第一个启用模型及其第一个强度。模型选择和来源绑定在服务端强制校验。当前付费外包已适配 DeepSeek 官方目录与 OpenAI 官方 `gpt-5-mini`，其他模型需先补充计费适配。详见 [模型配置与路由](docs/model-management.md)。

```json
{"task_name":"review","message":"检查 src/manager.ts 的生命周期处理，只给出问题列表。","context":"这是初版外部子代理管理器，请重点检查并发和中断。"}
```

1. 调用 `spawn_agent`，保存返回的 `agent.id` 和 `cursor`。
2. 调用 `wait_agent`：`{"targets":["<agent-id>"],"after_cursor":1,"timeout_ms":30000}`。将示例中的 `1` 替换为实际游标，之后始终使用新返回的 `cursor`。
3. 若 `has_more` 为 `true`，继续读取下一页；若 `history_gap` 为 `true`，通过 `read_agent` 获取当前状态和结果。
4. `read_agent`：`{"target":"<agent-id>"}`。有 `next_offset` 时继续分页。
5. `followup_task`：`{"target":"<agent-id>","message":"根据审查结果修复第一个问题。"}`。
6. 不再使用时调用 `close_agent`。

省略 `after_cursor` 时使用当前服务进程的共享消费游标；多个独立观察者应显式保存各自的游标。事件历史默认只保留最近 1000 条，完整对话由 Harness 的会话日志保存。

## 上下文继承示例

```json
{"task_name":"review","message":"检查项目，允许为独立问题创建子代理。","max_depth":1,"max_children":2}
{"task_name":"child","parent":"/root/review","message":"继续检查剩余问题。","fork_turns":"all"}
```

将 `fork_turns` 改为 `"none"` 即不自动继承。`parent` 接受代理 ID 或任务路径；不指定 `parent` 时，`all` 优先使用显式 `context`，否则通过 `source_thread_id`、配置 `codex_thread_id` 或 `CODEX_THREAD_ID` 精确定位本地 Codex 聊天。继承内容只在新会话首次输入时注入，后续 `followup_task` 使用其自身持久会话。

## 二次外包控制

`spawn_agent` 新增两个可选的非负整数：

| 参数 | 顶层默认值 | 含义 |
| --- | --- | --- |
| `max_depth` | `0` | 新代理下面还能派生几层。`0` 禁止继续外包，`1` 允许一层，`2` 允许两层。 |
| `max_children` | `1` | 每个代理一生累计可以创建的直属子代理数，已关闭的也计数；`0` 禁止创建。 |

```json
{"task_name":"lead","message":"完成检查，可把独立检查项交给子代理。","max_depth":2,"max_children":3}
```

当用户同时设置 `allow_secondary:true`、`max_depth_user >= 2`、`max_children_user >= 3` 时，这允许 `lead` 创建最多 3 个直属子代理，各自最多再创建 3 个代理；最深一层不能继续外包。更小的用户上限会收紧模型请求的值。子代理省略参数时继承父代理的 `max_children` 和减 1 后的 `max_depth`，显式参数只能收紧继承限制，不能放大。额度保存到本地状态，继续任务、关闭代理和重启服务均不会重置。`list_agents`、`read_agent` 和 `spawn_agent` 返回保存的额度、当前有效额度与 `children_count`。

具有额度的工作进程通过 Harness 官方 MCP 客户端获得 14 个 `mcp__dsh__*` 工具，包括模型与强度查询；全局 `set_concurrency`、`list_deliveries`、`retry_delivery` 仅提供给主调用方。服务端绑定调用者身份，省略 `parent` 即创建自己的直属子代理；它只能查看自身及后代、控制后代，不能指定其他代理或顶层身份来跳过限制。下一层默认 `fork_turns: "none"`，可显式改为 `"all"` 继承其 dsh 父代理上下文。子代理默认不单独向 Codex 聊天回传，父代理通过 `wait_agent` / `read_agent` 收集结果。

同一聊天的所有层仍共享 `max_concurrent_agents` 和 `max_agents`；等待子代理的父进程也占并发槽，额度不足时明确报错。不同聊天分别计数，当前没有跨聊天的全局并发上限。初版中断或关闭一个代理仅影响该代理，已有后代继续由管理器跟踪，可单独中断或关闭。

工作进程控制通道只监听本机回环地址，每个进程使用独立临时凭据，退出时关闭。Harness 内建子代理工具仍关闭，嵌套任务统一经过 dsh 管理器。二次外包及所有后代只能使用父代理的模型和 API 来源；子代理模型清单仅显示自身有效模型，不能通过显式 `model` 或 `parent` 参数绕过。推理强度默认继承父代理，可在同模型已声明档位内调整。此限制约束 dsh 工具调用，不是针对任意工作区脚本的操作系统隔离。

## 批量控制与动态并发

`batch_control` 的 `action` 接受 `send_message`、`followup_task`、`pause_agent`、`resume_agent`、`interrupt_agent`、`close_agent`。前两种必须提供共用的 `message`，其余不能传 `message`。选择器必须二选一：`targets` 接受 1–1000 个代理 ID、路径或无歧义短名，同一代理的不同别名只执行一次；`path_prefix` 选择对应任务及其所有后代，主代理可以用 `/root` 选择全部。

```json
{"action":"send_message","targets":["/root/review","/root/test"],"message":"优先检查最近改动。"}
{"action":"followup_task","targets":["/root/review","/root/test"],"message":"继续完成剩余检查。"}
{"action":"interrupt_agent","path_prefix":"/root/review"}
{"action":"close_agent","path_prefix":"/root"}
```

选择在调用开始时固定，先解析并检查所有目标；未知目标、歧义目标或越出调用者范围时，整次请求拒绝且不执行任何操作。执行阶段每个代理独立返回 `results[].ok`、`status` 和可选 `error`，并汇总 `total`、`succeeded`、`failed`；部分成功不会回滚。消息投递仍遵守原有的轮次边界和邮箱顺序。空路径选择返回 `total: 0`。外部子代理的路径选择只包含后代，即使用自身路径也不会停止自己。

批量继续任务仍受并发限制：有空位的接受，没有空位的逐项返回 `CAPACITY`，被拒绝的跟进消息不会写入邮箱。中断保留邮箱，关闭清空邮箱。若关闭进程失败，立即返回该代理的 `CLEANUP` 错误，保留未确认退出的进程名额，其余目标继续处理。工具调用本身成功并不表示所有目标成功，应检查 `failed`。

主代理用 `set_concurrency` 调整所有层共享的并发上限：

```json
{"max_concurrent_agents":8}
```

新上限立即生效，允许值为 1–32。增加后可立即创建或唤醒更多代理；降低不会中断已有工作，新启动请求在占用数小于上限前返回 `CAPACITY`，运行中代理仍可接收排队跟进。当前没有自动等待空位的任务队列。`list_agents`、`wait_agent` 和控制结果包含 `active_count`、`max_concurrent_agents`、`available_slots`、`over_limit`（超过新上限的占用数）。

上限保存在当前聊天的 `state.json`（默认位于 `data_dir/chats/<聊天 UUID>/`）的 `runtime_settings.max_concurrent_agents`，重启继续生效，原配置文件不会被改写；有保存的覆盖值时优先使用该值，否则读取配置。调整上限会产生当前聊天的 `concurrency_changed` 事件，其 `agent_id`、`path`、`status` 为 `null`，即使 `wait_agent` 指定了代理也会返回该事件。相同数值的重复设置不会产生重复事件。外部子代理不获得调整聊天总并发的工具。

## 暂停与恢复

`pause_agent({"target":"/root/review"})` 是轮次边界暂停：已被工作进程领取的当前输入继续执行，状态为 `pausing`；当前轮结束且进程退出确认后，状态变成 `paused`，保留结果和待处理消息并释放并发名额。空闲代理立即暂停。它不会冻结正在进行的 API 请求；需要立即停止时仍使用 `interrupt_agent`，已开始的输入不会自动重放。

`resume_agent({"target":"/root/review"})` 按原顺序处理剩余队列，恢复同一 Harness 会话，不添加新提示词。空队列不调用模型；暂停尚未生效时，恢复会取消暂停请求。需要启动新进程而没有并发名额时返回 `CAPACITY` 并保持暂停。暂停期间 `send_message` 和 `followup_task` 都只入队，返回 `queued_until_resume`。

暂停状态、队列及版本会持久化。暂停过程中关闭服务，尚在执行的输入会记为中断，不自动重新执行；当前轮已完成的结果会保留。单个代理暂停不影响已有后代，可以用 `batch_control` 的 `pause_agent` / `resume_agent` 对整个任务树操作。完成消息在队列处理结束并回到 `idle` 时发送；暂停期间可以用 `read_agent` 查看已完成的当前轮结果。

## 消息队列管理

`manage_queue` 只操作 `pending`，无法修改正在执行或已经处理的输入。所有操作都指定 `target`：

| action | 参数 | 行为 |
| --- | --- | --- |
| `list` | 可选 `offset`、`limit` | 分页列出消息 ID、位置、1000 字符预览和 `revision`。默认每页 20 条。 |
| `read` | `message_id`，可选 `offset`、`max_chars` | 按字符分页读取完整消息。默认 12000 字符。 |
| `edit` | `message_id`、`message`、`expected_revision` | 替换消息文本，保留 ID 和位置，记录编辑时间。 |
| `remove` | `message_id`、`expected_revision` | 删除一条待处理消息。 |
| `move` | `message_id`、`position`、`expected_revision` | 移动到最终队列中的指定位置，从 0 开始。 |
| `clear` | `expected_revision` | 清空待处理消息，保留正在执行的输入。 |

入队、出队和修改都会更新 `queue_revision`。写操作必须使用最近读取的 `revision`，若期间队列改变则返回 `QUEUE_CONFLICT`，不进行修改。建议先暂停并等待 `paused`，再读取和编辑队列。修改队列不会自动唤醒代理。外部子代理可以读取自己的队列，只能修改后代的队列。

## 回传重试

`list_deliveries` 支持 `target`、`status` 筛选和 `offset` / `limit` 分页，提供回传 ID、原目标、消息预览、尝试次数和最近 20 条尝试记录。通过 `retry_delivery({"delivery_id":"<id>"})` 显式重试 `failed` 状态。

`unknown` 和 `queued` 可能已经在目标端留下消息，检查目标后需显式传入 `allow_duplicate: true`；`published` 不允许重试，`pending` / `sending` 拒绝重复提交。重试沿用原消息、聊天、任务轮次和传输方式，不重新执行代理任务，也不自动重试。记录在发送前持久化；发送中退出后恢复为 `unknown`。详细状态见 [完成结果回传](docs/completion-delivery.md)。

## 本地状态与行为边界

- 当前聊天目录（默认 `data_dir/chats/<聊天 UUID>/`）中的 `state.json` 保存代理注册表、账本、队列、当前结果和最近事件，采用临时文件替换写入。同目录的 `agents/<id>/home/` 保存 Harness 会话、缓存和配置。任务文本、输出和提供方凭据可能出现在 Harness 的本地数据中，应按本地开发数据管理，整个目录已被 Git 忽略。
- 断开 stdio 连接只移除该连接，不中断其他连接或运行中的任务。没有 MCP 连接且没有运行任务时，聊天服务默认空闲 60 秒后退出（`session_idle_timeout_ms`）；活动任务仍受其超时及预算约束。显式停止服务会清理它的代理。工作完成后释放 CLI 进程，后续任务恢复同一会话。服务重启后不会自动执行遗留任务；暂停意图保留为 `paused`，其余未结束任务标记为 `interrupted`，已开始的输入都不会自动重试。
- 异常退出后，下一次启动会在操作系统互斥锁内确认旧服务已退出，自动接管 `server.lock` 并清理已知的写入临时文件、旧 UI 连接信息。Windows/Linux 会比较进程创建标识，防止 PID 复用；其他平台遇到仍存在的 PID 会保守拒绝。恢复记录在 `last-recovery.json`，账本和会话保留；中断任务及结果不明的回传不会自动重试。损坏的锁文件仍需人工检查，不能直接猜测归属。详见 [崩溃恢复](docs/recovery.md)。
- 代理共享工作文件，并没有自动创建 Git worktree。并行修改时应明确分配文件。中断和关闭不会撤销已经写入的文件或外部副作用。
- 默认使用 Harness 的 `workspace-write` 和 `approval: never`；这里的 `never` 是**拒绝需要额外批准的操作**。也可配置 `read-only`。工作目录检查解析真实路径以拒绝目录穿越和链接逃逸；具体工具的读写限制由 Harness 执行，外部进程不自动继承 Codex 的权限设置。
- 仅转发操作系统运行必需变量和 `env_vars` 指定的变量，不自动传递无关凭据。工作进程补丁关闭额外会话遥测、日志贡献、插件管理、定时任务及 Harness 内建子代理入口；有外包额度时额外接入受限的 dsh MCP 工具。正常模型请求仍发送完成任务所需的上下文。
- 运行中消息在**轮次之间**处理，不是原生 collaboration 的即时插入。启用 `completion_delivery.mode: "app_tools"` 后，完成结果和失败会自动回传到绑定的 Codex 聊天；`wait_agent`/`read_agent` 也可主动查询。`codex_queue` 只创建待发送项，本机仍需要用户点击发布。
- `fork_turns` 接受 `none`（默认）或 `all`。`all` 对指定 `parent` 创建快照，包含已记录的输入、助手文本及工具调用/结果，也保留父代理继承的历史；不包含尚未处理的排队消息、未提交的流式输出、隐藏推理、系统权限或附件文件本体。快照在创建时固定，后续父代理消息不会同步。父子拥有独立会话。
- 从 Codex 主聊天创建代理时，`fork_turns: "all"` 可以只读导入本机 `sessions/` 中指定聊天的可见历史；来源选择顺序为显式 `context` → `source_thread_id` → 配置 `codex_thread_id` → `CODEX_THREAD_ID`。没有可靠 ID 时报错，不按最近修改时间猜测。存在 `parent` 时，继承 dsh 父代理，`context` 可作为补充。`none` 不自动继承父历史，仍可传入显式 `context`。旧版本代理缺少完整历史时，`all` 明确报错。
- 继承默认最多 1000000 个字符，可通过 `max_context_chars` 调整；超限明确报错，不静默截断。模型提供方自身的上下文窗口仍适用。模型和推理强度由 Harness 实际提供方验证。
- 初版不提供交互式用户问题和审批转接。代理应把需要澄清的内容作为结果交回主代理；未能处理的交互不会被视为批准。
- `max_agents` 限制注册表中的总代理数（包括已关闭代理），默认 100；长时间使用可更换数据目录或调整该上限。

## 验证

```powershell
pnpm test
pnpm run smoke
```

单元测试覆盖消息顺序、会话恢复、动态并发和降低上限、批量授权预检和部分失败、超时、中断、资源清理失败、事件游标、持久化、目录约束和凭据过滤。Windows 的目录链接测试需要系统允许创建 junction。

`smoke` 使用真正的 MCP 客户端、官方 SDK 和官方 CLI，把模型接口指向 `127.0.0.1` 上的模拟服务，检查工具发现、参数验证、流式回复、后续任务、消息队列、中断恢复、嵌套外包、批量控制及并发调整后的重启恢复；还会实际创建测试文件，并验证工作区外的写入被拒绝。它使用虚拟密钥，**不调用真实 DeepSeek API**，报告保存在 `.test-output/smoke/run-*/report.json`。

运行环境若限制本地回环网络或创建子进程，需在正常本机终端执行集成测试。本次已通过标准 MCP 客户端和真实 DeepSeek API 完成一次源码辅助审查（只读快照、`max_depth: 0`、关闭聊天回传）；第一次触及输出预算，随后在同一持久会话中继续并获得结果。`scripts/assist-review.mjs` 是可复用的现场检查脚本，仅应在明确授权将所选源码交给 DeepSeek 审查时运行，常规测试不调用它。

## 代码位置

| 文件 | 职责 |
| --- | --- |
| `src/server.ts` | dsh 工具定义、输入校验和 MCP 返回格式 |
| `src/application.ts` | UI/宿主控制 API 与模型 MCP 的共同入口 |
| `src/multi-client.ts` / `sessions.ts` / `socket-transport.ts` | 多连接适配、聊天目录和后台服务生命周期 |
| `src/control-contract.ts` | 控制协议、货币、策略与计费类型 |
| `src/control-plane.ts` | 用户策略、共享轮次预算、预留和持久账本 |
| `src/models.ts` | 模型目录、元数据读取与复核价格 |
| `src/billing.ts` / `billing/rules.py` | Python 计费适配器与可自定义预留、结算规则 |
| `billing/prices.json` | 基准双币种价格与核验有效期 |
| `src/model-gateway.ts` | 模型请求前检查、提供方凭据隔离和用量解析 |
| `src/manager.ts` | 代理状态、消息、并发、等待和中断 |
| `src/backend.ts` | 官方 Harness SDK 与 CLI 适配 |
| `src/control.ts` | 嵌套外包的调用者身份和任务树范围 |
| `src/control-bridge.ts` | 工作进程专用的本机 MCP 控制连接 |
| `src/store.ts` | 独占数据目录与持久化 |
| `src/config.ts` | 配置、工作区目录和子进程环境 |
| `packaging/launch-server.mjs` / `src/cli.ts` | 默认多聊天入口；兼容单连接模式和诊断 |
| `config/worker.patch.yml` | 工作进程的默认能力和权限配置 |

自动回传的配置、去重和本机接口限制见 [完成结果回传](docs/completion-delivery.md)。项目配置已启用 `app_tools`；普通空配置默认关闭。可用 `notify_on_completion: false` 关闭单个任务回传。

后续适合继续完善的部分：轮次内消息注入、审批转接、共享服务模式和按任务创建 worktree。

本地 Codex 格式、去重和当前工作上下文的区别见 [本地上下文研究](docs/codex-local-context.md)。
