import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// A real Codex app-server supplies identity on each MCP request, without a model turn.
const codex = process.env.DSH_TEST_CODEX_EXE;
assert(codex, 'Set DSH_TEST_CODEX_EXE to the Codex executable to test the actual host.');
const runtime = resolve(process.env.DSH_RELEASE_ROOT ?? '.');
const node = process.env.DSH_RELEASE_ROOT ? join(runtime, 'bin/node/node.exe') : process.execPath;
const root = resolve('.test-output/codex-host'); mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'run-')), home = join(directory, 'home'), data = join(directory, 'data'); mkdirSync(home);
const cfg = join(directory, 'dsh.json');
writeFileSync(cfg, JSON.stringify({ workspace_root: directory, data_dir: data, ui_auto_start: false, session_idle_timeout_ms: 1500,
  ...(process.env.DSH_RELEASE_ROOT ? { billing: { python: join(runtime, 'bin/python/python.exe'), rules: join(runtime, 'billing/rules.py') } } : {}) }));
const q = value => JSON.stringify(value.replaceAll('\\', '/'));
writeFileSync(join(home, 'config.toml'), '[mcp_servers.dsh]\ncommand = ' + q(node) + '\nargs = [' +
  [join(runtime, 'packaging/launch-server.mjs'), '--config', cfg].map(q).join(', ') + ']\n');
const env = { ...process.env, CODEX_HOME: home }; delete env.CODEX_THREAD_ID; delete env.DEEPSEEK_API_KEY;
const child = spawn(codex, ['app-server'], { env, cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let nextId = 0, stderr = ''; child.stderr.on('data', c => { stderr = (stderr + c).slice(-2000); });
const pending = new Map();
createInterface({ input: child.stdout }).on('line', line => {
  const message = JSON.parse(line), request = pending.get(message.id);
  if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
});
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error('Timed out ' + method + ': ' + stderr)); }, 30000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const invoke = async (id, tool, args = {}) => {
  const result = await call('mcpServer/tool/call', { server: 'dsh', tool, arguments: args, threadId: id });
  assert(!result.isError, JSON.stringify(result));
  const value = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert.equal(value.control.chat_id, id, 'The actual host must route its tool call to the calling chat.');
  return value;
};
try {
  await call('initialize', { clientInfo: { name: 'dsh_host_test', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const ids = [];
  for (let i = 0; i < 2; i++) ids.push((await call('thread/start', { cwd: directory, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' })).thread.id);
  await invoke(ids[0], 'set_concurrency', { max_concurrent_agents: 2 });
  await invoke(ids[1], 'set_concurrency', { max_concurrent_agents: 3 });
  assert.equal((await invoke(ids[0], 'list_agents')).max_concurrent_agents, 2);
  assert.equal((await invoke(ids[1], 'list_agents')).max_concurrent_agents, 3);
  await invoke(ids[0], 'list_model');
  assert.notEqual(...ids.map(id => JSON.parse(readFileSync(join(data, 'chats', id, 'session.json'), 'utf8')).pid));
  const report = { ok: true, directory, runtime, model_requests: 0,
    checks: ['actual Codex app-server with no CODEX_THREAD_ID', 'host-supplied request identity', 'two independent chat controls', 'no model turn or API call'] };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { child.stdin.end(); child.kill(); for (const item of pending.values()) clearTimeout(item.timer); }
