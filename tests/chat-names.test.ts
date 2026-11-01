import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readChatNames } from '../src/chat-names.ts';
const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
test('chat labels use exact IDs and the latest committed title, never messages or another chat', () => {
  const root = resolve('.test-output/chat-names'); mkdirSync(root, { recursive: true }); const dir = mkdtempSync(join(root, 'case-'));
  assert.equal(readChatNames([A], dir).size, 0);
  const row = (id: string, name: string, date: string) => JSON.stringify({ id, thread_name: name, updated_at: date }) + '\n';
  const index = row(A, '旧名称', '2026-10-30T00:00:00Z') + row(A, '新的聊天名称\n', '2026-10-31T00:00:00Z') +
    row(B, '不应泄露的其他名称', '2026-11-01T00:00:00Z') + 'bad committed row\n' + row(A, '更旧的名称', '2026-10-29T00:00:00Z');
  writeFileSync(join(dir, 'session_index.jsonl'), index + row(A, '未提交', '2026-11-01T00:00:00Z').trim());
  assert.deepEqual([...readChatNames([A, '../invalid'], dir)], [[A, '新的聊天名称']]);
  writeFileSync(join(dir, 'session_index.jsonl'), row(A, '再次改名', '2026-11-02T00:00:00Z'));
  assert.equal(readChatNames([A], dir).get(A), '再次改名');
});
