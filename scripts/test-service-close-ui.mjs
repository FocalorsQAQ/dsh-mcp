import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const runtime = resolve(process.env.DSH_RELEASE_ROOT ?? '.');
const { createApplication, loadConfig } = await import(pathToFileURL(join(runtime, 'dist/application.js')));
const { sessionConfig, writeSessionInfo } = await import(pathToFileURL(join(runtime, 'dist/sessions.js')));
const { TaskSnapshots } = await import(pathToFileURL(join(runtime, 'dist/task-snapshot.js')));
const { OutsourcingSwitch } = await import(pathToFileURL(join(runtime, 'dist/global-control.js')));
const { startUiBridge } = await import(pathToFileURL(join(runtime, 'dist/ui-bridge.js')));

const require = createRequire(join(runtime, 'package.json')), output = resolve('.test-output/service-close-ui'); mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, 'run-')), configPath = join(directory, 'config.json');
writeFileSync(configPath, JSON.stringify({ workspace_root: directory, data_dir: join(directory, 'data'), ui_auto_start: false,
  control: { allow_secondary: true }, completion_delivery: { mode: 'off' },
  ...(process.env.DSH_RELEASE_ROOT ? { billing: { python: join(runtime, 'bin/python/python.exe'), rules: join(runtime, 'billing/rules.py') } } : {}) }));
const config = loadConfig(configPath), gate = new OutsourcingSwitch(config.data_dir, config.billing.python, config.control), snapshots = new TaskSnapshots(config);
const rows = [], sent = [], errors = []; let desktop;
const until = async check => { const deadline = Date.now() + 15000; while (!(await check())) { assert(Date.now() < deadline, 'UI shutdown timed out'); await new Promise(r => setTimeout(r, 25)); } };
async function launch() {
  const env = { ...process.env, DSH_UI_LOCALE: 'zh-CN' }; delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: require('electron'), args: [join(runtime, 'desktop/main.mjs'), '--config', configPath], env });
  const page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '下一轮任务配置' }).waitFor(); return page;
}
try {
  for (let index = 0; index < 2; index++) {
    const id = randomUUID(), turn = randomUUID(), local = sessionConfig(config, id);
    snapshots.capture(id, turn, directory);
    const app = createApplication(local, () => { let finish; return { async open() {}, async run() { await new Promise(r => { finish = r; }); return { finalResponse: '', finishReason: 'interrupted' }; }, async close() { finish?.(); } }; },
      async item => { sent.push(item); return { published: true }; });
    const bridge = await startUiBridge(app.ui, local.data_dir);
    writeSessionInfo(config.data_dir, { version: 1, id, workspace: directory, created_at: new Date().toISOString(), pid: process.pid });
    const server = app.createMcpServer(), client = new Client({ name: 'close-ui', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    const call = (name, args = {}) => client.callTool({ name, arguments: args, _meta: { thread_id: id, turn_id: turn } });
    rows.push({ app, bridge, server, client, call, id });
    const result = await call('spawn_agent', { task_name: 'root', message: 'isolated fixture', max_depth: 1, max_children: 1, notify_on_completion: false });
    assert(!result.isError, JSON.stringify(result));
    if (!index) assert(!(await call('spawn_agent', { task_name: 'child', parent: result.structuredContent.agent.id, message: 'isolated child', notify_on_completion: false })).isError);
  }
  let page = await launch();
  await page.getByText('3 个子代理在线', { exact: true }).waitFor();
  assert.equal(await page.locator('.titlebar .close-button').count(), 0);
  const close = page.getByRole('button', { name: '关闭DSH as Subagent', exact: true });
  assert(await close.isVisible());
  assert.equal(await page.locator('.service-close-area').getByRole('button').count(), 1);
  await page.getByRole('button', { name: '紧凑模式' }).click();
  await until(async () => await close.count() === 0);
  assert.equal(await close.count(), 0, 'Close action must not exist in compact mode');
  await page.getByRole('button', { name: '展开窗口' }).click();
  await desktop.evaluate(({ dialog }) => {
    globalThis.closeDialogs = []; globalThis.closeAnswer = 1;
    dialog.showMessageBox = async (_window, options) => { globalThis.closeDialogs.push(options); return { response: globalThis.closeAnswer }; };
  });
  const before = gate.snapshot();
  await close.click();
  await until(async () => (await desktop.evaluate(() => globalThis.closeDialogs.length)) === 1);
  assert.deepEqual(gate.snapshot(), before, 'Cancel must preserve service state');
  assert.equal(sent.length, 0);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await until(async () => (await desktop.evaluate(() => globalThis.closeDialogs.length)) === 2);
  assert(await close.isVisible(), 'Native window close also requires confirmation');
  const dialogs = await desktop.evaluate(() => globalThis.closeDialogs);
  assert(dialogs.every(options => options.defaultId === 1 && options.cancelId === 1));
  assert.match(dialogs[0].detail, /所有聊天/);
  await page.screenshot({ path: join(directory, 'expanded-chinese.png') });
  await page.getByRole('combobox', { name: '界面语言' }).selectOption('en-US');
  await page.getByRole('button', { name: 'Close DSH as Subagent', exact: true }).waitFor();
  await desktop.evaluate(() => { globalThis.closeAnswer = 0; });
  const closed = desktop.waitForEvent('close');
  await page.getByRole('button', { name: 'Close DSH as Subagent', exact: true }).click();
  await closed; desktop = undefined;
  await until(() => rows.every(row => row.app.ui.snapshot().runtime.active_count === 0) && sent.length === 2);
  assert(gate.snapshot().service_stop.active);
  assert.equal(gate.enabled, false);
  for (const row of rows) {
    assert.equal(sent.filter(item => item.thread_id === row.id).length, 1);
    assert.equal((await row.call('get_status')).structuredContent.enabled, false);
    assert((await row.call('list_agents')).isError);
  }
  page = await launch();
  assert.equal(await page.getByRole('switch', { name: '启用外包' }).getAttribute('aria-checked'), 'false');
  await page.getByText('服务已被用户停用。重新启用后，请发布新任务；旧任务不会恢复。', { exact: true }).waitFor();
  await page.getByRole('switch', { name: '启用外包' }).click();
  await until(() => gate.enabled);
  for (const row of rows) assert.equal((await row.call('get_status')).structuredContent.enabled, false);
  assert.deepEqual(errors, []);
  const report = { ok: true, directory, paid_api_calls: 0, real_chat_messages: 0,
    checks: ['bottom close action only in expanded mode', 'cancel and native close confirmation', 'cross-chat worker/descendant shutdown',
      'one notice per affected caller', 'disabled MCP rejection', 'persistent stop and explicit re-enable', 'revoked turns stay blocked', 'bilingual'] };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('Service close UI artifacts: ' + directory);
  if (desktop) await (await desktop.firstWindow()).screenshot({ path: join(directory, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await desktop?.close();
  for (const row of rows) { await row.client.close(); await row.server.close(); await row.bridge.close(); await row.app.close(); }
}
