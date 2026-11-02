import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentManager } from '../src/manager.ts';
import { loadConfig } from '../src/config.ts';
import { TaskSnapshots, snapshotInstructions } from '../src/task-snapshot.ts';
import { OutsourcingSwitch } from '../src/global-control.ts';
import { scopedTools } from '../src/control.ts';
import { createServer } from '../src/server.ts';
import { sessionConfig } from '../src/sessions.ts';
import { isWithin } from '../src/workspaces.ts';
import type { BackendFactory, BackendSpec, DeliveryRecord } from '../src/types.ts';

function fixture(t: TestContext) {
  const output = resolve('.test-output/workspaces'); mkdirSync(output, { recursive: true });
  const dir = mkdtempSync(join(output, 'case-')), main = join(dir, 'main'), configured = join(dir, 'default');
  mkdirSync(main); mkdirSync(configured);
  const base = loadConfig(undefined, { workspace: configured, dataDir: join(dir, 'data') });
  base.control = { ...base.control, allow_secondary: true, max_depth_user: 3, max_children_user: 5 };
  const chat = randomUUID(), config = sessionConfig(base, chat), gate = new OutsourcingSwitch(base.data_dir, 'python', base.control);
  const store = new TaskSnapshots(base), specs: BackendSpec[] = [], sent: DeliveryRecord[] = [];
  const factory: BackendFactory = spec => { specs.push(spec); return { async open() {}, async close() {}, async run(message) {
    writeFileSync(join(spec.cwd, 'local-worker.txt'), message);
    return { finalResponse: message, finishReason: 'completed' };
  } }; };
  const managers: AgentManager[] = [];
  const open = () => { const manager = new AgentManager(config, factory, async item => { sent.push(item); return { published: true }; }); managers.push(manager); return manager; };
  t.after(async () => { for (const manager of managers) await manager.shutdown(); });
  const capture = (restricted: boolean) => {
    gate.updateSettings({ restrict_to_caller_workspace: restricted }, gate.snapshot().revision);
    return store.capture(chat, randomUUID(), main);
  };
  return { dir, main, configured, base, config, gate, store, chat, specs, sent, managers, factory, open, capture };
}
async function idle(manager: AgentManager, id: string) {
  const end = Date.now() + 10000;
  while (manager.list().active_count) { assert(Date.now() < end); await new Promise(r => setTimeout(r, 25)); }
  assert.equal(manager.read(id).agent.status, 'idle', manager.read(id).agent.error ?? '');
}

test('main caller registers any local project, creates folders, persists IDs, and workers use the selected directory', async t => {
  const f = fixture(t), turn = f.capture(false), manager = f.open();
  const outside = join(f.dir, 'other-project');
  const workspace = manager.controlPlane.withSnapshot(turn, () => manager.createWorkspace({ path: outside, name: 'Other project' }));
  assert(workspace.created_directory); assert(existsSync(outside));
  assert.equal(manager.controlPlane.withSnapshot(turn, () => manager.createWorkspace({ path: outside })).workspace.id, workspace.workspace.id);
  const local = manager.controlPlane.withSnapshot(turn, () => manager.createWorkspace({ path: '.' }));
  assert.equal(local.workspace.path, f.main, 'Relative registration follows the host project, not installer workspace_root');
  const agent = manager.controlPlane.withSnapshot(turn, () => manager.spawn({ task_name: 'other', message: 'fixture only', workspace_id: workspace.workspace.id })).agent;
  await idle(manager, agent.id);
  assert.equal(f.specs[0]!.cwd, outside);
  assert.equal(readFileSync(join(outside, 'local-worker.txt'), 'utf8'), 'fixture only');
  assert(!existsSync(join(f.configured, 'local-worker.txt')));
  assert.throws(() => manager.controlPlane.withSnapshot(turn, () => manager.spawn({ task_name: 'without_id', message: 'x', cwd: outside })), /create_workspace/);
  await manager.shutdown();
  const next = f.open();
  assert.equal(next.listWorkspaces().workspaces.length, 2);
  next.followup(agent.id, 'after restart'); await idle(next, agent.id);
  assert.equal(readFileSync(join(outside, 'local-worker.txt'), 'utf8'), 'after restart');
  const other = new AgentManager(sessionConfig(f.base, randomUUID()), f.factory); f.managers.push(other);
  assert.throws(() => other.spawn({ task_name: 'other_chat', message: 'x', workspace_id: workspace.workspace.id }), /not registered in this chat/);
});

test('the immutable user switch gates creation, existing IDs and followups before any file or worker changes', async t => {
  const f = fixture(t), unrestricted = f.capture(false), manager = f.open();
  const workspace = manager.controlPlane.withSnapshot(unrestricted, () => manager.createWorkspace({ path: join(f.dir, 'outside') })).workspace;
  const agent = manager.controlPlane.withSnapshot(unrestricted, () => manager.spawn({ task_name: 'old', message: 'old', workspace_id: workspace.id })).agent;
  await idle(manager, agent.id);
  const restricted = f.capture(true), forbidden = join(f.dir, 'must-not-create', 'nested');
  manager.controlPlane.withSnapshot(restricted, () => {
    assert.equal(manager.controlPlane.agentInfo().restrict_to_caller_workspace, true);
    assert.equal(manager.controlPlane.agentInfo().caller_workspace, f.main);
    assert.throws(() => manager.createWorkspace({ path: forbidden }), /WORKSPACE_SCOPE|主 agent/);
    assert(!existsSync(join(f.dir, 'must-not-create')));
    assert.throws(() => manager.createWorkspace({ path: workspace.path }), /主 agent/);
    assert.equal(manager.listWorkspaces().workspaces[0]!.available, false);
    assert.throws(() => manager.spawn({ task_name: 'blocked', message: 'x', workspace_id: workspace.id }), /主 agent/);
    assert.throws(() => manager.followup(agent.id, 'blocked followup'), /主 agent/);
    assert.equal(manager.read(agent.id).pending.length, 0);
    const inside = manager.createWorkspace({ path: 'jobs/inside' });
    assert.equal(inside.workspace.path, join(f.main, 'jobs', 'inside'));
  });
  f.gate.updateSettings({ restrict_to_caller_workspace: false }, f.gate.snapshot().revision);
  manager.controlPlane.withSnapshot(restricted, () => assert.throws(() => manager.createWorkspace({ path: forbidden }), /主 agent/));
  manager.controlPlane.withSnapshot(unrestricted, () => assert.equal(manager.createWorkspace({ path: workspace.path }).reused, true));
  assert.match(snapshotInstructions(restricted), /"restrict_to_caller_workspace":true/);
  assert.match(snapshotInstructions(restricted), /create_workspace/);
});

test('children inherit a workspace, cannot register or switch roots, and stay inside the parent cwd', async t => {
  const f = fixture(t), manager = f.open(), turn = f.capture(false);
  let parentId = '', workspaceId = '';
  manager.controlPlane.withSnapshot(turn, () => {
    const workspace = manager.createWorkspace({ path: join(f.dir, 'project') }).workspace; workspaceId = workspace.id;
    mkdirSync(join(workspace.path, 'area')); mkdirSync(join(workspace.path, 'area', 'child')); mkdirSync(join(workspace.path, 'sibling'));
    parentId = manager.spawn({ task_name: 'parent', message: 'parent', workspace_id: workspace.id, cwd: 'area', max_depth: 2, max_children: 4 }).agent.id;
  });
  await idle(manager, parentId);
  const scoped = scopedTools(manager, parentId);
  assert.equal(scoped.createWorkspace, undefined); assert.equal(scoped.listWorkspaces, undefined);
  const child = scoped.spawn({ task_name: 'child', message: 'child', cwd: 'area/child' }).agent;
  await idle(manager, child.id); assert.equal(child.workspace_id, workspaceId);
  assert.throws(() => scoped.spawn({ task_name: 'sibling', message: 'x', cwd: 'sibling' }), /parent working directory/);
  const different = manager.createWorkspace({ path: join(f.dir, 'different') }).workspace;
  assert.throws(() => scoped.spawn({ task_name: 'switch', message: 'x', workspace_id: different.id }), /cannot select another workspace/);
  const server = createServer(scoped), client = new Client({ name: 'workspace-child', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  assert(!(await client.listTools()).tools.some(tool => ['create_workspace', 'list_workspaces'].includes(tool.name)));
});

test('junction escapes and replaced persisted roots fail before mkdir, spawn, resume or followup', async t => {
  const f = fixture(t), turn = f.capture(true), manager = f.open(), outside = join(f.dir, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(f.main, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  let root = '', id = '';
  manager.controlPlane.withSnapshot(turn, () => {
    assert.throws(() => manager.createWorkspace({ path: 'escape/new-folder' }), /主 agent/);
    assert(!existsSync(join(outside, 'new-folder')));
    const workspace = manager.createWorkspace({ path: 'owned' }).workspace; root = workspace.path;
    id = manager.spawn({ task_name: 'bound', message: 'first', workspace_id: workspace.id }).agent.id;
  });
  await idle(manager, id); manager.pause(id); manager.followup(id, 'pending');
  const backup = root + '-backup'; assert(isWithin(f.dir, root) && isWithin(f.dir, backup)); renameSync(root, backup);
  symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => manager.resume(id), /moved|replaced/);
  assert.equal(manager.read(id).agent.status, 'paused');
  assert.throws(() => manager.followup(id, 'blocked'), /moved|replaced/);
  assert.equal(f.specs.length, 1);
});

test('read-only mode registers existing directories, refuses creation and preserves existing contents', async t => {
  const f = fixture(t); f.config.permission_mode = 'read-only'; const manager = f.open();
  const existing = join(f.dir, 'existing'); mkdirSync(existing); writeFileSync(join(existing, 'keep.txt'), 'keep');
  assert(!manager.createWorkspace({ path: existing }).created_directory);
  assert.equal(readFileSync(join(existing, 'keep.txt'), 'utf8'), 'keep');
  assert.throws(() => manager.createWorkspace({ path: join(f.dir, 'new') }), /Read-only/);
  assert(!existsSync(join(f.dir, 'new')));
  assert.throws(() => manager.createWorkspace({ path: join(existing, 'keep.txt') }), /not a local directory/);
  if (process.platform === 'win32') assert.throws(() => manager.createWorkspace({ path: '\\\\server\\share' }), /network/);
});

test('the captured main workspace cannot be retargeted through a junction after submission', t => {
  const f = fixture(t), alias = join(f.dir, 'host-alias');
  symlinkSync(f.main, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.gate.updateSettings({ restrict_to_caller_workspace: true }, f.gate.snapshot().revision);
  const turn = f.store.capture(f.chat, randomUUID(), alias);
  assert.equal(turn.caller_cwd, f.main, 'Freeze the real host directory, not a retargetable alias');
  const manager = f.open(), backup = f.main + '-backup', outside = join(f.dir, 'outside');
  mkdirSync(outside); assert(isWithin(f.dir, f.main) && isWithin(f.dir, backup)); renameSync(f.main, backup);
  symlinkSync(outside, f.main, process.platform === 'win32' ? 'junction' : 'dir');
  manager.controlPlane.withSnapshot(turn, () => assert.throws(() => manager.createWorkspace({ path: 'blocked' }), /moved|replaced/));
  assert(!existsSync(join(outside, 'blocked')));
});

test('MCP exposes workspace tools only to the main caller, with snapshot scope and service-disable enforcement', async t => {
  const f = fixture(t), manager = f.open(), turn = f.capture(true);
  const server = createServer(manager, '', { sessionId: f.chat, scope: (extra, action) => manager.withRequest(extra._meta, action) });
  const client = new Client({ name: 'workspace-main', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); t.after(async () => { await client.close(); await server.close(); });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert(names.includes('create_workspace') && names.includes('list_workspaces'));
  const call = (name: string, args = {}, turnId = turn.turn_id) => client.callTool({ name, arguments: args, _meta: { thread_id: f.chat, turn_id: turnId } });
  assert((await call('create_workspace', { path: 'no-snapshot' }, randomUUID())).isError);
  assert(!existsSync(join(f.main, 'no-snapshot')));
  const result = await call('create_workspace', { path: 'mcp-workspace' }); assert(!result.isError, JSON.stringify(result));
  const workspace = result.structuredContent!.workspace as { id: string; path: string };
  assert.equal(workspace.path, join(f.main, 'mcp-workspace'));
  assert.equal(((await call('list_workspaces')).structuredContent!.workspaces as unknown[]).length, 1);
  assert((await call('create_workspace', { path: join(f.dir, 'outside') })).isError);
  manager.globalControl.stopService();
  assert((await call('create_workspace', { path: 'stopped' })).isError);
  assert(!existsSync(join(f.main, 'stopped')));
});

test('context inheritance and callback attribution follow the host chat even when the worker uses another project', async t => {
  const f = fixture(t); f.config.completion_delivery.mode = 'app_tools';
  const home = join(f.dir, 'codex'), sessions = join(home, 'sessions'); mkdirSync(sessions, { recursive: true });
  f.config.codex_home = home;
  writeFileSync(join(sessions, 'rollout-fixture-' + f.chat + '.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: f.chat, cwd: f.main } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'LOCAL_HOST_CONTEXT' } }) + '\n');
  const turn = f.capture(false), manager = f.open();
  const workspace = manager.controlPlane.withSnapshot(turn, () => manager.createWorkspace({ path: join(f.dir, 'elsewhere') })).workspace;
  const agent = manager.controlPlane.withSnapshot(turn, () => manager.spawn({ task_name: 'context', message: 'local test', fork_turns: 'all', workspace_id: workspace.id, notify_on_completion: true })).agent;
  await idle(manager, agent.id); await manager.flushDeliveries();
  assert.equal(agent.context_source?.id, f.chat);
  assert(readFileSync(join(workspace.path, 'local-worker.txt'), 'utf8').includes('LOCAL_HOST_CONTEXT'));
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.thread_id, f.chat); assert.equal(f.sent[0]!.caller_cwd, f.main);
});
