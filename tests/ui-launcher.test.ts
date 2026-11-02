import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ensureDesktopCompanion } from '../src/ui-launcher.ts';

test('an owned startup receipt requires a live companion check; other configurations are left alone', { skip: process.platform !== 'win32' }, async () => {
  const output = resolve('.test-output/ui-launch-failure'); mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(output, 'health-'));
  const config = join(root, 'config.json'), marker = join(root, 'ensure-called.json');
  mkdirSync(join(root, 'runtime'));
  writeFileSync(config, '{}');
  writeFileSync(join(root, 'runtime/codex_watch.py'), `import json, pathlib, sys\npathlib.Path(__file__).resolve().parents[1].joinpath('ensure-called.json').write_text(json.dumps(sys.argv[1:]))\n`);
  assert.equal(await ensureDesktopCompanion(config, root), false);
  writeFileSync(join(root, 'ui-startup-registration.json'), JSON.stringify({ registered: true, config }));
  writeFileSync(join(root, 'ui-startup-status.json'), JSON.stringify({ pid: 99999999 }));
  assert.equal(await ensureDesktopCompanion(join(root, 'other-config.json'), root), false);
  assert.equal(existsSync(marker), false);
  assert.equal(await ensureDesktopCompanion(config, root), true);
  const args = JSON.parse(readFileSync(marker, 'utf8'));
  assert(args.includes('--ensure-running'));
  assert.equal(args[args.indexOf('--config') + 1], config);
  writeFileSync(join(root, 'runtime/codex_watch.py'), 'raise SystemExit(4)\n');
  await assert.rejects(ensureDesktopCompanion(config, root), 'A failed repair must not report a healthy listener');
});

test('a failed control window launch does not break MCP initialization or tools', { timeout: 20000 }, async t => {
  const output = resolve('.test-output/ui-launch-failure'); mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(join(output, 'run-'));
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify({ workspace_root: directory, data_dir: join(directory, 'data'),
    ui_auto_start: true, completion_delivery: { mode: 'off' } }));
  const transport = new StdioClientTransport({ command: process.execPath, stderr: 'pipe', args: [
    '--experimental-transform-types', '--import', pathToFileURL(resolve('tests/fixtures/ui-launch-failure.mjs')).href,
    resolve('src/cli.ts'), '--config', configPath,
  ] });
  let diagnostics = ''; transport.stderr?.on('data', chunk => { diagnostics += chunk; });
  const client = new Client({ name: 'ui-failure-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert((await client.listTools()).tools.some(tool => tool.name === 'spawn_agent'));
  const deadline = Date.now() + 5000;
  while (!diagnostics.includes('Could not open the control window:') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  // A fresh source checkout may not have built the optional renderer yet.
  assert.match(diagnostics, /Could not open the control window: (Simulated control window launch failure|Control UI is missing\.)/);
  assert((await client.listTools()).tools.some(tool => tool.name === 'list_model'));
});
