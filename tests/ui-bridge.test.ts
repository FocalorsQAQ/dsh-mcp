import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApplication } from '../src/application.ts';
import { loadConfig } from '../src/config.ts';
import { startUiBridge } from '../src/ui-bridge.ts';
import { UiClient } from '../src/ui-client.ts';

const backend = () => ({ async open() {}, async close() {}, async run(message: string) { return { finalResponse: message, finishReason: 'completed' }; } });
async function until(condition: () => boolean) {
  const end = Date.now() + 5000;
  while (!condition()) { assert(Date.now() < end, 'condition timed out'); await new Promise(resolve => setTimeout(resolve, 15)); }
}
function config() {
  const root = resolve('.test-output', 'ui-unit'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'run-'));
  return loadConfig(undefined, { workspace: dir, dataDir: join(dir, 'data') });
}

test('UI bridge authenticates, validates writes and controls the same application as MCP', async t => {
  const cfg = config(); const app = createApplication(cfg, backend);
  const bridge = await startUiBridge(app.ui, cfg.data_dir);
  const server = app.createMcpServer(); const mcp = new Client({ name: 'ui-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await mcp.connect(b);
  const client = new UiClient(cfg.data_dir, cfg.workspace_root, 20); client.reconnect();
  t.after(async () => { client.close(); await mcp.close(); await server.close(); await bridge.close(); await app.close(); });
  await until(() => client.snapshot().status === 'connected');
  const url = bridge.endpoint.url;
  const auth = { Authorization: 'Bearer ' + bridge.endpoint.token };
  assert.equal((await fetch(url + '/v1/snapshot')).status, 403);
  assert.equal((await fetch(url + '/v1/snapshot', { headers: { ...auth, Origin: 'https://example.com' } })).status, 403);
  const bad = await fetch(url + '/v1/settings', { method: 'PATCH', headers: auth,
    body: JSON.stringify({ patch: { api_key: 'not-supported' }, expected_revision: app.ui.snapshot().revision }) });
  assert.equal(bad.status, 400);
  const revision = client.snapshot().snapshot!.revision;
  await client.updateSettings({ max_root_agents: 2 }, revision);
  await client.setOutsourcingEnabled(false, 0);
  assert.equal((await mcp.listTools()).tools.length, 18);
  assert.equal((await mcp.callTool({ name: 'get_status', arguments: {} })).structuredContent?.enabled, false);
  assert((await mcp.callTool({ name: 'spawn_agent', arguments: { task_name: 'forbidden', message: 'x' } })).isError);
  await assert.rejects(client.setOutsourcingEnabled(true, 0), /refresh/);
  await client.setOutsourcingEnabled(true, 1);
  assert.equal((await mcp.listTools()).tools.length, 18);
  assert.equal((await mcp.callTool({ name: 'get_status', arguments: {} })).structuredContent?.enabled, true);
  assert.equal(app.ui.snapshot().settings.max_root_agents, 2);
  assert(!JSON.stringify(client.snapshot()).includes(bridge.endpoint.token));
  const intent = await client.openManagementWindow('models');
  assert.equal(intent.implemented, true); assert.equal(intent.window, 'models');
  client.close();
  assert.equal((await mcp.listTools()).tools.length, 18, 'closing UI must not shut down the MCP owner');
  const stored = JSON.parse(readFileSync(join(cfg.data_dir, 'state.json'), 'utf8'));
  assert.equal(stored.control.policy.max_root_agents, 2);
});

test('UI client recovers from an absent service and restart with a new token without resetting settings', async t => {
  const cfg = config(); const client = new UiClient(cfg.data_dir, cfg.workspace_root, 30);
  client.reconnect(); await until(() => client.snapshot().status === 'disconnected');
  const app = createApplication(cfg, backend); const bridge = await startUiBridge(app.ui, cfg.data_dir);
  await until(() => client.snapshot().status === 'connected');
  await client.updateSettings({ max_root_agents: 7 }, client.snapshot().snapshot!.revision);
  await bridge.close(); await app.close();
  assert(!existsSync(join(cfg.data_dir, 'ui-endpoint.json')));
  await until(() => client.snapshot().status === 'disconnected');
  assert.equal(client.snapshot().snapshot!.settings.max_root_agents, 7);
  const nextApp = createApplication(cfg, backend); const nextBridge = await startUiBridge(nextApp.ui, cfg.data_dir);
  t.after(async () => { client.close(); await nextBridge.close(); await nextApp.close(); });
  assert.notEqual(nextBridge.endpoint.token, bridge.endpoint.token);
  await until(() => client.snapshot().status === 'connected');
  assert.equal(client.snapshot().snapshot!.settings.max_root_agents, 7);
  await client.updateSettings({ max_root_agents: 8 }, client.snapshot().snapshot!.revision);
  assert.equal(nextApp.ui.snapshot().settings.max_root_agents, 8);
});
