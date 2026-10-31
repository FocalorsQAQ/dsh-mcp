import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CredentialRegistry, type CredentialCipher } from '../src/credentials.ts';

const cipher: CredentialCipher = { async available() { return true; }, async encrypt() { return randomBytes(64); } };
function setup(encryption = cipher) {
  const root = resolve('.test-output/credentials'); mkdirSync(root, { recursive: true });
  const path = join(mkdtempSync(join(root, 'case-')), 'credentials.json');
  return { path, registry: new CredentialRegistry(path, encryption) };
}
const input = { name: ' Test API ', protocol: 'deepseek', base_url: 'https://untrusted.example', api_key: 'dummy-test-key', expected_revision: 0 };

test('metadata-only API contract persists ciphertext and canonical DeepSeek URL', async () => {
  const { registry, path } = setup();
  const result = await registry.add(input), entry = result.entries[0]!;
  assert.equal(entry.name, 'Test API'); assert.equal(entry.base_url, 'https://api.deepseek.com');
  assert(!JSON.stringify(result).includes(input.api_key));
  assert(!JSON.stringify(result).includes('secret_ciphertext'));
  assert(!readFileSync(path, 'utf8').includes(input.api_key));
  assert.deepEqual(await new CredentialRegistry(path, cipher).list(), result);
  assert.equal('decrypt' in registry, false);
});

test('rename and all protocol changes preserve the encrypted key, delete removes it', async () => {
  const { registry, path } = setup(); let result = await registry.add(input);
  const entry = result.entries[0]!;
  const ciphertext = JSON.parse(readFileSync(path, 'utf8')).entries[0].secret_ciphertext;
  for (const protocol of ['openai_chat', 'openai_responses', 'anthropic', 'deepseek']) {
    result = await registry.update({ id: entry.id, name: 'Renamed', protocol, base_url: 'https://api.example/v1/', expected_revision: result.revision });
    assert.equal(result.entries[0]!.protocol, protocol);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).entries[0].secret_ciphertext, ciphertext);
  }
  await assert.rejects(registry.update({ ...result.entries[0], api_key: 'replacement', expected_revision: result.revision }));
  result = await registry.remove({ id: entry.id, expected_revision: result.revision });
  assert.deepEqual(result.entries, []); assert(!readFileSync(path, 'utf8').includes(ciphertext));
});

test('stale revisions and concurrent adds cannot silently overwrite configuration', async () => {
  const { registry } = setup();
  const results = await Promise.allSettled([registry.add(input), registry.add({ ...input, name: 'second' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const snapshot = await registry.list(); assert.equal(snapshot.entries.length, 1);
  await assert.rejects(registry.remove({ id: snapshot.entries[0]!.id, expected_revision: 0 }), /changed/);
});

test('invalid endpoints and blank credentials are rejected without saving anything', async () => {
  const { registry, path } = setup();
  for (const base_url of ['file:///tmp/key', 'http://remote.example', 'https://user:pass@example.com', 'https://example.com?key=secret', 'https://example.com/#key']) {
    await assert.rejects(registry.add({ ...input, protocol: 'anthropic', base_url }));
  }
  await assert.rejects(registry.add({ ...input, api_key: '   ' }));
  assert(!existsSync(path));
  assert.equal((await registry.add({ ...input, protocol: 'openai_chat', base_url: 'http://127.0.0.1:8080/v1' })).entries.length, 1);
});

test('encryption unavailable and corrupt files fail closed without plaintext fallback', async () => {
  const first = setup({ async available() { return false; }, async encrypt() { throw new Error('must not run'); } });
  assert.equal((await first.registry.list()).encryption_available, false);
  await assert.rejects(first.registry.add(input), /unavailable/); assert(!existsSync(first.path));
  const second = setup(); writeFileSync(second.path, '{broken');
  await assert.rejects(second.registry.add(input), /could not be read/);
  assert.equal(readFileSync(second.path, 'utf8'), '{broken');
});
