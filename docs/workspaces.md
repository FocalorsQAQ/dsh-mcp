# 工作区管理 / Workspaces

安装时的 `workspace_root` 是默认目录。要处理另一个项目，主 agent 先调用：

```json
{"path":"D:/Projects/MyProject","name":"MyProject"}
```

以上是 `create_workspace` 的参数。目录存在时直接接入；不存在时创建缺少的目录，不复制、清空或删除已有文件。返回 `workspace.id`、真实 `path`、`created_directory` 和 `reused`。相同真实目录重复注册返回同一个 ID，保存在本聊天的 `state.json.workspaces` 中。`list_workspaces` 列出这些 ID、默认目录、主 agent 目录及本轮可用性。

然后调用 `spawn_agent`：

```json
{"task_name":"review","message":"Review the project","workspace_id":"<返回的 UUID>","cwd":"src"}
```

`cwd` 可省略；顶层默认使用所选工作区根目录，子代理默认使用父代理的 cwd。相对 cwd 按工作区根目录解析。未提供 `workspace_id` 时仍使用安装默认目录，不会静默更改其他聊天的配置。

`create_workspace.path` 可以是绝对本机路径，或相对主 agent 提交目录的路径。`path: "."` 可接入当前 Codex 项目。没有 Codex 提交快照的独立嵌入场景以配置的 `workspace_root` 为基准。Windows 不接受 UNC、设备路径或 `C:relative` 这种驱动器相对路径；操作系统的目录访问权限仍然有效。`read-only` 模式只允许注册已有目录。

## 用户权限

控制窗中的“仅限主 agent 工作区”对应 `ControlPolicy.restrict_to_caller_workspace`，默认 `false`。可通过抽象层 `Dashboard.updateSettings()` 修改，模型工具不能修改它。

- 关闭：主 agent 可创建或接入任意本机目录。
- 开启：创建与执行所用的工作区必须位于本轮快照的 `caller_cwd` 及其子目录。目录来自可信提交钩子，不接受模型用参数替换。先前注册的外部工作区会显示不可用，不能靠复用 ID 绕过。
- 设置在提交任务时固定，界面修改只影响之后的新任务。检查覆盖目录创建前、spawn、followup、恢复排队任务、实际启动及 API 预留；排队消息保留各自所属轮次的权限。
- 路径检查解析真实目录，阻止 `..`、符号链接或 Windows junction 越界。注册根目录后来被链接替换时，旧 ID 拒绝执行，不能静默改指向其他目录。

只有主 agent 拥有 `create_workspace` 和 `list_workspaces`。外包子代理不能新建授权根、切换 workspace ID 或跳到父代理 cwd 之外；二次外包继续使用同一工作区、模型来源和原任务预算。工作区注册不授予另一个聊天使用该 ID 的权利，但各聊天可自行接入同一实际项目，由主 agent 协调并行文件修改。

上下文继承核对主 agent 的聊天目录，完成通知也保存对应聊天的目录。外包使用另一个项目不再要求安装默认目录与聊天目录相同。不会自动导出聊天历史；仍须显式选择 `fork_turns=all`。

## English

The main caller can register an existing local directory or create missing directories with `create_workspace({path, name?})`, then pass the returned `workspace.id` as `spawn_agent.workspace_id`. `list_workspaces` reports IDs, paths and current permission. Registrations persist per chat and do not change the installation default. Relative registration paths use the host-bound main-agent directory; relative agent cwd paths use the selected workspace root.

The user-only `restrict_to_caller_workspace` switch defaults to false and is frozen per submitted turn. When enabled, registration and execution must remain within the main-agent directory and its subdirectories. Existing IDs cannot bypass a later turn's restrictions. Children inherit their parent workspace and cannot leave the parent working directory. Real-path validation is repeated for execution and resume; moved roots and junction escapes are rejected. Read-only mode can register existing directories but cannot create them. This does not isolate concurrent edits: the main agent still coordinates agents sharing a project.
