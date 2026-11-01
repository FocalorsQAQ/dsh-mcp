import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { createApplication } from '../dist/application.js';
import { loadConfig } from '../dist/config.js';
import { startUiBridge } from '../dist/ui-bridge.js';

const require = createRequire(import.meta.url);
const root = resolve('.test-output/i18n'); mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'run-')), workspace = join(directory, 'Language test'); mkdirSync(workspace);
const configPath = join(directory, 'config.json');
writeFileSync(configPath, JSON.stringify({ workspace_root: workspace, data_dir: join(directory, 'data'), completion_delivery: { mode: 'off' } }));
const config = loadConfig(configPath), application = createApplication(config, () => { throw new Error('This test must never start a model worker.'); });
const bridge = await startUiBridge(application.ui, config.data_dir);
const originalSettings = application.ui.snapshot().settings;
let desktop;
const errors = [];
async function launch(locale) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.DSH_UI_LOCALE;
  if (locale) env.DSH_UI_LOCALE = locale;
  desktop = await electron.launch({ executablePath: require('electron'), args: [resolve('desktop/main.mjs'), '--config', configPath], env, timeout: 30000 });
  const page = await desktop.firstWindow(); watch(page); return page;
}
function watch(page) { page.on('pageerror', error => errors.push(error.message)); }
async function open(control, name, heading) {
  const opened = desktop.waitForEvent('window');
  await control.getByRole('button', { name, exact: true }).click();
  const page = await opened; watch(page); await page.getByRole('heading', { name: heading, exact: true }).waitFor(); return page;
}
async function switchTo(control, label, value, heading) {
  await control.getByRole('combobox', { name: label }).selectOption(value);
  await control.getByRole('heading', { name: heading, exact: true }).waitFor();
}
async function layout(page, containers) {
  const result = await page.evaluate(selectors => selectors.map(selector => {
    const node = document.querySelector(selector);
    return { selector, excess: node.scrollWidth - node.clientWidth };
  }), containers);
  assert(result.every(item => item.excess <= 1), 'Horizontal overflow: ' + JSON.stringify(result));
}
try {
  let control = await launch();
  await control.getByRole('heading', { name: '下一轮任务配置', exact: true }).waitFor();
  const api = await open(control, 'API 密钥管理', '管理你的 API');
  // Synthetic local credential only. No validation or upstream request is made.
  const added = await api.evaluate(() => window.dsh.apis.add({ name: 'Test connection', protocol: 'openai_responses',
    base_url: 'https://example.invalid/v1', api_key: 'dsh-i18n-test-only', expected_revision: 0 }));
  assert.equal(added.ok, true);
  await api.getByRole('button', { name: '刷新 API 列表', exact: true }).click();
  await api.getByRole('button', { name: '新增 API', exact: true }).click();
  await api.getByLabel('API 名称', { exact: true }).fill('Unsaved name');
  await api.getByLabel('API key', { exact: true }).fill('unsaved-test-value');
  await switchTo(control, '界面语言', 'en-US', 'Next task settings');
  await api.getByRole('heading', { name: 'Manage your APIs', exact: true }).waitFor();
  assert.equal(await api.getByLabel('API name', { exact: true }).inputValue(), 'Unsaved name');
  assert.equal(await api.getByLabel('API key', { exact: true }).inputValue(), 'unsaved-test-value');
  assert.equal(await api.getByLabel('API key', { exact: true }).getAttribute('type'), 'password');
  assert.equal(await api.title(), 'API settings');
  const models = await open(control, 'Select models', 'Manage available models');
  await models.getByRole('button', { name: 'Add model', exact: true }).click();
  await models.getByLabel('Model ID', { exact: true }).fill('test-model');
  await models.getByLabel('Reasoning effort levels', { exact: true }).fill('low, medium, high');
  await desktop.evaluate(({ dialog }) => {
    globalThis.languageDialogs = [];
    dialog.showMessageBox = async (_window, options) => { globalThis.languageDialogs.push(options); return { response: 1, checkboxChecked: false }; };
  });
  await models.getByRole('button', { name: 'Verify and save', exact: true }).click();
  await models.getByRole('button', { name: 'Verify and save', exact: true }).waitFor();
  await switchTo(control, 'Interface language', 'zh-CN', '下一轮任务配置');
  await models.getByRole('heading', { name: '管理可用模型', exact: true }).waitFor();
  assert.equal(await models.getByLabel('模型 ID', { exact: true }).inputValue(), 'test-model');
  assert.equal(await models.getByLabel('思考强度分级', { exact: true }).inputValue(), 'low, medium, high');
  assert.equal(await api.getByLabel('API 名称', { exact: true }).inputValue(), 'Unsaved name');
  await models.getByRole('button', { name: '验证并保存', exact: true }).click();
  await models.getByRole('button', { name: '验证并保存', exact: true }).waitFor();
  const dialogs = await desktop.evaluate(() => globalThis.languageDialogs);
  assert.equal(dialogs.length, 2);
  assert.equal(dialogs[0].title, 'Confirm model verification');
  assert.match(dialogs[0].message, /small number of tokens/);
  assert.match(dialogs[0].detail, /Verification reasoning effort: low/);
  assert.equal(dialogs[1].title, '确认验证模型');
  await models.getByRole('button', { name: '保存', exact: true }).click();
  await models.getByText('模型已保存，尚未验证。', { exact: true }).waitFor();
  await switchTo(control, '界面语言', 'en-US', 'Next task settings');
  await models.getByText('Model saved without verification.', { exact: true }).waitFor();
  assert.deepEqual((await control.evaluate(() => window.dsh.language.set('../../invalid'))), { ok: false, code: 'UI_LOCALE' });
  assert.equal((await control.evaluate(() => window.dsh.language.get())).value, 'en-US');
  assert.deepEqual(application.ui.snapshot().settings, originalSettings, 'Language changes must not change the MCP policy.');
  assert.equal(JSON.parse(readFileSync(join(config.data_dir, 'desktop/window.json'), 'utf8')).locale, 'en-US');
  for (const [name, page] of [['control', control], ['api', api], ['models', models]]) {
    await layout(page, ['.app-shell']);
    await page.screenshot({ path: join(directory, name + '-english.png') });
  }
  await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => !new URL(item.webContents.getURL()).hash);
    window.setSize(400, 840);
  });
  await layout(control, ['main', 'footer', '.online-details', '.budget-section']);
  await control.screenshot({ path: join(directory, 'control-english-narrow.png') });
  await desktop.close(); desktop = undefined;
  control = await launch();
  await control.getByRole('heading', { name: 'Next task settings', exact: true }).waitFor();
  assert.equal(await control.getByRole('combobox', { name: 'Interface language' }).inputValue(), 'en-US');
  await bridge.close();
  assert(await control.getByRole('switch', { name: 'Enable delegation' }).isEnabled());
  await control.getByRole('heading', { name: 'Next task settings', exact: true }).waitFor();
  await switchTo(control, 'Interface language', 'zh-CN', '下一轮任务配置');
  await control.screenshot({ path: join(directory, 'control-chinese-offline.png') });
  await desktop.close(); desktop = undefined;
  control = await launch('en-US');
  await control.getByRole('heading', { name: 'Next task settings', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  const report = { ok: true, languages: ['zh-CN', 'en-US'], verified: ['live switching across three windows', 'unsaved forms preserved',
    'masked key input preserved', 'localized confirmation dialogs (cancelled)', 'existing notices translated', 'preference survives restart',
    'environment override', 'offline switching', '400px layout', 'MCP settings unchanged'], live_model_api_called: false, artifacts: directory };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('Language UI artifacts: ' + directory);
  for (const [index, page] of (desktop?.windows() ?? []).entries()) await page.screenshot({ path: join(directory, 'failure-' + index + '.png') }).catch(() => {});
  throw error;
} finally { await desktop?.close(); await bridge.close(); await application.close(); }
