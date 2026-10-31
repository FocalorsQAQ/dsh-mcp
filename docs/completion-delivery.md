# 自动回传到 Codex 聊天

当前项目配置启用了 `completion_delivery.mode: "app_tools"`。代理处理完当前批次的消息后，自动向绑定的 Codex 聊天发布结果；失败也会回报。`notify_on_completion: false` 可关闭单个任务的回传。`wait_agent` / `read_agent` 仍可主动查询。

回传开头为 `Deepseek: /root/<task> 已完成` 或失败状态，包含任务轮次、代理 ID、去重 ID 和结果预览，并明确标注为外部子代理数据。完整结果保留在 `read_agent`。预览默认最多 6000 字符，已知环境凭据会被替换为 `[redacted]`。

## 两条路径的实际区别

| 模式 | 行为 | 是否需要用户操作 |
| --- | --- | --- |
| `app_tools` | 调用桌面 App 的 `send_message_to_thread`，把消息交给聊天运行时 | 本机已验证无需点击待发送队列，消息直接进入当前轮次 |
| `codex_queue` | 执行 `codex queue --thread ... --message ...` | 本机 App 把它显示为队列项，需要点击“引导”等操作才真正发布 |
| `off` | 不自动回传 | 通过 MCP 主动读取结果 |

不能把 `codex queue` 的成功回执当作已发布。最初的本机测试证明了排队成功，但用户截图确认仍需点击；因此自动模式使用 App 工具接口，且不会静默降级成队列草稿。

## 环境和来源绑定

`app_tools` 使用桌面 App 提供的 `CODEX_APP_TOOLS_PIPE_PATH`。调用来源线程和轮次由该聊天真实的本地 rollout 验证，不查找或猜测其他服务端点。管道路径不会发送给 DeepSeek 模型。`config/codex.toml` 已加入相关环境变量的转发示例。

每个代理在创建时固定回传聊天 ID：父代理绑定 → 配置 `completion_delivery.thread_id` → `CODEX_THREAD_ID` → 明确的 Codex 上下文来源。没有可靠 ID 时，启用回传的创建请求会报错；可关闭单个任务回传或补齐运行环境。不同聊天共享一个 MCP 服务时，应使用独立配置和数据目录，避免把启动环境里的 ID 当作所有调用的来源。

桌面 App 的工具管道是**依赖版本的本机内部接口**，此适配按本机 App `26.1027.30824` 的实际协议实现，在 Windows 上验证。它不是通用 MCP 通知接口。App 升级、管道不可用或宿主拒绝请求时，回传失败会显示在代理的 `delivery` 字段；不会自动操作聊天 UI，也不会修改 App 文件或 Codex 数据库。

当前没有完全隐藏消息或自定义原生子代理卡片的能力。消息呈现由 App 决定。公开 app-server 协议支持独立工具输出，但本机没有可连接的同一宿主控制端点，因此没有用另开 app-server 的方式冒充当前聊天宿主。

## 状态和去重

`read_agent.agent.delivery` 包含最新回传的 ID、任务轮次、传输模式、状态、尝试次数和错误。`list_deliveries` 可以查看旧轮次的记录，按代理或状态筛选并分页；每条记录附带最近 20 次发送尝试，完整尝试历史保留在本地状态。

- `pending`：已持久化，等待发送。
- `sending`：已开始发送。
- `published`：App 已接受并确认对应聊天；不等于主代理已完成结果整合。
- `queued`：CLI 已确认排队，是待发送项，不等于已发布。
- `failed`：已知没有发出，例如缺少管道或可执行文件。
- `unknown`：可能已发送但未获得确认。检查目标聊天后再决定是否显式重试。

每个代理的每个任务轮次只创建一条回传。发送中崩溃的记录在重启后标记为 `unknown`，不自动重发，避免重复消息。尚未发送的 `pending` 记录可以继续发送。关闭或手动中断不产生普通完成消息。这里不承诺跨进程崩溃的严格 exactly-once。

项目示例配置启用回传；库的空配置仍默认 `off`，使一般测试和普通 MCP 客户端不会意外向真实聊天发消息。

## 显式重试

主调用方使用 `retry_delivery`，外部子代理不会获得这个工具：

```json
{"delivery_id":"<agent-id>:<turn>"}
```

确定未发送的 `failed` 可直接重试；`unknown` 和已排队的 `queued` 必须在检查目标后明确设置 `allow_duplicate: true`，因为再次发送可能产生重复消息。已经 `published` 的记录拒绝重发；`pending` 和 `sending` 拒绝重复提交。回传关闭时也拒绝重试。

重试立刻返回 `pending`，通过 `list_deliveries` 或 `wait_agent` 查看结果。它保留原回传 ID、原文、目标聊天、任务轮次和传输方式，即使该代理已经完成了后续任务或已经关闭，也不会用新的结果替换旧消息。每次发送前保存尝试记录，结束后保存回执或错误；并发重复重试只允许第一个请求进入发送队列。这里仍不承诺跨进程崩溃的严格 exactly-once。`codex_queue` 重试依然只创建草稿，不会自动变成已发布消息。

## 本机检查

```powershell
pnpm run build
node scripts/probe-app-tools.mjs
node scripts/test-completion-delivery.mjs
```

探测只检查接口。最后一条命令会创建一个模拟代理，完成后**实际向当前聊天发布测试回传**，不调用真实模型 API；应仅在用户已授权该聊天接收测试消息时运行。报告写入 `.test-output/live-delivery/run-*/report.json`。

单元测试覆盖自动发布、关闭回传、失败回报、去重、重启后的未知状态、队列和发布的区分，以及本机管道分帧。常规 `smoke` 使用独立配置和合成接口，不向真实聊天发布。

## 参考

- [Codex 开发者命令](https://learn.chatgpt.com/docs/developer-commands)：`codex queue`。
- [App Server](https://learn.chatgpt.com/docs/app-server)：`turn/start.toolOutput` 等公开协议。公开协议与 App 内部工具管道不是同一连接。
