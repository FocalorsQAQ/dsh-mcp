import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const root = resolve('.test-output/model-ui'); mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'run-')), config = join(directory, 'config.json');
writeFileSync(config, JSON.stringify({ workspace_root: directory, data_dir: join(directory, 'data') }));
const requests = [];
const server = createServer((req, res) => {
  let body = ''; req.on('data', data => body += data); req.on('end', () => {
    requests.push({ path: req.url, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'response', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1 } }));
  });
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port + '/v1';
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, page;
const errors = [];
try {
  desktop = await electron.launch({ executablePath: require('electron'), args: [resolve('desktop/main.mjs'), '--config', config, '--models'], env });
  for (let i = 0; i < 200; i++) {
    page = desktop.windows().find(item => item.url().endsWith('#models')); if (page) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(page); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '管理可用模型' }).waitFor();
  assert(await page.getByRole('button', { name: '新增模型', exact: true }).isDisabled());
  const control = desktop.windows().find(item => !item.url().includes('#'));
  assert.equal((await control.evaluate(() => window.dsh.models.list())).code, 'FORBIDDEN');
  const apiOpened = desktop.waitForEvent('window');
  await control.getByRole('button', { name: 'API 密钥管理', exact: true }).click();
  const apiPage = await apiOpened;
  await apiPage.getByRole('heading', { name: '管理你的 API' }).waitFor();
  const apis = await apiPage.evaluate(async base => {
    const a = await window.dsh.apis.add({ name: '官方来源', protocol: 'deepseek', base_url: 'https://api.deepseek.com', api_key: 'local-only-dummy', expected_revision: 0 });
    const b = await window.dsh.apis.add({ name: '模拟 Responses', protocol: 'openai_responses', base_url: base, api_key: 'local-only-dummy', expected_revision: a.value.revision });
    return b.value.entries;
  }, base);
  await apiPage.getByRole('button', { name: '关闭 API 配置' }).click();
  await page.getByRole('button', { name: '刷新模型列表', exact: true }).click();
  const add = async (api, id, levels) => {
    await page.getByRole('button', { name: '新增模型', exact: true }).click();
    await page.getByLabel('来源 API', { exact: true }).selectOption(api);
    await page.getByLabel('模型 ID', { exact: true }).fill(id);
    if (levels) await page.getByLabel('思考强度分级', { exact: true }).fill(levels);
  };
  await add(apis[0].id, 'same-id');
  assert.equal(await page.getByLabel('思考强度分级', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('模型已保存，尚未验证。', { exact: true }).waitFor();
  await add(apis[1].id, 'same-id', 'high, none, low');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('模型已保存，尚未验证。', { exact: true }).waitFor(); assert.equal(requests.length, 0);
  const first = page.getByRole('checkbox', { name: '启用模型 官方来源 · same-id', exact: true });
  const second = page.getByRole('checkbox', { name: '启用模型 模拟 Responses · same-id', exact: true });
  await first.click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="启用模型 模拟 Responses · same-id"]').disabled);
  assert(await second.isDisabled());
  await page.screenshot({ path: join(directory, 'model-list.png') });
  await first.click();
  await page.waitForFunction(() => !document.querySelector('input[aria-label="启用模型 官方来源 · same-id"]').checked && !document.querySelector('input[aria-label="启用模型 模拟 Responses · same-id"]').disabled);
  await second.click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="启用模型 官方来源 · same-id"]').disabled);
  assert(await first.isDisabled());
  await add(apis[1].id, 'probe-model', 'high, none, low');
  await page.screenshot({ path: join(directory, 'add-model.png') });
  await desktop.evaluate(({ dialog }) => {
    globalThis.testDialogChoice = 1;
    dialog.showMessageBox = async (_owner, options) => { globalThis.testDialogOptions = options; return { response: globalThis.testDialogChoice }; };
  });
  await page.getByRole('button', { name: '验证并保存', exact: true }).click();
  await page.getByRole('button', { name: '验证并保存', exact: true }).waitFor();
  assert.equal(requests.length, 0);
  const confirmation = await desktop.evaluate(() => globalThis.testDialogOptions);
  assert(confirmation.message.includes('少量 token'));
  assert(confirmation.detail.includes('high'));
  assert.equal(confirmation.defaultId, 1);
  assert.equal((await page.evaluate(() => window.dsh.models.list())).value.entries.length, 2);
  await desktop.evaluate(() => { globalThis.testDialogChoice = 0; });
  await page.getByRole('button', { name: '验证并保存', exact: true }).click();
  await page.getByText(/模型已验证并保存/).waitFor();
  assert.equal(requests.length, 1); assert.equal(requests[0].body.reasoning.effort, 'high');
  assert.equal(requests[0].body.max_output_tokens, 16); assert.equal(requests[0].body.input, '.');
  assert.equal(requests[0].path, '/v1/responses');
  const snapshot = (await page.evaluate(() => window.dsh.models.list())).value;
  assert.equal(snapshot.entries.filter(entry => entry.verified).length, 1);
  assert.equal(snapshot.attempts[0].input_tokens, 3);
  assert(!JSON.stringify(snapshot).includes('local-only-dummy'));
  await page.getByRole('button', { name: '删除模型 模拟 Responses · probe-model', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForFunction(() => !document.body.textContent.includes('probe-model'));
  assert.deepEqual(errors, []);
  const report = { ok: true, requests: requests.length, live_api_called: false, artifacts: directory,
    verified: ['save sends no request', 'native consent default cancel', 'cancel sends no request', 'verified save exactly one loopback request',
      'first declared thinking level', 'duplicate ID checkbox exclusion', 'DeepSeek automatic levels', 'source names', 'delete', 'metadata-only window'] };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { console.error('Model UI artifacts: ' + directory); await page?.screenshot({ path: join(directory, 'failure.png') }).catch(() => {}); throw error; }
finally { await desktop?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
