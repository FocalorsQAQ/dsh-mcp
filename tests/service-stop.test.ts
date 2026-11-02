import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApplication } from '../src/application.ts';
import { AgentManager } from '../src/manager.ts';
import { loadConfig } from '../src/config.ts';
import { sessionConfig } from '../src/sessions.ts';
import { OutsourcingSwitch } from '../src/global-control.ts';
import { TaskSnapshots } from '../src/task-snapshot.ts';
import type { BackendFactory, BackendSpec, DeliveryRecord } from '../src/types.ts';

function fixture() {
  const root = resolve('.test-output/service-stop'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'run-')), path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify({ workspace_root: directory, data_dir: join(directory, 'data'), ui_auto_start: false,
    control: { enabled: true, allow_secondary: true, round_budget: [8, 20] }, completion_delivery: { mode: 'off' } }));
  const config = loadConfig(path), gate = new OutsourcingSwitch(config.data_dir, config.billing.python, config.control);
  return { config, gate, snapshots: new TaskSnapshots(config) };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!check()) { assert(Date.now() < deadline, 'Service stop timed out'); await new Promise(r => setTimeout(r, 20)); }
}

test('service close revokes frozen turns across chats, stops descendants and notifies each active caller once', async t => {
  const { config, gate, snapshots } = fixture(), sent: DeliveryRecord[] = [], specs: BackendSpec[] = [];
  const factory: BackendFactory = spec => {
    specs.push(spec); let finish: (() => void) | undefined;
    return { async open() {}, async run() { await new Promise<void>(r => { finish = r; }); return { finalResponse: '', finishReason: 'interrupted' }; }, async close() { finish?.(); } };
  };
  const rows = await Promise.all([randomUUID(), randomUUID()].map(async id => {
    const turn = randomUUID(); snapshots.capture(id, turn, config.workspace_root);
    const app = createApplication(sessionConfig(config, id), factory, async item => { sent.push(item); return { published: true }; });
    const server = app.createMcpServer(), client = new Client({ name: 'stop-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    const call = (name: string, args = {}, round = turn) => client.callTool({ name, arguments: args, _meta: { thread_id: id, turn_id: round } });
    t.after(async () => { await client.close(); await server.close(); await app.close(); });
    return { id, turn, app, client, call };
  }));
  const root = await rows[0]!.call('spawn_agent', { task_name: 'parent', message: 'local only', max_depth: 1, max_children: 1, notify_on_completion: false });
  assert(!root.isError, JSON.stringify(root));
  const parent = (root.structuredContent as any).agent.id;
  assert(!(await rows[0]!.call('spawn_agent', { task_name: 'child', message: 'local only', parent, notify_on_completion: false })).isError);
  assert(!(await rows[1]!.call('spawn_agent', { task_name: 'other', message: 'local only', notify_on_completion: false })).isError);
  assert(!(await rows[0]!.call('send_message', { target: parent, message: 'must never execute' })).isError);
  await until(() => specs.length === 3);
  const settings = gate.snapshot().settings;
  const stop = gate.stopService().service_stop!;
  assert.equal(gate.stopService().service_stop!.id, stop.id, 'Repeated shutdown must be idempotent');
  for (const row of rows) {
    // Rejection is synchronous with the durable gate, before the periodic worker stop observer.
    assert.equal((await row.call('get_status')).structuredContent?.enabled, false);
    assert.match(JSON.stringify(await row.call('list_agents')), /OUTSOURCING_DISABLED/);
    assert.match(JSON.stringify(await row.call('spawn_agent', { task_name: 'forbidden', message: 'blocked' })), /OUTSOURCING_DISABLED/);
  }
  assert.throws(() => specs[0]!.metering!.reserve(config.model, 1), /外包已禁用/);
  await until(() => rows.every(row => row.app.ui.snapshot().runtime.active_count === 0));
  await until(() => sent.length === 2);
  for (const row of rows) {
    await row.app.ui.applyServiceStop();
    assert(row.app.ui.snapshot().runtime.agents.every(agent => agent.status === 'closed'));
    assert.equal(sent.filter(item => item.thread_id === row.id).length, 1);
  }
  assert(sent.every(item => item.kind === 'service_stopped' && item.text.includes('服务已被用户停用')));
  assert.equal(specs.length, 3, 'Queued work never starts after shutdown');
  assert.deepEqual(gate.snapshot().settings, { ...settings, enabled: false });
  gate.setEnabled(true, gate.snapshot().revision);
  for (const row of rows) assert.equal((await row.call('get_status')).structuredContent?.enabled, false, 'Re-enabling must not revive revoked turns');
  const fresh = randomUUID(); snapshots.capture(rows[0]!.id, fresh, config.workspace_root);
  assert.equal((await rows[0]!.call('get_status', {}, fresh)).structuredContent?.enabled, true);
  assert((await rows[0]!.call('followup_task', { target: parent, message: 'old handles stay closed' }, fresh)).isError);
  assert(!(await rows[0]!.call('spawn_agent', { task_name: 'fresh', message: 'new authorization', notify_on_completion: false }, fresh)).isError);
  assert.equal(sent.length, 2);
});

test('stop survives a rapid re-enable and restart; completed chats are not notified', async t => {
  const { config, gate } = fixture(), sent: DeliveryRecord[] = [];
  config.completion_delivery.thread_id = randomUUID();
  const factory: BackendFactory = () => ({ async open() {}, async run() { return { finalResponse: 'done', finishReason: 'completed' }; }, async close() {} });
  const deliver = async (item: DeliveryRecord) => { sent.push(item); return { published: true }; };
  const first = new AgentManager(config, factory, deliver);
  const old = first.spawn({ task_name: 'finished', message: 'local' }).agent;
  await until(() => first.read(old.id).agent.status === 'idle');
  await first.shutdown();
  gate.stopService(); gate.setEnabled(true, gate.snapshot().revision);
  const next = new AgentManager(config, factory, deliver); t.after(() => next.shutdown());
  await next.applyServiceStop(); await next.flushDeliveries();
  assert.equal(next.read(old.id).agent.status, 'closed');
  assert.equal(sent.length, 0);
  assert.throws(() => next.followup(old.id, 'cannot revive'), /外包已禁用/);
  assert(next.spawn({ task_name: 'fresh', message: 'new task' }).agent.id);
});

test('failed cleanup keeps capacity occupied, retries locally, and never duplicates the stop notice', async t => {
  const { config, gate } = fixture(), sent: DeliveryRecord[] = [];
  config.completion_delivery.thread_id = randomUUID();
  let mayClose = false, finish: (() => void) | undefined, runs = 0;
  const manager = new AgentManager(config, () => ({ async open() {}, async run() { runs++; await new Promise<void>(r => { finish = r; }); return { finalResponse: '', finishReason: 'interrupted' }; },
    async close() { if (!mayClose) throw new Error('transient cleanup failure'); finish?.(); } }), async item => { sent.push(item); return { published: true }; });
  t.after(async () => { mayClose = true; await manager.shutdown(); });
  const agent = manager.spawn({ task_name: 'running', message: 'local' }).agent;
  await until(() => runs === 1);
  manager.sendMessage(agent.id, 'cancel this queued input');
  gate.stopService();
  await assert.rejects(manager.applyServiceStop(), /unconfirmed/);
  assert.equal(manager.read(agent.id).pending.length, 0);
  assert.equal(manager.list().active_count, 1);
  assert.throws(() => manager.spawn({ task_name: 'blocked', message: 'local' }), /外包已禁用/);
  mayClose = true;
  await until(() => manager.list().active_count === 0);
  await manager.flushDeliveries();
  assert.equal(manager.read(agent.id).agent.status, 'closed');
  assert.equal(sent.length, 1);
  await manager.shutdown();
  const recovered = new AgentManager(config, () => { throw new Error('No worker should restart'); }, async item => { sent.push(item); return { published: true }; });
  t.after(() => recovered.shutdown());
  await recovered.applyServiceStop(); await recovered.flushDeliveries();
  assert.equal(sent.length, 1);
});

test('a second shutdown during cleanup also stops agents from the intervening enable', async t => {
  const { config, gate } = fixture(), sent: DeliveryRecord[] = [];
  config.completion_delivery.thread_id = randomUUID();
  let release!: () => void, runs = 0, created = 0;
  const held = new Promise<void>(r => { release = r; });
  const manager = new AgentManager(config, () => {
    const first = created++ === 0; let finish: (() => void) | undefined;
    return { async open() {}, async run() { runs++; await new Promise<void>(r => { finish = r; }); return { finalResponse: '', finishReason: 'interrupted' }; },
      async close() { if (first) await held; finish?.(); } };
  }, async item => { sent.push(item); return { published: true }; });
  t.after(async () => { release(); await manager.shutdown(); });
  manager.spawn({ task_name: 'old', message: 'local' }); await until(() => runs === 1);
  const first = gate.stopService().service_stop!.id;
  const cleaning = manager.applyServiceStop();
  gate.setEnabled(true, gate.snapshot().revision);
  manager.spawn({ task_name: 'new', message: 'local' }); await until(() => runs === 2);
  const second = gate.stopService().service_stop!.id;
  assert.notEqual(first, second);
  await new Promise(r => setTimeout(r, 300)); // Let the second notification observe the still-pending cleanup.
  release(); await cleaning;
  await until(() => manager.list().active_count === 0);
  await manager.flushDeliveries();
  assert(manager.list().agents.every(agent => agent.status === 'closed'));
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0]!.id, sent[1]!.id);
});
