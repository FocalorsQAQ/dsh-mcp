import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const runtime = resolve(process.env.DSH_RELEASE_ROOT ?? '.');
const runtimeNode = process.env.DSH_RELEASE_ROOT ? join(runtime, 'bin/node/node.exe') : process.execPath;
const { UiClient } = await import(pathToFileURL(join(runtime, 'dist/ui-client.js')));
const output = resolve('.test-output/multi-client'); mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, 'run-')), data = join(directory, 'data');
const configPath = join(directory, 'config.json');
const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
writeFileSync(configPath, JSON.stringify({ workspace_root: directory, data_dir: data, ui_auto_start: false,
  session_idle_timeout_ms: 1500, completion_delivery: { mode: 'off' },
  ...(process.env.DSH_RELEASE_ROOT ? { billing: { python: join(runtime, 'bin/python/python.exe'), rules: join(runtime, 'billing/rules.py') } } : {}) }));
let requests = 0, releaseHeld;
const mock = createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += part; requests++;
  const respond = () => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [
    { type: 'message_start', message: { id: 'mock', type: 'message', role: 'assistant', model: 'deepseek-v4-flash', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LOCAL_CHAT_RESULT' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }, { type: 'message_stop' },
  ];
  for (const event of events) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
  res.end();
  };
  if (body.includes('HOLD_ACROSS_DISCONNECT')) releaseHeld = respond;
  else respond();
});
mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
const clients = [], uiClients = [];
let diagnostics = '';
async function connect(id) {
  const env = { ...process.env, DEEPSEEK_API_KEY: 'local-multi-client-dummy', DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + mock.address().port };
  delete env.CODEX_THREAD_ID; delete env.CODEX_APP_TOOLS_PIPE_PATH;
  if (id) env.CODEX_THREAD_ID = id;
  const client = new Client({ name: 'multi-client-test', version: '1' }); clients.push(client);
  const transport = new StdioClientTransport({ command: runtimeNode,
    args: [join(runtime, 'packaging/launch-server.mjs'), '--config', configPath], env, stderr: 'pipe' });
  transport.stderr?.on('data', chunk => { diagnostics += chunk; });
  await client.connect(transport, { timeout: 20000 });
  return client;
}
async function call(client, name, args = {}, meta) {
  const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  const value = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert(!result.isError, JSON.stringify(value)); return value;
}
async function until(check, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) { assert(Date.now() < deadline, 'Timed out: ' + diagnostics); await new Promise(resolve => setTimeout(resolve, 100)); }
}
async function completed(client, id) {
  const agent = (await call(client, 'read_agent', { target: id })).agent;
  assert.notEqual(agent.status, 'failed', agent.error); return agent.status === 'idle';
}
async function ui(id) {
  const client = new UiClient(join(data, 'chats', id), directory); uiClients.push(client); client.reconnect();
  await until(() => client.snapshot().status === 'connected', 5000); return client;
}
const endpoint = id => JSON.parse(readFileSync(join(data, 'chats', id, 'mcp-endpoint.json'), 'utf8'));
try {
  const [a1, a2, b, catalog] = await Promise.all([connect(A), connect(A), connect(B), connect()]);
  for (const client of [a1, a2, b, catalog]) assert.equal((await client.listTools()).tools.length, 17);
  const pidA = endpoint(A).pid;
  assert.notEqual(pidA, endpoint(B).pid);
  const unauthorized = createConnection({ host: '127.0.0.1', port: endpoint(A).port });
  unauthorized.on('error', () => {}); await once(unauthorized, 'connect');
  const rejected = new Promise(resolve => unauthorized.once('close', resolve));
  unauthorized.write(JSON.stringify({ token: '0'.repeat(64), session_id: A }) + '\n'); await rejected;
  assert.equal((await a1.listTools()).tools.length, 17, 'Rejected authentication must leave existing clients usable.');
  const readOnly = await catalog.callTool({ name: 'spawn_agent', arguments: { task_name: 'forbidden', message: 'must never run' } });
  assert.equal(readOnly.isError, true); assert.match(readOnly.content[0].text, /SESSION_REQUIRED/);
  assert.equal((await catalog.callTool({ name: 'list_agents', arguments: {} })).isError, true);
  assert.equal((await catalog.callTool({ name: 'list_agents', arguments: {}, _meta: { threadId: A, thread_id: B } })).isError, true);
  assert.equal((await catalog.callTool({ name: 'list_agents', arguments: {}, _meta: { threadId: '../outside' } })).isError, true);
  assert.equal((await a1.callTool({ name: 'list_agents', arguments: {}, _meta: { threadId: B } })).isError, true);
  assert.equal((await call(catalog, 'list_agents', {}, { threadId: A })).control.chat_id, A);
  assert.equal((await call(catalog, 'list_agents', {}, { thread_id: B })).control.chat_id, B);
  assert.equal((await call(catalog, 'list_agents', {}, { 'x-codex-turn-metadata': JSON.stringify({ threadId: A }) })).control.chat_id, A);
  assert.equal(requests, 0);
  const [uiA, uiB] = await Promise.all([ui(A), ui(B)]);
  await uiA.updateSettings({ round_budget: [0, 1000], task_budget: [0, 2000], billing_currency: 'CNY' }, uiA.snapshot().snapshot.revision);
  await uiB.updateSettings({ round_budget: [0, 3000], task_budget: [0, 4000], billing_currency: 'CNY' }, uiB.snapshot().snapshot.revision);
  assert.notEqual(uiA.snapshot().snapshot.task_id, uiB.snapshot().snapshot.task_id);
  const agentA = (await call(catalog, 'spawn_agent', { task_name: 'same_name', message: 'Reply with a short answer. Do not use tools.' }, { threadId: A })).agent;
  await until(() => completed(a2, agentA.id));
  assert.equal((await call(a2, 'list_agents')).agents.length, 1);
  assert.equal((await call(b, 'list_agents')).agents.length, 0);
  assert.equal((await b.callTool({ name: 'read_agent', arguments: { target: agentA.id } })).isError, true);
  await until(() => uiA.snapshot().snapshot.metrics.task_cost[1] > 0);
  assert.deepEqual(uiB.snapshot().snapshot.metrics.task_cost, [0, 0]);
  const policyA = JSON.parse((await catalog.readResource({ uri: 'dsh://control/status', _meta: { threadId: A } })).contents[0].text);
  assert.equal(policyA.chat_id, A); assert.deepEqual(policyA.budget, [0, 1000]);
  await uiB.updateSettings({ enabled: false }, uiB.snapshot().snapshot.revision);
  assert.equal((await catalog.callTool({ name: 'spawn_agent', arguments: { task_name: 'disabled', message: 'Must not run' }, _meta: { threadId: B } })).isError, true);
  assert.equal((await call(catalog, 'list_agents', {}, { threadId: A })).agents.length, 1);
  const disabled = JSON.parse((await catalog.readResource({ uri: 'dsh://control/status', _meta: { threadId: B } })).contents[0].text);
  assert.equal(disabled.enabled, false);
  await uiB.updateSettings({ enabled: true }, uiB.snapshot().snapshot.revision);
  await a1.close();
  await call(a2, 'followup_task', { target: agentA.id, message: 'HOLD_ACROSS_DISCONNECT Reply once more, without tools.' });
  await until(() => !!releaseHeld);
  await a2.close();
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(endpoint(A).pid, pidA, 'The last MCP connection may close while an asynchronous task is still running.');
  const a3 = await connect(A);
  assert.equal((await call(a3, 'list_agents')).active_count, 1);
  releaseHeld();
  releaseHeld = undefined;
  await until(() => completed(a3, agentA.id));
  assert.equal(endpoint(A).pid, pidA, 'Closing another connection must preserve this chat host.');
  const agentB = (await call(catalog, 'spawn_agent', { task_name: 'same_name', message: 'Reply briefly, without tools.' }, { thread_id: B })).agent;
  assert.notEqual(agentA.id, agentB.id);
  await until(() => completed(b, agentB.id));
  assert.deepEqual(uiA.snapshot().snapshot.settings.round_budget, [0, 1000]);
  assert.deepEqual(uiB.snapshot().snapshot.settings.round_budget, [0, 3000]);
  await catalog.close(); await a3.close();
  await until(() => !existsSync(join(data, 'chats', A, 'mcp-endpoint.json')), 10000);
  const a4 = await connect(A);
  assert.notEqual(endpoint(A).pid, pidA);
  assert.equal((await call(a4, 'list_agents')).agents[0].id, agentA.id, 'Reconnect must retain only this chat\'s tasks.');
  assert.deepEqual((await call(a4, 'list_model')).control.budget, [0, 1000]);
  assert.equal((await call(b, 'list_agents')).agents[0].id, agentB.id, 'Another chat remains connected during restart.');
  const report = { ok: true, directory, runtime, paid_api_calls: 0, local_model_requests: requests,
    checks: ['simultaneous discovery and two chats', 'same-chat host reuse', 'catalog cannot execute tasks', 'tasks and budgets isolated',
      'cross-chat reads denied', 'authentication rejects an invalid token', 'close one connection without stopping others',
      'running task survives last-client disconnect', 'idle host cleanup', 'persisted reconnect', 'other chat survives restart',
      'host metadata routes task calls to independent chats', 'conflicting or invalid identities rejected',
      'disabled chat stays blocked through shared router', 'policy resource routed to caller'] };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally {
  for (const client of uiClients) client.close();
  releaseHeld?.();
  await Promise.all(clients.map(client => client.close().catch(() => {})));
  mock.closeAllConnections(); mock.close();
}
