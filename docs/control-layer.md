# 控制层 v1

入口是 `src/application.ts` 的 `createApplication(config)`。它创建唯一的代理管理器和持久化所有者，然后分别向宿主/UI 和模型提供接口。这里没有 UI 框架依赖。现已增加 [Electron 悬浮窗](desktop-control.md)，通过本机认证连接复用此 API；不同 UI 可以直接使用 TypeScript API 或复用 `UiClient`，不能绕过应用层修改 `state.json`。

```text
自定义 UI / 可信宿主
  └─ DshControlApi：快照、设置、轮次、订阅、窗口意图、模型目录
       └─ ControlPlane：用户策略 + 共享预算账本
            ├─ MCP 适配器 → 主模型 / 外包子模型（只读策略）
            ├─ AgentManager → 数量、层级、队列和生命周期检查
            └─ ModelGateway → 请求前预留 → 官方 API → 用量结算
```

## 宿主 API

| 方法 | 返回 / 行为 |
| --- | --- |
| `snapshot()` | 完整 v1 快照；包含 `revision`、设置、agent 信息、指标、模型目录、运行状态。快照可安全修改，不会修改服务端状态。 |
| `getGlobalControl()` | 所有聊天共享开关的 `{available,state}`；有效 `state` 包含独立的 `revision` 和 `enabled`。读取失败时关闭外包。 |
| `setOutsourcingEnabled(enabled, expectedRevision)` | 设置共享总开关；版本不符返回 `GLOBAL_CONTROL_CONFLICT`。不改变任何聊天的预算、任务或轮次。 |
| `updateSettings(patch, expectedRevision)` | 当前聊天设置的局部更新；旧版本返回 `CONTROL_CONFLICT`。v0.1.6 起 `enabled` 必须使用独立的总开关 API，避免混淆两种版本号。 |
| `beginRound(hostRoundId, expectedRevision)` | 用户向主代理发起新一轮任务时，由可信宿主调用。相同 ID 重用原账本，绝不清零。 |
| `subscribe(listener)` | 状态改变时收到完整快照；返回取消订阅函数。订阅异常不能破坏调度或计费。首次状态通过 `snapshot()` 读取。 |
| `openManagementWindow('api_keys' \| 'models')` | 返回 `{contract_version:1,type:'open_window',window,implemented:true}`；由 UI 适配器打开对应管理窗口。 |
| `refreshModels()` | 宿主使用本机 `DEEPSEEK_API_KEY` 调用官方 `/models`；更新名称、容量、输出上限、输入类型与推理等级。密钥不会出现在快照中。 |

```ts
import { createApplication, loadConfig } from 'dsh-mcp';

const app = createApplication(loadConfig('dsh.config.json'));
// 主模型 transport 与 UI 共用一个 app，不能为 UI 再创建第二个 registry owner。
const mcp = app.createMcpServer();
// await mcp.connect(yourMcpTransport);

let view = app.ui.snapshot();
const global = app.ui.getGlobalControl();
if (global.available) app.ui.setOutsourcingEnabled(true, global.state.revision);
view = app.ui.updateSettings({
  max_root_agents: 2,
  allow_secondary: true, max_depth_user: 2, max_children_user: 1,
  round_budget: [1, 0], task_budget: [5, 0], billing_currency: 'USD',
}, view.revision);
view = app.ui.beginRound('trusted-user-turn-id', view.revision);
const unsubscribe = app.ui.subscribe(next => { /* render(next) */ });
// ...
unsubscribe();
await app.close();
await mcp.close();
```

生产 stdio 入口已使用同一 application 工厂。**初版没有 Codex 用户消息事件接线**：未来宿主/UI 必须在派发主代理的新一轮任务之前调用 `beginRound`。在没有该接线时，所有工作继续使用已持久化的同一轮额度；不会猜测轮次或因 followup、空闲、重启而重新获得预算。`beginRound` 和设置修改都没有注册成 MCP 工具。

## 控件映射

不依赖聊天连接的自定义 UI 可导入 `dsh-mcp/global-control` 的 `OutsourcingSwitch`，用共享根目录和 Python 路径创建实例，再使用 `status()`、`setEnabled(enabled, revision)`、`subscribe(listener)`。它只维护总开关，不创建聊天账本。原有 `UiClient` 也提供 `setOutsourcingEnabled`，对应认证端点 `PATCH /v1/outsourcing`；`GET /v1/outsourcing` 读取全局状态。

开关写入由跨进程操作系统锁和原子文件替换保护；读取失败时拒绝外包。每次工具调用和付费请求同步检查，文件变化通知在约 250 毫秒内广播。首次创建从旧根目录 `state.json` 迁移全局 `enabled`，否则采用配置默认值；旧聊天中的同名字段不再控制启用状态。账本及其他策略不会迁移或合并。工具定义保持稳定，`get_status` 始终可读；禁用时其他调用返回明确提示，不依赖 Codex 刷新缓存。见 [多聊天连接](multi-chat.md)。

| 编号 | v1 字段 / 入口 | 语义与默认值 |
| --- | --- | --- |
| 1 | `global_control.state.enabled` / `setOutsourcingEnabled` | 所有聊天共用。`settings.enabled` 仅为兼容读取的当前值。关闭后保留工具定义，`get_status` 与状态资源返回“外包已禁用”，其他工具和新 API 请求在代码中被拒绝。已有聊天在下一次查询或调用时收到最新提示。 |
| 2 | `settings.max_root_agents` | 同时运行的顶层代理数，默认 4，可为 0。包含启动、暂停收尾与退出未确认的进程。独立于模型可调的全局并发数。 |
| 3 | `settings.allow_secondary` | 默认 false；用户允许且父代理的模型深度授权大于 0 才能再外包。 |
| 4 | `settings.max_depth_user` | 默认 1；从顶层外包代理向下计算可再外包的层数，与模型 `max_depth` 取更严格值，后代沿边减一。 |
| 5 | `settings.max_children_user` | 默认 1；与模型 `max_children` 取更严格值。沿用已有约定：每个父代理的累计直接子代理数，关闭子代理不退回名额。 |
| 6 | `settings.round_budget` | `[USD,CNY]`；**主代理处理当前用户任务期间全部外包 API 的共享预算**，包括后代、重试、followup、工具后的下一次模型请求。默认 null 表示不限额。 |
| 7 | `settings.task_budget` | `[USD,CNY]`；当前数据目录控制任务内跨所有用户轮次累计的外包预算。默认 null；重启不清零。 |
| 8 | `openManagementWindow('api_keys')` | 返回窗口意图，由 Electron 打开加密 API 管理窗口。 |
| 9 | `openManagementWindow('models')` | 打开模型配置窗口；配置库存在时 `selected_models` 返回有效启用的 ID，`model_selection_available:true`。旧环境单模型模式仍返回 null/false。 |

降低并发上限时让已运行进程收尾，不再发放超额新名额；状态包含 `roots_over_limit`。关闭外包会保留暂停意图，允许已经发出的 API 请求结算，但阻止后续请求；重新开启不会自动重放或唤醒任务。运行中降低深度、取消二次外包、降低预算都会在下一次创建/继续/请求时再次校验。

## UI 指标与主代理信息

所有货币字段均为 `[xUSD, yCNY]`，**不做汇率换算**，两个分量分别比较。`[1,0]` 不允许人民币支出。`billing_currency` 是旧环境单服务模式的默认币种；模型配置库中的已适配来源使用各自的计费币种（当前 DeepSeek CNY、OpenAI USD），不受该默认值切换影响，也不转换或删除历史支出。

| 编号 | 快照字段 | 含义 |
| --- | --- | --- |
| 10 | `metrics.task_cost` | 当前任务累计计额。另有 `round_cost` 和 `reserved_cost`。 |
| 11 | `metrics.last_api_cost` | 最近一次完成/失败结算请求的计额；并发时按本机结算完成顺序，不按发起顺序。 |
| 12 | `metrics.last_api_tokens.input_cache_miss` | 上次完整 API 回执中的缓存未命中输入；缓存创建也归入未命中。 |
| 13 | `metrics.last_api_tokens.input_cache_hit` | 上次完整 API 回执中的缓存命中输入。 |
| 14 | `metrics.last_api_tokens.output` | 上次完整 API 回执中的总输出。 |

`metrics.tokens` 提供相同三类 token 的任务累计；没有完整回执时 `last_api_tokens:null`，不编造 0。`last_api_status` 区分 `settled`、`unknown` 和 `rejected`；初始时为 null。`last_api_request_id` 用于去重和关联。`last_api_price_period` 提供 `peak`、`off_peak`、`mixed` 或 `unknown`；`last_api_cost_basis` 区分时段估算、高峰上界和未扣费拒绝。快照 `pricing` 给出北京时间规则、覆盖的日历年份和当前时段。

模型收到的 `agent` 配置包含 2–5；`budget` 为逐币种 `min(单轮预算, 任务剩余额度)`，`available_budget` 进一步扣除本轮已花额度和所有相关在途预留。每次工具结果都带 `control`，`spawn_agent` 的描述也显示策略。动态配置通过 MCP 工具列表变更和只读 `dsh://control/status` 资源更新通知传递；不支持动态刷新的客户端可能暂时显示旧名称，但调用仍由服务端拒绝。

## 预算执行与费用精度

请求必须先在同一个主进程里原子预留，持久化成功之后才向提供方发出。每个 API 请求使用独立 ID；结算重复到达不会重复计额。账本按十亿分之一货币单位保存整数，避免大量低价调用被按分舍入为零。

**费用是估算，不是账户账单。** 内置价格来自 2026-10-31 的 [官方美元价格](https://api-docs.deepseek.com/quick_start/pricing/)和[官方人民币价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。工作日北京时间 09:00–12:00、14:00–18:00 为高峰，其余时段、周末和中国节假日按半价估算。使用 UTC 时间戳换算北京时间，不依赖主机所在时区或本地夏令时；不接受缺少偏移量的本地时间字符串。

节假日日历按[国务院 2026 年放假安排](https://www.gov.cn/zhengce/content/202511/content_7047090.htm)的假期范围维护；周末即使调休上班也按提供方明确的周末低谷规则处理。官方当前价格页没有说明跨峰谷请求以开始还是结束时刻为准，所以 dsh 检查从预留到完整响应结束的**整个区间**：完全处于低谷才半价；跨峰谷、未知日历年份或时钟回拨均按高峰估算，不把自行选择的时间点冒充提供方实扣规则。模型目录中的 USD/CNY 单价仍为用于预留的高峰值。

任务累计标记 `metrics.cost_basis:'estimated'`，单次结算保存时段、单价和依据。已持久化的历史费用不重新估价。内置价格的本地复核有效期到 2026-11-07 UTC；过期会拒绝新请求，维护者需复核并更新 `billing/prices.json` 中的价格与有效期。调用 `/models` 不会延长价格有效期，因为目录接口不提供价格。

费用计算现由 [Python 计费模块](billing.md) 的 `quote` / `settle` 实现，默认规则保持上述行为。自定义结算可标记 `custom_estimate`；宿主验证金额、币种和输出上限，独立管理预算与持久化账本。每次请求保存 Python 规则哈希与 JSON 上下文，规则失效或执行失败不会导致已发出请求被退款。

没有可靠的请求级精确 tokenizer 时，预留按模型完整上下文上限的高峰未命中价格，加本次 `max_tokens` 的高峰输出价格计算；不足时可缩小输出上限，连输入预留都不足则在发送前返回 `BUDGET_RESERVATION`。因此小预算可能比实际所需更早被拒绝。不得用文本长度猜测、预期缓存命中或只在完成后检查来放宽这道限制。完整回执按实际 token 数和上述峰谷规则结算，退回多余预留；低谷发起请求也不会提前释放高峰预留，以防请求跨时段。

请求超时、中断、缺失用量或服务器在发送后崩溃，都可能已经扣款：将完整预留计为 `unknown`，不会自动退款。明确的请求拒绝（例如 401、429）退回预留。若提供方返回的用量超过审核过的容量/输出限制，记录实际计额并阻止后续调用，避免继续沿用失效模型资料。调整预算低于已花费/已预留额度不会撤销既有支出，只会阻止新增支出。

API 真实密钥留在主进程；Harness 的提供方环境变量使用本机网关令牌。网关绑定代理、模型与具体 API 来源，禁止跳转，不转发未知端点。运行时支持 DeepSeek 官方流式 Messages 与 OpenAI Responses/Chat；已复核的 OpenAI 模型目前为 `gpt-5-mini`。已管理的 DeepSeek 来源按 CNY 记账，OpenAI 按 USD 记账，分别检查同一预算数组的对应元素。Files、Search/Fetch、服务端计费工具、premium service tier 和未定价的模型/端点不能旁路放行。预算覆盖经 dsh 网关发出的模型 API，不包含 Codex 主模型自身账单或外部程序自行访问的服务。该层是服务端调度和计费控制，不是针对同一操作系统用户任意执行代码的安全隔离；宿主密钥应放在外包工作区以外。

## 状态与扩展

设置、轮次、账本与代理状态一起原子写入同一 `state.json`。旧格式可读取，已有代理保留；此前版本没有采集的费用无法回溯，新控制任务从本次启用计量开始累计。配置文件的 `control` 只负责首次默认值，后续优先使用持久化的用户设置。

扩展 UI 只需依赖 `DshControlApi`/`DshControlSnapshot`；替换模型提供方需要增加元数据/价格来源、请求前预算适配与用量解析，不能仅在工具描述里宣称新限制。`MeteringPort` 定义预留和结算边界，`BackendFactory` 保持可替换，测试不需要付费 API。
