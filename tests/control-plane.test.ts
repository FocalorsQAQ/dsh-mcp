import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ControlPlane } from '../src/control-plane.ts';
import { policySchema } from '../src/control-contract.ts';
import { ModelCatalog } from '../src/models.ts';
import { createApplication } from '../src/application.ts';
import { loadConfig } from '../src/config.ts';
import { AgentManager } from '../src/manager.ts';
import { scopedTools } from '../src/control.ts';
import type { BackendSpec } from '../src/types.ts';

const model = 'deepseek-v4-flash';
const usage = { input_cache_miss: 1000, input_cache_hit: 2000, output: 100 };
const peakTime = Date.parse('2026-10-26T02:00:00Z');
const plane = (settings = {}) => new ControlPlane(policySchema.parse(settings), undefined, () => {}, () => peakTime);
function update(control: ControlPlane, patch: unknown) { control.updatePolicy(patch, control.snapshot().revision); }
function configFor(t: TestContext) {
  const root = resolve('.test-output', 'policy'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'case-'));
  return loadConfig(undefined, { workspace: dir, dataDir: join(dir, 'data') });
}

test('shared round and task reservations prevent parallel overspending and preserve nanounits', () => {
  const c = plane({ round_budget: [0.34, 0], task_budget: [1, 0] });
  const first = c.reserve('a', c.currentRound, model, 16000);
  assert.throws(() => c.reserve('b', c.currentRound, model, 16000), /conservative input reservation/);
  c.settle(first.id, usage, 'complete');
  assert.deepEqual(c.snapshot().metrics.task_cost, [0.000432, 0]);
  c.settle(first.id, usage, 'complete');
  assert.deepEqual(c.snapshot().metrics.task_cost, [0.000432, 0], 'duplicate completion is idempotent');
  const second = c.reserve('b', c.currentRound, model, 16000);
  c.settle(second.id, { input_cache_miss: 1, input_cache_hit: 0, output: 0 }, 'complete');
  assert.deepEqual(c.snapshot().metrics.task_cost, [0.0004323, 0]);
  assert.deepEqual(c.snapshot().metrics.tokens, { input_cache_miss: 1001, input_cache_hit: 2000, output: 100 });
  c.snapshot().metrics.last_api_tokens!.output = 9999;
  assert.equal(c.snapshot().metrics.last_api_tokens!.output, 0, 'UI usage objects must not alias saved records');
});

test('all followups share a host round; switching and reusing round IDs never erases spending', () => {
  const c = plane({ round_budget: [1, 0], task_budget: [2, 0] });
  const original = c.currentRound;
  const a = c.reserve('a', original, model, 10); c.settle(a.id, usage, 'unknown');
  const spent = c.snapshot().metrics.task_cost[0];
  c.beginRound('next-user-message', c.snapshot().revision);
  assert.deepEqual(c.snapshot().metrics.round_cost, [0, 0]);
  assert.equal(c.snapshot().metrics.task_cost[0], spent);
  const late = c.reserve('old-child', original, model, 10); c.settle(late.id, usage, 'unknown');
  assert.deepEqual(c.snapshot().metrics.round_cost, [0, 0], 'old in-flight tree stays charged to its original round');
  c.beginRound(original, c.snapshot().revision);
  assert.equal(c.snapshot().metrics.round_cost[0], spent * 2);
  update(c, { task_budget: [0.7, 0] });
  assert(c.agentInfo().budget![0] < 1);
  assert.throws(() => c.reserve('a', original, model, 10), /conservative input reservation/);
});

test('CNY is a separate balance and no exchange conversion is implicit', () => {
  const c = plane({ billing_currency: 'CNY', task_budget: [100, 3] });
  const r = c.reserve('a', c.currentRound, model, 100);
  c.settle(r.id, usage, 'complete');
  assert.deepEqual(c.snapshot().metrics.task_cost, [0, 0.00288]);
  update(c, { task_budget: [100, 0] });
  assert.equal(c.policy.billing_currency, 'CNY', 'PATCH must not apply defaults to missing properties');
  assert.throws(() => c.reserve('a', c.currentRound, model, 100), /exhausted/);
});

test('partial policy updates preserve settings, reject unknown keys and snapshots do not expose mutable state', () => {
  const c = plane({ max_root_agents: 2, allow_secondary: true, max_depth_user: 4, round_budget: [2, 3] });
  const before = c.policy;
  update(c, { enabled: false });
  assert.deepEqual(c.policy, { ...before, enabled: false });
  assert.throws(() => update(c, { selected_models: ['invented'] }));
  const snapshot = c.snapshot(); snapshot.settings.max_root_agents = 30; snapshot.models.length = 0;
  assert.equal(c.policy.max_root_agents, 2); assert(c.snapshot().models.length > 0);
  c.subscribe(() => { throw new Error('faulty UI'); });
  update(c, { enabled: true });
  assert.equal(c.policy.enabled, true);
});

test('lost receipts and crash recovery retain the full reservation, while explicit rejection refunds', () => {
  const c = plane({ task_budget: [1, 0] });
  const r = c.reserve('a', c.currentRound, model, 100);
  const reserved = c.snapshot().metrics.reserved_cost;
  const recovered = new ControlPlane(policySchema.parse({}), c.exportState(), () => {});
  assert.deepEqual(recovered.snapshot().metrics.task_cost, reserved);
  assert.equal(recovered.snapshot().metrics.last_api_status, 'unknown');
  recovered.settle(r.id, usage, 'complete');
  assert.deepEqual(recovered.snapshot().metrics.task_cost, reserved);
  const next = recovered.reserve('b', recovered.currentRound, model, 100);
  recovered.settle(next.id, null, 'rejected');
  assert.deepEqual(recovered.snapshot().metrics.task_cost, reserved);
});

test('unpriced models, stale settings, disabled outsourcing and provider envelope violations fail closed', () => {
  const c = plane();
  assert.throws(() => c.reserve('a', c.currentRound, 'unknown', 100), /reviewed/);
  const revision = c.snapshot().revision;
  update(c, { enabled: false });
  assert.throws(() => c.reserve('a', c.currentRound, model, 100), /外包已禁用/);
  assert.throws(() => c.updatePolicy({ enabled: true }, revision), /refresh/);
  update(c, { enabled: true });
  const r = c.reserve('a', c.currentRound, model, 10);
  c.settle(r.id, usage, 'complete'); // actual output exceeds the admitted cap
  assert.equal(c.snapshot().metrics.accounting_blocked, true);
  assert.throws(() => c.reserve('a', c.currentRound, model, 100), /exceeded/);
});

test('model discovery uses metadata without inventing prices or exposing credentials', async () => {
  const catalog = new ModelCatalog();
  let url = '';
  await catalog.refresh({ apiKey: 'test-credential', fetch: (async (input, options) => {
    url = String(input); assert.equal(options?.redirect, 'error');
    return Response.json({ data: [{ id: 'new-model', name: 'New', context_window: 50000,
      max_output_tokens: 2000, input_modalities: ['text'], effort: { supported_levels: ['high'] } }] });
  }) as typeof fetch });
  assert.equal(url, 'https://api.deepseek.com/models');
  assert.equal(catalog.get('new-model')?.pricing, null);
  assert(!JSON.stringify(catalog.list()).includes('test-credential'));
  assert.equal(catalog.get(model)?.source, 'bundled');
});

test('MCP preserves tools while disabled, exposes a live notice and rejects outsourcing', async t => {
  const app = createApplication(configFor(t), () => ({ async open() {}, async close() {},
    async run() { return { finalResponse: 'x', finishReason: 'completed' }; } }));
  const server = app.createMcpServer();
  const client = new Client({ name: 'control-contract-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); await app.close(); });
  assert.equal((await client.listTools()).tools.length, 20);
  assert((await client.listTools()).tools.every(tool => !/update_settings|begin_round/.test(tool.name)));
  let events = 0;
  const unsubscribe = app.ui.subscribe(() => { events++; });
  app.ui.setOutsourcingEnabled(false, 0);
  assert.equal((await client.listTools()).tools.length, 20);
  assert.equal((await client.callTool({ name: 'get_status', arguments: {} })).structuredContent?.enabled, false);
  assert((await client.callTool({ name: 'spawn_agent', arguments: { task_name: 'bad', message: 'x' } })).isError);
  const resource = await client.readResource({ uri: 'dsh://control/status' });
  assert(JSON.stringify(resource).includes('外包已禁用'));
  app.ui.setOutsourcingEnabled(true, 1);
  assert.equal((await client.listTools()).tools.length, 20);
  assert.equal((await client.callTool({ name: 'get_status', arguments: {} })).structuredContent?.enabled, true);
  assert.equal(app.ui.openManagementWindow('api_keys').implemented, true);
  assert.equal(app.ui.openManagementWindow('models').window, 'models');
  assert.equal(events, 2); unsubscribe();
});

test('user AND model consent, depth clamping, width and live lowering apply inside manager', async t => {
  const config = configFor(t);
  const manager = new AgentManager(config, () => ({ async open() {}, async close() {}, async run() { return { finalResponse: 'ok', finishReason: 'completed' }; } }));
  t.after(() => manager.shutdown());
  const denied = manager.spawn({ task_name: 'denied', message: 'x', max_depth: 10 }).agent;
  assert.equal(denied.max_depth, 0);
  assert.throws(() => manager.spawn({ task_name: 'nested', message: 'x', parent: denied.id }), /no remaining/);
  update(manager.controlPlane, { allow_secondary: true, max_depth_user: 1, max_children_user: 1 });
  const allowed = manager.spawn({ task_name: 'allowed', message: 'x', max_depth: 20, max_children: 99 }).agent;
  assert.equal(allowed.max_depth, 1); assert.equal(allowed.max_children, 1);
  const child = manager.spawn({ task_name: 'child', message: 'x', parent: allowed.id }).agent;
  assert.equal(child.max_depth, 0);
  assert.throws(() => manager.spawn({ task_name: 'extra', message: 'x', parent: allowed.id }), /direct-child/);
  update(manager.controlPlane, { max_depth_user: 0 });
  assert.throws(() => manager.followup(child.id, 'x'), /forbids/);
  const modelNo = manager.spawn({ task_name: 'model_no', message: 'x' }).agent;
  assert.equal(modelNo.max_depth, 0);
});

test('root concurrency cannot be bypassed by set_concurrency, resume or followup; slots are reusable', async t => {
  const config = configFor(t); config.control.max_root_agents = 1;
  const pending = new Map<string, () => void>();
  const manager = new AgentManager(config, spec => ({ async open() {},
    async run() { await new Promise<void>(resolve => pending.set(spec.id, resolve)); return { finalResponse: 'x', finishReason: 'completed' }; },
    async close() { pending.get(spec.id)?.(); },
  }));
  t.after(() => manager.shutdown());
  const a = manager.spawn({ task_name: 'a', message: 'x' }).agent;
  manager.setConcurrency(32);
  assert.throws(() => manager.spawn({ task_name: 'b', message: 'x' }), /top-level/);
  await new Promise(resolve => setImmediate(resolve));
  await manager.interrupt(a.id);
  const b = manager.spawn({ task_name: 'b', message: 'x' }).agent;
  assert.throws(() => manager.followup(a.id, 'x'), /top-level/);
  manager.pause(a.id); manager.sendMessage(a.id, 'queued');
  assert.throws(() => manager.resume(a.id), /top-level/);
  await manager.interrupt(b.id);
});

test('backend capabilities charge nested calls to original user round across a new host task', async t => {
  const config = configFor(t); config.control.allow_secondary = true;
  const specs = new Map<string, BackendSpec>(); const release = new Map<string, () => void>();
  const manager = new AgentManager(config, spec => {
    specs.set(spec.id, spec);
    return { async open() {}, async run() { await new Promise<void>(resolve => release.set(spec.id, resolve)); return { finalResponse: '', finishReason: 'completed' }; },
      async close() { release.get(spec.id)?.(); } };
  });
  t.after(() => manager.shutdown());
  const original = manager.controlPlane.currentRound;
  const parent = manager.spawn({ task_name: 'parent', message: 'x', max_depth: 1 }).agent;
  await new Promise(resolve => setImmediate(resolve));
  manager.controlPlane.beginRound('second-user-task', manager.controlPlane.snapshot().revision);
  const child = scopedTools(manager, parent.id).spawn({ task_name: 'child', message: 'x' }).agent;
  await new Promise(resolve => setImmediate(resolve));
  const request = specs.get(child.id)!.metering!.reserve(model, 100);
  specs.get(child.id)!.metering!.settle(request.id, usage, 'complete');
  assert.equal(manager.controlPlane.snapshot().metrics.round_cost[0], 0);
  const spent = manager.controlPlane.exportState().rounds.find(round => round.id === original)!.spent_nano[0];
  assert(spent > 0);
  assert.equal(spent, manager.controlPlane.exportState().task_spent_nano[0]);
  manager.globalControl.setEnabled(false, manager.globalControl.snapshot().revision);
  assert.throws(() => specs.get(child.id)!.metering!.reserve(model, 100), /外包已禁用/);
  const saved = JSON.parse(readFileSync(join(config.data_dir, 'state.json'), 'utf8'));
  assert.equal(saved.control.task_spent_nano[0], spent);
});
