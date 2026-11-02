# 控制抽象层

0.1.7 将可编辑默认配置与运行中任务分离，完整协议见 [提交时配置快照](task-snapshots.md)。

## 推荐入口

第三方 UI 使用 `dsh-mcp/dashboard` 的 `Dashboard`。`start()` 发现并订阅所有聊天运行状态，`snapshot()` 返回共享配置和聚合在线明细；`updateSettings(patch, expectedRevision)` 保存下一轮默认值，独立于 MCP 生命周期。冲突返回 `GLOBAL_CONTROL_CONFLICT`，调用方应重新读取并由用户决定是否重试。

用户确认关闭服务后调用 `await dashboard.stopService()`。此操作先持久化停用，再请求所有已连接服务停止代理；各服务也独立监听共享状态，界面退出不会取消清理。未确认的清理返回 `SERVICE_STOP_UNCONFIRMED`，UI 应保留窗口并提示重试。可信的单服务适配层通过 `DshControlApi.applyServiceStop()` / `UiClient.applyServiceStop()`（鉴权 `POST /v1/service-stop`）应用已经保存的停用；该接口本身不能开启服务，也不是模型工具。

仅需配置存储时使用 `dsh-mcp/global-control` 的 `OutsourcingSwitch`：`snapshot()`、`status()`、`updateSettings()`、`setEnabled()`、`subscribe()`。版本 2 的 `settings` 包含完整 `ControlPolicy`；`enabled` 是公开返回值的兼容别名，不单独保存。

`restrict_to_caller_workspace` 控制工作区是否必须位于主 agent 提交目录内，默认 `false`。UI 用 `updateSettings({restrict_to_caller_workspace: true}, revision)` 修改下一轮默认值；`get_status.control` 和提交提示提供该开关与 `caller_workspace`。旧配置补默认值，不重置预算。`create_workspace` / `list_workspaces` 为主模型接口，不能修改用户权限；详见 [工作区管理](workspaces.md)。

`OutsourcingSwitch.stopService()` 原子设置 `settings.enabled=false` 并写入 `service_stop`（唯一 `id`、递增配置 `revision`、时间 `at`、`active`）。重复停用幂等。显式设置 `enabled=true` 只清除 `active`，保留撤销修订号；此前快照和代理仍不可执行。模型工具与每次 API 预留都检查此状态，普通下一轮参数编辑仍不改变当前任务。无需修改或删除历史上下文。

模型配置仍由 `ModelRegistry` 管理，密钥仍由 `CredentialRegistry` 加密保存。提交钩子同时捕获有效模型选择和声明顺序；后续勾选变化仅影响新任务。API 来源被撤销时会阻止旧任务使用该来源。

## 服务端约束

`TaskSnapshots.capture(chatId, turnId, cwd)` 是可信宿主入口，不注册为模型工具。Codex 使用 `UserPromptSubmit` 自动调用。相同身份只保存一次；MCP 参数中没有用于替换快照、选择聊天或重置预算的选项。

模型继续使用 `get_status`、`list_model`、`list_effort` 和 collaboration 风格工具。`get_status` 在禁用时返回“外包已禁用”；缺失快照拒绝执行。所有工具和付费请求均由宿主强制检查，不依赖模型自觉。动态工具目录只作展示，不作为授权来源。

`ControlPlane.withSnapshot()` 对重叠请求隔离轮次，`MeteringPort` 按原消息轮次预留/结算。子代理继承原轮次，followup 消息记录新请求所属轮次。预算数组为 `[USD,CNY]`，仍按聊天累积任务总花费，各轮共享本轮总预算。

`DshControlApi` 与 `UiClient` 保留旧的单服务读数和独立嵌入接口。没有 Codex 聊天绑定的独立嵌入者可用 `beginRound`；已经绑定提交快照的轮次禁止 `updatePolicy`，应改共享默认值。

## 预算执行与费用精度

请求必须先在同一个主进程里原子预留，持久化成功之后才向提供方发出。每个 API 请求使用独立 ID；结算重复到达不会重复计额。账本按十亿分之一货币单位保存整数，避免大量低价调用被按分舍入为零。

**费用是估算，不是账户账单。** 内置价格来自 2026-10-31 的 [官方美元价格](https://api-docs.deepseek.com/quick_start/pricing/)和[官方人民币价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。工作日北京时间 09:00–12:00、14:00–18:00 为高峰，其余时段、周末和中国节假日按半价估算。使用 UTC 时间戳换算北京时间，不依赖主机所在时区或本地夏令时；不接受缺少偏移量的本地时间字符串。

节假日日历按[国务院 2026 年放假安排](https://www.gov.cn/zhengce/content/202511/content_7047090.htm)的假期范围维护；周末即使调休上班也按提供方明确的周末低谷规则处理。官方当前价格页没有说明跨峰谷请求以开始还是结束时刻为准，所以 dsh 检查从预留到完整响应结束的**整个区间**：完全处于低谷才半价；跨峰谷、未知日历年份或时钟回拨均按高峰估算，不把自行选择的时间点冒充提供方实扣规则。模型目录中的 USD/CNY 单价仍为用于预留的高峰值。

任务累计标记 `metrics.cost_basis:'estimated'`，单次结算保存时段、单价和依据。已持久化的历史费用不重新估价。内置价格的本地复核有效期到 2026-11-07 UTC；过期会拒绝新请求，维护者需复核并更新 `billing/prices.json` 中的价格与有效期。调用 `/models` 不会延长价格有效期，因为目录接口不提供价格。

费用计算现由 [Python 计费模块](billing.md) 的 `quote` / `settle` 实现，默认规则保持上述行为。自定义结算可标记 `custom_estimate`；宿主验证金额、币种和输出上限，独立管理预算与持久化账本。每次请求保存 Python 规则哈希与 JSON 上下文，规则失效或执行失败不会导致已发出请求被退款。

没有可靠的请求级精确 tokenizer 时，预留按模型完整上下文上限的高峰未命中价格，加本次 `max_tokens` 的高峰输出价格计算；不足时可缩小输出上限，连输入预留都不足则在发送前返回 `BUDGET_RESERVATION`。因此小预算可能比实际所需更早被拒绝。不得用文本长度猜测、预期缓存命中或只在完成后检查来放宽这道限制。完整回执按实际 token 数和上述峰谷规则结算，退回多余预留；低谷发起请求也不会提前释放高峰预留，以防请求跨时段。

请求超时、中断、缺失用量或服务器在发送后崩溃，都可能已经扣款：将完整预留计为 `unknown`，不会自动退款。明确的请求拒绝（例如 401、429）退回预留。若提供方返回的用量超过审核过的容量/输出限制，记录实际计额并阻止后续调用，避免继续沿用失效模型资料。调整预算低于已花费/已预留额度不会撤销既有支出，只会阻止新增支出。

API 真实密钥留在主进程；Harness 的提供方环境变量使用本机网关令牌。网关绑定代理、模型与具体 API 来源，禁止跳转，不转发未知端点。运行时支持 DeepSeek 官方流式 Messages 与 OpenAI Responses/Chat；已复核的 OpenAI 模型目前为 `gpt-5-mini`。已管理的 DeepSeek 来源按 CNY 记账，OpenAI 按 USD 记账，分别检查同一预算数组的对应元素。Files、Search/Fetch、服务端计费工具、premium service tier 和未定价的模型/端点不能旁路放行。预算覆盖经 dsh 网关发出的模型 API，不包含 Codex 主模型自身账单或外部程序自行访问的服务。该层是服务端调度和计费控制，不是针对同一操作系统用户任意执行代码的安全隔离；宿主密钥应放在外包工作区以外。

## 持久化

共享默认值与不可变提交快照独立存储；各聊天的 `state.json` 保存被使用的快照及账本。旧默认策略会迁移，旧支出不会清零。模型任务、队列和回传仍按聊天隔离。扩展计费逻辑见 [Python 计费](billing.md)。
