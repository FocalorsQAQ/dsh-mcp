import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../src/store.ts';

function directory() {
  const root = resolve('.test-output/store'); mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'case-'));
}
async function owner(t: TestContext, dir: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/store-owner.ts', import.meta.url)), [dir], {
    execArgv: ['--experimental-transform-types'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.stderr?.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    }
  });
  await once(child, 'message', { signal: AbortSignal.timeout(10000) });
  return child;
}
async function acquire(child: ChildProcess): Promise<{ acquired: boolean; code?: string }> {
  const reply = once(child, 'message', { signal: AbortSignal.timeout(10000) });
  child.send('acquire'); return (await reply)[0];
}

test('force-killed owner recovers automatically and concurrent contenders elect exactly one writer', async t => {
  const dir = directory(), original = await owner(t, dir);
  assert.equal((await acquire(original)).acquired, true);
  const oldLock = readFileSync(join(dir, 'server.lock'), 'utf8');
  const exit = once(original, 'exit'); original.kill('SIGKILL'); await exit;
  const contenders = await Promise.all([owner(t, dir), owner(t, dir)]);
  const results = await Promise.all(contenders.map(acquire));
  assert.equal(results.filter(result => result.acquired).length, 1);
  assert.equal(results.find(result => !result.acquired)!.code, 'LOCKED');
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).cursor, 7);
  assert.equal(JSON.parse(readFileSync(join(dir, 'last-recovery.json'), 'utf8')).previous_owner.token, JSON.parse(oldLock).token);
});

test('live owners are never reclaimed and reused process IDs are distinguished by creation time', t => {
  const dir = directory(); const first = new StateStore(dir);
  const path = join(dir, 'server.lock'), old = JSON.parse(readFileSync(path, 'utf8'));
  assert.throws(() => new StateStore(dir), { code: 'LOCKED' });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, old.token);
  first.close();
  if (old.process_identity === 'alive') return; // conservative fallback has no reuse detection
  old.process_identity = old.process_identity.replace(/\d+$/, (n: string) => String(BigInt(n) + 1n));
  writeFileSync(path, JSON.stringify(old));
  const replacement = new StateStore(dir); t.after(() => replacement.close());
  assert.notEqual(JSON.parse(readFileSync(path, 'utf8')).token, old.token);
});

test('recovery removes only owned temporary files and the dead hosts UI endpoint', t => {
  const dir = directory(), token = randomUUID();
  writeFileSync(join(dir, 'server.lock'), JSON.stringify({ pid: 2147483647, token: 'legacy' }));
  writeFileSync(join(dir, 'ui-endpoint.json'), JSON.stringify({ pid: 2147483647, token: 'test-only' }));
  const leftover = join(dir, 'state.json.' + token + '.tmp'); writeFileSync(leftover, 'partial');
  writeFileSync(join(dir, 'notes.tmp'), 'keep');
  mkdirSync(join(dir, 'sessions')); writeFileSync(join(dir, 'sessions', 'history.json'), 'keep');
  const store = new StateStore(dir); t.after(() => store.close());
  assert.equal(existsSync(leftover), false); assert.equal(existsSync(join(dir, 'ui-endpoint.json')), false);
  assert.equal(readFileSync(join(dir, 'notes.tmp'), 'utf8'), 'keep');
  assert.equal(readFileSync(join(dir, 'sessions', 'history.json'), 'utf8'), 'keep');
  assert(existsSync(join(dir, '.server.lock.guard')), 'stable OS guard is never unlinked');
});

test('corrupt ownership is preserved for inspection, rather than guessed away', () => {
  const dir = directory(), lock = join(dir, 'server.lock'); writeFileSync(lock, '{broken');
  assert.throws(() => new StateStore(dir), { code: 'LOCKED' });
  assert.equal(readFileSync(lock, 'utf8'), '{broken');
});

test('failed state writes preserve the last committed state and remove partial temporary files', t => {
  const dir = directory(), store = new StateStore(dir); t.after(() => store.close());
  store.write({ version: 1, cursor: 7, agents: [], events: [], deliveries: [] });
  const invalid: any = {}; invalid.circular = invalid;
  assert.throws(() => store.write(invalid), /circular/i);
  assert.equal(store.read().cursor, 7);
  const token = JSON.parse(readFileSync(join(dir, 'server.lock'), 'utf8')).token;
  assert.equal(existsSync(join(dir, 'state.json.' + token + '.tmp')), false);
});
