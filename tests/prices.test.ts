import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PriceCatalog, defaultPriceDirectory } from '../src/prices.ts';
import { ModelCatalog } from '../src/models.ts';
import { ControlPlane } from '../src/control-plane.ts';
import { policySchema } from '../src/control-contract.ts';

const peak = Date.parse('2026-10-26T02:00:00Z');
function fixture() {
  const root = resolve('.test-output/prices'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'case-'));
  for (const file of ['prices.json', 'openai-prices.json']) copyFileSync(join(defaultPriceDirectory, file), join(dir, file));
  const path = join(dir, 'prices.json');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const catalog = new ModelCatalog(new PriceCatalog(dir));
  const control = new ControlPlane(policySchema.parse({ billing_currency: 'CNY', task_budget: [5, 20] }), undefined, () => {}, () => peak, undefined, catalog);
  return { dir, path, data, catalog, control };
}

test('saved price changes apply to new reservations while in-flight settlement keeps its original quote', () => {
  const { path, data, control } = fixture();
  const first = control.reserve('a', control.currentRound, 'deepseek-flash', 10);
  const original = control.exportState().requests[0]!;
  data.flash.CNY = [4, 0.08, 16]; writeFileSync(path, JSON.stringify(data));
  const second = control.reserve('a', control.currentRound, 'deepseek-flash', 10);
  assert.deepEqual(control.exportState().requests[0]!.rates, original.rates);
  assert.deepEqual(control.exportState().requests[1]!.rates, [4, 0.08, 16]);
  const usage = { input_cache_miss: 1000, input_cache_hit: 0, output: 0 };
  control.settle(first.id, usage, 'complete'); control.settle(second.id, usage, 'complete');
  assert.deepEqual(control.exportState().requests.map(item => item.cost_nano), [[0, 2000000], [0, 4000000]]);
});

test('invalid price edits block only their provider, keep UI snapshots available and recover without restart', () => {
  const { path, data, catalog, control } = fixture();
  writeFileSync(path, '{');
  assert.throws(() => control.reserve('a', control.currentRound, 'deepseek-flash', 10), { code: 'PRICING_INVALID' });
  assert.equal(control.exportState().requests.length, 0);
  assert.equal(control.snapshot().pricing.catalog.files[0]!.valid, false);
  assert(catalog.get('gpt-5-mini')!.pricing);
  writeFileSync(path, JSON.stringify(data));
  assert(control.reserve('a', control.currentRound, 'deepseek-flash', 10).id);
});

test('schema rejects malformed dates, negative rates, missing columns and unknown fields', () => {
  const { path, data, catalog } = fixture();
  const mutations = [
    { ...data, verified_at: '2026-99-99' }, { ...data, valid_until: '2026-01-01T00:00:00Z' },
    { ...data, flash: { ...data.flash, USD: [-1, 0, 1] } },
    { ...data, flash: { ...data.flash, CNY: [1, 2] } }, { ...data, typo: 1 },
  ];
  for (const value of mutations) {
    writeFileSync(path, JSON.stringify(value));
    assert.equal(catalog.pricingStatus().files[0]!.valid, false);
    assert.equal(catalog.get('deepseek-flash')!.pricing, null);
  }
});

test('valid but expired prices remain blocked until the reviewed expiry is updated', () => {
  const { path, data, control } = fixture();
  data.verified_at = '2026-10-01'; data.valid_until = '2026-10-02T08:00:00+08:00';
  writeFileSync(path, JSON.stringify(data));
  assert.throws(() => control.reserve('a', control.currentRound, 'deepseek-flash', 10), { code: 'PRICING_EXPIRED' });
  data.valid_until = '2026-11-07T00:00:00Z'; writeFileSync(path, JSON.stringify(data));
  assert(control.reserve('a', control.currentRound, 'deepseek-flash', 10).id);
});

test('hot reload cannot restore prices for unknown models or unreviewed increased capacities', async () => {
  const { path, data, catalog } = fixture();
  await catalog.refresh({ apiKey: 'local-test', fetch: async () => new Response(JSON.stringify({ data: [
    { id: 'deepseek-flash', context_window: 9_000_000 }, { id: 'unknown', context_window: 100 },
  ] })) });
  data.flash.CNY = [4, 0.08, 16]; writeFileSync(path, JSON.stringify(data));
  assert.equal(catalog.get('deepseek-flash')!.pricing, null);
  assert.equal(catalog.get('unknown')!.pricing, null);
});

test('unreadable pricing does not prevent model catalog construction or hide available effort levels', () => {
  const catalog = new ModelCatalog(new PriceCatalog(resolve('.test-output/absent-price-directory')));
  assert(catalog.get('deepseek-flash')!.effort_levels.length);
  assert(catalog.pricingStatus().files.every(file => !file.valid));
});
