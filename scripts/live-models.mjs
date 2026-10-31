// Explicit paid integration test. Reuses its durable budget across invocations.
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { hostCredentials } from '../dist/host-credentials.js';
import { ModelRegistry } from '../dist/model-config.js';
import { AgentManager } from '../dist/manager.js';
import { loadConfig } from '../dist/config.js';
import { createBackendFactory } from '../dist/backend.js';

assert(process.argv.includes('--run-paid'), 'Requires --run-paid and explicit user authorization.');
const root = resolve('.test-output/live-models-20261031'); mkdirSync(root, { recursive: true });
const configPath = join(root, 'config.json'), registryDir = resolve('.dsh-mcp');
if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify({ workspace_root: root, data_dir: join(root, 'data'),
  model_config_dir: registryDir, max_tokens: 4096, turn_timeout_ms: 180000,
  billing: { rules: resolve('billing/rules.py') }, completion_delivery: { mode: 'off' },
  control: { task_budget: [5, 10], round_budget: [5, 10], billing_currency: 'CNY' } }, null, 2));
const config = loadConfig(configPath), credentials = hostCredentials(registryDir);
const manager = new AgentManager(config, createBackendFactory(config));
const control = manager.controlPlane;
// Verification is a host operation before models are enabled, using this same durable ledger.
control.selection = undefined;
const resultsPath = join(root, 'report.json');
const report = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : { budget: [5, 10], validations: [], tasks: [] };
const save = () => writeFileSync(resultsPath, JSON.stringify(report, null, 2));
let currentApi;
const registry = new ModelRegistry(join(registryDir, 'model-config.json'), credentials, async (url, options) => {
  const body = JSON.parse(options.body);
  assert(['deepseek-flash', 'gpt-5-mini'].includes(body.model));
  const reservation = control.reserve('model-verification', control.currentRound, body.model, body.max_tokens ?? body.max_output_tokens);
  let response;
  try {
    response = await fetch(url, options);
    if (!response.ok) { control.settle(reservation.id, null, [400, 401, 403, 404, 422, 429].includes(response.status) ? 'rejected' : 'unknown'); return response; }
    const result = await response.clone().json(), usage = result.usage;
    const input = currentApi.protocol === 'deepseek' ? usage?.prompt_tokens : usage?.input_tokens;
    const cached = currentApi.protocol === 'deepseek' ? usage?.prompt_cache_hit_tokens ?? 0 : usage?.input_tokens_details?.cached_tokens ?? 0;
    const output = currentApi.protocol === 'deepseek' ? usage?.completion_tokens : usage?.output_tokens;
    control.settle(reservation.id, { input_cache_miss: input - cached, input_cache_hit: cached, output }, 'complete');
    return response;
  } catch (error) { control.settle(reservation.id, null, 'unknown'); throw error; }
});
const runnable = [];
try {
  for (const protocol of ['deepseek', 'openai_responses']) {
    const apis = credentials.metadata().filter(api => api.protocol === protocol);
    // Newest matching entry lets a user replace an invalid credential without exposing it.
    currentApi = apis.at(-1); if (!currentApi) continue;
    assert.equal(currentApi.base_url, protocol === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1');
    const model = protocol === 'deepseek' ? 'deepseek-flash' : 'gpt-5-mini';
    const discovery = await credentials.withCredential(currentApi.id, currentApi, async key => {
      const response = await fetch(currentApi.base_url + '/models', { headers: { authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); return { status: response.status, available: false }; }
      const body = await response.json(); return { status: response.status, available: body.data.some(entry => entry.id === model) };
    });
    if (!discovery.available) {
      report.validations.push({ api: currentApi.name, model, discovery }); save(); console.log(JSON.stringify({ api: currentApi.name, discovery })); continue;
    }
    control.updatePolicy({ billing_currency: protocol === 'deepseek' ? 'CNY' : 'USD' }, control.snapshot().revision);
    let snapshot = await registry.list(), row = snapshot.entries.find(entry => entry.api_id === currentApi.id && entry.model_id === model);
    if (!row) {
      const plan = await registry.prepare({ expected_revision: snapshot.revision, draft: { api_id: currentApi.id, model_id: model,
        reasoning_levels: protocol === 'deepseek' ? null : ['minimal', 'low', 'medium', 'high'] } });
      const result = await registry.confirm(plan.token); // User explicitly authorized paid verification in this chat.
      report.validations.push({ api: currentApi.name, model, receipt: result.receipt }); save(); console.log(JSON.stringify({ model, validation: result.receipt.status }));
      snapshot = result.snapshot; row = snapshot.entries.find(entry => entry.api_id === currentApi.id && entry.model_id === model);
    }
    if (!row?.verification_valid) continue;
    if (!row.enabled) await registry.toggle({ id: row.id, enabled: true, expected_revision: snapshot.revision });
    runnable.push({ model, effort: row.reasoning_levels[0], label: protocol === 'deepseek' ? 'deepseek' : 'openai' });
  }
} finally { report.cost = control.snapshot().metrics.task_cost; save(); await manager.shutdown(); }

const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), '--config', configPath],
  cwd: resolve('.'), stderr: 'pipe' });
// Do not persist process logs or credential-bearing environment; structured tool errors are already sanitized.
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'dsh-live-model-test', version: '1.0' });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 70000 });
  const value = result.structuredContent ?? JSON.parse(result.content[0].text);
  if (result.isError) throw new Error(JSON.stringify(value)); return value;
}
async function finish(id) {
  const deadline = Date.now() + 200000;
  for (;;) {
    const state = await call('read_agent', { target: id });
    if (!['starting', 'running', 'pausing', 'stopping'].includes(state.agent.status)) return state;
    assert(Date.now() < deadline, 'Live task exceeded deadline');
    await call('wait_agent', { targets: [id], after_cursor: state.cursor, timeout_ms: 5000 });
  }
}
try {
  await client.connect(transport);
  report.tools = (await client.listTools()).tools.map(tool => tool.name);
  report.models = await call('list_model');
  for (const item of runnable) {
    const previous = report.tasks.find(task => task.model === item.model && task.passed);
    if (previous) continue;
    const work = join(root, item.label); mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'input.json'), JSON.stringify({ numbers: [13, 21, 34] }));
    const attempt = report.tasks.filter(task => task.model === item.model).length;
    const started = await call('spawn_agent', { task_name: 'live_' + item.label + '_' + attempt, cwd: work,
      model: item.model, reasoning_effort: item.effort, fork_turns: 'none', notify_on_completion: false, max_depth: 0,
      message: 'Use your file or terminal tools to read input.json in your current directory. Sum its numbers. Create result.json with exactly the JSON object {"sum": computed sum, "count": number of entries}. Read the file back to verify it. Do not delegate or access other directories. Finish with one short confirmation.' });
    const state = await finish(started.agent.id);
    const resultPath = join(work, 'result.json');
    let artifact = null; try { artifact = JSON.parse(readFileSync(resultPath, 'utf8')); } catch {}
    const task = { model: item.model, effort: item.effort, agent_id: state.agent.id, status: state.agent.status,
      error: state.agent.error, final_response: state.final_response, artifact,
      passed: state.agent.status === 'idle' && artifact?.sum === 68 && artifact?.count === 3 };
    report.tasks.push(task); save(); console.log(JSON.stringify(task));
    if (task.passed) {
      await call('followup_task', { target: state.agent.id, message: 'Use tools to read result.json. Add a new property "doubled": twice its sum, keeping sum and count unchanged. Save it, read back, then report completion in one short sentence.' });
      const followup = await finish(state.agent.id);
      const actual = JSON.parse(readFileSync(resultPath, 'utf8'));
      task.followup = { status: followup.agent.status, artifact: actual, passed: followup.agent.status === 'idle' && actual.doubled === 136 && actual.sum === 68 && actual.count === 3 };
      save(); console.log(JSON.stringify({ model: item.model, followup: task.followup }));
    }
  }
  if (process.argv.includes('--recheck-terminal') && !report.terminal_recheck) {
    const previous = report.tasks.find(task => task.model === 'deepseek-flash' && task.passed);
    if (previous) {
      await call('followup_task', { target: previous.agent_id, message: 'Use a tool to read result.json. Reply with only the sum value.' });
      const state = await finish(previous.agent_id);
      report.terminal_recheck = { status: state.agent.status, response: state.final_response }; save();
      console.log(JSON.stringify({ terminal_recheck: report.terminal_recheck }));
    }
  }
} finally {
  await client.close();
  const state = JSON.parse(readFileSync(join(root, 'data/state.json'), 'utf8'));
  report.cost = state.control.task_spent_nano.map(value => value / 1e9);
  report.tokens = state.control.tokens;
  report.requests = state.control.requests.map(({ model, status, usage, cost_nano }) => ({ model, status, usage, cost: cost_nano.map(value => value / 1e9) }));
  save(); console.log(JSON.stringify({ report: resultsPath, cost: report.cost }));
}
