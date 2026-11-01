import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { createApplication } from '../dist/application.js';
import { loadConfig } from '../dist/config.js';
import { startUiBridge } from '../dist/ui-bridge.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const require = createRequire(import.meta.url);
const root = resolve('.test-output', 'ui'); mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'run-'));
const workspace = join(directory, 'UI验证项目'); mkdirSync(workspace);
const configPath = join(directory, 'config.json');
writeFileSync(configPath, JSON.stringify({ workspace_root: workspace, data_dir: join(directory, 'data'), completion_delivery: { mode: 'off' } }));
const config = loadConfig(configPath);
const app = createApplication(config, spec => ({ async open() {}, async close() {}, async run(message) {
  const request = spec.metering.reserve(spec.model, 2000);
  spec.metering.settle(request.id, { input_cache_miss: 12640, input_cache_hit: 48000, output: 832 }, 'complete');
  return { finalResponse: 'UI test fixture: ' + message, finishReason: 'completed' };
} }));
const bridge = await startUiBridge(app.ui, config.data_dir);
const server = app.createMcpServer(); const mcp = new Client({ name: 'ui-e2e', version: '1' });
const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(left); await mcp.connect(right);
let desktop;
const errors = [];
async function until(condition) {
  const end = Date.now() + 10000;
  while (!(await condition())) { assert(Date.now() < end, 'condition timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
}
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: require('electron'), args: [resolve('desktop/main.mjs'), '--config', configPath], env, timeout: 30000 });
  const page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.getByRole('heading', { name: '外包已启用' }).waitFor();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  await page.getByRole('switch', { name: '启用外包' }).click();
  await page.getByRole('heading', { name: '外包已关闭' }).waitFor();
  assert.equal((await mcp.listTools()).tools.length, 18);
  assert.equal((await mcp.callTool({ name: 'get_status', arguments: {} })).structuredContent.enabled, false);
  await page.getByRole('switch', { name: '启用外包' }).click();
  await until(() => app.ui.snapshot().settings.enabled);
  assert.equal((await mcp.callTool({ name: 'get_status', arguments: {} })).structuredContent.enabled, true);

  const number = async (label, value, check) => {
    const input = page.getByRole('textbox', { name: label, exact: true });
    await input.fill(String(value)); await input.press('Enter'); await until(check);
  };
  await number('顶层代理数量', 3, () => app.ui.snapshot().settings.max_root_agents === 3);
  await page.getByRole('switch', { name: '允许二次外包' }).click();
  await until(() => app.ui.snapshot().settings.allow_secondary);
  await number('最大外包深度', 2, () => app.ui.snapshot().settings.max_depth_user === 2);
  await number('子代理数量', 2, () => app.ui.snapshot().settings.max_children_user === 2);
  await page.getByRole('checkbox', { name: '本轮总预算设上限' }).check();
  await until(() => app.ui.snapshot().settings.round_budget !== null);
  await number('本轮总预算美元', 2, () => app.ui.snapshot().settings.round_budget?.[0] === 2);
  await number('本轮总预算人民币', 10, () => app.ui.snapshot().settings.round_budget?.[1] === 10);
  await page.getByRole('checkbox', { name: '任务总预算设上限' }).check();
  await until(() => app.ui.snapshot().settings.task_budget !== null);
  await number('任务总预算美元', 10, () => app.ui.snapshot().settings.task_budget?.[0] === 10);
  await number('任务总预算人民币', 50, () => app.ui.snapshot().settings.task_budget?.[1] === 50);
  await page.getByRole('button', { name: '使用CNY计费', exact: true }).click();
  await until(() => app.ui.snapshot().settings.billing_currency === 'CNY');
  await page.getByRole('button', { name: '使用USD计费', exact: true }).click();
  await until(() => app.ui.snapshot().settings.billing_currency === 'USD');
  assert.deepEqual(app.ui.snapshot().settings.round_budget, [2, 10]);
  await mcp.callTool({ name: 'spawn_agent', arguments: { task_name: 'ui_fixture', message: 'local verification only' } });
  await until(() => app.ui.snapshot().metrics.last_api_status === 'settled');
  await page.getByText('48,000', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('token-miss').textContent(), '12,640');
  assert.equal(await page.getByTestId('token-output').textContent(), '832');

  const apiOpened = desktop.waitForEvent('window');
  await page.getByRole('button', { name: 'API 密钥管理', exact: true }).click();
  const apiPage = await apiOpened;
  await apiPage.getByRole('heading', { name: '管理你的 API' }).waitFor();
  await apiPage.getByRole('button', { name: '关闭 API 配置' }).click();
  const modelsOpened = desktop.waitForEvent('window');
  await page.getByRole('button', { name: '模型选择', exact: true }).click();
  const modelsPage = await modelsOpened;
  await modelsPage.getByRole('heading', { name: '管理可用模型' }).waitFor();
  await modelsPage.getByRole('button', { name: '关闭模型配置' }).click();
  assert.equal(await page.locator('.brand').textContent(), 'DeepSeek Harness as Subagent');
  assert.equal(await page.getByRole('button', { name: '窗口置顶', exact: true }).count(), 0);
  assert.equal(await page.locator('.cost-grid .currency-pair').first().innerText(), '0.00 USD + 0.00 CNY');
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), false);
  if (process.platform === 'win32') {
    const handle = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString());
    let native;
    for (let attempt = 0; attempt < 5; attempt++) {
      native = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve('desktop/owner-window.ps1'), '-WindowHandle', handle, '-Inspect'], { encoding: 'utf8', windowsHide: true }));
      if (native.codex_owner) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(native.codex_owner, true, 'Codex must own the floating window');
    assert.equal(native.tool_window, true);
    assert.equal(native.app_window, false);
    assert.equal(native.topmost, false);
    console.log('Win32 window verification: ' + JSON.stringify(native));
  }
  await page.evaluate(() => document.querySelector('main').scrollTo(0, 0));
  const layout = await page.evaluate(() => ({ overflow: document.querySelector('main').scrollHeight - document.querySelector('main').clientHeight,
    viewport: { width: innerWidth, height: innerHeight }, managementVisible: document.querySelector('.management-buttons').getBoundingClientRect().bottom < innerHeight - 30 }));
  console.log('Window layout: ' + JSON.stringify(layout));
  await page.screenshot({ path: join(directory, 'control-window.png') });
  await page.getByRole('button', { name: '紧凑模式', exact: true }).click();
  await page.getByRole('button', { name: '展开窗口', exact: true }).waitFor();
  await page.screenshot({ path: join(directory, 'compact-window.png') });
  await page.getByRole('button', { name: '展开窗口', exact: true }).click();
  await bridge.close();
  await page.locator('.connection-indicator.disconnected').waitFor();
  await page.getByRole('heading', { name: '外包已启用' }).waitFor();
  assert(await page.getByRole('switch', { name: '启用外包' }).isEnabled());
  await page.getByRole('switch', { name: '启用外包' }).click();
  await page.getByRole('heading', { name: '外包已关闭' }).waitFor();
  assert.equal((await mcp.callTool({ name: 'get_status', arguments: {} })).structuredContent.enabled, false);
  await page.screenshot({ path: join(directory, 'disconnected-window.png') });
  assert.deepEqual(errors, [], 'renderer must not report runtime or CSP errors');
  const report = { ok: true, settings: app.ui.snapshot().settings, metrics: app.ui.snapshot().metrics,
    verified: ['actual Electron renderer', 'isolated preload', 'shared MCP policy', 'all user controls', 'dual-currency budgets', 'live tokens and costs', 'placeholder buttons', 'Codex owned tool window without topmost', 'localized labels and two decimal costs', 'compact', 'disconnect handling'],
    live_model_api_called: false, artifacts: directory };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('UI artifacts: ' + directory);
  if (desktop) { const page = await desktop.firstWindow(); await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => {}); }
  if (errors.length) console.error(errors);
  throw error;
} finally {
  await desktop?.close(); await mcp.close(); await server.close(); await bridge.close(); await app.close();
}
