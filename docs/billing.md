# Python 自定义计费

费用计算已从 `ControlPlane` 拆出，默认由 Python 执行。需要 Python 3.10 或更新版本，不需要 pip 依赖。

## 修改入口

| 文件 | 用途 |
| --- | --- |
| `billing/rules.py` | 修改计费公式、折扣、按次收费、阶梯价格等；提供 `quote` 与 `settle` 两个函数。 |
| `billing/prices.json` | 基准模型价格、核验日期、失效日期；每百万 token 单价按未命中输入、缓存命中输入、输出排列。 |
| `billing/openai-prices.json` | OpenAI 模型的美元价格及独立核验日期、失效日期。 |
| `billing/examples/fixed_fee.py` | 完整示例：每次成功 API 调用收取所选币种的 0.01；这是自定义规则示例，不是官方费率。 |
| `billing/runner.py` | Python 的 JSON 输入输出适配器，通常无需修改。 |
| `src/billing.ts` | 启动 Python、限制执行时间、验证返回值、固定请求所用规则版本。 |
| `src/control-plane.ts` | 持久化账本、独立币种预算、并发预留、重复结算和失败处理；不再计算 token 金额。 |

配置写在 `dsh.config.json`：

```json
"billing": {
  "python": "python",
  "rules": "./billing/rules.py",
  "timeout_ms": 2000
}
```

`python` 可以是解释器完整路径。`rules` 相对配置文件目录解析，可以指向用户自己的 `.py` 文件。未配置时使用项目内默认规则。试用按次收费示例时，把 `rules` 改为 `./billing/examples/fixed_fee.py`。

配置修改后重启 dsh MCP。两份 JSON 价格表保存后自动加载，无需重启；新请求使用新价格，已经预留的请求固定使用发出时的价格，历史账单不会重算。表格损坏、缺少字段或出现负数时，只阻止对应服务的新请求，控制服务仍可启动；修正保存后自动恢复。UI 最迟在下一次 10 秒心跳显示价格状态。

Python 规则每次调用都会重新加载，但应等付费请求全部结束后再编辑：若同一请求预留与结算时的规则文件哈希不同，会保留预留费用并暂停新调用，防止中途换算法产生错误退款。

基准价格表仍有有效期检查；自定义 Python 价格不会绕过它。请核验价格后再更新价格表的日期。模型列表展示基准价格，具体请求的有效费率和规则上下文另存于账本。

### 快速修改价格

在项目目录执行（Windows 会打开记事本）：

```text
pnpm prices:edit deepseek
pnpm prices:edit openai
pnpm prices:check
```

也可以直接用文本编辑器打开文件。`prices:check` 不发送 API 请求；错误信息包含字段位置。以下仅说明结构，费率示例不是当前官方价格：

```json
"flash": {
  "USD": [0.30, 0.006, 1.20],
  "CNY": [2.00, 0.04, 8.00]
}
```

数组依次是 **每百万 token 的未命中输入、缓存命中输入、输出单价**，不是总预算。USD、CNY 各自独立，不做汇率转换。DeepSeek 的 `flash` 也用于已支持的 Flash 别名，`pro` 用于 Pro；OpenAI 目前仅支持 `gpt-5-mini` 的美元费率。新增任意模型或计费币种仍需对应的容量与计费适配，不能只在 JSON 中添加字段。

`verified_at` 为 `YYYY-MM-DD` 核验日期，`valid_until` 为带时区的 ISO 时间，例如 `2026-11-07T00:00:00Z` 或 `2026-11-07T08:00:00+08:00`（两者相同）。有效期必须晚于核验日期，系统不会自动延长。默认 DeepSeek JSON 填高峰单价，现有峰谷折扣另由 Python 规则计算。若修改的是套餐、折扣或按次收费公式，应修改 Python 规则而非把折扣后的金额重复写入基准价格。

控制抽象层在 `snapshot.pricing.catalog` 提供每个文件的路径、校验错误、有效期、过期状态和内容版本，方便自定义 UI 接入；不暴露任何 API key。目前没有图形化价格表格编辑器。

## 两个函数

### `quote(request)`：请求发出前

输入包含模型、币种、基准三类单价、完整输入容量上限、允许的最大输出 token、可用预算 `available_nano` 和带时区的开始时间。没有可用预算限制时 `available_nano` 为 `null`。不传入 API key、聊天内容或文件内容。

返回：

```python
{
    "max_tokens": 1000,
    "reserved_nano": [10000000, 0],
    "rates": [0, 0, 0],
    "context": {"fee_nano": [10000000, 0]}
}
```

`reserved_nano` 为保守费用上限。`max_tokens` 可以降低，不能超过宿主提供的限制。预算不足可返回 `{"error": "BUDGET_RESERVATION"}`。宿主会再次检查总任务和当前主代理轮次预算，Python 不能修改预算或直接写账本。

默认算法按完整输入容量、全部缓存未命中、高峰价格预留，并通过搜索降低输出上限以适配剩余预算。它没有用实际文本长度猜测输入 token。

### `settle(request)`：收到完整用量后

输入包含原始模型和币种、三类 `usage` token、带时区的开始与结束时间、`period`、以及原样保存的 `context`。默认 `period` 由 `src/pricing-time.ts` 按北京时间、峰谷边界和假期规则计算；不确定或跨时段采取保守分类。自定义 Python 可以使用时间戳实现自己的时段规则。

返回：

```python
{
    "cost_nano": request["context"]["fee_nano"],
    "settled_rates": None,
    "pricing_period": "unknown",
    "cost_basis": "custom_estimate"
}
```

`pricing_period` 可为 `peak`、`off_peak`、`mixed`、`unknown`。`cost_basis` 可为 `peak_upper_bound`、`time_of_use_estimate`、`custom_estimate`。`settled_rates` 为三类单价，非 token 计费可为 `None`。

所有影响结算的参数应在 `quote` 中写入 `context`；不要在结算时重新读取可能变化的价格。上下文必须可序列化为 JSON，最多 16 KiB。初版适合单文件、无外部状态的规则；规则哈希只覆盖该 `.py` 文件，不覆盖它导入的其他文件或外部服务。

## 精度与限制

- 金额始终是 `[USD, CNY]`，内部以十亿分之一货币单位的安全整数传递。当前请求仅能记入其指定币种，另一项必须为零，不自动换汇。
- 默认 Python 使用 `Decimal`，最后向上取整到最小单位，避免浮点金额误差与小额费用被抹掉。UI 两位小数仅用于显示。
- Python 在本机运行，不向解释器转发 API key 环境变量。自定义规则属于可信本地代码，具有当前账号的文件访问权限，并不是隔离沙箱。
- 每次预留和正常结算各启动一次 Python，使用 JSON stdin/stdout、无 shell 拼接。不要向 stdout 打印调试信息；用 stderr。总输出上限为 64 KiB。
- 初版使用同步、限时调用，保持预留检查和写账本之间不可被其他请求插入；这会短暂阻塞服务端事件循环。默认每次上限 2 秒，可配置 100–10000 毫秒。规则应快速、确定，不进行网络调用或长任务。

## 异常处理

预留阶段的 Python 不存在、超时、异常或非法返回会直接阻止 API 请求，账本不新增预留。结算阶段出错则保留整笔预留费用、记为未知、写入 `billing_error` 并阻止新调用；需要人工核对账本，当前尚无 UI 对账/解锁入口。

明确拒绝、未发送请求、用量缺失、重复回执和重启恢复由宿主处理，不交给自定义公式。未知远端结果不会自动退款，重复回执不会重复收费。若实际结算超过预留或用量超过模型上限，会记下费用并暂停后续调用。

预算是依据所配置公式的本地约束。若用户填写的价格低于供应商实际账单，宿主无法凭本地公式保证供应商账单不超额；自定义公式必须提供可信的保守预留上限。当前所有费用仍为本地估算。

可运行 `pnpm test`、`pnpm smoke` 验证计费和完整 MCP 链路。这些测试使用本地模拟 API，不产生模型费用。
