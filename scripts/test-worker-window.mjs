import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'win32', 'This check inspects the Windows console of the actual CLI child.');
const runtime = resolve(process.env.DSH_RELEASE_ROOT ?? '.');
const require = createRequire(join(runtime, 'package.json'));
const sdkPath = require.resolve('@deepseek-ai/dsh-sdk-client');
const { DeepSeekHarness } = await import(pathToFileURL(sdkPath));
const output = resolve('.test-output/worker-window'); mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, 'run-')), reportPath = join(directory, 'console.json');
const probe = join(directory, 'console-probe.cjs');
// This preload runs inside the real SDK-launched CLI, before any profile code.
// GetConsoleWindow proves a console was never allocated, including a hidden one.
writeFileSync(probe, `const fs=require('node:fs'), k=require(${JSON.stringify(require.resolve('koffi'))});
const kernel=k.load('kernel32.dll'), get=kernel.func('uintptr_t __stdcall GetConsoleWindow()');
fs.writeFileSync(${JSON.stringify(reportPath)},JSON.stringify({pid:process.pid,console:Number(get())}));`);
const env = { ...process.env, DEEPSEEK_API_KEY: 'local-window-test-only', DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
  DSH_TELEMETRY_MODE: 'DISABLED', DSH_PERMISSION_MODE: 'read-only', NODE_OPTIONS: '--require ' + JSON.stringify(probe) };
delete env.ELECTRON_RUN_AS_NODE;
const harness = new DeepSeekHarness({ profile: 'sdk', cwd: directory, processCwd: directory,
  dshHome: join(directory, 'home'), patches: [join(runtime, 'config/worker.patch.yml')], env, initializeTimeoutMs: 30000 });
try {
  await harness.start();
  await harness.session('window-test').getWorkingDirectory();
  const child = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.notEqual(child.pid, process.pid);
  assert.equal(child.console, 0, 'The SDK must start its CLI without creating a Windows console.');
  const report = { ok: true, directory, runtime, cli_console: child.console, paid_api_calls: 0,
    checks: ['actual SDK and CLI handshake', 'no console allocated in the worker process', 'normal SDK shutdown'] };
  await harness.close();
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await harness.close(); }
