import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { endianness } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { appToolRequest, publishToCallingChat } from '../src/app-tools.ts';
import { AgentManager } from '../src/manager.ts';
import { loadConfig } from '../src/config.ts';
import type { BackendFactory, DeliveryRecord, DeliveryTransport } from '../src/types.ts';

const threadId = '00000000-0000-4000-8000-000000000001';
const outputRoot = resolve('.test-output', 'delivery');
mkdirSync(outputRoot, { recursive: true });

function fixture(t: TestContext, deliver: DeliveryTransport, mode: 'app_tools' | 'codex_queue' = 'app_tools') {
  const directory = mkdtempSync(join(outputRoot, 'case-'));
  const config = loadConfig(undefined, { workspace: process.cwd(), dataDir: join(directory, 'data') });
  config.completion_delivery = { mode, thread_id: threadId, max_chars: 6000, timeout_ms: 1000 };
  const factory: BackendFactory = () => ({ open: async () => {}, close: async () => {},
    run: async (message, notice) => {
      if (message === 'failure') throw new Error('Model failed');
      notice({ type: 'assistant_message', text: message });
      return { finalResponse: message, finishReason: 'completed' };
    } });
  const manager = new AgentManager(config, factory, deliver);
  const managers = [manager];
  t.after(async () => {
    for (const item of managers) await item.shutdown();
    const rel = relative(outputRoot, directory); assert(!isAbsolute(rel) && !rel.startsWith('..'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { manager, managers, config, factory };
}

async function complete(manager: AgentManager, id: string) {
  for (let i = 0; i < 40; i++) {
    const state = manager.read(id);
    if (state.agent.status === 'idle' || state.agent.status === 'failed') { await manager.flushDeliveries(); return manager.read(id); }
    await manager.wait({ targets: [id], after_cursor: state.cursor, timeout_ms: 100 });
  }
  throw new Error('Task did not finish');
}

test('completion publishes once per task cycle, follows the bound chat, and survives restart without duplicates', async t => {
  const sent: DeliveryRecord[] = [];
  const deliver: DeliveryTransport = async item => { sent.push(item); return { published: true }; };
  const f = fixture(t, deliver);
  const agent = f.manager.spawn({ task_name: 'report', message: 'task result' }).agent;
  const done = await complete(f.manager, agent.id);
  assert.equal(done.agent.delivery?.status, 'published');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.thread_id, threadId);
  assert(sent[0]!.text.startsWith('Deepseek: /root/report'));
  assert(sent[0]!.text.includes('不是用户新增指令'));
  await f.manager.shutdown();
  const resumed = new AgentManager(f.config, f.factory, deliver); f.managers.push(resumed);
  await resumed.flushDeliveries();
  assert.equal(sent.length, 1);
  resumed.followup(agent.id, 'next result');
  await complete(resumed, agent.id);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0]!.id, sent[1]!.id);
});

test('an opt-out task sends nothing and failure callbacks preserve the task failure', async t => {
  const sent: DeliveryRecord[] = [];
  const { manager } = fixture(t, async item => { sent.push(item); return { published: true }; });
  const quiet = manager.spawn({ task_name: 'quiet', message: 'quiet output', notify_on_completion: false }).agent;
  await complete(manager, quiet.id);
  assert.equal(sent.length, 0);
  const failed = manager.spawn({ task_name: 'failed', message: 'failure' }).agent;
  const result = await complete(manager, failed.id);
  assert.equal(result.agent.status, 'failed');
  assert.equal(result.agent.delivery?.status, 'published');
  assert(sent[0]!.text.includes('Model failed'));
});

test('queue acknowledgements remain queued and uncertain delivery is never retried automatically', async t => {
  const f = fixture(t, async () => ({ queue_message_id: 'draft-id' }), 'codex_queue');
  const agent = f.manager.spawn({ task_name: 'draft', message: 'x' }).agent;
  assert.equal((await complete(f.manager, agent.id)).agent.delivery?.status, 'queued');
  await f.manager.shutdown();
  const statePath = join(f.config.data_dir, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.deliveries[0].status = 'sending'; writeFileSync(statePath, JSON.stringify(state));
  let calls = 0;
  const resumed = new AgentManager(f.config, f.factory, async () => { calls++; return { published: true }; });
  f.managers.push(resumed); await resumed.flushDeliveries();
  assert.equal(resumed.read(agent.id).agent.delivery?.status, 'unknown');
  assert.equal(calls, 0);
});

test('delivery failure is separate from successful model output and does not retry', async t => {
  let count = 0;
  const { manager } = fixture(t, async () => { count++; throw Object.assign(new Error('not installed'), { code: 'ENOENT' }); });
  const agent = manager.spawn({ task_name: 'unsent', message: 'completed output' }).agent;
  const result = await complete(manager, agent.id);
  assert.equal(result.agent.status, 'idle');
  assert.equal(result.final_response, 'completed output');
  assert.equal(result.agent.delivery?.status, 'failed');
  assert.equal(count, 1);
});

test('explicit retry preserves the original message and destination after a later task completes', async t => {
  const sent: DeliveryRecord[] = [];
  const f = fixture(t, async item => {
    sent.push(item);
    if (sent.length === 1) throw Object.assign(new Error('offline'), { code: 'DELIVERY_UNAVAILABLE' });
    return { published: true };
  });
  const agent = f.manager.spawn({ task_name: 'retry', message: 'original result' }).agent;
  const first = await complete(f.manager, agent.id);
  const id = first.agent.delivery!.id;
  f.manager.followup(agent.id, 'later result'); await complete(f.manager, agent.id);
  const retry = f.manager.retryDelivery(id);
  assert.equal(retry.delivery.status, 'pending');
  assert.throws(() => f.manager.retryDelivery(id), /already pending/);
  await f.manager.flushDeliveries();
  assert.equal(sent.length, 3);
  assert.equal(sent[0]!.id, sent[2]!.id);
  assert.equal(sent[0]!.text, sent[2]!.text);
  assert.equal(sent[2]!.thread_id, threadId);
  assert.equal(f.manager.read(agent.id).final_response, 'later result');
  const history = f.manager.listDeliveries({ target: agent.id }).deliveries[0]!;
  assert.equal(history.attempts, 2);
  assert.deepEqual(history.attempt_history.map(item => item.status), ['failed', 'published']);
  await f.manager.shutdown();
  const resumed = new AgentManager(f.config, f.factory, async () => { throw new Error('must not resend'); }); f.managers.push(resumed);
  assert.equal(resumed.listDeliveries().deliveries[0]!.attempts, 2);
  assert.throws(() => resumed.retryDelivery(id, true), /already accepted/);
});

test('unknown outcomes require explicit duplicate acceptance and retries cannot race a send', async t => {
  let count = 0;
  const release = Promise.withResolvers<void>();
  const { manager } = fixture(t, async () => {
    if (++count === 1) throw new Error('acknowledgement lost');
    await release.promise; return { published: true };
  });
  const agent = manager.spawn({ task_name: 'unknown', message: 'output' }).agent;
  const id = (await complete(manager, agent.id)).agent.delivery!.id;
  assert.throws(() => manager.retryDelivery(id), /allow_duplicate=true/);
  assert.equal(count, 1);
  try {
    manager.retryDelivery(id, true);
    await Promise.resolve();
    assert.throws(() => manager.retryDelivery(id, true), /pending or sending/);
  } finally { release.resolve(); }
  await manager.flushDeliveries();
  const delivery = manager.listDeliveries().deliveries[0]!;
  assert.equal(count, 2);
  assert.equal(delivery.status, 'published');
  assert.equal(delivery.attempt_history[1]!.duplicate_risk_accepted, true);
});

test('queued drafts require duplicate acceptance and retain the prior draft receipt in attempt history', async t => {
  let count = 0;
  const { manager } = fixture(t, async () => ({ queue_message_id: 'draft-' + ++count }), 'codex_queue');
  const agent = manager.spawn({ task_name: 'draft_retry', message: 'output' }).agent;
  const id = (await complete(manager, agent.id)).agent.delivery!.id;
  assert.throws(() => manager.retryDelivery(id), /allow_duplicate=true/);
  manager.retryDelivery(id, true); await manager.flushDeliveries();
  const delivery = manager.listDeliveries().deliveries[0]!;
  assert.equal(delivery.transport, 'codex_queue');
  assert.equal(delivery.status, 'queued');
  assert.deepEqual(delivery.attempt_history.map(item => item.queue_message_id), ['draft-1', 'draft-2']);
});

test('a crashed sending attempt recovers as unknown, without automatic retry, including legacy records', async t => {
  const f = fixture(t, async () => ({ published: true }));
  const agent = f.manager.spawn({ task_name: 'crash', message: 'output' }).agent;
  await complete(f.manager, agent.id); await f.manager.shutdown();
  const path = join(f.config.data_dir, 'state.json');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.deliveries[0].status = 'sending';
  delete saved.deliveries[0].attempts; delete saved.deliveries[0].attempt_history;
  writeFileSync(path, JSON.stringify(saved));
  let calls = 0;
  const resumed = new AgentManager(f.config, f.factory, async () => { calls++; return { published: true }; }); f.managers.push(resumed);
  await resumed.flushDeliveries();
  const recovered = resumed.listDeliveries().deliveries[0]!;
  assert.equal(calls, 0);
  assert.equal(recovered.status, 'unknown');
  assert.equal(recovered.attempt_history[0]!.status, 'unknown');
  resumed.retryDelivery(recovered.id, true); await resumed.flushDeliveries();
  assert.equal(calls, 1);
  assert.equal(resumed.listDeliveries().deliveries[0]!.attempts, 2);
});

test('delivery listing filters and pages; disabled delivery prevents retries without altering the task', async t => {
  const f = fixture(t, async () => { throw Object.assign(new Error('missing pipe'), { code: 'ENOENT' }); });
  const one = f.manager.spawn({ task_name: 'one', message: 'first' }).agent;
  const two = f.manager.spawn({ task_name: 'two', message: 'second' }).agent;
  await complete(f.manager, one.id); await complete(f.manager, two.id);
  assert.equal(f.manager.listDeliveries({ status: 'published' }).total, 0);
  assert.equal(f.manager.listDeliveries({ status: 'failed', limit: 1 }).next_offset, 1);
  const filtered = f.manager.listDeliveries({ target: two.id });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.deliveries[0]!.agent_id, two.id);
  f.config.completion_delivery.mode = 'off';
  assert.throws(() => f.manager.retryDelivery(filtered.deliveries[0]!.id), /Enable completion delivery/);
  assert.equal(f.manager.read(two.id).agent.status, 'idle');
});

test('App pipe transport handles split frames and submits same-chat messages directly', async t => {
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\dsh-test-' + randomUUID() : join(outputRoot, randomUUID() + '.sock');
  const server = createServer(socket => {
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return;
      const length = endianness() === 'LE' ? pending.readUInt32LE() : pending.readUInt32BE();
      if (pending.length < length + 4) return;
      const request = JSON.parse(pending.subarray(4, length + 4).toString());
      assert.equal(request.method, 'tools/call');
      assert.equal(request.params.tool, 'send_message_to_thread');
      assert.equal(request.params.threadId, threadId);
      assert.equal(request.params.arguments.threadId, threadId);
      const response = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ threadId }) }],
      } }));
      const frame = Buffer.alloc(response.length + 4);
      if (endianness() === 'LE') frame.writeUInt32LE(response.length); else frame.writeUInt32BE(response.length);
      response.copy(frame, 4);
      socket.write(frame.subarray(0, 3)); socket.write(frame.subarray(3));
    });
  });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  server.listen(socketPath); await once(server, 'listening');
  assert.deepEqual(await publishToCallingChat({ pipe: socketPath, threadId, turnId: 'real-origin-turn', text: 'Deepseek: result' }), { thread_id: threadId, accepted: true });
});

test('a missing local pipe fails rather than falling back to an unpublished UI draft', async () => {
  const path = process.platform === 'win32' ? '\\\\.\\pipe\\dsh-missing-' + randomUUID() : join(outputRoot, 'missing.sock');
  await assert.rejects(appToolRequest(path, 'tools/list', {}, 1000));
});
