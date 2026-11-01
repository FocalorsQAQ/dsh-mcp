import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const runtime = resolve(process.env.DSH_RELEASE_ROOT ?? '.'), require = createRequire(join(runtime, 'package.json'));
const { createApplication } = await import(pathToFileURL(join(runtime, 'dist/application.js')));
const { loadConfig } = await import(pathToFileURL(join(runtime, 'dist/config.js')));
const { startUiBridge } = await import(pathToFileURL(join(runtime, 'dist/ui-bridge.js')));
const { sessionConfig, writeSessionInfo } = await import(pathToFileURL(join(runtime, 'dist/sessions.js')));
const output = resolve('.test-output/session-ui'); mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, 'run-')), configPath = join(directory, 'config.json'), data = join(directory, 'data');
const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
const codexHome = join(directory, 'codex-home'); mkdirSync(codexHome);
const titleIndex = join(codexHome, 'session_index.jsonl');
writeFileSync(titleIndex, [{ id: A, thread_name: '实现控制面板', updated_at: '2026-10-31T00:00:00Z' },
  { id: B, thread_name: '检查并发任务', updated_at: '2026-10-31T00:00:00Z' }].map(row => JSON.stringify(row) + '\n').join(''));
writeFileSync(configPath, JSON.stringify({ workspace_root: directory, data_dir: data, ui_auto_start: false, codex_home: codexHome,
  completion_delivery: { mode: 'off' }, control: { billing_currency: 'CNY', round_budget: [0, 2] },
  ...(process.env.DSH_RELEASE_ROOT ? { billing: { python: join(runtime, 'bin/python/python.exe'), rules: join(runtime, 'billing/rules.py') } } : {}) }));
const base = loadConfig(configPath), instances = [];
let desktop;
async function instance(id) {
  const config = sessionConfig(base, id);
  const app = createApplication(config, () => { let finish; return { async open() {}, async close() { finish?.(); },
    async run() { await new Promise(resolve => { finish = resolve; }); return { finalResponse: 'UI test', finishReason: 'completed' }; } }; });
  const bridge = await startUiBridge(app.ui, config.data_dir);
  writeSessionInfo(data, { version: 1, id, workspace: directory, created_at: new Date().toISOString(), pid: process.pid });
  const server = app.createMcpServer(), client = new Client({ name: 'session-ui-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(left); await client.connect(right);
  const row = { app, bridge, server, client, config }; instances.push(row); return row;
}
async function until(check) { const deadline = Date.now() + 10000; while (!(await check())) { assert(Date.now() < deadline, 'Condition timed out.'); await new Promise(resolve => setTimeout(resolve, 50)); } }
try {
  const env = { ...process.env, DSH_UI_LOCALE: 'zh-CN' }; delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: require('electron'), args: [join(runtime, 'desktop/main.mjs'), '--config', configPath, '--session-id', A], env });
  const page = await desktop.firstWindow(), errors = []; page.on('pageerror', e => errors.push(e.message));
  // The user can operate the global switch before any chat host, tool call, or ledger exists.
  await page.getByRole('heading', { name: '外包已启用', exact: true }).waitFor();
  await page.getByRole('switch', { name: '启用外包', exact: true }).click();
  await page.getByRole('heading', { name: '外包已关闭', exact: true }).waitFor();
  const a = await instance(A), b = await instance(B);
  for (const client of [a.client, b.client]) {
    assert.equal((await client.listTools()).tools.length, 18);
    assert.equal((await client.callTool({ name: 'get_status', arguments: {} })).structuredContent.enabled, false);
  }
  await page.getByRole('switch', { name: '启用外包', exact: true }).click();
  await until(async () => (await a.client.callTool({ name: 'get_status', arguments: {} })).structuredContent.enabled &&
    (await b.client.callTool({ name: 'get_status', arguments: {} })).structuredContent.enabled);
  b.app.ui.updateSettings({ round_budget: [0, 3] }, b.app.ui.snapshot().revision);
  const selector = page.getByLabel('当前聊天', { exact: true }), budget = page.getByLabel('本轮总预算人民币', { exact: true });
  await selector.selectOption(A);
  await until(async () => await budget.inputValue() === '2');
  assert.equal(await selector.locator('option').filter({ hasText: '实现控制面板' }).getAttribute('value'), A);
  assert.equal(await selector.locator('option').filter({ hasText: '检查并发任务' }).getAttribute('value'), B);
  appendFileSync(titleIndex, JSON.stringify({ id: A, thread_name: '已重命名的控制面板聊天', updated_at: '2026-11-01T00:00:00Z' }) + '\n');
  await until(async () => (await selector.textContent()).includes('已重命名的控制面板聊天'));
  await selector.selectOption(B); await until(async () => await budget.inputValue() === '3');
  await budget.fill('7'); await budget.press('Tab');
  await until(() => b.app.ui.snapshot().settings.round_budget[1] === 7);
  assert.deepEqual(a.app.ui.snapshot().settings.round_budget, [0, 2]);
  const stale = await page.evaluate(async id => {
    const state = (await window.dsh.getState()).value;
    return window.dsh.updateSettings({ round_budget: [0, 99] }, state.connection.snapshot.revision, id);
  }, A);
  assert.equal(stale.code, 'UI_SESSION'); assert.deepEqual(b.app.ui.snapshot().settings.round_budget, [0, 7]);
  for (const [client, task] of [[a.client, 'a'], [b.client, 'b1'], [b.client, 'b2']]) {
    const response = await client.callTool({ name: 'spawn_agent', arguments: { task_name: task, message: 'Local held UI test.' } }); assert(!response.isError);
  }
  const opening = desktop.waitForEvent('window'); await page.getByRole('button', { name: '收起为悬浮球' }).click();
  const orb = await opening; await orb.getByTestId('orb-concurrency').filter({ hasText: /^2$/ }).waitFor();
  await orb.getByRole('button', { name: '展开控制窗口' }).click();
  await selector.selectOption(A); await until(async () => await budget.inputValue() === '2');
  await page.getByRole('button', { name: '收起为悬浮球' }).click();
  await orb.getByTestId('orb-concurrency').filter({ hasText: /^1$/ }).waitFor();
  await orb.getByRole('button', { name: '展开控制窗口' }).click();
  await page.screenshot({ path: join(directory, 'chat-selector.png') });
  // API/model windows use shared storage even after switching the selected chat.
  let opened = desktop.waitForEvent('window'); await page.getByRole('button', { name: 'API 密钥管理', exact: true }).click();
  const api = await opened; await api.getByRole('heading', { name: '管理你的 API' }).waitFor();
  const saved = await api.evaluate(() => window.dsh.apis.add({ name: 'Shared test API', protocol: 'deepseek', base_url: 'https://api.deepseek.com', api_key: 'LOCAL-ONLY-DUMMY', expected_revision: 0 }));
  assert(saved.ok); assert(existsSync(join(data, 'credentials.json')));
  for (const item of instances) assert(!existsSync(join(item.config.data_dir, 'credentials.json')));
  await api.getByRole('button', { name: '关闭 API 配置' }).click();
  opened = desktop.waitForEvent('window'); await page.getByRole('button', { name: '模型选择', exact: true }).click();
  const models = await opened; await models.getByRole('heading', { name: '管理可用模型' }).waitFor();
  await models.getByRole('button', { name: '新增模型', exact: true }).click();
  await models.getByLabel('来源 API', { exact: true }).selectOption(saved.value.entries[0].id);
  await models.getByLabel('模型 ID', { exact: true }).fill('deepseek-v4-flash');
  await models.getByRole('button', { name: '保存', exact: true }).click();
  await models.getByRole('checkbox', { name: '启用模型 Shared test API · deepseek-v4-flash', exact: true }).click();
  await until(() => existsSync(join(data, 'model-config.json')));
  for (const item of instances) {
    assert(!existsSync(join(item.config.data_dir, 'model-config.json')));
    await until(async () => (await item.client.callTool({ name: 'list_model', arguments: {} })).structuredContent.models.includes('deepseek-v4-flash'));
  }
  await models.getByRole('button', { name: '关闭模型配置' }).click();
  await page.getByRole('combobox', { name: '界面语言' }).selectOption('en-US');
  await page.getByLabel('Current chat', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  const report = { ok: true, directory, runtime, paid_api_calls: 0,
    checks: ['global switch before any chat host/tool call', 'global switch supplies live status to both chats', 'chat names from local Codex index and live rename', 'chat selector', 'independent budget editing', 'reject stale chat edits', 'orb follows selected chat', 'shared encrypted API and model configuration', 'bilingual selector'] };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally {
  await desktop?.close();
  for (const item of instances) { await item.client.close(); await item.server.close(); await item.bridge.close(); await item.app.close(); }
}
