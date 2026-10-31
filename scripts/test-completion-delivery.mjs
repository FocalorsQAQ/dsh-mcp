import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentManager } from '../dist/manager.js';
import { loadConfig } from '../dist/config.js';

if (!process.env.CODEX_THREAD_ID || !process.env.CODEX_APP_TOOLS_PIPE_PATH) throw new Error('Run from the authorized Codex chat environment.');
const output = resolve('.test-output', 'live-delivery'); mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, 'run-'));
const config = loadConfig(undefined, { workspace: process.cwd(), dataDir: join(directory, 'data') });
config.completion_delivery = { mode: 'app_tools', thread_id: process.env.CODEX_THREAD_ID, max_chars: 6000, timeout_ms: 15000 };
const waitMs = Number(process.argv[2] ?? 0);
if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw new Error('Delay must be between 0 and 60000 ms.');
const manager = new AgentManager(config, () => ({
  open: async () => {}, close: async () => {},
  run: async () => {
    await delay(waitMs);
    return { finalResponse: '【dsh 完成事件端到端测试】模拟代理已完成，完成事件自动触发本条回传；本测试没有调用真实模型 API。无需点击待发送队列，也无需创建新任务。', finishReason: 'completed' };
  },
}));
try {
  const { agent } = manager.spawn({ task_name: 'callback_test', message: 'Run the authorized callback transport test.' });
  let state = manager.read(agent.id);
  while (['starting', 'running', 'stopping'].includes(state.agent.status)) {
    await manager.wait({ targets: [agent.id], after_cursor: state.cursor, timeout_ms: 5000 });
    state = manager.read(agent.id);
  }
  await manager.flushDeliveries();
  const result = manager.read(agent.id);
  const report = { agent_status: result.agent.status, delivery: result.agent.delivery, artifacts: directory, live_model_api_used: false };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (result.agent.delivery?.status !== 'published') process.exitCode = 1;
} finally { await manager.shutdown(); }
