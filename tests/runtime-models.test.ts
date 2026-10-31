import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CredentialRegistry } from '../src/credentials.ts';
import { ModelRegistry } from '../src/model-config.ts';
import { AgentManager } from '../src/manager.ts';
import { createServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import type { BackendSpec } from '../src/types.ts';
import { scopedTools } from '../src/control.ts';

async function setup(t: TestContext) {
  const base = resolve('.test-output/runtime-models'); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'case-'));
  const credentials = new CredentialRegistry(join(directory, 'credentials.json'), { available: async () => true,
    encrypt: async value => Buffer.from(value), decrypt: async value => value.toString() });
  const ds = await credentials.add({ name: 'DS', protocol: 'deepseek', base_url: 'https://api.deepseek.com', api_key: 'synthetic-only', expected_revision: 0 });
  const apis = await credentials.add({ name: 'OA', protocol: 'openai_responses', base_url: 'https://api.openai.com/v1', api_key: 'synthetic-only', expected_revision: ds.revision });
  const registry = new ModelRegistry(join(directory, 'model-config.json'), credentials);
  let snapshot = await registry.save({ draft: { api_id: apis.entries[0]!.id, model_id: 'deepseek-flash', reasoning_levels: null }, expected_revision: 0 });
  snapshot = await registry.save({ draft: { api_id: apis.entries[1]!.id, model_id: 'gpt-5-mini', reasoning_levels: ['high', 'minimal', 'low'] }, expected_revision: snapshot.revision });
  for (const row of snapshot.entries) snapshot = await registry.toggle({ id: row.id, enabled: true, expected_revision: snapshot.revision });
  const config = loadConfig(undefined, { workspace: directory, dataDir: directory });
  config.control.task_budget = [1, 5]; config.control.round_budget = [1, 5];
  const specs: BackendSpec[] = [];
  const manager = new AgentManager(config, spec => { specs.push(spec); return { open: async () => {}, close: async () => {},
    run: async () => ({ finalResponse: 'ok', finishReason: 'completed' }) }; });
  t.after(() => manager.shutdown());
  return { registry, credentials, manager, snapshot, apis, directory, specs };
}

test('MCP exposes current IDs and ordered efforts, refreshes descriptions, and hides all tools when disabled', async t => {
  const { manager, registry } = await setup(t);
  const server = createServer(manager), client = new Client({ name: 'model-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
  assert.deepEqual((await call('list_model'))!.models, ['deepseek-flash', 'gpt-5-mini']);
  assert.deepEqual((await call('list_effort', { model_id: 'gpt-5-mini' }))!.efforts, ['high', 'minimal', 'low']);
  assert((await client.listTools()).tools.find(tool => tool.name === 'spawn_agent')!.description!.includes('gpt-5-mini'));
  const snapshot = await registry.list();
  await registry.toggle({ id: snapshot.entries[1]!.id, enabled: false, expected_revision: snapshot.revision });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert(!(await client.listTools()).tools.find(tool => tool.name === 'spawn_agent')!.description!.includes('gpt-5-mini'));
  assert((await client.callTool({ name: 'list_effort', arguments: { model_id: 'gpt-5-mini' } })).isError);
  manager.controlPlane.updatePolicy({ enabled: false }, manager.controlPlane.snapshot().revision);
  assert.equal((await client.listTools()).tools.length, 0);
});

test('dispatch rejects undeclared efforts, binds source, and rechecks removal before each request', async t => {
  const { manager, registry, credentials, specs, apis } = await setup(t);
  assert.throws(() => manager.spawn({ task_name: 'invalid', message: 'x', model: 'gpt-5-mini', reasoning_effort: 'none' }), /Undeclared/);
  const spawned = manager.spawn({ task_name: 'valid', message: 'x', model: 'gpt-5-mini' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(specs[0]!.reasoningEffort, 'high', 'default follows declaration order');
  assert.equal(specs[0]!.modelBinding?.api_id, apis.entries[1]!.id);
  const snapshot = await registry.list();
  await registry.toggle({ id: snapshot.entries[1]!.id, enabled: false, expected_revision: snapshot.revision });
  assert.throws(() => manager.followup(spawned.agent.id, 'x'), /not enabled/);
  await registry.toggle({ id: snapshot.entries[1]!.id, enabled: true, expected_revision: snapshot.revision + 1 });
  const list = await credentials.list();
  await credentials.update({ id: list.entries[1]!.id, name: 'OA', protocol: 'openai_responses', base_url: 'https://other.example/v1', expected_revision: list.revision });
  assert.throws(() => manager.followup(spawned.agent.id, 'x'), /not enabled/);
});

test('managed providers reserve independent currency budgets and corrupted configuration fails closed', async t => {
  const { manager, directory } = await setup(t);
  const c = manager.controlPlane;
  const ds = c.reserve('d', c.currentRound, 'deepseek-flash', 50);
  c.settle(ds.id, { input_cache_miss: 1000, input_cache_hit: 0, output: 10 }, 'complete');
  assert.equal(c.snapshot().metrics.task_cost[0], 0); assert(c.snapshot().metrics.task_cost[1] > 0);
  const oa = c.reserve('o', c.currentRound, 'gpt-5-mini', 50);
  c.settle(oa.id, { input_cache_miss: 1000, input_cache_hit: 0, output: 10 }, 'complete');
  assert.equal(c.snapshot().metrics.last_api_cost[1], 0); assert(c.snapshot().metrics.last_api_cost[0] > 0);
  c.updatePolicy({ task_budget: [0, 5] }, c.snapshot().revision);
  assert.throws(() => c.reserve('o', c.currentRound, 'gpt-5-mini', 50), /exhausted/);
  writeFileSync(join(directory, 'model-config.json'), '{invalid');
  assert.throws(() => manager.listModel(), /Cannot read model configuration/);
  assert.throws(() => c.reserve('d', c.currentRound, 'deepseek-flash', 50), /Cannot read model configuration/);
});

test('secondary delegation inherits only its parent model and source, including scoped discovery and nested calls', async t => {
  const { manager, registry, credentials, specs } = await setup(t);
  manager.controlPlane.updatePolicy({ allow_secondary: true, max_depth_user: 2, max_children_user: 3 }, manager.controlPlane.snapshot().revision);
  const parent = manager.spawn({ task_name: 'parent', message: 'x', model: 'gpt-5-mini', reasoning_effort: 'low', max_depth: 2, max_children: 3 }).agent;
  const scoped = scopedTools(manager, parent.id);
  assert.deepEqual(manager.listModel().models, ['deepseek-flash', 'gpt-5-mini']);
  assert.deepEqual(scoped.listModel!().models, ['gpt-5-mini']);
  assert.deepEqual(scoped.policySource!.agentInfo().selected_models, ['gpt-5-mini']);
  assert.throws(() => scoped.listEffort!('deepseek-flash'), /not available/);
  assert.throws(() => scoped.spawn({ task_name: 'wrong', message: 'x', model: 'deepseek-flash' }), /parent model/);
  assert.throws(() => manager.spawn({ parent: parent.id, task_name: 'bypass', message: 'x', model: 'deepseek-flash' }), /parent model/);
  const child = scoped.spawn({ task_name: 'child', message: 'x' }).agent;
  assert.equal(child.model, 'gpt-5-mini'); assert.equal(child.reasoning_effort, 'low');
  const grandchild = scopedTools(manager, child.id).spawn({ task_name: 'grandchild', message: 'x', reasoning_effort: 'minimal' }).agent;
  assert.equal(grandchild.model, 'gpt-5-mini'); assert.equal(grandchild.reasoning_effort, 'minimal');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(specs[1]!.modelBinding, specs[0]!.modelBinding);
  assert.deepEqual(specs[2]!.modelBinding, specs[0]!.modelBinding);

  // Another enabled API with the exact same ID must not silently replace the parent's source.
  const apis = await credentials.list();
  const newApis = await credentials.add({ name: 'replacement', protocol: 'openai_responses', base_url: 'https://api.openai.com/v1', api_key: 'synthetic-new', expected_revision: apis.revision });
  let snapshot = await registry.list();
  snapshot = await registry.toggle({ id: snapshot.entries[1]!.id, enabled: false, expected_revision: snapshot.revision });
  snapshot = await registry.save({ draft: { api_id: newApis.entries.at(-1)!.id, model_id: 'gpt-5-mini', reasoning_levels: ['low'] }, expected_revision: snapshot.revision });
  await registry.toggle({ id: snapshot.entries.at(-1)!.id, enabled: true, expected_revision: snapshot.revision });
  assert.deepEqual(scoped.listModel!().models, []);
  assert.deepEqual(scoped.policySource!.agentInfo().selected_models, []);
  assert.throws(() => scoped.spawn({ task_name: 'changed_source', message: 'x' }), /source changed/);
  assert.throws(() => manager.followup(child.id, 'x'), /source changed/);
});

test('legacy children inherit nondefault models; persisted cross-model children cannot resume', async t => {
  const base = resolve('.test-output/runtime-models'); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'legacy-'));
  const config = loadConfig(undefined, { workspace: directory, dataDir: directory });
  config.control.allow_secondary = true; config.control.max_depth_user = 1;
  const backend = () => ({ open: async () => {}, close: async () => {}, run: async () => ({ finalResponse: 'ok', finishReason: 'completed' }) });
  const first = new AgentManager(config, backend); t.after(() => first.shutdown());
  const parent = first.spawn({ task_name: 'parent', message: 'x', model: 'deepseek-v4-pro', max_depth: 1 }).agent;
  const child = scopedTools(first, parent.id).spawn({ task_name: 'child', message: 'x' }).agent;
  assert.equal(child.model, 'deepseek-v4-pro'); assert.equal(child.reasoning_effort, undefined);
  assert.deepEqual(scopedTools(first, parent.id).listModel!().models, ['deepseek-v4-pro']);
  await first.shutdown();
  const statePath = join(directory, 'state.json'), state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.agents.find((agent: { id: string }) => agent.id === child.id).model = 'deepseek-v4-flash';
  writeFileSync(statePath, JSON.stringify(state));
  const restored = new AgentManager(config, backend); t.after(() => restored.shutdown());
  assert.throws(() => restored.followup(child.id, 'continue'), /parent model and API source/);
});
