import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { AgentManager } from '../src/manager.ts';
import { scopedTools } from '../src/control.ts';
import { agentDirectory, childEnvironment, loadConfig } from '../src/config.ts';
import { errorText, type AgentBackend, type BackendNotice, type BackendResult, type BackendSpec } from '../src/types.ts';

const outputRoot = resolve('.test-output', 'unit');
mkdirSync(outputRoot, { recursive: true });

class ControlledBackend implements AgentBackend {
  calls: string[] = [];
  closed = false;
  closeFailures = 0;
  pending?: { resolve: (value: BackendResult) => void; reject: (error: Error) => void };
  constructor(readonly spec: BackendSpec) {}
  async open() { if (this.closed) throw new Error('closed'); }
  async run(message: string, notice: (value: BackendNotice) => void): Promise<BackendResult> {
    this.calls.push(message);
    if (message === 'hold') return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
    if (message === 'fail') throw new Error('simulated model failure');
    notice({ type: 'assistant_message', text: 'answer:' + message });
    return { finalResponse: 'answer:' + message, finishReason: message === 'no_terminal' ? null : 'completed' };
  }
  finish(text = 'done') { this.pending?.resolve({ finalResponse: text, finishReason: 'completed' }); this.pending = undefined; }
  async close() {
    if (this.closeFailures-- > 0) throw new Error('simulated unconfirmed exit');
    this.closed = true;
    this.pending?.reject(new Error('interrupted'));
    this.pending = undefined;
  }
}

function fixture(t: TestContext, overrides = {}) {
  const directory = mkdtempSync(join(outputRoot, 'case-'));
  const workspace = join(directory, 'workspace');
  mkdirSync(workspace);
  const config = { ...loadConfig(undefined, { workspace, dataDir: join(directory, 'data') }), ...overrides };
  config.control = { ...config.control, allow_secondary: true, max_depth_user: 32, max_children_user: 1000, max_root_agents: 32 };
  const backends: ControlledBackend[] = [];
  const factory = (spec: BackendSpec) => { const backend = new ControlledBackend(spec); backends.push(backend); return backend; };
  const manager = new AgentManager(config, factory);
  const managers = [manager];
  t.after(async () => {
    for (const backend of backends) backend.closeFailures = 0;
    for (const item of managers) await item.shutdown();
    const rel = relative(realpathSync(outputRoot), realpathSync(directory));
    assert(!isAbsolute(rel) && !rel.startsWith('..'), 'cleanup must stay within the test output directory');
    rmSync(directory, { recursive: true, force: true });
  });
  return { manager, config, backends, factory, directory, managers };
}

async function settled(manager: AgentManager, id: string) {
  for (let count = 0; count < 30; count++) {
    const snapshot = manager.read(id);
    if (!['starting', 'running', 'pausing', 'stopping'].includes(snapshot.agent.status)) return snapshot;
    await manager.wait({ targets: [id], after_cursor: snapshot.cursor, timeout_ms: 100 }, AbortSignal.timeout(2000));
  }
  throw new Error('Agent did not settle');
}

async function running(manager: AgentManager, id: string) {
  while (manager.read(id).agent.status === 'starting') {
    await manager.wait({ targets: [id], after_cursor: manager.list().cursor, timeout_ms: 100 }, AbortSignal.timeout(2000));
  }
}

test('spawn returns immediately, saves results, and rejects duplicate canonical names', async t => {
  const { manager } = fixture(t);
  const spawned = manager.spawn({ task_name: 'one', message: 'hello' });
  assert.equal(spawned.agent.status, 'starting');
  assert.equal(spawned.agent.path, '/root/one');
  assert.throws(() => manager.spawn({ task_name: 'one', message: 'again' }), /already exists/);
  const finished = await settled(manager, spawned.agent.id);
  assert.equal(finished.agent.status, 'idle');
  assert.equal(finished.final_response, 'answer:hello');
  assert.equal(manager.list().active_count, 0);
  assert.equal(manager.read('one', 0, 3).final_response, 'ans');
  assert.equal(manager.read('one', 0, 3).next_offset, 3);
});

test('delegation defaults deny child creation and validate integer budgets before launching', async t => {
  const { manager, backends } = fixture(t);
  const root = manager.spawn({ task_name: 'default_policy', message: 'hello' }).agent;
  assert.equal(root.max_depth, 0);
  assert.equal(root.max_children, 1);
  assert.equal(root.children_count, 0);
  await settled(manager, root.id);
  assert.equal(backends[0]!.spec.control, undefined);
  assert.throws(() => manager.spawn({ task_name: 'denied', parent: root.id, message: 'x' }), /no remaining delegation/);
  for (const name of ['max_depth', 'max_children'] as const) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => manager.spawn({ task_name: 'invalid', message: 'x', [name]: value }), /non-negative safe integer/);
    }
  }
  assert.equal(manager.list().agents.length, 1);
});

test('delegation depth decreases on each edge; descendants cannot enlarge either budget', async t => {
  const { manager, backends } = fixture(t);
  const root = manager.spawn({ task_name: 'delegator', message: 'hello', max_depth: 2, max_children: 2 }).agent;
  await settled(manager, root.id);
  assert(backends[0]!.spec.control, 'non-leaf workers receive scoped MCP controls');
  assert.throws(() => manager.spawn({ task_name: 'over_depth', parent: root.id, message: 'x', max_depth: 2 }), /cannot increase/);
  assert.throws(() => manager.spawn({ task_name: 'over_width', parent: root.id, message: 'x', max_children: 3 }), /cannot increase/);
  const child = manager.spawn({ task_name: 'child', parent: root.id, message: 'hello' }).agent;
  await settled(manager, child.id);
  assert.equal(child.max_depth, 1);
  assert.equal(child.max_children, 2);
  const leaf = manager.spawn({ task_name: 'leaf', parent: child.id, message: 'hello' }).agent;
  await settled(manager, leaf.id);
  assert.equal(leaf.max_depth, 0);
  assert.equal(backends.at(-1)!.spec.control, undefined);
  assert.throws(() => manager.spawn({ task_name: 'too_deep', parent: leaf.id, message: 'x' }), /no remaining delegation/);
  const reduced = manager.spawn({ task_name: 'reduced', parent: root.id, message: 'hello', max_depth: 0, max_children: 0 }).agent;
  await settled(manager, reduced.id);
  assert.equal(reduced.max_depth, 0);
  assert.equal(reduced.max_children, 0);
});

test('direct-child quota includes closed agents and persists across server restarts', async t => {
  const f = fixture(t);
  const root = f.manager.spawn({ task_name: 'root_budget', message: 'hello', max_depth: 1 }).agent;
  await settled(f.manager, root.id);
  const child = f.manager.spawn({ task_name: 'first', parent: root.id, message: 'hello' }).agent;
  await settled(f.manager, child.id);
  await f.manager.interrupt(child.id, true);
  assert.throws(() => f.manager.spawn({ task_name: 'second', parent: root.id, message: 'x' }), /lifetime direct-child limit/);
  await f.manager.shutdown();
  const resumed = new AgentManager(f.config, f.factory);
  f.managers.push(resumed);
  const policy = resumed.read(root.id).agent;
  assert.equal(policy.max_depth, 1);
  assert.equal(policy.max_children, 1);
  assert.equal(policy.children_count, 1);
  assert.throws(() => resumed.spawn({ task_name: 'second', parent: root.id, message: 'x' }), /lifetime direct-child limit/);
});

test('scoped controls bind the parent identity, hide unrelated tasks, and cannot escape the tree', async t => {
  const { manager } = fixture(t);
  const root = manager.spawn({ task_name: 'scoped', message: 'hello', max_depth: 2, max_children: 2 }).agent;
  const other = manager.spawn({ task_name: 'unrelated', message: 'hello', max_depth: 1 }).agent;
  await settled(manager, root.id);
  await settled(manager, other.id);
  const tools = scopedTools(manager, root.id);
  const child = tools.spawn({ task_name: 'nested', message: 'hello' }).agent;
  await settled(manager, child.id);
  assert.equal(child.parent_id, root.id);
  assert.equal(child.max_depth, 1);
  assert.equal(child.notify_on_completion, false);
  assert.deepEqual(tools.list().agents.map(agent => agent.id), [root.id, child.id]);
  assert.throws(() => tools.spawn({ task_name: 'escape', parent: other.id, message: 'x' }), /parent must be/);
  assert.throws(() => tools.read(other.id), /own descendants/);
  assert.throws(() => tools.list('/root'), /inside the calling agent/);
  assert.throws(() => tools.sendMessage(other.id, 'x'), /own descendants/);
  assert.throws(() => tools.followup(other.id, 'x'), /own descendants/);
  assert.throws(() => tools.interrupt(root.id), /own descendants/);
  assert.throws(() => tools.wait({ targets: [other.id], timeout_ms: 0 }), /own descendants/);
  const wait = await tools.wait({ after_cursor: manager.list().cursor, timeout_ms: 0 });
  assert.deepEqual(wait.agents.map(agent => agent.id), [child.id]);
  assert.equal(tools.read(root.id).agent.id, root.id, 'the caller may read its own policy');
});

test('max_children=0 disables the worker delegation bridge even with remaining depth', async t => {
  const { manager, backends } = fixture(t);
  const root = manager.spawn({ task_name: 'no_children', message: 'hello', max_depth: 3, max_children: 0 }).agent;
  await settled(manager, root.id);
  assert.equal(backends[0]!.spec.control, undefined);
  assert.throws(() => manager.spawn({ task_name: 'denied', parent: root.id, message: 'x' }), /direct-child limit/);
});

test('all inherits an immutable parent snapshot; none stays independent and queued mail is excluded', async t => {
  const { manager, backends } = fixture(t);
  const parent = manager.spawn({ task_name: 'parent', message: 'PARENT_CONTEXT_MARKER', max_depth: 1, max_children: 2 }).agent;
  await settled(manager, parent.id);
  manager.sendMessage(parent.id, 'UNCONSUMED_MAIL_MARKER');
  const inherited = manager.spawn({ task_name: 'inherited', parent: parent.id, fork_turns: 'all', message: 'child task' }).agent;
  const fresh = manager.spawn({ task_name: 'fresh', parent: parent.id, fork_turns: 'none', message: 'fresh task' }).agent;
  await settled(manager, inherited.id);
  await settled(manager, fresh.id);
  const prompt = backends.find(item => item.spec.id === inherited.id)!.calls[0]!;
  assert(prompt.includes('PARENT_CONTEXT_MARKER'));
  assert(prompt.includes('answer:PARENT_CONTEXT_MARKER'));
  assert(!prompt.includes('UNCONSUMED_MAIL_MARKER'));
  assert.equal(backends.find(item => item.spec.id === fresh.id)!.calls[0], 'fresh task');
  manager.followup(inherited.id, 'later');
  await settled(manager, inherited.id);
  assert.equal(backends.at(-1)!.calls[0], 'later', 'snapshot is not prepended again on followup');
});

test('root all requires supplied context and context limits fail before creating a child', async t => {
  const { manager, backends } = fixture(t, { max_context_chars: 1000 });
  const ambientThread = process.env.CODEX_THREAD_ID;
  delete process.env.CODEX_THREAD_ID;
  try { assert.throws(() => manager.spawn({ task_name: 'missing', message: 'x', fork_turns: 'all' }), /requires/); }
  finally { if (ambientThread !== undefined) process.env.CODEX_THREAD_ID = ambientThread; }
  assert.throws(() => manager.spawn({ task_name: 'large', message: 'x', fork_turns: 'all', context: 'x'.repeat(1001) }), /exceeds/);
  assert.equal(manager.list().agents.length, 0);
  const { agent } = manager.spawn({ task_name: 'root_context', message: 'x', fork_turns: 'all', context: 'CALLER_CONTEXT' });
  await settled(manager, agent.id);
  assert(backends[0]!.calls[0]!.includes('CALLER_CONTEXT'));
});

test('context survives server restart and can be inherited transitively', async t => {
  const f = fixture(t);
  const parent = f.manager.spawn({ task_name: 'origin', message: 'ANCESTOR_MARKER', max_depth: 2 }).agent;
  await settled(f.manager, parent.id);
  const child = f.manager.spawn({ task_name: 'child', message: 'CHILD_MARKER', parent: parent.id, fork_turns: 'all' }).agent;
  await settled(f.manager, child.id);
  await f.manager.shutdown();
  const resumed = new AgentManager(f.config, f.factory);
  f.managers.push(resumed);
  const grandchild = resumed.spawn({ task_name: 'grandchild', message: 'new task', parent: child.id, fork_turns: 'all' }).agent;
  await settled(resumed, grandchild.id);
  const prompt = f.backends.at(-1)!.calls[0]!;
  assert(prompt.includes('ANCESTOR_MARKER'));
  assert(prompt.includes('CHILD_MARKER'));
});

test('running messages are delivered in order at the next turn boundary', async t => {
  const { manager, backends } = fixture(t);
  const { agent } = manager.spawn({ task_name: 'queue', message: 'hold' });
  await running(manager, agent.id);
  assert.equal(manager.sendMessage(agent.id, 'context').delivery, 'next_turn');
  manager.followup(agent.id, 'continue');
  assert.deepEqual(backends[0]!.calls, ['hold']);
  backends[0]!.finish();
  const result = await settled(manager, agent.id);
  assert.deepEqual(backends.flatMap(item => item.calls), ['hold', 'context', 'continue']);
  assert.equal(result.agent.turn, 3);
  assert.equal(result.final_response, 'answer:continue');
});

test('idle mail does not wake an agent; followup resumes its exact session', async t => {
  const { manager, backends } = fixture(t);
  const { agent } = manager.spawn({ task_name: 'resume', message: 'first' });
  await settled(manager, agent.id);
  assert.equal(manager.sendMessage(agent.id, 'mail').delivery, 'queued_until_followup');
  assert.equal(backends.length, 1);
  assert.equal(manager.list().active_count, 0);
  manager.followup(agent.id, 'second');
  const result = await settled(manager, agent.id);
  assert.equal(backends[1]!.spec.resume, true);
  assert.equal(backends[1]!.spec.sessionId, backends[0]!.spec.sessionId);
  assert.deepEqual(backends[1]!.calls, ['mail', 'second']);
  assert.equal(result.final_response, 'answer:second');
});

test('interrupt during startup launches no process and preserves pending work', async t => {
  const { manager, backends } = fixture(t);
  const { agent } = manager.spawn({ task_name: 'early', message: 'hello' });
  const stopped = await manager.interrupt(agent.id);
  assert.equal(stopped.agent.status, 'interrupted');
  assert.equal(backends.length, 0);
  assert.equal(stopped.agent.queued_messages, 1);
});

test('interrupt reaps a running worker, preserves its session, and does not retry its input', async t => {
  const { manager, backends } = fixture(t);
  const { agent } = manager.spawn({ task_name: 'stop', message: 'hold' });
  await running(manager, agent.id);
  const stopped = await manager.interrupt(agent.id);
  assert.equal(stopped.previous_status, 'running');
  assert.equal(stopped.agent.status, 'interrupted');
  assert(backends[0]!.closed);
  manager.followup(agent.id, 'resume safely');
  assert.equal((await settled(manager, agent.id)).agent.status, 'idle');
  assert.deepEqual(backends[1]!.calls, ['resume safely']);
  assert(backends[1]!.spec.resume);
});

test('model errors and missing terminal events are failures with no automatic retry', async t => {
  const { manager, backends } = fixture(t);
  for (const message of ['fail', 'no_terminal']) {
    const { agent } = manager.spawn({ task_name: message, message });
    assert.equal((await settled(manager, agent.id)).agent.status, 'failed');
  }
  assert.equal(backends.reduce((sum, item) => sum + item.calls.length, 0), 2);
});

test('capacity is enforced until worker exit is confirmed', async t => {
  const { manager, backends } = fixture(t, { max_concurrent_agents: 1 });
  const { agent } = manager.spawn({ task_name: 'held', message: 'hold' });
  await running(manager, agent.id);
  assert.throws(() => manager.spawn({ task_name: 'extra', message: 'x' }), /slots are busy/);
  backends[0]!.closeFailures = 3;
  backends[0]!.finish();
  const failed = await settled(manager, agent.id);
  assert.equal(failed.agent.status, 'failed');
  assert(failed.agent.runtime_exit_unconfirmed);
  assert.throws(() => manager.spawn({ task_name: 'extra', message: 'x' }), /slots are busy/);
  backends[0]!.closeFailures = 0;
  await manager.interrupt(agent.id, true);
  assert.equal(manager.list().active_count, 0);
});

test('batch preflight rejects invalid selections before mutations and deduplicates target aliases', async t => {
  const { manager } = fixture(t);
  const one = manager.spawn({ task_name: 'one', message: 'hello' }).agent;
  await settled(manager, one.id);
  await assert.rejects(manager.batchControl({ action: 'send_message', targets: [one.id, 'missing'], message: 'x' }), /Unknown agent/);
  await assert.rejects(manager.batchControl({ action: 'send_message', targets: [one.id], path_prefix: '/root', message: 'x' }), /exactly one/);
  await assert.rejects(manager.batchControl({ action: 'send_message', targets: [one.id] }), /requires a message/);
  await assert.rejects(manager.batchControl({ action: 'send_message', targets: [one.id], message: ' ' }), /requires a message/);
  await assert.rejects(manager.batchControl({ action: 'close_agent', targets: [one.id], message: 'x' }), /only accepted/);
  await assert.rejects(manager.batchControl({ action: 'close_agent', path_prefix: '/' }), /canonical task path/);
  assert.equal(manager.read(one.id).agent.queued_messages, 0);
  assert.equal(manager.read(one.id).agent.status, 'idle');
  const sent = await manager.batchControl({ action: 'send_message', targets: [one.id, one.path, 'one'], message: 'once' });
  assert.equal(sent.total, 1);
  assert.equal(sent.succeeded, 1);
  assert.equal(sent.results[0]!.delivery, 'queued_until_followup');
  assert.equal(manager.read(one.id).agent.queued_messages, 1);
  const empty = await manager.batchControl({ action: 'close_agent', path_prefix: '/root/missing' });
  assert.equal(empty.total, 0);
});

test('pause before startup preserves the first message; capacity failure leaves resume paused', async t => {
  const { manager, backends } = fixture(t, { max_concurrent_agents: 1 });
  const one = manager.spawn({ task_name: 'one', message: 'first' }).agent;
  assert.equal(manager.pause(one.id).agent.status, 'pausing');
  const paused = await settled(manager, one.id);
  assert.equal(paused.agent.status, 'paused');
  assert.equal(paused.agent.queued_messages, 1);
  assert.equal(backends.length, 0);
  const busy = manager.spawn({ task_name: 'busy', message: 'hold' }).agent;
  await running(manager, busy.id);
  assert.throws(() => manager.resume(one.id), /slots are busy/);
  assert.equal(manager.read(one.id).agent.status, 'paused');
  assert.equal(manager.read(one.id).agent.pause_requested, true);
  await manager.interrupt(busy.id);
  manager.resume(one.id);
  assert.equal((await settled(manager, one.id)).final_response, 'answer:first');
  assert.deepEqual(backends.filter(item => item.spec.id === one.id).flatMap(item => item.calls), ['first']);
});

test('pause drains the active turn, persists its queue across restart and resumes without replay', async t => {
  const f = fixture(t);
  const one = f.manager.spawn({ task_name: 'one', message: 'hold' }).agent;
  await running(f.manager, one.id);
  f.manager.sendMessage(one.id, 'first pending');
  f.manager.pause(one.id);
  assert.equal(f.manager.followup(one.id, 'second pending').delivery, 'queued_until_resume');
  assert.equal(f.backends[0]!.closed, false);
  assert.equal(f.manager.list().active_count, 1);
  f.backends[0]!.finish('current turn completed');
  const paused = await settled(f.manager, one.id);
  assert.equal(paused.agent.status, 'paused');
  assert.equal(paused.final_response, 'current turn completed');
  assert.equal(paused.agent.queued_messages, 2);
  assert.equal(f.manager.list().active_count, 0);
  assert(f.backends[0]!.closed);
  await f.manager.shutdown();
  const resumed = new AgentManager(f.config, f.factory); f.managers.push(resumed);
  assert.equal(resumed.read(one.id).agent.status, 'paused');
  assert.equal(f.backends.length, 1);
  resumed.resume(one.id);
  assert.equal((await settled(resumed, one.id)).final_response, 'answer:second pending');
  assert.deepEqual(f.backends.flatMap(item => item.calls), ['hold', 'first pending', 'second pending']);
  assert.equal(f.backends[1]!.spec.sessionId, one.session_id);
  assert(f.backends[1]!.spec.resume);
});

test('resume before the turn boundary cancels the pause and an empty paused queue makes no model call', async t => {
  const { manager, backends } = fixture(t);
  const one = manager.spawn({ task_name: 'one', message: 'hold' }).agent;
  await running(manager, one.id);
  manager.pause(one.id);
  assert.equal(manager.resume(one.id).agent.status, 'running');
  manager.sendMessage(one.id, 'next');
  backends[0]!.finish();
  assert.equal((await settled(manager, one.id)).final_response, 'answer:next');
  const count = backends.length;
  manager.pause(one.id);
  const pausedCursor = manager.list().cursor;
  assert.equal(manager.pause(one.id).cursor, pausedCursor);
  assert.equal(manager.resume(one.id).agent.status, 'idle');
  assert.equal(backends.length, count);
  assert.equal(manager.resume(one.id).agent.turn, 2);
});

test('resume during pause cleanup does not strand mail accepted before process exit', async t => {
  const { manager, backends } = fixture(t);
  const one = manager.spawn({ task_name: 'one', message: 'hold' }).agent;
  await running(manager, one.id);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalClose = backends[0]!.close.bind(backends[0]);
  backends[0]!.close = async () => { entered.resolve(); await release.promise; await originalClose(); };
  manager.pause(one.id); backends[0]!.finish();
  await entered.promise;
  try { manager.resume(one.id); manager.followup(one.id, 'arrived during cleanup'); }
  finally { release.resolve(); }
  assert.equal((await settled(manager, one.id)).final_response, 'answer:arrived during cleanup');
  assert.equal(manager.read(one.id).agent.queued_messages, 0);
});

test('shutdown during pausing preserves the pause but never retries the interrupted active input', async t => {
  const f = fixture(t);
  const one = f.manager.spawn({ task_name: 'one', message: 'hold' }).agent;
  await running(f.manager, one.id);
  f.manager.pause(one.id); f.manager.sendMessage(one.id, 'survives');
  await f.manager.shutdown();
  const resumed = new AgentManager(f.config, f.factory); f.managers.push(resumed);
  assert.equal(resumed.read(one.id).agent.status, 'paused');
  assert.equal(resumed.read(one.id).agent.finish_reason, 'interrupted');
  resumed.resume(one.id);
  assert.equal((await settled(resumed, one.id)).final_response, 'answer:survives');
  assert.deepEqual(f.backends.flatMap(item => item.calls), ['hold', 'survives']);
});

test('shutdown at the pause cleanup boundary preserves an already completed result', async t => {
  const f = fixture(t);
  const one = f.manager.spawn({ task_name: 'one', message: 'hold' }).agent;
  await running(f.manager, one.id);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const close = f.backends[0]!.close.bind(f.backends[0]);
  f.backends[0]!.close = async () => { entered.resolve(); await release.promise; await close(); };
  f.manager.pause(one.id); f.backends[0]!.finish('completed before shutdown');
  await entered.promise;
  const shutdown = f.manager.shutdown(); release.resolve(); await shutdown;
  const resumed = new AgentManager(f.config, f.factory); f.managers.push(resumed);
  const state = resumed.read(one.id);
  assert.equal(state.agent.status, 'paused');
  assert.equal(state.agent.finish_reason, 'completed');
  assert.equal(state.final_response, 'completed before shutdown');
  assert.equal(resumed.resume(one.id).agent.status, 'idle');
  assert.equal(f.backends.length, 1);
});

test('interrupt persists cancellation of a pause after the active turn fails', async t => {
  const f = fixture(t);
  const one = f.manager.spawn({ task_name: 'one', message: 'hold' }).agent;
  await running(f.manager, one.id);
  f.manager.pause(one.id);
  f.backends[0]!.pending!.reject(new Error('model failed while pausing'));
  assert.equal((await settled(f.manager, one.id)).agent.status, 'failed');
  await f.manager.interrupt(one.id);
  await f.manager.shutdown();
  const resumed = new AgentManager(f.config, f.factory); f.managers.push(resumed);
  assert.equal(resumed.read(one.id).agent.pause_requested, false);
  resumed.followup(one.id, 'new task');
  assert.equal((await settled(resumed, one.id)).final_response, 'answer:new task');
});

test('batch pause and resume respect scoped ownership and preserve pending messages', async t => {
  const { manager } = fixture(t);
  const parent = manager.spawn({ task_name: 'parent', message: 'hello', max_depth: 1 }).agent;
  await settled(manager, parent.id);
  const tools = scopedTools(manager, parent.id);
  const child = tools.spawn({ task_name: 'child', message: 'hello' }).agent;
  await settled(manager, child.id);
  assert.throws(() => tools.pause(parent.id), /own descendants/);
  assert.throws(() => tools.resume(parent.id), /own descendants/);
  assert.equal((await tools.batchControl({ action: 'pause_agent', path_prefix: parent.path })).results[0]!.status, 'paused');
  tools.followup(child.id, 'pending');
  assert.equal(manager.read(child.id).agent.status, 'paused');
  assert.equal((await tools.batchControl({ action: 'resume_agent', path_prefix: parent.path })).succeeded, 1);
  assert.equal((await settled(manager, child.id)).final_response, 'answer:pending');
});

test('queue editing, reordering, removal and paginated reads preserve identity and survive restart', async t => {
  const f = fixture(t);
  const one = f.manager.spawn({ task_name: 'one', message: 'hello' }).agent;
  await settled(f.manager, one.id); f.manager.pause(one.id);
  const first = f.manager.sendMessage(one.id, 'remove me').message_id;
  const second = f.manager.followup(one.id, 'original').message_id;
  const third = f.manager.sendMessage(one.id, 'x'.repeat(1500)).message_id;
  const page = f.manager.manageQueue(one.id, { action: 'list', limit: 2 });
  assert.equal(page.next_offset, 2);
  const long = f.manager.manageQueue(one.id, { action: 'read', message_id: third, offset: 1000, max_chars: 200 });
  assert.equal(long.message!.text, 'x'.repeat(200));
  assert.equal(long.next_offset, 1200);
  const revision = () => f.manager.read(one.id).agent.queue_revision;
  f.manager.manageQueue(one.id, { action: 'edit', message_id: second, message: 'edited', expected_revision: revision() });
  f.manager.manageQueue(one.id, { action: 'move', message_id: third, position: 0, expected_revision: revision() });
  f.manager.manageQueue(one.id, { action: 'remove', message_id: first, expected_revision: revision() });
  const queue = f.manager.manageQueue(one.id, { action: 'list' });
  assert.deepEqual(queue.messages!.map(item => item.id), [third, second]);
  assert(queue.messages![1]!.edited_at);
  await f.manager.shutdown();
  const resumed = new AgentManager(f.config, f.factory); f.managers.push(resumed);
  assert.equal(resumed.read(one.id).agent.queue_revision, queue.revision);
  resumed.resume(one.id); await settled(resumed, one.id);
  assert.deepEqual(f.backends.flatMap(item => item.calls), ['hello', 'x'.repeat(1500), 'edited']);
});

test('queue revisions reject concurrent enqueue or dequeue and the active message cannot be edited', async t => {
  const { manager, backends } = fixture(t);
  const spawned = manager.spawn({ task_name: 'one', message: 'hold' });
  const initial = manager.manageQueue(spawned.agent.id, { action: 'list' });
  const activeId = initial.messages![0]!.id;
  await running(manager, spawned.agent.id);
  assert.throws(() => manager.manageQueue(spawned.agent.id, { action: 'edit', message_id: activeId, message: 'no', expected_revision: initial.revision }), /Queue changed/);
  assert.throws(() => manager.manageQueue(spawned.agent.id, { action: 'edit', message_id: activeId, message: 'no', expected_revision: manager.read(spawned.agent.id).agent.queue_revision }), /not pending/);
  const queued = manager.sendMessage(spawned.agent.id, 'pending').message_id;
  const revision = manager.read(spawned.agent.id).agent.queue_revision;
  manager.sendMessage(spawned.agent.id, 'another');
  assert.throws(() => manager.manageQueue(spawned.agent.id, { action: 'clear', expected_revision: revision }), /Queue changed/);
  assert.throws(() => manager.manageQueue(spawned.agent.id, { action: 'remove', message_id: queued }), /expected_revision/);
  const current = manager.read(spawned.agent.id).agent.queue_revision;
  assert.throws(() => manager.manageQueue(spawned.agent.id, { action: 'move', message_id: queued, position: 100, expected_revision: current }), /out of range/);
  assert.equal(manager.read(spawned.agent.id).agent.queue_revision, current);
  manager.manageQueue(spawned.agent.id, { action: 'clear', expected_revision: current });
  assert.equal(manager.read(spawned.agent.id).active_message!.id, activeId);
  backends[0]!.finish(); await settled(manager, spawned.agent.id);
  assert.deepEqual(backends[0]!.calls, ['hold']);
});

test('scoped queue control may read self but cannot modify self or inspect another tree', async t => {
  const { manager } = fixture(t);
  const parent = manager.spawn({ task_name: 'parent', message: 'hello', max_depth: 1 }).agent;
  const other = manager.spawn({ task_name: 'other', message: 'hello' }).agent;
  await settled(manager, parent.id); await settled(manager, other.id);
  const tools = scopedTools(manager, parent.id);
  assert.equal(tools.manageQueue(parent.id, { action: 'list' }).agent_id, parent.id);
  assert.throws(() => tools.manageQueue(parent.id, { action: 'clear', expected_revision: manager.read(parent.id).agent.queue_revision }), /own descendants/);
  assert.throws(() => tools.manageQueue(other.id, { action: 'list' }), /own descendants/);
  assert.equal(tools.retryDelivery, undefined);
  assert.equal(tools.listDeliveries, undefined);
});

test('batch messages and followups preserve mailbox ordering and persisted sessions', async t => {
  const { manager, backends } = fixture(t);
  const one = manager.spawn({ task_name: 'one', message: 'hello' }).agent;
  const two = manager.spawn({ task_name: 'two', message: 'hello' }).agent;
  await settled(manager, one.id); await settled(manager, two.id);
  const sent = await manager.batchControl({ action: 'send_message', targets: [one.id, two.id], message: 'queued context' });
  assert.equal(sent.succeeded, 2);
  assert.equal(backends.length, 2, 'idle message batches do not wake workers');
  const continued = await manager.batchControl({ action: 'followup_task', targets: [one.id, two.id], message: 'continue' });
  assert.equal(continued.failed, 0);
  for (const agent of [one, two]) {
    const state = await settled(manager, agent.id);
    assert.equal(state.final_response, 'answer:continue');
    const runs = backends.filter(backend => backend.spec.id === agent.id);
    assert.deepEqual(runs.flatMap(backend => backend.calls), ['hello', 'queued context', 'continue']);
    assert.equal(runs[1]!.spec.resume, true);
    assert.equal(runs[1]!.spec.sessionId, agent.session_id);
  }
});

test('batch followup reports closed and capacity failures separately without queuing rejected work', async t => {
  const { manager } = fixture(t, { max_concurrent_agents: 1 });
  const closed = manager.spawn({ task_name: 'closed', message: 'hello' }).agent;
  await settled(manager, closed.id); await manager.interrupt(closed.id, true);
  const one = manager.spawn({ task_name: 'one', message: 'hello' }).agent;
  await settled(manager, one.id);
  const two = manager.spawn({ task_name: 'two', message: 'hello' }).agent;
  await settled(manager, two.id);
  const result = await manager.batchControl({ action: 'followup_task', targets: [closed.id, one.id, two.id], message: 'hold' });
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.results[0]!.error!.code, 'CLOSED');
  assert.equal(result.results[1]!.ok, true);
  assert.equal(result.results[2]!.error!.code, 'CAPACITY');
  assert.equal(manager.read(two.id).agent.queued_messages, 0);
  assert.equal(manager.read(two.id).agent.status, 'idle');
});

test('batch interrupt keeps mailboxes and prefix close selects the full tree with path boundaries', async t => {
  const { manager } = fixture(t);
  const parent = manager.spawn({ task_name: 'branch', message: 'hold', max_depth: 1 }).agent;
  const child = manager.spawn({ task_name: 'child', parent: parent.id, message: 'hold' }).agent;
  const other = manager.spawn({ task_name: 'branch_extra', message: 'hold' }).agent;
  await running(manager, parent.id); await running(manager, child.id); await running(manager, other.id);
  manager.sendMessage(child.id, 'retained until explicit continuation');
  const interrupted = await manager.batchControl({ action: 'interrupt_agent', targets: [parent.id, child.id] });
  assert.equal(interrupted.succeeded, 2);
  assert(interrupted.results.every(item => item.status === 'interrupted'));
  assert.equal(manager.read(child.id).agent.queued_messages, 1);
  const closed = await manager.batchControl({ action: 'close_agent', path_prefix: parent.path + '/' });
  assert.equal(closed.total, 2);
  assert(closed.results.every(item => item.status === 'closed'));
  assert.equal(manager.read(child.id).agent.queued_messages, 0);
  assert.equal(manager.read(other.id).agent.status, 'running');
});

test('batch stop continues after an unconfirmed worker exit and retains that capacity slot', async t => {
  const { manager, backends } = fixture(t);
  const one = manager.spawn({ task_name: 'one', message: 'hold' }).agent;
  const two = manager.spawn({ task_name: 'two', message: 'hold' }).agent;
  await running(manager, one.id); await running(manager, two.id);
  backends[0]!.closeFailures = 10;
  const result = await manager.batchControl({ action: 'close_agent', targets: [one.id, two.id] });
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0]!.error!.code, 'CLEANUP');
  assert.equal(result.results[1]!.status, 'closed');
  assert.equal(result.active_count, 1);
  assert(manager.read(one.id).agent.runtime_exit_unconfirmed);
  backends[0]!.closeFailures = 0;
  await manager.interrupt(one.id, true);
  assert.equal(manager.list().active_count, 0);
});

test('scoped batches authorize the entire selection and a caller prefix excludes the caller', async t => {
  const { manager } = fixture(t);
  const parent = manager.spawn({ task_name: 'parent', message: 'hello', max_depth: 1 }).agent;
  const other = manager.spawn({ task_name: 'other', message: 'hello' }).agent;
  await settled(manager, parent.id); await settled(manager, other.id);
  const tools = scopedTools(manager, parent.id);
  const child = tools.spawn({ task_name: 'child', message: 'hello' }).agent;
  await settled(manager, child.id);
  assert.equal(tools.setConcurrency, undefined);
  await assert.rejects(tools.batchControl({ action: 'close_agent', targets: [child.id, other.id] }), /own descendants/);
  await assert.rejects(tools.batchControl({ action: 'close_agent', targets: [parent.id] }), /own descendants/);
  await assert.rejects(tools.batchControl({ action: 'close_agent', path_prefix: '/root' }), /inside the calling agent/);
  assert.equal(manager.read(child.id).agent.status, 'idle', 'failed authorization must not partially close the valid target');
  const result = await tools.batchControl({ action: 'close_agent', path_prefix: parent.path });
  assert.equal(result.total, 1);
  assert.equal(result.results[0]!.target, child.id);
  assert.equal(manager.read(parent.id).agent.status, 'idle');
  assert.equal(manager.read(other.id).agent.status, 'idle');
});

test('dynamic concurrency grows immediately and lowering drains running workers without stopping them', async t => {
  const { manager, backends } = fixture(t, { max_concurrent_agents: 1 });
  const idle = manager.spawn({ task_name: 'idle', message: 'hello' }).agent;
  await settled(manager, idle.id);
  const one = manager.spawn({ task_name: 'one', message: 'hold' }).agent;
  await running(manager, one.id);
  assert.throws(() => manager.spawn({ task_name: 'two', message: 'hold' }), /slots are busy/);
  const up = manager.setConcurrency(2);
  assert.equal(up.previous_max_concurrent_agents, 1);
  assert.equal(up.available_slots, 1);
  const two = manager.spawn({ task_name: 'two', message: 'hold' }).agent;
  await running(manager, two.id);
  const down = manager.setConcurrency(1);
  assert.equal(down.active_count, 2);
  assert.equal(down.available_slots, 0);
  assert.equal(down.over_limit, 1);
  assert.equal(manager.read(one.id).agent.status, 'running');
  assert.equal(manager.read(two.id).agent.status, 'running');
  assert(backends.slice(1).every(backend => !backend.closed));
  assert.throws(() => manager.followup(idle.id, 'blocked'), /slots are busy/);
  assert.equal(manager.read(idle.id).agent.queued_messages, 0);
  manager.followup(two.id, 'already-running followup');
  assert.equal(manager.read(two.id).agent.queued_messages, 1);
  backends.find(backend => backend.spec.id === one.id)!.finish();
  await settled(manager, one.id);
  assert.throws(() => manager.followup(idle.id, 'still blocked'), /slots are busy/);
  backends.find(backend => backend.spec.id === two.id)!.finish();
  await settled(manager, two.id);
  manager.followup(idle.id, 'now allowed');
  assert.equal((await settled(manager, idle.id)).final_response, 'answer:now allowed');
  assert.equal(manager.list().max_concurrent_agents, 1);
  assert.equal(manager.list().over_limit, 0);
});

test('concurrency changes wake targeted waits with global events and idempotent updates keep the cursor', async t => {
  const { manager } = fixture(t);
  const agent = manager.spawn({ task_name: 'waiter', message: 'hold' }).agent;
  await running(manager, agent.id);
  const cursor = manager.list().cursor;
  const waiting = manager.wait({ targets: [agent.id], after_cursor: cursor, timeout_ms: 1000 });
  manager.setConcurrency(2);
  const update = await waiting;
  assert.equal(update.reason, 'update');
  assert.equal(update.max_concurrent_agents, 2);
  assert.equal(update.events.length, 1);
  assert.equal(update.events[0]!.type, 'concurrency_changed');
  assert.equal(update.events[0]!.agent_id, null);
  assert.equal(manager.setConcurrency(2).cursor, update.cursor);
  for (const value of [0, -1, 33, 1.5, NaN, Infinity]) assert.throws(() => manager.setConcurrency(value), /between 1 and 32/);
  assert.equal(manager.list().cursor, update.cursor);
});

test('concurrency overrides persist while an untouched old state still follows the config', async t => {
  const f = fixture(t, { max_concurrent_agents: 2 });
  await f.manager.shutdown();
  const statePath = join(f.config.data_dir, 'state.json');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).runtime_settings, undefined);
  const configured = new AgentManager({ ...f.config, max_concurrent_agents: 3 }, f.factory);
  f.managers.push(configured);
  assert.equal(configured.list().max_concurrent_agents, 3);
  configured.setConcurrency(5);
  await configured.shutdown();
  const resumed = new AgentManager({ ...f.config, max_concurrent_agents: 1 }, f.factory);
  f.managers.push(resumed);
  assert.equal(resumed.list().max_concurrent_agents, 5);
  assert.equal(resumed.list().active_count, 0);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).runtime_settings.max_concurrent_agents, 5);
  assert.equal((await resumed.wait({ after_cursor: 0, timeout_ms: 0 })).events[0]!.type, 'concurrency_changed');
});

test('turn timeout closes the process instead of only abandoning its promise', async t => {
  const { manager, backends } = fixture(t, { turn_timeout_ms: 25 });
  const { agent } = manager.spawn({ task_name: 'timeout', message: 'hold' });
  const result = await settled(manager, agent.id);
  assert.equal(result.agent.status, 'failed');
  assert.equal(result.agent.finish_reason, 'timeout');
  assert(backends[0]!.closed);
});

test('restart recovers interrupted state without executing work until followup', async t => {
  const f = fixture(t);
  const { agent } = f.manager.spawn({ task_name: 'recover', message: 'hold' });
  await running(f.manager, agent.id);
  await f.manager.shutdown();
  const path = join(f.config.data_dir, 'state.json');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.agents[0].status = 'running';
  writeFileSync(path, JSON.stringify(saved));
  const resumed = new AgentManager(f.config, f.factory);
  f.managers.push(resumed);
  assert.equal(resumed.read(agent.id).agent.status, 'interrupted');
  assert.equal(f.backends.length, 1);
  resumed.followup(agent.id, 'resume');
  assert.equal((await settled(resumed, agent.id)).agent.status, 'idle');
  assert.equal(f.backends[1]!.spec.sessionId, agent.session_id);
  assert.equal(f.backends[1]!.spec.resume, true);
});

test('cursor pagination, filtering, and retention gaps are explicit', async t => {
  const { manager } = fixture(t, { max_events: 10 });
  const first = manager.spawn({ task_name: 'first', message: 'hello' }).agent;
  await settled(manager, first.id);
  const second = manager.spawn({ task_name: 'second', message: 'hello' }).agent;
  await settled(manager, second.id);
  for (let i = 0; i < 12; i++) manager.sendMessage(first.id, 'mail ' + i);
  const page = await manager.wait({ after_cursor: 0, timeout_ms: 0, limit: 2, targets: [first.id] });
  assert(page.history_gap);
  assert(page.has_more);
  assert.equal(page.events.length, 2);
  const next = await manager.wait({ after_cursor: page.cursor, timeout_ms: 0 });
  assert(next.events.every(event => event.cursor > page.cursor));
  const empty = await manager.wait({ after_cursor: next.cursor, timeout_ms: 0 });
  assert.equal(empty.events.length, 0);
  assert.equal(empty.reason, 'settled');
});

test('cancelling a wait does not interrupt the agent', async t => {
  const { manager, backends } = fixture(t);
  const { agent } = manager.spawn({ task_name: 'waiter', message: 'hold' });
  await running(manager, agent.id);
  const controller = new AbortController();
  const wait = manager.wait({ after_cursor: manager.list().cursor, timeout_ms: 1000 }, controller.signal);
  controller.abort();
  await assert.rejects(wait, /Wait cancelled/);
  assert.equal(manager.read(agent.id).agent.status, 'running');
  assert.equal(backends[0]!.closed, false);
});

test('close discards the mailbox and makes the handle terminal', async t => {
  const { manager } = fixture(t);
  const { agent } = manager.spawn({ task_name: 'closed', message: 'hello' });
  await settled(manager, agent.id);
  manager.sendMessage(agent.id, 'mail');
  await manager.interrupt(agent.id, true);
  assert.equal(manager.read(agent.id).agent.queued_messages, 0);
  assert.equal(manager.read(agent.id).final_response, 'answer:hello');
  assert.throws(() => manager.followup(agent.id, 'again'), /closed/);
});

test('registry locking and corrupt state fail without discarding saved data', async t => {
  const f = fixture(t);
  assert.throws(() => new AgentManager(f.config, f.factory), /already owned/);
  await f.manager.shutdown();
  const path = join(f.config.data_dir, 'state.json');
  writeFileSync(path, '{bad');
  assert.throws(() => new AgentManager(f.config, f.factory));
  assert.equal(readFileSync(path, 'utf8'), '{bad');
});

test('messages accepted during runtime teardown still execute before the agent becomes idle', async t => {
  const { manager, backends } = fixture(t);
  const { agent } = manager.spawn({ task_name: 'teardown', message: 'hold' });
  await running(manager, agent.id);
  const originalClose = backends[0]!.close.bind(backends[0]);
  let enterClose!: () => void;
  const entered = new Promise<void>(resolve => { enterClose = resolve; });
  let releaseClose!: () => void;
  const released = new Promise<void>(resolve => { releaseClose = resolve; });
  backends[0]!.close = async () => { enterClose(); await released; await originalClose(); };
  backends[0]!.finish();
  await entered;
  assert.equal(manager.sendMessage(agent.id, 'arrived during teardown').delivery, 'next_turn');
  releaseClose();
  const result = await settled(manager, agent.id);
  assert.equal(result.final_response, 'answer:arrived during teardown');
  assert.equal(result.agent.queued_messages, 0);
  assert.equal(backends[1]!.spec.resume, true);
});

test('a proven dead owner is recovered without discarding the registry', async t => {
  const f = fixture(t);
  await f.manager.shutdown();
  const lock = join(f.config.data_dir, 'server.lock');
  writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: 'stale' }));
  const recovered = new AgentManager(f.config, f.factory);
  f.managers.push(recovered);
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid);
  assert.equal(JSON.parse(readFileSync(join(f.config.data_dir, 'last-recovery.json'), 'utf8')).previous_owner.token, 'stale');
});

test('workspace validation rejects lexical traversal and junction escapes', t => {
  const { config, directory } = fixture(t);
  assert.throws(() => agentDirectory(config, '..'), /workspace_root/);
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(config.workspace_root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => agentDirectory(config, 'escape'), /workspace_root/);
});

test('child environment and diagnostics omit unrelated credentials', t => {
  const { config } = fixture(t);
  const name = 'DSH_TEST_UNRELATED_SECRET';
  const old = process.env[name];
  process.env[name] = 'test-private-secret-321';
  try {
    assert.equal(childEnvironment(config)[name], undefined);
    assert.equal(errorText(new Error('failure ' + process.env[name])), 'failure [redacted]');
    assert.equal(childEnvironment(config).DSH_PERMISSION_MODE, 'workspace-write');
  } finally {
    if (old === undefined) delete process.env[name]; else process.env[name] = old;
  }
});

test('task paths disambiguate siblings with the same short name', async t => {
  const { manager } = fixture(t);
  const one = manager.spawn({ task_name: 'one', message: 'first', max_depth: 1 }).agent;
  const two = manager.spawn({ task_name: 'two', message: 'second', max_depth: 1 }).agent;
  await settled(manager, one.id);
  await settled(manager, two.id);
  manager.spawn({ task_name: 'child', parent: one.id, message: 'A' });
  manager.spawn({ task_name: 'child', parent: two.id, message: 'B' });
  assert.throws(() => manager.read('child'), /ambiguous/);
  assert.equal(manager.list('/root/one').agents.length, 2);
  assert.equal(manager.read('/root/one/child').agent.parent_id, one.id);
});
