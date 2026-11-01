import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Exercise the actual MCP-triggered Electron process. All state is disposable; no model is called.
assert.equal(process.platform, 'win32', 'This native-window integration check requires Windows.');
const runtime = resolve(process.env.DSH_RELEASE_ROOT ?? '.');
const node = process.env.DSH_RELEASE_ROOT ? join(runtime, 'bin/node/node.exe') : process.execPath;
const output = resolve('.test-output/ui-autostart'); mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, 'run-'));
const workspace = join(directory, 'workspace with spaces'); mkdirSync(workspace);
const data = join(directory, 'overridden data');
const configPath = join(directory, 'config.json');
const config = { workspace_root: workspace, data_dir: join(directory, 'unused-data'), session_idle_timeout_ms: 1500, completion_delivery: { mode: 'off' } };
if (process.env.DSH_RELEASE_ROOT) config.billing = { python: join(runtime, 'bin/python/python.exe'), rules: join(runtime, 'billing/rules.py') };
writeFileSync(configPath, JSON.stringify(config));
const exec = promisify(execFile);
const probe = resolve('scripts/test-ui-window.ps1');
async function inspect(action = 'inspect') {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', probe,
    '-ConfigPath', configPath, '-Action', action], { windowsHide: true, timeout: 15000 });
  return JSON.parse(stdout);
}
async function until(predicate) {
  const deadline = Date.now() + 30000;
  let state;
  while (Date.now() < deadline) {
    state = await inspect();
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the control window: ' + JSON.stringify(state));
}
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_UI_LOCALE: 'en-US' };
delete env.CODEX_THREAD_ID; // Actual Codex startup has no chat environment variable.
delete env.DEEPSEEK_API_KEY;
const transport = new StdioClientTransport({ command: node,
  args: [join(runtime, 'packaging/launch-server.mjs'), '--config', configPath, '--data-dir', data], env, stderr: 'pipe' });
let diagnostics = ''; transport.stderr?.on('data', chunk => { diagnostics += chunk; });
const client = new Client({ name: 'ui-autostart-test', version: '1' });
const require = createRequire(join(runtime, 'package.json'));
const electron = require('electron');
async function openAgain(auto = true) {
  const environment = { ...env }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(runtime, 'desktop/main.mjs'), '--config', configPath,
    '--workspace', workspace, '--data-dir', data, ...(auto ? ['--auto-start'] : [])],
  { env: environment, windowsHide: true, stdio: 'ignore' });
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, 'The second UI process must hand off and exit.');
  } finally { clearTimeout(timeout); }
}
try {
  await client.connect(transport);
  assert((await client.listTools()).tools.length > 0, 'MCP initialization/tools must succeed.');
  const first = await until(state => state.length === 1 && state[0].visible);
  console.log('Verified: MCP starts one visible control window.');
  const pid = first[0].pid;
  assert.equal(first[0].focused, false, 'Automatic launch must not take keyboard focus.');
  assert(existsSync(join(data, 'desktop')), 'UI must use the effective MCP data directory.');
  assert(existsSync(join(data, 'chats', 'discovery', 'state.json')), 'Shared MCP startup must open the UI before the first chat-bound call.');
  assert(!existsSync(join(config.data_dir, 'desktop')), 'Config overrides must reach Electron.');
  await inspect('minimize');
  await until(state => state[0]?.minimized);
  await openAgain();
  let state = await inspect();
  assert.equal(state.length, 1); assert.equal(state[0].pid, pid);
  assert.equal(state[0].minimized, true, 'Automatic reconnection must leave a minimized UI alone.');
  console.log('Verified: repeated auto-start retains the existing minimized window.');
  // Even a duplicate initialized notification must not reopen a window after the user closed it.
  await inspect('close');
  await until(state => state.length === 0);
  await client.notification({ method: 'notifications/initialized' });
  assert((await client.listTools()).tools.length > 0);
  assert.equal((await inspect()).length, 0);
  // A subsequent normal launch still works and can restore the existing window.
  const environment = { ...env }; delete environment.ELECTRON_RUN_AS_NODE;
  const manual = spawn(electron, [join(runtime, 'desktop/main.mjs'), '--config', configPath, '--data-dir', data],
    { env: environment, windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'] });
  manual.stderr.on('data', chunk => { diagnostics += chunk; });
  manual.on('exit', code => { diagnostics += '\nManual UI exit: ' + code; });
  manual.on('error', error => { diagnostics += error.message; });
  console.log('Checking manual launch, process ' + manual.pid);
  await until(state => state.length === 1 && state[0].visible);
  await inspect('minimize'); await until(state => state[0]?.minimized);
  await openAgain(false);
  state = await until(state => state.length === 1 && !state[0].minimized && state[0].visible);
  await inspect('close'); await until(state => state.length === 0);
  await client.close();
  // An explicit opt-out prevents any Electron process, while MCP remains usable.
  writeFileSync(configPath, JSON.stringify({ ...config, ui_auto_start: false }));
  const disabled = new Client({ name: 'ui-autostart-disabled-test', version: '1' });
  try {
    await disabled.connect(new StdioClientTransport({ command: node,
      args: [join(runtime, 'packaging/launch-server.mjs'), '--config', configPath], env, stderr: 'pipe' }));
    assert((await disabled.listTools()).tools.length > 0);
    assert.equal((await inspect()).length, 0);
    assert(!existsSync(join(config.data_dir, 'desktop')));
  } finally { await disabled.close(); }
  const report = { ok: true, directory, runtime, paid_api_calls: 0,
    checks: ['real MCP auto-launch', 'no focus stealing', 'effective data-dir override', 'single instance',
      'minimized state retained on auto-start', 'duplicate initialization ignored', 'manual reopen/restore', 'auto-start opt-out'] };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(directory, diagnostics); throw error; }
finally { await inspect('close').catch(() => {}); await client.close(); }
