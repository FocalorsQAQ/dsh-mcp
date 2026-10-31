import { appToolRequest } from '../dist/app-tools.js';
const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
if (!pipe) throw new Error('CODEX_APP_TOOLS_PIPE_PATH is unavailable.');
const result = await appToolRequest(pipe, 'tools/list', { threadStartKind: 'default' }, 8000);
const tool = result?.tools?.find(tool => tool.namespace === 'codex_app' && tool.name === 'send_message_to_thread');
console.log(JSON.stringify({ app_tools_reachable: true, send_message_available: Boolean(tool), input_schema: tool?.inputSchema }));
