import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const root = resolve('.test-output/api-ui'); mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'run-'));
const config = join(directory, 'config.json'), data = join(directory, 'data');
writeFileSync(config, JSON.stringify({ workspace_root: directory, data_dir: data }));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const dummy = 'LOCAL-TEST-NOT-A-REAL-KEY-76235';
let desktop;
const errors = [];
async function launch() {
  desktop = await electron.launch({ executablePath: require('electron'), args: [resolve('desktop/main.mjs'), '--config', config, '--api-keys'], env });
  let apiPage;
  const deadline = Date.now() + 15000;
  while (!apiPage && Date.now() < deadline) {
    apiPage = desktop.windows().find(page => page.url().endsWith('#api-keys'));
    if (!apiPage) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(apiPage, 'API window must open');
  apiPage.on('pageerror', error => errors.push(error.message));
  await apiPage.getByRole('heading', { name: '管理你的 API' }).waitFor();
  return apiPage;
}
try {
  let page = await launch();
  const control = desktop.windows().find(item => !item.url().endsWith('#api-keys'));
  assert.equal((await control.evaluate(() => window.dsh.apis.list())).code, 'FORBIDDEN');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await page.getByRole('button', { name: '新增 API', exact: true }).click();
  assert.equal(await page.getByLabel('Base URL', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('API key', { exact: true }).getAttribute('type'), 'password');
  for (const protocol of ['openai_chat', 'openai_responses', 'anthropic']) {
    await page.getByLabel('协议', { exact: true }).selectOption(protocol);
    assert(await page.getByLabel('Base URL', { exact: true }).isVisible());
  }
  await page.getByLabel('协议', { exact: true }).selectOption('deepseek');
  await page.getByLabel('API 名称', { exact: true }).fill('DeepSeek 本地测试');
  await page.getByLabel('API key', { exact: true }).fill(dummy);
  await page.screenshot({ path: join(directory, 'add-api.png') });
  await page.getByRole('button', { name: '保存 API', exact: true }).click();
  await page.getByText('API 配置已保存。', { exact: true }).waitFor();
  const response = await page.evaluate(() => window.dsh.apis.list());
  assert(response.ok); assert(!JSON.stringify(response).includes(dummy));
  assert(!JSON.stringify(response).includes('secret_ciphertext'));
  const vault = JSON.parse(readFileSync(join(data, 'credentials.json'), 'utf8'));
  assert(!JSON.stringify(vault).includes(dummy));
  // Verify only the synthetic test key in the trusted Electron process; never expose plaintext over UI IPC.
  const decrypts = await desktop.evaluate(async ({ safeStorage }, { blob, expected }) => {
    const value = await safeStorage.decryptStringAsync(Buffer.from(blob, 'base64'));
    return value.result === expected;
  }, { blob: vault.entries[0].secret_ciphertext, expected: dummy });
  assert.equal(decrypts, true, 'OS-encrypted storage must decrypt correctly inside the trusted host');
  await desktop.close(); desktop = undefined;
  page = await launch();
  await page.getByRole('button', { name: /DeepSeek 本地测试/ }).click();
  assert.equal(await page.locator('input[type=password]').count(), 0);
  assert(!await page.locator('body').innerText().then(text => text.includes(dummy)));
  await page.getByLabel('API 名称', { exact: true }).fill('我的 OpenAI');
  await page.getByLabel('协议', { exact: true }).selectOption('openai_responses');
  await page.getByLabel('Base URL', { exact: true }).fill('https://api.example.test/v1');
  await page.getByRole('button', { name: '保存 API', exact: true }).click();
  await page.getByText('API 配置已保存。', { exact: true }).waitFor();
  await page.getByRole('button', { name: /我的 OpenAI/ }).click();
  assert.equal(JSON.parse(readFileSync(join(data, 'credentials.json'), 'utf8')).entries[0].secret_ciphertext, vault.entries[0].secret_ciphertext);
  await page.screenshot({ path: join(directory, 'manage-api.png') });
  await page.getByRole('button', { name: '删除 API', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).last().click();
  assert.equal((await page.evaluate(() => window.dsh.apis.list())).value.entries.length, 1);
  await page.getByRole('button', { name: '删除 API', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.getByText('API 配置已删除。', { exact: true }).waitFor();
  assert.equal(JSON.parse(readFileSync(join(data, 'credentials.json'), 'utf8')).entries.length, 0);
  assert.deepEqual(errors, []);
  const report = { ok: true, verified: ['offline management window', 'all protocol choices', 'DeepSeek hides URL',
    'password input', 'OS encrypted roundtrip', 'metadata-only IPC', 'no saved secret in renderer',
    'persistence across restart', 'rename and protocol edit keep encrypted key', 'delete confirmation and removal', 'IPC sender restriction'], artifacts: directory };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  console.error('API UI artifacts: ' + directory);
  const page = desktop?.windows().find(page => page.url().endsWith('#api-keys'));
  await page?.screenshot({ path: join(directory, 'failure.png') }).catch(() => {});
  throw error;
} finally { await desktop?.close(); }
