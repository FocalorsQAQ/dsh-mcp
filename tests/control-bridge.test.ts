import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startControlBridge } from '../src/control-bridge.ts';
import { scopedTools } from '../src/control.ts';
import { AgentManager } from '../src/manager.ts';
import { loadConfig } from '../src/config.ts';

test('worker MCP bridge requires its capability and enforces bound scope through real MCP calls', async t => {
  const root = resolve('.test-output', 'control');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'case-'));
  const config = loadConfig(undefined, { workspace: directory, dataDir: join(directory, 'data') });
  config.control.allow_secondary = true;
  const manager = new AgentManager(config, () => ({
    async open() {}, async run(message) { return { finalResponse: message, finishReason: 'completed' }; }, async close() {},
  }));
  t.after(async () => { await manager.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  const parent = manager.spawn({ task_name: 'parent', message: 'hello', max_depth: 1 }).agent;
  const other = manager.spawn({ task_name: 'other', message: 'hello' }).agent;
  const bridge = await startControlBridge(scopedTools(manager, parent.id));
  t.after(() => bridge.close());
  assert.equal((await fetch(bridge.url, { method: 'POST' })).status, 403);
  assert.equal((await fetch(bridge.url, { method: 'POST', headers: { Authorization: 'Bearer invalid' } })).status, 403);
  assert.equal((await fetch(bridge.url, { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token, Origin: 'http://example.com' } })).status, 403);
  const client = new Client({ name: 'control-test', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: 'Bearer ' + bridge.token } } }));
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 14);
  assert(tools.tools.some(tool => tool.name === 'batch_control'));
  assert(!tools.tools.some(tool => tool.name === 'set_concurrency'), 'workers cannot change the global limit');
  assert(!tools.tools.some(tool => ['retry_delivery', 'list_deliveries'].includes(tool.name)), 'outbox controls are reserved to the main caller');
  const schema = tools.tools.find(tool => tool.name === 'spawn_agent')!.inputSchema;
  assert.equal(schema.properties!.max_depth!.type, 'integer');
  assert.equal(schema.properties!.max_children!.type, 'integer');
  assert(!schema.required?.includes('max_depth'));
  const bad = await client.callTool({ name: 'spawn_agent', arguments: { task_name: 'invalid', message: 'x', max_depth: 0.5 } });
  assert(bad.isError);
  const escaped = await client.callTool({ name: 'spawn_agent', arguments: { task_name: 'escape', message: 'x', parent: other.id } });
  assert(escaped.isError);
  const spawned = await client.callTool({ name: 'spawn_agent', arguments: { task_name: 'child', message: 'x' } });
  assert(!spawned.isError);
  const child = (spawned.structuredContent as { agent: { id: string; parent_id: string; max_depth: number } }).agent;
  assert.equal(child.parent_id, parent.id);
  assert.equal(child.max_depth, 0);
  for (const name of ['pause_agent', 'resume_agent']) {
    assert((await client.callTool({ name, arguments: { target: other.id } })).isError);
  }
  assert((await client.callTool({ name: 'manage_queue', arguments: { target: other.id, action: 'list' } })).isError);
  const exceeded = await client.callTool({ name: 'spawn_agent', arguments: { task_name: 'second', message: 'x' } });
  assert(exceeded.isError);
  assert.equal((exceeded.structuredContent as { error: { code: string } }).error.code, 'DELEGATION_LIMIT');
  const unrelated = await client.callTool({ name: 'read_agent', arguments: { target: other.id } });
  assert(unrelated.isError);
  const batchEscape = await client.callTool({ name: 'batch_control', arguments: { action: 'close_agent', targets: [child.id, other.id] } });
  assert(batchEscape.isError);
  assert.notEqual(manager.read(child.id).agent.status, 'closed');
  const batch = await client.callTool({ name: 'batch_control', arguments: { action: 'close_agent', path_prefix: parent.path } });
  assert(!batch.isError);
  assert.equal((batch.structuredContent as { succeeded: number }).succeeded, 1);
  assert.equal(manager.read(child.id).agent.status, 'closed');
  assert.notEqual(manager.read(parent.id).agent.status, 'closed');
});
