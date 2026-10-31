import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
