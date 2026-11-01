import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { listSessions, sessionConfig, sessionDirectory, writeSessionInfo } from '../src/sessions.ts';

const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
function fixture() {
  const parent = resolve('.test-output/sessions-unit'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'run-')), config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ workspace_root: root, data_dir: join(root, 'data') }));
  const base = loadConfig(config); mkdirSync(base.data_dir);
  return { root, base };
}
test('chat sessions share provider configuration, retain policy defaults, and never copy another ledger or agent', () => {
  const { base } = fixture();
  const legacy = JSON.stringify({ agents: [{ private_text: 'legacy-only' }], control: { policy: { task_budget: [3, 4] }, task_spent_nano: [7, 8] } });
  writeFileSync(join(base.data_dir, 'state.json'), legacy);
  const a = sessionConfig(base, A), b = sessionConfig(base, B);
  assert.notEqual(a.data_dir, b.data_dir); assert.equal(a.model_config_dir, base.data_dir); assert.equal(b.model_config_dir, base.data_dir);
  assert.deepEqual(a.control.task_budget, [3, 4]); assert.equal(a.codex_thread_id, A); assert.equal(b.completion_delivery.thread_id, B);
  assert(!existsSync(join(a.data_dir, 'state.json'))); assert(!existsSync(join(b.data_dir, 'state.json')));
  assert.equal(readFileSync(join(base.data_dir, 'state.json'), 'utf8'), legacy);
  assert.equal(sessionConfig(base, 'discovery').completion_delivery.mode, 'off');
});
test('invalid legacy limits fail closed instead of silently removing budgets', () => {
  const { base } = fixture();
  writeFileSync(join(base.data_dir, 'state.json'), JSON.stringify({ control: { policy: { task_budget: 'invalid' } } }));
  assert.throws(() => sessionConfig(base, A));
});
test('session paths reject traversal and junctions, and the catalog omits malformed or mismatched metadata', () => {
  const { base, root } = fixture();
  assert.throws(() => sessionDirectory(base.data_dir, '../outside', true));
  const external = join(root, 'outside'); mkdirSync(external);
  const parent = join(base.data_dir, 'chats'); mkdirSync(parent);
  symlinkSync(external, join(parent, A), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => sessionConfig(base, A), /regular directory/);
  writeSessionInfo(base.data_dir, { version: 1, id: B, workspace: root, created_at: new Date().toISOString(), pid: process.pid });
  writeSessionInfo(base.data_dir, { version: 1, id: 'discovery', workspace: root, created_at: new Date().toISOString(), pid: process.pid });
  assert.deepEqual(listSessions(base.data_dir).map(row => row.id), [B]);
  const file = join(parent, B, 'session.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace(B, A));
  assert.deepEqual(listSessions(base.data_dir), []);
});
