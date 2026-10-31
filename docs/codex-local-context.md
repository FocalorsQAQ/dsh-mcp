# Codex 本地上下文研究与 dsh 读取

本机检查版本：`codex-cli 0.166.0-alpha.5.1`。以下文件格式来自此安装的实际状态，不是稳定公开文件协议；官方支持的程序化读取接口是 app-server 的 `thread/read`、`thread/turns/list` 和 `thread/items/list`。本实现先提供只读 JSONL 适配，不启动或恢复 Codex 会话。

## 实际存储

| 位置（相对 Codex home） | 本机观察到的用途 |
| --- | --- |
| `sessions/YYYY/MM/DD/rollout-时间-聊天UUID.jsonl` | 按事件追加的会话记录，包含可见消息、工具调用、配置及其他内部事件 |
| `state_5.sqlite` → `threads` | `id`、`rollout_path`、`cwd`、模型、标题及其他聊天元数据索引 |
| `thread_history_1.sqlite` → `thread_turns` | 轮次状态，以及 rollout 的 ordinal 和字节偏移 |
| `thread_history_1.sqlite` → `thread_items` | UI 项目投影：`thread_id`、`turn_id`、`item_type`、`item_json` 等 |
| `session_index.jsonl` | 本地聊天索引；不把它作为完整对话来源 |

运行中的 SQLite 数据库带 `-wal`/`-shm`。读取主数据库文件的静态复制品可能遗漏 WAL 中的新记录；研究使用只读连接，dsh 运行时则直接按精确 UUID 查找 rollout，不依赖数据库模式或锁。

## JSONL 记录

每行是一个 JSON 对象。本机常见外层字段为 `timestamp`、`ordinal`、`type`、`payload`，部分记录另有 `metadata`。以下仅展示结构示意，没有复制聊天正文。

```json
{"type":"session_meta","payload":{"id":"<thread-uuid>","cwd":"<project>","cli_version":"<version>"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<text>"}]}}
{"type":"response_item","payload":{"type":"function_call","call_id":"<id>","name":"<tool>","arguments":"<json>"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"<id>","output":"<result>"}}
```

`response_item` 中还存在 `custom_tool_call` / `custom_tool_call_output`。按 `call_id` 配对，保留已完成的调用及结果；不把尚未返回结果的调用当作已完成操作。`event_msg.item_completed` 也记录 UI 项目，若再一起导入会重复计算消息和工具结果。

读取仅选择 `response_item` 中的用户/助手文本和已配对工具调用结果。`reasoning`、`encrypted_content`、analysis 消息、developer/system 内容、`session_meta.base_instructions`、`world_state`、权限配置和工具注册信息不会导入。图片块和附件本体不读取。未知的非消息事件忽略，损坏的已提交 JSON 行报错。

## 历史档案与当前上下文

rollout 是持久历史记录，不能直接等同于模型当前收到的请求。日志可能含压缩前的旧消息、`compacted` 记录、配置变化和 UI 投影。此适配输出标记为 `history_kind: visible_archive`，保留完整可见档案并报告压缩记录数量，不尝试重建压缩后的精确工作上下文。

读取在打开文件时固定字节数，只处理完整换行结束的记录，忽略活动写入中的最后半行；不会追随持续增长的文件。读取上限 64 MiB，导出文本受 `max_context_chars` 约束，超限明确报错，不静默截断。

## dsh 接口

从 Codex 根聊天继承，仍用 `fork_turns` 开关：

```json
{"task_name":"child","message":"继续处理当前任务。","fork_turns":"all","source_thread_id":"<codex-thread-uuid>"}
```

`source_thread_id` 只选择来源，不是新的继承开关；`none` 不触发本地聊天读取。如果 MCP 启动环境已提供正确的 `CODEX_THREAD_ID`，调用方可省略来源 ID；`config/codex.toml` 已增加该变量的转发示例。也可在 dsh 配置中指定 `codex_thread_id` 和 `codex_home`。多个聊天共用同一服务时，建议每次显式传入 `source_thread_id`，避免把服务启动时的环境 ID 误当作之后每次调用的聊天 ID。本机确认执行工具环境有线程 ID，但不把它当作所有 MCP 客户端的保证。

必须同时匹配文件名、`session_meta.id` 和配置的真实工作区目录。目录不符、来源缺失或重复时拒绝导入；不会选“最新聊天”。返回的代理摘要含 `context_source`，可检查实际来源。指定 dsh `parent` 时优先使用 dsh 父代理的快照；显式 `context` 则支持调用者自行整理的上下文。

本机已对当前聊天实际执行读取，验证了身份与工作区，并确认导出中包含本次用户请求；验证只打印计数与布尔值，没有打印导出正文或调用真实模型 API。

## 官方参考

- [状态目录与环境变量](https://learn.chatgpt.com/docs/config-file/environment-variables)：`CODEX_HOME`、`CODEX_SQLITE_HOME`。
- [App Server](https://learn.chatgpt.com/docs/app-server)：读取线程、轮次、项目以及持久日志的相关接口。

后续若需要精确恢复 Codex 自身的工作上下文，应研究对应版本的 app-server 历史读取与压缩重放机制，而不是把全部 JSONL 内容直接作为系统指令送入外部模型。
