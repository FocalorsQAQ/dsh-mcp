import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { parseCodexRollout, readCodexContext } from '../src/codex-context.ts';
const id = '00000000-0000-4000-8000-000000000001';
const workspace = resolve('.');
const row = (type: string, payload: object) => JSON.stringify({ type, payload }) + '\n';
const meta = row('session_meta', { id, cwd: workspace, cli_version: 'fixture' });

test('rollout reader exports visible history and paired tools once, excluding private and duplicate UI records', () => {
  const data = meta + row('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'PRIVATE_INSTRUCTIONS' }] }) +
    row('response_item', { type: 'reasoning', encrypted_content: 'PRIVATE_REASONING' }) +
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'TASK' }] }) +
    row('event_msg', { type: 'item_completed', item: { text: 'DUPLICATE_UI' } }) +
    row('response_item', { type: 'function_call', call_id: 'a', name: 'read', arguments: '{}' }) +
    row('response_item', { type: 'function_call_output', call_id: 'a', output: 'TOOL_RESULT' }) +
    row('response_item', { type: 'custom_tool_call', call_id: 'pending', name: 'exec', input: 'UNFINISHED' }) +
    row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ANSWER' }] }) +
    row('compacted', { message: 'summary' }) + '{"partial';
  const result = parseCodexRollout(data, id, workspace);
  assert.equal(result.messages.length, 4);
  assert.equal(result.compactions, 1);
  const serialized = JSON.stringify(result);
  for (const excluded of ['PRIVATE_INSTRUCTIONS', 'PRIVATE_REASONING', 'DUPLICATE_UI', 'UNFINISHED']) assert(!serialized.includes(excluded));
  assert(serialized.includes('TOOL_RESULT'));
  assert.equal(result.history_kind, 'visible_archive');
});

test('rollout reader refuses mismatched identity, workspace, and malformed committed records', () => {
  assert.throws(() => parseCodexRollout(meta, 'other', workspace), /thread ID/);
  assert.throws(() => parseCodexRollout(meta, id, resolve('src')), /workspace/);
  assert.throws(() => parseCodexRollout(meta + '{bad}\n', id, workspace), /Invalid committed/);
});

test('file lookup uses exact UUID and preserves a bounded snapshot of a live JSONL file', t => {
  const root = resolve('.test-output', 'codex-reader');
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, 'case-'));
  t.after(() => { const rel = relative(root, home); assert(!isAbsolute(rel) && !rel.startsWith('..')); rmSync(home, { recursive: true }); });
  const date = join(home, 'sessions', '2026', '10', '30');
  mkdirSync(date, { recursive: true });
  writeFileSync(join(date, 'rollout-date-' + id + '.jsonl'), meta + row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SOURCE_MARKER' }] }));
  const options = { threadId: id, codexHome: home, workspace, maxChars: 10000 };
  assert(readCodexContext(options).context.includes('SOURCE_MARKER'));
  assert.throws(() => readCodexContext({ ...options, maxChars: 10 }), /exceeds/);
  assert.throws(() => readCodexContext({ ...options, threadId: '../escape' }), /UUID/);
});
