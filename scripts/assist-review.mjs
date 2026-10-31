import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// An explicitly requested live MCP development check. Only selected source snapshots are supplied.
if (!process.env.DEEPSEEK_API_KEY) throw new Error('Configure DEEPSEEK_API_KEY locally before this live review.');
const root = resolve('.test-output', 'assist'); mkdirSync(root, { recursive: true });
const resumeDirectory = process.argv[2] === '--resume' ? resolve(process.argv[3] ?? '') : undefined;
if (resumeDirectory) {
  const rel = relative(root, resumeDirectory);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Resume directory must be inside .test-output/assist.');
}
const directory = resumeDirectory ?? mkdtempSync(join(root, 'run-'));
const workspace = join(directory, 'workspace'); mkdirSync(join(workspace, 'src'), { recursive: true });
for (const name of resumeDirectory ? [] : ['manager.ts', 'types.ts', 'control.ts', 'delivery.ts']) {
  writeFileSync(join(workspace, 'src', name), readFileSync(resolve('src', name)));
}
const configPath = join(directory, 'config.json');
writeFileSync(configPath, JSON.stringify({ workspace_root: workspace, data_dir: join(directory, 'data'),
  permission_mode: 'read-only', max_concurrent_agents: 1, max_tokens: resumeDirectory ? 16384 : 4096, turn_timeout_ms: 240000,
  completion_delivery: { mode: 'off' } }));
const client = new Client({ name: 'dsh-development-review', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('dist/cli.js'), '--config', configPath], cwd: resolve('.'),
  env: Object.fromEntries(Object.entries(process.env).filter(([,value]) => value !== undefined)), stderr: 'pipe' });
transport.stderr?.resume();
const statusPath = join(directory, 'status.json');
const redact = value => String(value).replaceAll(process.env.DEEPSEEK_API_KEY, '[redacted]').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]');
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 70000 });
  const data = result.structuredContent ?? JSON.parse(result.content[0].text);
  if (result.isError) throw new Error(JSON.stringify(data));
  return data;
}
console.log('Live MCP review artifacts: ' + directory);
try {
  await client.connect(transport);
  const { agent } = resumeDirectory
    ? await call('followup_task', { target: JSON.parse(readFileSync(statusPath, 'utf8')).agent_id,
      message: '上一轮触及输出预算。这次请直接给出最多 4 个最重要的边界测试建议，每项不超过 120 字；沿用已提供的只读快照，不读取其他文件、环境或密钥，不访问网络，不修改文件。' })
    : await call('spawn_agent', { task_name: 'architecture_review', fork_turns: 'none', max_depth: 0,
    notify_on_completion: false, message: '请辅助审查这个 dsh MCP 控制器的设计。仅可只读查看提供的 src 文件快照，不修改文件，不读取环境/密钥或工作区外文件，不访问网络。我们将添加三项功能：1) pause_agent 在当前轮结束后阻止下一轮，保留 pending；resume_agent 原序处理 pending，不重放 active，空队列不创建新提示词。2) manage_queue 提供 list/read/edit/remove/move/clear，只允许修改 pending；每次队列变化更新 revision，写操作必须携带 expected_revision。3) list_deliveries/retry_delivery 保留原消息和绑定目标；failed 可重试，unknown/queued 必须显式 allow_duplicate；published/sending/pending 禁止重发；记录每次尝试。请结合现有生命周期、持久化和作用域指出最多 6 个值得测试的具体竞态或边界，并给出简短实现建议。不要进行代码改动。' });
  writeFileSync(statusPath, JSON.stringify({ agent_id: agent.id, status: agent.status }));
  const deadline = Date.now() + 270000;
  let state = await call('read_agent', { target: agent.id, max_chars: 24000 });
  while (['starting', 'running', 'stopping'].includes(state.agent.status)) {
    if (Date.now() > deadline) { await call('interrupt_agent', { target: agent.id }); throw new Error('Live review deadline reached.'); }
    await call('wait_agent', { targets: [agent.id], after_cursor: state.cursor, timeout_ms: 30000 });
    state = await call('read_agent', { target: agent.id, max_chars: 24000 });
    writeFileSync(statusPath, JSON.stringify({ agent_id: agent.id, status: state.agent.status }));
  }
  const report = { ok: state.agent.status === 'idle', live_api_attempted: true, agent_id: agent.id,
    status: state.agent.status, error: state.agent.error, review: state.final_response };
  writeFileSync(join(directory, 'report.json'), redact(JSON.stringify(report, null, 2)));
  console.log(redact(JSON.stringify(report, null, 2)));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  const report = { ok: false, live_api_attempted: true, error: redact(error.message) };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); process.exitCode = 1;
} finally { await client.close(); }
