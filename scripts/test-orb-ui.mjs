import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const runtime = resolve(process.env.DSH_RELEASE_ROOT ?? '.');
const { createApplication } = await import(pathToFileURL(join(runtime, 'dist/application.js')));
const { loadConfig } = await import(pathToFileURL(join(runtime, 'dist/config.js')));
const { startUiBridge } = await import(pathToFileURL(join(runtime, 'dist/ui-bridge.js')));
const require = createRequire(join(runtime, 'package.json'));
const output = resolve('.test-output/orb-ui'); mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, 'run-'));
const configPath = join(directory, 'config.json');
writeFileSync(configPath, JSON.stringify({ workspace_root: directory, data_dir: join(directory, 'data'),
  ...(process.env.DSH_RELEASE_ROOT ? { billing: { python: join(runtime, 'bin/python/python.exe') } } : {}),
  control: { allow_secondary: true, max_depth_user: 1, max_children_user: 1 }, completion_delivery: { mode: 'off' } }));
const config = loadConfig(configPath), held = [];
const application = createApplication(config, () => {
  let finish;
  return { async open() {}, async close() { finish?.(); }, async run() {
    await new Promise(resolve => { finish = resolve; held.push(resolve); });
    return { finalResponse: 'Local orb test', finishReason: 'completed' };
  } };
});
const bridge = await startUiBridge(application.ui, config.data_dir);
const server = application.createMcpServer(), mcp = new Client({ name: 'orb-ui-test', version: '1' });
const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(left); await mcp.connect(right);
let desktop;
const errors = [];
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!(await check())) { assert(Date.now() < deadline, 'Condition timed out.'); await new Promise(resolve => setTimeout(resolve, 25)); }
}
try {
  const env = { ...process.env, DSH_UI_LOCALE: 'zh-CN' }; delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: require('electron'), args: [join(runtime, 'desktop/main.mjs'), '--config', configPath], env });
  const control = await desktop.firstWindow(); control.on('pageerror', error => errors.push(error.message));
  await control.getByRole('heading', { name: '下一轮任务配置' }).waitFor();
  const original = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const opened = desktop.waitForEvent('window');
  await control.getByRole('button', { name: '收起为悬浮球' }).click();
  const orb = await opened; orb.on('pageerror', error => errors.push(error.message));
  await orb.getByTestId('orb-concurrency').filter({ hasText: /^0$/ }).waitFor();
  await until(() => desktop.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).hash).isVisible()));
  const rootResult = await mcp.callTool({ name: 'spawn_agent', arguments: { task_name: 'root', message: 'local root', max_depth: 1, max_children: 1 } });
  const root = JSON.parse(rootResult.content[0].text).agent;
  await mcp.callTool({ name: 'spawn_agent', arguments: { task_name: 'child', parent: root.id, message: 'local child' } });
  await until(() => application.ui.snapshot().runtime.active_count === 2 && held.length === 2);
  assert.equal(application.ui.snapshot().runtime.active_root_count, 1);
  await orb.getByTestId('orb-concurrency').filter({ hasText: /^2$/ }).waitFor();
  await orb.screenshot({ path: join(directory, 'orb-running.png'), omitBackground: true });
  // Feed native cursor positions to the main process while exercising real pointer IPC.
  const position = await desktop.evaluate(({ BrowserWindow, screen }) => {
    const bounds = BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL()).hash === '#orb').getBounds();
    globalThis.savedCursor = screen.getCursorScreenPoint;
    globalThis.testCursor = { x: bounds.x + 36, y: bounds.y + 36 };
    screen.getCursorScreenPoint = () => ({ ...globalThis.testCursor });
    return bounds;
  });
  await orb.mouse.move(36, 36); await orb.mouse.down();
  await orb.evaluate(() => window.dsh.dragOrb('start'));
  await desktop.evaluate(() => { globalThis.testCursor.x -= 80; globalThis.testCursor.y += 60; });
  await orb.mouse.move(30, 30); await orb.evaluate(() => window.dsh.dragOrb('move')); await orb.mouse.up();
  await until(() => existsPreference());
  const moved = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL()).hash === '#orb').getBounds());
  assert.equal(moved.x, position.x - 80); assert.equal(moved.y, position.y + 60);
  assert.equal((await control.evaluate(() => window.dsh.getState())).value.window.floating, true, 'Dragging must not expand the panel.');
  await desktop.evaluate(({ screen }) => { screen.getCursorScreenPoint = globalThis.savedCursor; });
  held[1](); await orb.getByTestId('orb-concurrency').filter({ hasText: /^1$/ }).waitFor();
  held[0](); await orb.getByTestId('orb-concurrency').filter({ hasText: /^0$/ }).waitFor();
  await orb.getByRole('button', { name: '展开控制窗口' }).click();
  await until(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).hash).isVisible()));
  const assertPanelBounds = async () => {
    const actual = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).hash).getBounds());
    for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(actual[key] - original[key]) <= 2, 'Restore bounds with only DPI rounding: ' + JSON.stringify({ original, actual }));
  };
  await assertPanelBounds();
  for (let i = 0; i < 4; i++) {
    await control.evaluate(() => window.dsh.windowAction('minimize'));
    await orb.evaluate(() => window.dsh.windowAction('restore'));
    await assertPanelBounds();
  }
  await control.getByRole('combobox', { name: '界面语言' }).selectOption('en-US');
  await control.getByRole('button', { name: 'Collapse to floating orb' }).click();
  await orb.getByText('Active', { exact: true }).waitFor();
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2, 'Reuse the same orb window.');
  await bridge.close();
  await orb.getByText('Active', { exact: true }).waitFor();
  await orb.getByTestId('orb-concurrency').filter({ hasText: /^0$/ }).waitFor();
  await orb.screenshot({ path: join(directory, 'orb-offline.png'), omitBackground: true });
  assert.deepEqual(errors, []);
  const closed = desktop.waitForEvent('close');
  await desktop.evaluate(({ BrowserWindow }) => {
    const orb = BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL()).hash === '#orb');
    setTimeout(() => orb.close(), 10);
  });
  await closed; desktop = undefined;
  const report = { ok: true, directory, runtime, paid_api_calls: 0,
    checks: ['floating orb replaces minimize button', 'live total concurrency includes child agents', '2 to 1 to 0 updates',
      'drag without expansion', 'position saved', 'click restores original bounds', 'same orb reused', 'bilingual', 'offline has no stale count', 'closing orb exits the UI'] };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await desktop?.close(); await mcp.close(); await server.close(); await bridge.close(); await application.close(); }
function existsPreference() { try { return Boolean(JSON.parse(readFileSync(join(config.data_dir, 'desktop/window.json'), 'utf8')).orb_bounds); } catch { return false; } }
