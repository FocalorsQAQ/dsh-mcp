import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { TaskSnapshots } from '../src/task-snapshot.ts';
import { OutsourcingSwitch } from '../src/global-control.ts';
import { ControlPlane } from '../src/control-plane.ts';
import { createApplication } from '../src/application.ts';
import { sessionConfig } from '../src/sessions.ts';
import { handlePromptSubmission } from '../src/prompt-hook.ts';
import { CredentialRegistry } from '../src/credentials.ts';
import { ModelRegistry } from '../src/model-config.ts';
import { RuntimeModels } from '../src/runtime-models.ts';
import { AgentManager } from '../src/manager.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

function fixture() {
  const root = resolve('.test-output/snapshots'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'case-')), config = loadConfig(undefined, { workspace: dir, dataDir: join(dir, 'data') });
  const gate = new OutsourcingSwitch(config.data_dir, 'python', config.control);
  return { dir, config, gate, store: new TaskSnapshots(config), chat: randomUUID(), turn: randomUUID() };
}

test('submission freezes every setting, repeated hooks cannot refresh it, and corrupt snapshots cannot reset budgets', () => {
  const f = fixture();
  f.gate.updateSettings({ enabled: true, max_root_agents: 2, round_budget: [2, 10], task_budget: [5, 20] }, 0);
  const one = f.store.capture(f.chat, f.turn, f.dir);
  f.gate.updateSettings({ enabled: false, max_root_agents: 9, round_budget: [8, 9] }, 1);
  assert.deepEqual(f.store.capture(f.chat, f.turn, f.dir), one);
  const next = f.store.capture(f.chat, randomUUID(), f.dir);
  assert.equal(next.settings.enabled, false); assert.deepEqual(next.settings.round_budget, [8, 9]);
  const path = join(f.config.data_dir, 'task-snapshots', f.chat, f.turn + '.json');
  writeFileSync(path, 'corrupt');
  assert.throws(() => f.store.capture(f.chat, f.turn, f.dir));
  assert.equal(readFileSync(path, 'utf8'), 'corrupt');
});

test('overlapping host requests and paid reservations retain their original round and budget', async () => {
  const f = fixture(); f.gate.updateSettings({ round_budget: [0.4, 0], task_budget: [2, 0] }, 0);
  const a = f.store.capture(f.chat, f.turn, f.dir);
  f.gate.updateSettings({ round_budget: [1, 0], enabled: false }, 1);
  const b = f.store.capture(f.chat, randomUUID(), f.dir);
  const plane = new ControlPlane(f.config.control, undefined, () => {}, () => Date.parse('2026-10-26T02:00:00Z'));
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const old = plane.withSnapshot(a, async () => {
    await waiting; assert.equal(plane.currentRound, a.turn_id); assert.equal(plane.policy.max_root_agents, a.settings.max_root_agents);
    const reservation = plane.reserve('a', a.turn_id, a.legacy_model, 100);
    plane.settle(reservation.id, null, 'unknown');
    assert.throws(() => plane.reserve('b', a.turn_id, a.legacy_model, 100), /budget|reservation/i);
  });
  plane.withSnapshot(b, () => assert.throws(() => plane.reserve('c', b.turn_id, b.legacy_model, 100), /禁用/));
  release(); await old;
  assert.equal(plane.currentRound, b.turn_id);
  assert.throws(() => plane.withSnapshot({ ...a, settings: b.settings }, () => {}), /cannot be replaced/);
  const saved = plane.exportState();
  const restarted = new ControlPlane(f.config.control, saved, () => {});
  restarted.withSnapshot(a, () => assert(restarted.agentInfo().available_budget![0] < 0.4));
});

test('Codex MCP rejects a missing snapshot and enforces the exact host turn even after defaults change', async t => {
  const f = fixture(); f.gate.updateSettings({ max_root_agents: 1, round_budget: [0, 0] }, 0);
  f.store.capture(f.chat, f.turn, f.dir);
  const app = createApplication(sessionConfig(f.config, f.chat), () => { throw new Error('Paid worker must not start'); });
  const server = app.createMcpServer(), client = new Client({ name: 'snapshot-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); await app.close(); });
  const call = (turn: string, name = 'get_status', args = {}) => client.callTool({ name, arguments: args, _meta: { thread_id: f.chat, turn_id: turn } });
  assert((await call(randomUUID())).isError);
  f.gate.updateSettings({ enabled: false, round_budget: [99, 99], max_root_agents: 32 }, 1);
  const status = (await call(f.turn)).structuredContent!;
  assert.equal(status.enabled, true); assert.equal((status.control as { max_root_agents: number }).max_root_agents, 1);
  assert.match(JSON.stringify(await call(f.turn, 'spawn_agent', { task_name: 'blocked', message: 'local test' })), /BUDGET_EXHAUSTED/);
  const next = randomUUID(); f.store.capture(f.chat, next, f.dir);
  assert.equal((await call(next)).structuredContent!.enabled, false);
  assert.match(JSON.stringify(await call(next, 'list_agents')), /OUTSOURCING_DISABLED/);
});

test('hook uses exact fork transcript identity and never stores prompt content', () => {
  const f = fixture(), transcript = join(f.dir, 'rollout.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: f.chat } }) + '\n');
  const output = handlePromptSubmission(f.config, { hook_event_name: 'UserPromptSubmit', session_id: randomUUID(), turn_id: f.turn,
    transcript_path: transcript, cwd: f.dir, prompt: 'SECRET_PROMPT_FIXTURE' });
  assert(output.hookSpecificOutput.additionalContext.includes(f.turn));
  assert(!JSON.stringify(f.store.read(f.chat, f.turn)).includes('SECRET_PROMPT_FIXTURE'));
});

test('a queued followup cannot bypass the next turn root limit using an existing worker', async t => {
  const f = fixture(), release = new Map<string, () => void>();
  const manager = new AgentManager(f.config, spec => ({ async open() {}, async close() { release.get(spec.id)?.(); },
    async run() { await new Promise<void>(resolve => release.set(spec.id, resolve)); return { finalResponse: 'local', finishReason: 'completed' }; } }));
  t.after(() => manager.shutdown());
  const old = f.store.capture(f.chat, f.turn, f.dir);
  const a = manager.controlPlane.withSnapshot(old, () => manager.spawn({ task_name: 'old', message: 'hold' })).agent;
  f.gate.updateSettings({ max_root_agents: 1 }, f.gate.snapshot().revision);
  const next = f.store.capture(f.chat, randomUUID(), f.dir);
  const b = manager.controlPlane.withSnapshot(next, () => manager.spawn({ task_name: 'new', message: 'hold' })).agent;
  const until = async (check: () => boolean) => { const deadline = Date.now() + 3000; while (!check()) { assert(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)); } };
  await until(() => release.size === 2);
  manager.controlPlane.withSnapshot(next, () => manager.followup(a.id, 'queued next turn'));
  release.get(a.id)!();
  await until(() => manager.read(a.id).agent.status === 'failed');
  assert.equal(manager.read(a.id).agent.turn, 1);
  assert.equal(manager.read(a.id).agent.queued_messages, 1);
  assert.equal(manager.read(b.id).agent.status, 'running');
});

test('selected models and declared efforts freeze while credential removal still revokes the source', async () => {
  const f = fixture(), directory = f.config.data_dir;
  const credentials = new CredentialRegistry(join(directory, 'credentials.json'), { available: async () => true,
    encrypt: async value => Buffer.from(value), decrypt: async value => value.toString() });
  const api = await credentials.add({ name: 'test', protocol: 'openai_responses', base_url: 'https://api.openai.com/v1', api_key: 'LOCAL-DUMMY', expected_revision: 0 });
  const registry = new ModelRegistry(join(directory, 'model-config.json'), credentials);
  let models = await registry.save({ draft: { api_id: api.entries[0]!.id, model_id: 'gpt-5-mini', reasoning_levels: ['minimal', 'high'] }, expected_revision: 0 });
  models = await registry.toggle({ id: models.entries[0]!.id, enabled: true, expected_revision: models.revision });
  const snapshot = f.store.capture(f.chat, f.turn, f.dir), runtime = new RuntimeModels(f.config);
  await registry.remove({ id: models.entries[0]!.id, expected_revision: models.revision });
  assert.deepEqual(runtime.resolve('gpt-5-mini', 'minimal', undefined, snapshot.models)!.reasoning_levels, ['minimal', 'high']);
  assert.throws(() => runtime.resolve('gpt-5-mini', 'low', undefined, snapshot.models), /Undeclared/);
  assert.deepEqual(f.store.capture(f.chat, randomUUID(), f.dir).models, []);
  await credentials.remove({ id: api.entries[0]!.id, expected_revision: api.revision });
  assert.throws(() => runtime.resolve('gpt-5-mini', undefined, undefined, snapshot.models), /removed/);
});
