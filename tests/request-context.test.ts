import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestSessionId } from '../src/request-context.ts';

const a = '10000000-0000-4000-8000-000000000001', b = '20000000-0000-4000-8000-000000000002';
test('Codex request metadata supports direct and serialized host identities', () => {
  assert.equal(requestSessionId({ threadId: a, progressToken: 1 }), a);
  assert.equal(requestSessionId({ thread_id: a, threadId: a }), a);
  assert.equal(requestSessionId({ 'x-codex-turn-metadata': JSON.stringify({ threadId: a, turnId: 'turn' }) }), a);
  assert.equal(requestSessionId({ 'x-codex-turn-metadata': { thread_id: a } }), a);
  assert.equal(requestSessionId(undefined), undefined);
  assert.equal(requestSessionId({ progressToken: 1 }), undefined);
});
test('invalid and conflicting identities fail closed instead of choosing another chat', () => {
  for (const meta of [{ threadId: a, thread_id: b }, { threadId: a, 'x-codex-turn-metadata': { threadId: b } },
    { threadId: '../outside' }, { thread_id: null }, { 'x-codex-turn-metadata': '{broken' }]) {
    assert.throws(() => requestSessionId(meta), /metadata|identit|UUID/);
  }
});
