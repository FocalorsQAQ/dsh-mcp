import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { OutsourcingSwitch } from '../src/global-control.ts';
import { createApplication } from '../src/application.ts';
import { loadConfig } from '../src/config.ts';
import { sessionConfig } from '../src/sessions.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

function directory() { const root = resolve('.test-output/global-control'); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, 'case-')); }
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) { assert(Date.now() < deadline, 'Global state notification timed out.'); await new Promise(resolve => setTimeout(resolve, 25)); }
}
test('global switch migrates the original preference once, persists independently and detects stale writes', () => {
  const dir = directory(), legacy = JSON.stringify({ control: { policy: { enabled: false, round_budget: [9, 3] }, task_spent_nano: [100, 200] } });
  writeFileSync(join(dir, 'state.json'), legacy);
  const a = new OutsourcingSwitch(dir), b = new OutsourcingSwitch(dir);
  assert.equal(a.enabled, false);
  a.setEnabled(true, 0);
  assert.equal(b.enabled, true);
  assert.throws(() => b.setEnabled(false, 0), /changed/);
  assert.equal(new OutsourcingSwitch(dir, 'python', false).enabled, true);
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), legacy);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'outsourcing.json'), 'utf8'))).sort(), ['enabled', 'revision', 'version']);
});
test('separate processes serialize competing global switch writes', async () => {
  const dir = directory(); new OutsourcingSwitch(dir);
  const update = () => new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
    const child = spawn('python', ['-I', '-B', 'runtime/global_control.py'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', chunk => { out += chunk; }); child.once('error', reject);
    child.once('exit', code => { try { assert.equal(code, 0); resolve(JSON.parse(out)); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify({ operation: 'update', directory: dir, enabled: false, expected_revision: 0 }));
  });
  const results = await Promise.all([update(), update()]);
  assert.equal(results.filter(row => row.ok).length, 1);
  assert.equal(results.find(row => !row.ok)?.code, 'GLOBAL_CONTROL_CONFLICT');
});
test('shared gate preserves tool definitions and supplies live disable notices before any chat calls', async t => {
  const dir = directory(), base = loadConfig(undefined, { workspace: dir, dataDir: join(dir, 'data') });
  const gate = new OutsourcingSwitch(base.data_dir, 'python', false);
  const ids = ['discovery', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002'];
  const apps = ids.map(id => createApplication(sessionConfig(base, id), () => { throw new Error('No worker may start.'); }));
  const clients: Client[] = [], servers = apps.map((app, i) => app.createMcpServer(i === 0));
  let notifications = 0;
  t.after(async () => { for (const client of clients) await client.close(); for (const server of servers) await server.close(); for (const app of apps) await app.close(); });
  for (const server of servers) {
    const client = new Client({ name: 'gate-test', version: '1' }); clients.push(client);
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications++; });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    assert.equal((await client.listTools()).tools.length, 18);
    assert.match(client.getInstructions()!, /外包已禁用/);
    const status = await client.callTool({ name: 'get_status', arguments: {} });
    assert(!status.isError); assert.equal(status.structuredContent?.enabled, false);
  }
  const ledgers = apps.map(app => JSON.stringify(app.ui.snapshot().metrics));
  assert.throws(() => apps[1]!.ui.updateSettings({ enabled: true }, apps[1]!.ui.snapshot().revision), /setOutsourcingEnabled/);
  gate.setEnabled(true, 0);
  for (const client of clients) assert.equal((await client.callTool({ name: 'get_status', arguments: {} })).structuredContent?.enabled, true);
  await until(() => notifications >= 3);
  assert(notifications >= 3);
  gate.setEnabled(false, 1);
  // No notification or host catalog refresh is required for this notice or rejection.
  const rejected = await clients[0]!.callTool({ name: 'list_model', arguments: {} });
  assert(rejected.isError); assert.match(JSON.stringify(rejected.structuredContent), /OUTSOURCING_DISABLED.*外包已禁用/);
  for (const client of clients) {
    assert.equal((await client.listTools()).tools.length, 18);
    const status = await client.callTool({ name: 'get_status', arguments: {} });
    assert(!status.isError); assert.equal(status.structuredContent?.enabled, false);
  }
  const policy = JSON.parse(((await clients[0]!.readResource({ uri: 'dsh://control/status' })).contents[0] as { text: string }).text);
  assert.equal(policy.enabled, false); assert.match(policy.message, /外包已禁用/);
  assert.deepEqual(apps.map(app => JSON.stringify(app.ui.snapshot().metrics)), ledgers);
  writeFileSync(join(base.data_dir, 'outsourcing.json'), 'corrupt');
  assert.equal(gate.enabled, false); assert.throws(() => gate.assertEnabled(), /disabled/);
  const unavailable = await clients[1]!.callTool({ name: 'get_status', arguments: {} });
  assert(!unavailable.isError); assert.equal(unavailable.structuredContent?.enabled, false);
  assert.match(JSON.stringify(unavailable.structuredContent), /GLOBAL_CONTROL_STORAGE/);
  assert((await clients[1]!.callTool({ name: 'spawn_agent', arguments: { task_name: 'forbidden', message: 'No API call.' } })).isError);
});
