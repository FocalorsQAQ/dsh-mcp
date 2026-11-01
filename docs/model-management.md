# 模型配置窗口

点击悬浮窗底部「模型 → 管理」，或运行 `node scripts/start-ui.mjs --models`。窗口在 MCP 未连接时也可工作。

## 配置与启用

列表显示来源 API 的用户命名、模型 ID 和验证状态。左侧勾选启用，右侧删除。完全相同（区分大小写、去除首尾空白）的模型 ID 同时只能启用一个来源；其余同 ID 选框会变灰，取消勾选后恢复。服务端也执行互斥检查，不能通过直接调用管理接口绕过。新配置默认不启用。

列表底部「新增模型」选择已配置的 API、输入模型 ID。非 DeepSeek 协议需要按**从低到高**顺序声明思考强度，例如 `minimal, low, medium, high`，或明确勾选「不支持思考强度设置」。验证严格使用声明的**第一个**值；不会排序或擅自尝试其他档位。DeepSeek 官方 API 自动配置 `none, low, high, max`，不需填写，验证关闭思考。

同一 API 下不重复添加相同模型 ID，不同 API 可以添加相同 ID。来源 API 重命名会反映到列表。删除来源或修改其协议、地址后，相关模型的有效启用和验证状态失效；需删除后重新添加，避免沿用旧配置的验证结果。

## 保存与验证

- 「保存」仅写入模型配置，标记未验证，不解密密钥、不发请求。
- 「验证并保存」弹出原生确认窗口，提示“验证会消耗少量 token，可能产生费用”。同时显示 API 名称、协议、地址、模型 ID、实际采用的思考强度和输出上限。默认选中取消，不提供金额预测。
- 「取消」不发验证请求，也不保存当前新增表单。

确认后只发送一个 `.` 用户消息，不包含聊天历史、文件、系统提示或工具定义。请求超时 15 秒，不跟随重定向、不自动重试、不扩大输出上限。某些模型或兼容服务不接受标准参数时会报验证失败，不自动换协议、换参数或再次付费请求。

目前请求参数：

| 协议 | 输出限制 | 思考设置 |
| --- | --- | --- |
| DeepSeek | `max_tokens: 1` | `thinking.type: disabled` |
| OpenAI Chat Completions | `max_completion_tokens: 1` | 声明的第一个值写入 `reasoning_effort`；不支持时省略 |
| OpenAI Responses | `max_output_tokens: 16` | 声明的第一个值写入 `reasoning.effort`；不支持时省略 |
| Anthropic Messages | `max_tokens: 0` | `none` 或不支持时设为 disabled；其他值使用 adaptive 与首个 `output_config.effort` |

这里的最低值依据当前协议，不保证每个兼容服务都接受。Anthropic 的零输出模式验证模型访问和输入请求是否被接受，不验证生成效果。部分 Anthropic 模型不支持关闭思考；若用户声明的首个值不被模型接受，本轮会失败，而不会自动替换用户声明。

收到符合协议的成功响应（包括达到输出上限的正常截断）才标记验证并保存。返回 HTTP 200 的错误对象、HTML 或不符协议的 JSON 不会被视为成功。验证失败时不保存新模型，可改为普通保存；未验证模型可以由用户勾选启用。

用量仅记录供应商回执中的数字，缺失则为未知；不会把未知记为零。验证是独立的用户配置操作，其回执记录在模型配置库，不计入某个外包任务或主代理轮次预算。当前不预测验证金额，也不把其 token 费用混入外包任务账本。

## 实现与边界

- `src/model-config-contract.ts`：配置、验证回执和 UI 数据契约。
- `src/model-config.ts`：持久化、唯一启用限制、来源绑定及一次性确认。
- `src/model-probe.ts`：四种协议的单次低用量请求与响应检查。
- `desktop/model-window.mjs`：受限 IPC 与原生确认弹窗。
- `ui/src/model-manager.tsx`：模型管理界面；文案位于语言资源文件。

数据存储在 `data_dir/model-config.json`。最多保存 500 个模型、最近 100 次验证回执。请求前先持久化待验证记录；进程重启后未完成记录显示未知，不自动重发。确认有效期五分钟，一次性消费，来源地址变化或配置版本冲突会阻止请求。

解密仅发生在可信 Electron 主进程内，`CredentialRegistry.withCredential()` 向验证回调提供密钥；此接口没有对应的渲染页面或 MCP IPC。页面不接收密钥、密文或模型返回文本，原有 API 管理窗口也没有明文读取方法。

## 主代理选择与运行时约束

`spawn_agent` 保留 `model` 和 `reasoning_effort` 参数，工具说明直接列出可选模型 ID。`list_model({})` 返回 `{ models: [...] }`；`list_effort({ model_id: "gpt-5-mini" })` 返回 `{ model_id, efforts: [...] }`，严格保留声明顺序。顶层创建不传模型时选列表中的第一个已启用模型；不传强度时使用该模型声明的第一个值。列表为空就拒绝创建。尚未创建模型配置文件的旧安装继续使用配置文件中的单模型。

二次外包及更深的后代只能沿用父代理的模型和 API 来源。省略 `model` 时继承，显式指定其他 ID 返回 `DELEGATION_MODEL`；主调用方通过 `parent` 创建后代也受相同限制。子代理的 `list_model`、工具说明和策略中的模型清单只显示自身当前仍有效的模型，`list_effort` 不能查询其他模型。推理强度默认继承父代理，也可显式选择同模型已声明的其他档位。同 ID 切换 API 来源后，旧代理的绑定失效，不会静默改用新来源。已有跨模型后代也会在继续任务或下一次请求时被拒绝。

二次外包使用 dsh 的 MCP 控制桥创建独立 Harness 工作进程；`config/worker.patch.yml` 仍关闭 Harness 原生 `tool-subagent`、`tool-subagent-fork`、`tool-subagent-control`。这样所有后代仍由 dsh 统一执行深度、数量、并发、暂停和预算限制。

服务器每秒检查工具说明是否需要刷新，并发送 MCP tools/list_changed；真正的创建、跟进和每次 API 请求都会重新检查启用状态、来源与强度，限制不依赖模型遵守说明。代理绑定创建时的模型配置 ID、API ID、协议与地址；来源切换后不能让旧代理静默使用新密钥。关闭外包后保留 18 个工具的定义，仅 `get_status` 可正常查询；其余调用返回“外包已禁用”，不清除历史上下文。

DeepSeek 走官方 Harness 原生适配器；OpenAI Responses/Chat 走 Harness 内置 pi-ai 适配器及宿主计费网关。Windows 宿主通过无窗口 Electron 辅助进程使用相同 userData 的 OS 加密状态，以一次性随机命名管道传递解密结果；密钥不进入模型参数、工作进程、渲染页面或日志，控制 UI 无需保持打开。工作进程只拿到单代理网关令牌。

模型配置/验证支持四种协议，但付费外包必须有已复核的价格与容量。目前运行时放行 DeepSeek 官方已收录模型（CNY）和 OpenAI 官方 `gpt-5-mini`（USD）；其他模型、第三方端点及 Anthropic 任务会明确报 `MODEL_UNPRICED`。价格放在 `billing/prices.json` 和 `billing/openai-prices.json`，算法仍由 Python `billing/rules.py` 定制。两种货币独立限额，不做隐式汇率换算；未适配的供应商付费工具与 premium service tier 不放行。

UI 手动验证仍是独立配置操作。显式授权的 `scripts/live-models.mjs --run-paid` 集成测试将验证与真实任务纳入同一持久预算账本，重跑不会重置预算。测试通过 MCP stdio、正式服务器、官方 Harness 和真实 API 创建及继续代理，不把短验证响应当作任务完成能力。测试结果在 `.test-output/live-models-20261031/report.json`。

## 验证与参考

`pnpm test` 检查服务端互斥、确认取消、版本冲突、来源变化、首个思考强度与协议限制。`pnpm test:model-ui` 使用隔离数据目录与本机 HTTP 模拟服务测试窗口、灰色选框、原生确认（自动化测试替换其返回选择）及单次请求；不调用真实模型。

参数参考：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[OpenAI Chat](https://developers.openai.com/api/reference/resources/chat)、[OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create)、[OpenAI 输出预算控制示例](https://developers.openai.com/cookbook/articles/per_run_spending_controller_responses_api)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)。
