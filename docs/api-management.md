# API 配置管理

点击悬浮控制窗底部的「API 密钥 → 管理」打开独立窗口；MCP 没有连接时也能管理配置。也可运行 `node scripts/start-ui.mjs --api-keys` 直接打开。

左侧显示已保存的 API 名称、协议和基础地址，列表底部是「新增 API」。选择已有条目可修改名称、协议和地址，或确认删除。协议包括 DeepSeek、OpenAI Chat Completions、OpenAI Responses 和 Anthropic。

新增时 API key 使用密码输入框，没有明文显示开关。DeepSeek 隐藏 Base URL 输入框，服务端固定使用 `https://api.deepseek.com`；其他协议允许配置 HTTPS 地址，也允许本机回环 HTTP 地址。地址不得含用户名、密码、查询参数或片段。

保存之后不提供读取、复制、导出或回显密钥功能，修改配置只操作元数据，保留原密文。若要换密钥，删除后重新添加。列表不显示密钥前缀或后缀。保存失败后需重新输入密钥，输入框不会保留上次提交值。

## 本轮范围

保存配置不代表 API 已验证可用，也不会自动切换运行中的代理。模型窗口可新增、验证和启用模型；启用后主代理可通过 `spawn_agent.model` 选择。运行时绑定具体来源，并要求有对应计费适配，详见 [模型配置](model-management.md)。

列表来自当前项目的独立配置库，不自动导入 `.env` 或系统环境变量中的旧密钥。现有单服务调用配置仍由原运行层管理。

## 存储与接口

- `src/credential-contract.ts` 定义协议枚举、输入验证和只含元数据的返回类型。
- `src/credentials.ts` 的 `CredentialRegistry` 是与 UI 框架无关的单写入者服务，提供 `list/add/update/remove`。加密器通过 `CredentialCipher` 注入，方便其他 UI 使用自己的系统凭据服务。
- `desktop/api-window.mjs` 提供 Electron 管理窗口和受限 IPC。凭据命令仅接受该窗口主 frame，不能从主控制窗、外部页面或 MCP 模型工具调用。没有解密或导出 IPC。
- `ui/src/api-manager.tsx` 是 React 界面；中英文文案位于 `resources/locales/zh-CN.json` 和 `resources/locales/en-US.json`，跟随控制窗的语言选择即时更新。

Windows 下通过 Electron `safeStorage` 异步 API 使用系统保护存储。密文和元数据原子写入 `data_dir/credentials.json`，使用版本校验与进程内写入队列避免覆盖。Electron 的单实例限制保证同一数据目录只有一个 UI 写入者。文件损坏时拒绝写入，不自动清空原数据。删除操作移除配置记录及其密文，不承诺文件系统历史数据的物理擦除。

当前 Windows 加密保护基于登录账号，不是对同一账号下任意本地程序的安全隔离。密钥新增时会短暂存在于输入页面和主进程内存中；这里承诺的是「保存后不通过 UI/管理接口读取密钥」和「不在配置文件中保存明文」。系统加密不可用时禁用新增，拒绝明文回退。Linux 本轮未启用存储适配。

自定义 UI 可以导入 `dsh-mcp/credentials` 和 `dsh-mcp/credential-contract`，注入可信加密器并复用管理服务。MCP 控制连接不传输密钥。运行层通过 `src/host-credentials.ts` 的可信凭据解析接口解密，管理页面没有明文读取方法。

## 验证

`pnpm test` 覆盖密文持久化、元数据修改、版本冲突、URL 校验、损坏文件及加密不可用。

`pnpm test:api-ui` 在隔离目录使用虚拟密钥，验证实际密码输入、全部协议选项、Windows 加密解密往返（仅在测试主进程内）、重启持久化、重命名、协议修改、删除及 IPC 来源限制。不会请求模型 API。
