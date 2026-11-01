import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createPipeServer } from 'node:net';
import { endianness } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Exercise the production MCP -> official SDK -> official CLI -> HTTP path without a paid API.
const output = resolve('.test-output', 'smoke');
const runtimeRoot = resolve(process.env.DSH_RELEASE_ROOT ?? '.');
const runtimeNode = process.env.DSH_RELEASE_ROOT ? join(runtimeRoot, 'bin/node/node.exe') : process.execPath;
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, 'run-'));
const workspace = join(directory, 'workspace');
mkdirSync(workspace);
const configPath = join(directory, 'config.json');
const codexHome = join(directory, 'codex-home');
const rolloutDirectory = join(codexHome, 'sessions', '2026', '10', '30');
mkdirSync(rolloutDirectory, { recursive: true });
const sourceThread = '00000000-0000-4000-8000-000000000001';
writeFileSync(join(rolloutDirectory, 'rollout-fixture-' + sourceThread + '.jsonl'), [
  { type: 'session_meta', payload: { id: sourceThread, cwd: workspace, cli_version: 'fixture' } },
  { type: 'turn_context', payload: { turn_id: 'fixture-caller-turn' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'LOCAL_CODEX_SOURCE_MARKER' }] } },
  { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'EXCLUDED_PRIVATE_REASONING' } },
].map(item => JSON.stringify(item) + '\n').join(''));
writeFileSync(configPath, JSON.stringify({ workspace_root: workspace, data_dir: join(directory, 'data'), ui_auto_start: false, codex_home: codexHome, turn_timeout_ms: 120000,
  ...(process.env.DSH_RELEASE_ROOT ? { billing: { python: join(runtimeRoot, 'bin/python/python.exe') } } : {}),
  control: { allow_secondary: true, max_depth_user: 2, max_children_user: 2 },
  completion_delivery: { mode: 'app_tools', thread_id: sourceThread } }));
const callbackRequests = [];
let droppedRetryAck = false;
const pipePath = process.platform === 'win32' ? '\\\\.\\pipe\\dsh-smoke-' + randomUUID() : join(directory, 'callbacks.sock');
const callbackServer = createPipeServer(socket => {
  let pending = Buffer.alloc(0);
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length < 4) return;
    const size = endianness() === 'LE' ? pending.readUInt32LE() : pending.readUInt32BE();
    if (pending.length < size + 4) return;
    const request = JSON.parse(pending.subarray(4, size + 4).toString());
    assert.equal(request.params.tool, 'send_message_to_thread');
    assert.equal(request.params.threadId, sourceThread);
    assert.equal(request.params.arguments.threadId, sourceThread);
    callbackRequests.push(request);
    if (!droppedRetryAck && request.params.arguments.prompt.includes('/root/uncertain_delivery ')) {
      droppedRetryAck = true; socket.end(); return;
    }
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ threadId: sourceThread }) }] } }));
    const frame = Buffer.alloc(body.length + 4);
    if (endianness() === 'LE') frame.writeUInt32LE(body.length); else frame.writeUInt32BE(body.length);
    body.copy(frame, 4); socket.end(frame);
  });
});
callbackServer.listen(pipePath); await once(callbackServer, 'listening');
const requests = [];
let held = false;
let wroteInside = false;
let triedOutside = false;
let delegatedRoot = false;
let delegatedChild = false;
let leafPolicyVerified = false;
const batchHeld = new Set();
let releasePauseResponse;
const mock = createServer(async (req, res) => {
  try {
    let body = '';
    for await (const part of req) body += part;
    const payload = JSON.parse(body);
    requests.push(payload);
    const number = requests.length;
    const last = JSON.stringify(payload.messages?.at(-1));
    if (!held && last?.includes('DSH_HOLD_RESPONSE')) {
      held = true;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': waiting for cancellation\n\n');
      return;
    }
    const batchHold = /DSH_HOLD_BATCH_[AB]/.exec(last ?? '')?.[0];
    if (batchHold && !batchHeld.has(batchHold)) {
      batchHeld.add(batchHold);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': batch worker waiting for interruption\n\n');
      return;
    }
    const answer = 'LOCAL_MOCK_RESPONSE_' + number;
    let events = [
      { type: 'message_start', message: { id: 'msg_' + number, type: 'message', role: 'assistant', model: 'deepseek-v4-flash', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ];
    const outside = !triedOutside && last?.includes('DSH_WRITE_OUTSIDE');
    const inside = !wroteInside && last?.includes('DSH_WRITE_FIXTURE');
    if (inside || outside) {
      if (inside) wroteInside = true; else triedOutside = true;
      const tool = payload.tools.find(tool => tool.name === 'write');
      assert(tool, 'The native write tool must be advertised: ' + JSON.stringify(payload.tools.map(tool => tool.name)));
      events = [events[0],
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'write_' + number, name: tool.name, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: outside ? join(directory, 'outside.txt') : join(workspace, 'smoke-file.txt'), content: 'written by the actual Harness file tool\n' }) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
        { type: 'message_stop' },
      ];
    }
    const delegateRoot = !delegatedRoot && last?.includes('DSH_DELEGATE_ROOT');
    const delegateChild = !delegatedChild && last?.includes('DSH_DELEGATE_CHILD');
    if (last?.includes('DSH_DELEGATE_LEAF')) {
      assert(!payload.tools.some(tool => tool.name === 'mcp__dsh__spawn_agent'), 'depth-zero leaf must not expose delegation');
      leafPolicyVerified = true;
    }
    if (delegateRoot || delegateChild) {
      if (delegateRoot) delegatedRoot = true; else delegatedChild = true;
      const tool = payload.tools.find(tool => tool.name === 'mcp__dsh__spawn_agent');
      assert(tool, 'Delegation-enabled worker must advertise dsh spawn_agent: ' + JSON.stringify(payload.tools.map(tool => tool.name)));
      const input = { task_name: delegateRoot ? 'nested' : 'leaf', message: delegateRoot ? 'DSH_DELEGATE_CHILD' : 'DSH_DELEGATE_LEAF' };
      events = [events[0],
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'delegate_' + number, name: tool.name, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
        { type: 'message_stop' },
      ];
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const response = events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('');
    if (last?.includes('DSH_PAUSE_HOLD') && !releasePauseResponse) {
      releasePauseResponse = () => res.end(response); res.write(': waiting for pause test\n\n'); return;
    }
    res.end(response);
  } catch (error) {
    res.writeHead(500); res.end(String(error));
  }
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const address = mock.address();
let client;
let stderr = '';

async function connect() {
  const transport = new StdioClientTransport({
    command: runtimeNode, args: [join(runtimeRoot, 'dist/cli.js'), '--config', configPath], cwd: runtimeRoot,
    env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: pipePath, DEEPSEEK_API_KEY: 'local-smoke-dummy-key', DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + address.port },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  client = new Client({ name: 'dsh-smoke', version: '0.1.0' });
  await client.connect(transport);
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 });
  const data = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert(!result.isError, JSON.stringify(data));
  return data;
}
async function finish(id) {
  const deadline = Date.now() + 90000;
  let state = await call('read_agent', { target: id });
  while (['starting', 'running', 'pausing', 'stopping'].includes(state.agent.status) || ['pending', 'sending'].includes(state.agent.delivery?.status)) {
    assert(Date.now() < deadline, 'agent timed out: ' + JSON.stringify(state));
    await call('wait_agent', { targets: [id], after_cursor: state.cursor, timeout_ms: 5000 });
    state = await call('read_agent', { target: id });
  }
  assert.equal(state.agent.status, 'idle', JSON.stringify(state));
  assert.equal(state.agent.delivery?.status, 'published', JSON.stringify(state));
  return state;
}

async function observeUntil(id, predicate) {
  const deadline = Date.now() + 90000;
  while (true) {
    const state = await call('read_agent', { target: id });
    if (predicate(state)) return state;
    assert(Date.now() < deadline && !['failed', 'closed'].includes(state.agent.status), JSON.stringify(state));
    await call('wait_agent', { targets: [id], after_cursor: state.cursor, timeout_ms: 500 });
  }
}

try {
  await connect();
  console.log('Connected to the production dsh MCP server.');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['get_status', 'batch_control', 'close_agent', 'followup_task', 'interrupt_agent', 'list_agents', 'list_deliveries', 'list_model', 'list_effort', 'manage_queue', 'pause_agent', 'read_agent', 'resume_agent', 'retry_delivery', 'send_message', 'set_concurrency', 'spawn_agent', 'wait_agent'].sort());
  for (const args of [{ max_concurrent_agents: 0 }, { max_concurrent_agents: 1.5 }]) {
    assert((await client.callTool({ name: 'set_concurrency', arguments: args })).isError);
  }
  const invalid = await client.callTool({ name: 'spawn_agent', arguments: { task_name: 'invalid', message: 'x', fork_turns: 'all' } });
  assert(invalid.isError, 'all without a parent or supplied context must reject');
  const first = (await call('spawn_agent', { task_name: 'roundtrip', message: 'Remember DSH_LOCAL_SMOKE.' })).agent;
  assert.equal((await finish(first.id)).final_response, 'LOCAL_MOCK_RESPONSE_1');
  console.log('Official CLI completed a turn through the local model stand-in.');
  await call('followup_task', { target: first.id, message: 'Recall the previous task.' });
  const second = await finish(first.id);
  assert.equal(second.final_response, 'LOCAL_MOCK_RESPONSE_2');
  assert.equal(second.agent.session_id, first.session_id);
  assert(JSON.stringify(requests[1].messages).includes('DSH_LOCAL_SMOKE'), 'resumed request must include earlier history');
  assert(JSON.stringify(requests[1].messages).includes('LOCAL_MOCK_RESPONSE_1'));
  assert.equal((await call('send_message', { target: first.id, message: 'Queued context.' })).delivery, 'queued_until_followup');
  assert.equal(requests.length, 2);
  await call('followup_task', { target: first.id, message: 'Continue after context.' });
  assert.equal((await finish(first.id)).final_response, 'LOCAL_MOCK_RESPONSE_4');
  console.log('Session restoration and ordered mailbox delivery passed.');

  const interrupted = (await call('spawn_agent', { task_name: 'interrupt', message: 'DSH_HOLD_RESPONSE' })).agent;
  const deadline = Date.now() + 60000;
  while (!held) {
    assert(Date.now() < deadline, 'held request did not arrive');
    const state = await call('read_agent', { target: interrupted.id });
    assert.notEqual(state.agent.status, 'failed', JSON.stringify(state));
    await call('wait_agent', { targets: [interrupted.id], after_cursor: state.cursor, timeout_ms: 100 });
  }
  assert.equal((await call('interrupt_agent', { target: interrupted.id })).agent.status, 'interrupted');
  await call('followup_task', { target: interrupted.id, message: 'Continue with a short response.' });
  assert.equal((await finish(interrupted.id)).agent.session_id, interrupted.session_id);
  console.log('Runtime interruption and persisted-session resumption passed.');
  await call('close_agent', { target: interrupted.id });

  await client.close();
  await connect();
  assert.equal((await call('list_agents')).agents.length, 2);
  assert.equal((await call('read_agent', { target: first.id })).final_response, 'LOCAL_MOCK_RESPONSE_4');
  await call('followup_task', { target: first.id, message: 'Continue after MCP restart.' });
  await finish(first.id);
  await call('close_agent', { target: first.id });
  const fileAgent = (await call('spawn_agent', { task_name: 'file_edit', message: 'DSH_WRITE_FIXTURE', max_depth: 1, max_children: 2 })).agent;
  await finish(fileAgent.id);
  assert.equal(readFileSync(join(workspace, 'smoke-file.txt'), 'utf8'), 'written by the actual Harness file tool\n');
  await call('followup_task', { target: fileAgent.id, message: 'DSH_WRITE_OUTSIDE' });
  await finish(fileAgent.id);
  assert(!existsSync(join(directory, 'outside.txt')), 'Harness must refuse writes outside the agent workspace');
  const toolNames = requests[0].tools.map(tool => tool.name);
  for (const name of ['subagent', 'subagent_fork', 'plugin_manager', 'send_message']) assert(!toolNames.includes(name), 'Worker tool should be disabled: ' + name);
  const forked = (await call('spawn_agent', { task_name: 'inherited', parent: fileAgent.id, fork_turns: 'all', message: 'Use the inherited conversation.' })).agent;
  await finish(forked.id);
  const inheritedRequest = JSON.stringify(requests.at(-1).messages);
  assert(inheritedRequest.includes('DSH_WRITE_FIXTURE'));
  assert(inheritedRequest.includes('tool/result'), 'inheritance includes actual tool result events');
  assert(inheritedRequest.includes('smoke-file.txt'));
  assert.equal(forked.fork_turns, 'all');
  const fresh = (await call('spawn_agent', { task_name: 'fresh', parent: fileAgent.id, fork_turns: 'none', message: 'Independent task.' })).agent;
  await finish(fresh.id);
  assert(!JSON.stringify(requests.at(-1).messages).includes('DSH_WRITE_FIXTURE'));
  const supplied = (await call('spawn_agent', { task_name: 'caller_context', fork_turns: 'all', context: 'EXPLICIT_CALLER_HISTORY_MARKER', message: 'Use supplied context.' })).agent;
  await finish(supplied.id);
  assert(JSON.stringify(requests.at(-1).messages).includes('EXPLICIT_CALLER_HISTORY_MARKER'));
  const local = (await call('spawn_agent', { task_name: 'local_codex', fork_turns: 'all', source_thread_id: sourceThread, message: 'Use the local chat context.' })).agent;
  await finish(local.id);
  assert(JSON.stringify(requests.at(-1).messages).includes('LOCAL_CODEX_SOURCE_MARKER'));
  assert(!JSON.stringify(requests.at(-1).messages).includes('EXCLUDED_PRIVATE_REASONING'));
  assert.equal(local.context_source.id, sourceThread);
  for (const agent of [forked, fresh, supplied, local, fileAgent]) await call('close_agent', { target: agent.id });
  console.log('Parent/tool context inheritance, fresh context, and supplied caller context passed.');
  console.log('Real workspace file write and outside-workspace denial passed.');
  const delegator = (await call('spawn_agent', { task_name: 'delegator', message: 'DSH_DELEGATE_ROOT', max_depth: 2 })).agent;
  await finish(delegator.id);
  const nestedDeadline = Date.now() + 90000;
  let tree;
  while (true) {
    tree = (await call('list_agents', { path_prefix: delegator.path })).agents;
    assert(Date.now() < nestedDeadline, 'nested CLI workers did not finish');
    assert(!tree.some(agent => agent.status === 'failed'), JSON.stringify(tree));
    if (tree.length === 3 && tree.every(agent => agent.status === 'idle')) break;
    await call('wait_agent', { targets: tree.map(agent => agent.id), timeout_ms: 200 });
  }
  assert(delegatedRoot && delegatedChild && leafPolicyVerified, 'real workers must delegate exactly two levels');
  assert.deepEqual(tree.map(agent => agent.max_depth), [2, 1, 0]);
  assert.deepEqual(tree.map(agent => agent.max_children), [1, 1, 1]);
  assert.deepEqual(tree.map(agent => agent.children_count), [1, 1, 0]);
  const tooMany = await client.callTool({ name: 'spawn_agent', arguments: { task_name: 'over_quota', message: 'x', parent: delegator.id } });
  assert(tooMany.isError);
  const tooDeep = await client.callTool({ name: 'spawn_agent', arguments: { task_name: 'over_depth', message: 'x', parent: tree[2].id } });
  assert(tooDeep.isError);
  assert.equal((await call('batch_control', { action: 'close_agent', path_prefix: delegator.path })).succeeded, 3);
  console.log('Real CLI recursive delegation, inherited budgets, leaf policy, and quota rejection passed.');

  const limited = await call('set_concurrency', { max_concurrent_agents: 1 });
  assert.equal(limited.available_slots, 1);
  const bulkA = (await call('spawn_agent', { task_name: 'bulk_a', message: 'DSH_HOLD_BATCH_A' })).agent;
  const full = await client.callTool({ name: 'spawn_agent', arguments: { task_name: 'bulk_b', message: 'DSH_HOLD_BATCH_B' } });
  assert(full.isError);
  await call('set_concurrency', { max_concurrent_agents: 2 });
  const bulkB = (await call('spawn_agent', { task_name: 'bulk_b', message: 'DSH_HOLD_BATCH_B' })).agent;
  const bulkDeadline = Date.now() + 60000;
  while (batchHeld.size < 2) {
    assert(Date.now() < bulkDeadline, 'batch workers did not reach the model stand-in');
    for (const agent of [bulkA, bulkB]) assert.notEqual((await call('read_agent', { target: agent.id })).agent.status, 'failed');
    await call('wait_agent', { targets: [bulkA.id, bulkB.id], timeout_ms: 100 });
  }
  const lowered = await call('set_concurrency', { max_concurrent_agents: 1 });
  assert.equal(lowered.active_count, 2);
  assert.equal(lowered.over_limit, 1);
  assert.equal(lowered.available_slots, 0);
  for (const agent of [bulkA, bulkB]) assert.equal((await call('read_agent', { target: agent.id })).agent.status, 'running');
  const batchMessages = await call('batch_control', { action: 'send_message', targets: [bulkA.id, bulkA.path, bulkB.id], message: 'BATCH_QUEUED_CONTEXT' });
  assert.equal(batchMessages.total, 2);
  assert.equal(batchMessages.succeeded, 2);
  const stopped = await call('batch_control', { action: 'interrupt_agent', targets: [bulkA.id, bulkB.id] });
  assert.equal(stopped.succeeded, 2);
  assert.equal(stopped.active_count, 0);
  for (const agent of [bulkA, bulkB]) assert.equal((await call('read_agent', { target: agent.id })).agent.queued_messages, 1);
  const resumedBatch = await call('batch_control', { action: 'followup_task', targets: [bulkA.id, bulkB.id], message: 'Complete the batch task.' });
  assert.equal(resumedBatch.succeeded, 1);
  assert.equal(resumedBatch.results[1].error.code, 'CAPACITY');
  assert.equal((await call('read_agent', { target: bulkB.id })).agent.queued_messages, 1, 'capacity rejection must not append a followup');
  await finish(bulkA.id);
  await call('set_concurrency', { max_concurrent_agents: 2 });
  assert.equal((await call('batch_control', { action: 'followup_task', targets: [bulkB.id], message: 'Complete the remaining task.' })).succeeded, 1);
  await finish(bulkB.id);
  assert.equal((await call('batch_control', { action: 'close_agent', targets: [bulkA.id, bulkB.id] })).succeeded, 2);
  const beforeSettings = (await call('list_agents')).cursor;
  await call('set_concurrency', { max_concurrent_agents: 3 });
  const settings = await call('wait_agent', { after_cursor: beforeSettings, timeout_ms: 0 });
  assert(settings.events.some(event => event.type === 'concurrency_changed' && event.agent_id === null));
  await client.close(); await connect();
  assert.equal((await call('list_agents')).max_concurrent_agents, 3);
  console.log('Batch controls, live concurrency draining, partial capacity failures, and persisted limit passed.');

  const pausable = (await call('spawn_agent', { task_name: 'pausable', message: 'DSH_PAUSE_HOLD' })).agent;
  await observeUntil(pausable.id, () => Boolean(releasePauseResponse));
  assert.equal((await call('pause_agent', { target: pausable.id })).agent.status, 'pausing');
  const discarded = await call('followup_task', { target: pausable.id, message: 'QUEUE_DROP' });
  const edited = await call('followup_task', { target: pausable.id, message: 'QUEUE_EDIT_OLD' });
  const moved = await call('send_message', { target: pausable.id, message: 'QUEUE_LAST' });
  assert.equal(discarded.delivery, 'queued_until_resume');
  let queue = await call('manage_queue', { target: pausable.id, action: 'list' });
  const oldRevision = queue.revision;
  queue = await call('manage_queue', { target: pausable.id, action: 'edit', message_id: edited.message_id, message: 'QUEUE_EDITED', expected_revision: queue.revision });
  queue = await call('manage_queue', { target: pausable.id, action: 'move', message_id: moved.message_id, position: 0, expected_revision: queue.revision });
  queue = await call('manage_queue', { target: pausable.id, action: 'remove', message_id: discarded.message_id, expected_revision: queue.revision });
  assert((await client.callTool({ name: 'manage_queue', arguments: { target: pausable.id, action: 'clear', expected_revision: oldRevision } })).isError);
  assert.equal((await call('manage_queue', { target: pausable.id, action: 'read', message_id: edited.message_id })).message.text, 'QUEUE_EDITED');
  releasePauseResponse();
  const paused = await observeUntil(pausable.id, state => state.agent.status === 'paused');
  assert.equal(paused.agent.queued_messages, 2);
  assert.equal((await call('list_agents')).active_count, 0);
  const beforeResume = requests.length;
  await client.close(); await connect();
  assert.equal((await call('read_agent', { target: pausable.id })).agent.status, 'paused');
  await call('resume_agent', { target: pausable.id });
  await finish(pausable.id);
  assert.equal(requests.length, beforeResume + 2);
  assert(JSON.stringify(requests[beforeResume].messages.at(-1)).includes('QUEUE_LAST'));
  assert(JSON.stringify(requests.at(-1).messages.at(-1)).includes('QUEUE_EDITED'));
  assert(!JSON.stringify(requests.at(-1).messages).includes('QUEUE_DROP'));
  assert(!JSON.stringify(requests.at(-1).messages).includes('QUEUE_EDIT_OLD'));
  await call('batch_control', { action: 'pause_agent', targets: [pausable.id] });
  await call('followup_task', { target: pausable.id, message: 'cleared before resume' });
  queue = await call('manage_queue', { target: pausable.id, action: 'list' });
  await call('manage_queue', { target: pausable.id, action: 'clear', expected_revision: queue.revision });
  const beforeEmptyResume = requests.length;
  await call('batch_control', { action: 'resume_agent', targets: [pausable.id] });
  assert.equal(requests.length, beforeEmptyResume);
  await call('close_agent', { target: pausable.id });
  console.log('Real CLI pause boundary, queue editing and revisions, empty resume and paused restart passed.');

  // The missing test receiver yields a definitely-unsent ENOENT, then comes back for explicit retry.
  await new Promise((resolve, reject) => callbackServer.close(error => error ? reject(error) : resolve()));
  const retryAgent = (await call('spawn_agent', { task_name: 'failed_delivery', message: 'Result to retry without rerunning.' })).agent;
  const unsent = await observeUntil(retryAgent.id, state => state.agent.status === 'idle' && state.agent.delivery?.status === 'failed');
  callbackServer.listen(pipePath); await once(callbackServer, 'listening');
  await call('retry_delivery', { delivery_id: unsent.agent.delivery.id });
  await finish(retryAgent.id);
  const retried = await call('list_deliveries', { target: retryAgent.id });
  assert.equal(retried.deliveries[0].attempts, 2);
  assert.deepEqual(retried.deliveries[0].attempt_history.map(item => item.status), ['failed', 'published']);
  const uncertainAgent = (await call('spawn_agent', { task_name: 'uncertain_delivery', message: 'Result with a lost receipt.' })).agent;
  const uncertain = await observeUntil(uncertainAgent.id, state => state.agent.status === 'idle' && state.agent.delivery?.status === 'unknown');
  const intentionalDuplicateId = uncertain.agent.delivery.id;
  assert((await client.callTool({ name: 'retry_delivery', arguments: { delivery_id: intentionalDuplicateId } })).isError);
  await call('retry_delivery', { delivery_id: intentionalDuplicateId, allow_duplicate: true });
  await finish(uncertainAgent.id);
  assert((await client.callTool({ name: 'retry_delivery', arguments: { delivery_id: intentionalDuplicateId, allow_duplicate: true } })).isError);
  assert.equal((await call('list_deliveries', { target: uncertainAgent.id })).deliveries[0].attempts, 2);
  await call('batch_control', { action: 'close_agent', targets: [retryAgent.id, uncertainAgent.id] });
  console.log('Unavailable receiver retry, lost acknowledgement protection, and immutable delivery attempts passed.');
  const deliveryIds = callbackRequests.map(request => /delivery_id: ([^\n]+)/.exec(request.params.arguments.prompt)?.[1]);
  assert.equal(deliveryIds.filter(id => id === intentionalDuplicateId).length, 2, 'only the explicitly accepted uncertain retry may duplicate');
  const ordinaryIds = deliveryIds.filter(id => id !== intentionalDuplicateId);
  assert.equal(new Set(ordinaryIds).size, ordinaryIds.length, 'ordinary completion callbacks must not repeat across MCP restart');
  assert(callbackRequests.some(request => request.params.arguments.prompt.includes('LOCAL_MOCK_RESPONSE_1')));
  const metered = JSON.parse(readFileSync(join(directory, 'data', 'state.json'), 'utf8')).control;
  assert.equal(metered.requests.length, requests.length, 'every actual CLI API request must cross the metering gateway');
  assert(metered.requests.every(request => request.status !== 'reserved'), 'all completed/stopped requests must settle');
  assert(metered.requests.some(request => request.status === 'unknown'), 'interrupted requests must retain their reservation');
  const settledRequests = metered.requests.filter(request => request.status === 'settled');
  assert.equal(metered.tokens.input_cache_miss, settledRequests.length * 12);
  assert.equal(metered.tokens.output, settledRequests.length * 8);
  const report = { ok: true, tools: tools.length, mock_model_requests: requests.length,
    verified: ['MCP discovery and validation', 'real CLI startup', 'model-response streaming', 'persistent followup', 'idle mailbox', 'interrupt and resume', 'MCP restart recovery', 'resource close', 'real workspace file edit', 'outside-workspace write denied', 'worker tool policy'],
    context_inheritance_verified: true, local_codex_context_verified: true, completion_callbacks: callbackRequests.length,
    direct_completion_delivery_verified: true, delegation_verified: true, batch_control_verified: true,
    dynamic_concurrency_verified: true, pause_resume_verified: true, queue_management_verified: true,
    delivery_retry_verified: true, api_metering_verified: true, metered_requests: metered.requests.length,
    live_deepseek_api_tested: false, artifacts: directory };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('Smoke artifacts: ' + directory);
  if (stderr) console.error(stderr);
  throw error;
} finally {
  await client?.close();
  mock.closeAllConnections();
  mock.close();
  callbackServer.close();
}
