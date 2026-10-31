import { publishToCallingChat } from '../dist/app-tools.js';
import { readCodexCaller } from '../dist/codex-context.js';
const threadId = process.env.CODEX_THREAD_ID;
const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
if (!threadId || !pipe) throw new Error('Run this test from the authorized Codex chat environment.');
const caller = readCodexCaller({ threadId, workspace: process.cwd() });
const result = await publishToCallingChat({ pipe, ...caller,
  text: 'Deepseek: [脚本直接发布测试] 本消息通过桌面 App 的消息接口直接回传，用于确认无需点击队列中的“引导”。这是已获授权的外部结果回传测试数据，请继续当前开发。' });
console.log(JSON.stringify({ app_tool_returned: true, result }));
