# dsh 悬浮控制窗

初版使用 Electron 45、React 19、TypeScript 和 Vite 8。深色悬浮窗支持拖动、最小化、紧凑模式和窗口位置记忆。Windows 下不占任务栏，通过 Win32 `GWLP_HWNDPARENT` 归属于 Codex 主窗口，不使用全局置顶。API 密钥按钮已接入独立的配置管理窗口；模型按钮已接入 [模型配置窗口](model-management.md)。已保存的 API key 不回传或展示，详见 [API 配置管理](api-management.md)。

窗口标题为 DeepSeek Harness as Subagent。费用统一显示为 `0.00 USD + 0.00 CNY`，只对显示四舍五入，账本和预算判断保持原始精度。

界面支持简体中文与英文。在控制窗底部的语言下拉框选择，控制窗、API 配置窗、模型配置窗立即同步，保留未保存的表单输入。没有连接 MCP 时也能切换；选择保存在当前项目的 `<data_dir>/desktop/window.json`，重启后恢复。新打开的模型验证确认框也使用所选语言。

文案分别位于 `resources/locales/zh-CN.json` 和 `resources/locales/en-US.json`，语言名称与列表在 `resources/languages.json`。添加语言时登记列表、提供同键名 JSON 并重新构建；缺失翻译回退到中文，资源支持 `{name}` 占位符。错误提示通过资源映射，不直接显示后端错误文案。API 名称、模型 ID 等用户填写的数据保持原样。

启动时可通过 `DSH_UI_LOCALE=en-US` 或 `DSH_UI_LOCALE=zh-CN` 覆盖已保存的选择；未指定时默认采用已保存语言，首次使用默认中文。语言只改变桌面显示，不改变模型、预算、计费币种或 MCP 工具协议。`pnpm test:i18n-ui` 验证切换、持久化和英文布局，不调用付费模型。

Win32 归属辅助进程只修改控制窗自身，识别桌面 Codex（含 OpenAI.Codex 包下的 ChatGPT.exe），找不到时保持普通非置顶隐藏任务栏窗口并定期重试。多个 Codex 窗口优先选择前台窗口，否则选择一个可见主窗口；绑定后保持稳定。Codex 最小化时所属窗口遵循 Windows 的归属行为。关闭 Codex 可能连同控制窗关闭，MCP 生命周期仍独立。控制窗被最小化或关闭后，可再次执行启动命令恢复。

## 启动

在项目目录运行：

```powershell
pnpm ui
```

已经构建后，可直接启动：

```powershell
node scripts/start-ui.mjs
```

使用另一个项目配置：

```powershell
node scripts/start-ui.mjs --config D:/path/to/dsh.config.json
```

控制窗与 MCP 必须使用相同的配置和 `data_dir`。MCP 启动配置仍使用 `dist/cli.js`，无需把 Electron 配置成 MCP 命令。更新代码后需要重启已有 dsh MCP 进程，让它加载新的 UI 连接服务；`config/codex.toml` 是现有接入样例。

**窗口可以先打开。** 没有运行中的 dsh 服务时显示“等待服务连接”，禁用设置修改；MCP 启动后自动连接。关闭窗口仅退出 UI，不关闭 MCP 或代理；MCP 退出时窗口保留上次数据并明确标记已断开，自动等待重连。不会为了打开界面启动第二个代理管理器，也不会自动执行模型任务。

## 控件和数据显示

| 控件 | 行为 |
| --- | --- |
| 启用外包 | 即时更新 `enabled`，影响 MCP 的整个工具组。关闭后仍可在窗口重新开启。 |
| 顶层代理数量 | 按同时运行数设置；支持步进按钮和直接输入，Enter 或移开焦点保存。 |
| 允许二次外包 | 用户授权开关；实际执行还需要模型的深度授权。 |
| 最大外包深度 / 子代理上限 | 对应 `max_depth_user` / `max_children_user`；禁止二次外包时暂时禁用这两个控件并保留原值。 |
| 本轮总预算 | 当前用户轮次所有外包调用共用的 `[USD,CNY]` 上限。取消“已设上限”表示不限额。 |
| 任务总预算 | 跨轮累计预算，同样使用两个独立币额。 |
| 账户计费币种 | 指定费用记入 USD 或 CNY，不执行汇率转换。 |
| 任务总花费 / 上次 API | 显示双币种费用估算，固定两位小数。 |
| 未命中输入 / 缓存命中 / 输出 | 可切换“上次调用”和“任务累计”；没有回执时显示横线。 |
| API 密钥 / 模型 | API 密钥打开独立配置管理窗口；模型按钮打开模型配置与验证窗口。 |

设置通过服务端校验和持久化后才更新界面；若版本冲突或连接失效，会显示未保存提示。费率标签按北京时间自动更新。费用未知或计量异常会明确提示，不将未知用量当作零。

用户新轮次仍由可信宿主调用 `beginRound`，当前控制窗没有自行识别 Codex 消息或重置预算的按钮。预算、峰谷、跨时段和费用精度规则见 [控制层协议](control-layer.md)。

## 接入结构

```text
React 控制界面
  → 受限 preload API（contextBridge）
  → Electron 主进程 UiClient
  → 本机认证控制连接
  → DshControlApi
  → 与 MCP 共用的 ControlPlane / AgentManager
```

`src/cli.ts` 在现有应用实例上启动 `startUiBridge`。连接只监听 `127.0.0.1` 的随机端口；每次启动产生独立认证令牌，通过数据目录中的 `ui-endpoint.json` 供本机客户端发现。令牌留在 Electron 主进程，不传给页面，不打印到日志。关闭服务时删除自己的发现文件。

界面不会直接读写 `state.json`。控制端点未注册为模型工具，拒绝带浏览器 Origin 的访问；写入需要版本校验。页面禁用 Node 集成，开启上下文隔离与 renderer sandbox，只加载打包的本地文件；禁止导航、弹窗和权限请求，并校验 IPC 来源。

这一边界保护浏览器页面和工具协议，不是对同一系统账号任意本地程序的操作系统隔离。控制发现文件和数据目录应保留在可信本机环境中，不应发布或共享给不受信任的程序。

本机控制协议 v1：

| 方法和路径 | 内容 |
| --- | --- |
| `GET /v1/snapshot` | 当前 `{server_id, sequence, snapshot}` |
| `GET /v1/events` | SSE 全量状态推送；序号防止旧消息覆盖新状态 |
| `PATCH /v1/settings` | `{patch, expected_revision}`；只接受策略字段 |
| `POST /v1/window-intent` | `{window:"api_keys"}` 或 `{window:"models"}` |

所有请求均需本机发现文件的 Bearer 凭据；禁止重定向。`UiClient` 负责连接、订阅、重连和错误处理，可通过 `dsh-mcp/ui-client` 复用；不要将其发现令牌交给普通网页。原来的框架无关 `DshControlApi` 仍可直接嵌入其他可信宿主。

## 个性化和测试

- `ui/src/theme.css`：颜色、字体和主题变量。
- `ui/src/main.tsx`：控件、字段映射和交互。
- `ui/src/style.css` / `density.css`：布局与默认悬浮尺寸下的密度。
- `desktop/main.mjs`：窗口、Win32 归属、位置、IPC；窗口偏好存于 `data_dir/desktop/`。
- `desktop/preload.cjs`：页面可调用的最小接口。
- `src/ui-bridge.ts` / `ui-client.ts` / `ui-protocol.ts`：传输适配与协议。

```powershell
pnpm run build
pnpm run ui:build
pnpm test
pnpm run test:ui
pnpm run smoke
```

界面测试会打开真实 Electron 窗口，使用隔离项目和模拟后端，逐项操作控件，并验证 MCP 工具列表同步变化、费用和 token 推送、紧凑模式及断线状态。截图和报告在 `.test-output/ui/run-*/`；这些是测试数据，不是用户实际消费。普通测试不调用真实模型 API。

当前提供源码运行版本，尚未制作安装包或自动更新器。
