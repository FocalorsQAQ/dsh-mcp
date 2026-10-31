# 模型选择与真实 MCP 验证（2026-10-31）

使用 API 管理窗口保存的 DeepSeek 官方凭据与重新保存后的 OpenAI 官方凭据。未记录密钥、密文或完整 HTTP 错误文本。主聊天历史未传给测试代理。

## 结果

| 模型 | 新增验证 | MCP 创建任务 | 同会话跟进 |
| --- | --- | --- | --- |
| `deepseek-flash` | 通过，关闭思考 | 读取 input.json、计算 68、写 result.json 并读回 | 加入 doubled=136，保留原字段 |
| `gpt-5-mini` | 通过，首档 minimal | 同上 | 同上 |

路径为 MCP SDK 客户端 → 正式 stdio 服务器 → 官方 Harness SDK/CLI → 宿主计费网关 → 官方 API。测试目录是 `.test-output/live-models-20261031`；机读记录在该目录 `report.json`，原始账本在 `data/state.json`。测试未安装或修改 Codex 全局 MCP 配置。

测试期间 OpenAI 旧凭据返回 401/invalid_api_key；用户更新后通过。一次 OpenAI 适配器注册失败在发出生成请求前终止，已补齐 Harness retryPolicy.mode。

## 预算与计费

全部验证和任务共用持久预算 `[5 USD, 10 CNY]`，重试不清零，不换汇。

- 有完整用量回执的估算合计：`0.00328830 USD + 0.00979616 CNY`。
- 首轮 DeepSeek 两次任务收尾发生回执竞态，保守保留 `4.25984000 CNY`，不能视为已确认实际扣款。
- 当前预算账本合计：`0.00328830 USD + 4.26963616 CNY`，均在用户限额内。
- 已修复收到最终用量后断连导致未知计费的问题；额外真实 DeepSeek 短跟进返回 `68`，新增两次 API 请求均正常结算，未产生新的未知项。旧未知项未凭空退款。

估算依赖供应商回执、已复核单价及既有峰谷规则，最终实扣以服务商账单为准。价格资料：[OpenAI GPT-5 mini](https://developers.openai.com/api/docs/models/gpt-5-mini)；DeepSeek 沿用项目复核价格表。

## 本地覆盖与限制

110 项单元/回归检查通过；增加模型 ID 动态描述、列表查询、首档顺序、来源变化、每次请求重检、币种独立限额、Responses 用量和终止回执断连覆盖。Electron 模型窗口测试通过，使用模拟 API，未消耗真实费用。

这是小型文件任务的接入验证，不是复杂开发能力评测。模型配置支持四协议；实际付费外包仍要求对应模型、端点、币种和容量有计费适配，目前放行已收录 DeepSeek 官方模型和 OpenAI 官方 `gpt-5-mini`。
