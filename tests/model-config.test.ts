import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CredentialRegistry } from '../src/credentials.ts';
import { ModelRegistry } from '../src/model-config.ts';
import { probeRequest, probeModel } from '../src/model-probe.ts';
import type { ApiProtocol, ApiEntry } from '../src/credential-contract.ts';

async function setup(protocol: ApiProtocol = 'openai_responses') {
  const root = resolve('.test-output/model-config'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'case-'));
  const credentials = new CredentialRegistry(join(dir, 'keys.json'), { async available() { return true; },
    async encrypt(value) { return Buffer.from(value); }, async decrypt(value) { return value.toString(); } });
  const apis = await credentials.add({ name: 'First', protocol, base_url: 'https://api.example.test/v1', api_key: 'synthetic-test-key', expected_revision: 0 });
  const calls: any[] = [];
  const path = join(dir, 'models.json');
  const registry = new ModelRegistry(path, credentials, (async (url, options) => {
    calls.push({ url, options });
    return Response.json({ object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: { input_tokens: 3, output_tokens: 16 } });
  }) as typeof fetch);
  const draft = { api_id: apis.entries[0]!.id, model_id: 'test-model', reasoning_levels: ['high', 'low'] };
  return { credentials, registry, draft, calls, path, api: apis.entries[0]! };
}

test('save and prepare do not invoke APIs; confirmation is one-use and preserves first declared effort', async () => {
  const { registry, draft, calls } = await setup();
  const plan = await registry.prepare({ draft, expected_revision: 0 }); assert.equal(plan.reasoning, 'high'); assert.equal(calls.length, 0);
  const result = await registry.confirm(plan.token);
  assert.equal(result.receipt.status, 'verified'); assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).reasoning.effort, 'high');
  assert.equal(JSON.parse(calls[0].options.body).input, '.');
  assert.equal(JSON.parse(calls[0].options.body).max_output_tokens, 16);
  assert.equal(calls[0].options.redirect, 'error');
  assert(!JSON.stringify(result).includes('synthetic-test-key'));
  await assert.rejects(registry.confirm(plan.token), /Confirmation/); assert.equal(calls.length, 1);
  const saved = await registry.save({ draft: { ...draft, model_id: 'saved-without-call' }, expected_revision: result.snapshot.revision });
  assert.equal(saved.entries[1]!.verified, false); assert.equal(saved.entries[1]!.enabled, false); assert.equal(calls.length, 1);
});

test('exact ID exclusion is enforced by the store and re-enabled after unchecking', async () => {
  const { registry, credentials, draft } = await setup();
  const other = await credentials.add({ name: 'Second', protocol: 'openai_chat', base_url: 'https://example.test/v1', api_key: 'dummy', expected_revision: 1 });
  let snapshot = await registry.save({ draft, expected_revision: 0 });
  snapshot = await registry.save({ draft: { ...draft, api_id: other.entries[1]!.id }, expected_revision: snapshot.revision });
  const [first, second] = snapshot.entries;
  snapshot = await registry.toggle({ id: first!.id, enabled: true, expected_revision: snapshot.revision });
  await assert.rejects(registry.toggle({ id: second!.id, enabled: true, expected_revision: snapshot.revision }), /already enabled/);
  snapshot = await registry.toggle({ id: first!.id, enabled: false, expected_revision: snapshot.revision });
  snapshot = await registry.toggle({ id: second!.id, enabled: true, expected_revision: snapshot.revision });
  assert.equal(snapshot.entries.filter(item => item.effective_enabled).length, 1);
  await assert.rejects(registry.save({ draft, expected_revision: snapshot.revision }), /already exists/);
  snapshot = await registry.remove({ id: second!.id, expected_revision: snapshot.revision }); assert.equal(snapshot.entries.length, 1);
});

test('source renaming is reflected, endpoint changes invalidate enablement and pending consent', async () => {
  const { registry, credentials, draft, api, calls } = await setup();
  const plan = await registry.prepare({ draft, expected_revision: 0 });
  await credentials.update({ id: api.id, name: 'Renamed', protocol: api.protocol, base_url: 'https://other.test/v1', expected_revision: 1 });
  await assert.rejects(registry.confirm(plan.token), /Endpoint changed/); assert.equal(calls.length, 0);
  let saved = await registry.save({ draft, expected_revision: 0 });
  assert.equal(saved.entries[0]!.api_name, 'Renamed');
  saved = await registry.toggle({ id: saved.entries[0]!.id, enabled: true, expected_revision: saved.revision });
  await credentials.remove({ id: api.id, expected_revision: 2 });
  assert.equal((await registry.list()).entries[0]!.effective_enabled, false);
  await assert.rejects(registry.toggle({ id: saved.entries[0]!.id, enabled: true, expected_revision: saved.revision }), /Source API/);
});

test('cancellation, undeclared levels and stale changes never dispatch validation', async () => {
  const { registry, draft, calls } = await setup();
  await assert.rejects(registry.save({ draft: { ...draft, reasoning_levels: null }, expected_revision: 0 }), /Declare/);
  const plan = await registry.prepare({ draft, expected_revision: 0 }); registry.cancel(plan.token);
  await assert.rejects(registry.confirm(plan.token), /Confirmation/);
  const next = await registry.prepare({ draft, expected_revision: 0 });
  await registry.save({ draft: { ...draft, model_id: 'other' }, expected_revision: 0 });
  await assert.rejects(registry.confirm(next.token), /configuration changed/); assert.equal(calls.length, 0);
  const deepseek = await setup('deepseek');
  const saved = await deepseek.registry.save({ draft: { ...deepseek.draft, reasoning_levels: null }, expected_revision: 0 });
  assert.deepEqual(saved.entries[0]!.reasoning_levels, ['none', 'low', 'high', 'max']);
});

test('probe protocol payloads use their small output caps and first effort without reordering', async () => {
  for (const protocol of ['deepseek', 'openai_chat', 'openai_responses', 'anthropic'] as const) {
    const api: ApiEntry = { id: randomUUID(), name: 'Test', protocol, base_url: 'https://example.test/v1', created_at: '', updated_at: '' };
    const draft = { api_id: api.id, model_id: 'model', reasoning_levels: ['high', 'none'] };
    const request = probeRequest(api, draft);
    assert.equal(request.output_limit, protocol === 'openai_responses' ? 16 : protocol === 'anthropic' ? 0 : 1);
    assert.equal(request.reasoning, protocol === 'deepseek' ? 'none' : 'high');
    let calls = 0;
    const failed = await probeModel(api, draft, 'secret', undefined, (async (_url, options) => { calls++; assert.equal(options?.redirect, 'error'); return new Response('secret should not be surfaced', { status: 400 }); }) as typeof fetch);
    assert.equal(failed.status, 'failed'); assert.equal(calls, 1); assert(!JSON.stringify(failed).includes('secret'));
    const unknown = await probeModel(api, draft, 'secret', undefined, (async () => { throw new Error('timeout secret'); }) as typeof fetch);
    assert.equal(unknown.status, 'unknown'); assert.equal(unknown.output_tokens, null);
  }
});

test('incomplete persisted attempts become unknown after restart, not free or verified', async () => {
  const { registry, path, draft } = await setup();
  await registry.save({ draft, expected_revision: 0 });
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.attempts.push({ id: randomUUID(), api_id: draft.api_id, model_id: draft.model_id, status: 'pending', started_at: new Date().toISOString(), finished_at: null,
    input_tokens: null, output_tokens: null, error_code: null, http_status: null });
  writeFileSync(path, JSON.stringify(saved));
  assert.equal((await registry.list()).attempts[0]!.status, 'unknown');
});
