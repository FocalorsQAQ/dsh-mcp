import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestPricePeriod } from '../src/pricing-time.ts';
import { ControlPlane } from '../src/control-plane.ts';
import { policySchema } from '../src/control-contract.ts';

const at = (time: string) => requestPricePeriod(time, time);
const model = 'deepseek-v4-flash';
const usage = { input_cache_miss: 1000, input_cache_hit: 2000, output: 100 };

test('Beijing peak intervals use inclusive starts and exclusive ends independently of machine timezone', () => {
  for (const time of ['09:00:00', '11:59:59.999', '14:00:00', '17:59:59.999']) {
    assert.equal(at('2026-10-26T' + time + '+08:00'), 'peak', time);
  }
  for (const time of ['00:00:00', '08:59:59.999', '12:00:00', '13:59:59.999', '18:00:00', '23:59:59.999']) {
    assert.equal(at('2026-10-26T' + time + '+08:00'), 'off_peak', time);
  }
  assert.equal(at('2026-10-26T01:00:00Z'), 'peak');
});

test('summer and winter offsets, UTC and Beijing timestamps identify the same tariff', () => {
  assert.equal(at('2026-10-26T21:30:00-04:00'), at('2026-10-27T09:30:00+08:00'));
  assert.equal(at('2026-11-02T20:30:00-05:00'), at('2026-11-03T09:30:00+08:00'));
  assert.equal(at('2026-11-02T20:30:00-05:00'), 'peak');
  // The two distinct instants in New York's repeated fall-back hour are both Sunday off-peak.
  assert.equal(at('2026-11-01T01:30:00-04:00'), 'off_peak');
  assert.equal(at('2026-11-01T01:30:00-05:00'), 'off_peak');
  assert.equal(requestPricePeriod(new Date('2026-10-26T01:00:00Z'), Date.parse('2026-10-26T01:01:00Z')), 'peak');
});

test('weekends and Chinese public holiday periods are off-peak, including weekend make-up work days', () => {
  for (const date of ['2026-01-01', '2026-02-17', '2026-04-06', '2026-05-01', '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-31']) {
    assert.equal(at(date + 'T10:00:00+08:00'), 'off_peak', date);
  }
  assert.equal(at('2026-10-10T10:00:00+08:00'), 'off_peak', 'Saturday make-up work does not override provider weekend pricing');
  assert.equal(at('2026-10-08T10:00:00+08:00'), 'peak');
  assert.equal(at('2026-10-04T21:30:00-04:00'), 'off_peak', 'holiday date follows Beijing, not the caller date');
});

test('cross-boundary calls use a conservative classification, even with two off-peak endpoints', () => {
  assert.equal(requestPricePeriod('2026-10-26T08:59:00+08:00', '2026-10-26T09:01:00+08:00'), 'mixed');
  assert.equal(requestPricePeriod('2026-10-26T11:59:00+08:00', '2026-10-26T12:01:00+08:00'), 'mixed');
  assert.equal(requestPricePeriod('2026-10-26T12:30:00+08:00', '2026-10-26T18:30:00+08:00'), 'mixed');
  assert.equal(requestPricePeriod('2026-10-30T19:00:00+08:00', '2026-11-02T08:00:00+08:00'), 'off_peak');
  assert.equal(requestPricePeriod('2026-10-30T17:00:00+08:00', '2026-11-02T08:00:00+08:00'), 'mixed');
});

test('ambiguous local dates, clock reversal and missing calendar years cannot obtain a discount', () => {
  assert.equal(at('2026-10-26T08:00:00'), 'unknown');
  assert.equal(at('not-a-date'), 'unknown');
  assert.equal(at('2027-01-01T10:00:00+08:00'), 'unknown');
  assert.equal(requestPricePeriod('2026-10-26T02:00:00Z', '2026-10-26T01:59:59Z'), 'unknown');
  assert.equal(requestPricePeriod(NaN, 0), 'unknown');
  assert.equal(requestPricePeriod(0, Infinity), 'unknown');
});

test('off-peak settlement halves both currency rates while reservations retain peak coverage', () => {
  for (const currency of ['USD', 'CNY'] as const) {
    const index = currency === 'USD' ? 0 : 1;
    let now = Date.parse('2026-10-26T01:00:00Z');
    const c = new ControlPlane(policySchema.parse({ billing_currency: currency }), undefined, () => {}, () => now);
    const peak = c.reserve('a', c.currentRound, model, 100);
    const peakReservation = c.snapshot().metrics.reserved_cost[index];
    c.settle(peak.id, usage, 'complete');
    const peakCost = c.snapshot().metrics.last_api_cost[index];
    assert.equal(c.snapshot().metrics.last_api_price_period, 'peak');
    now = Date.parse('2026-10-26T04:30:00Z');
    const off = c.reserve('a', c.currentRound, model, 100);
    assert.equal(c.snapshot().metrics.reserved_cost[index], peakReservation);
    c.settle(off.id, usage, 'complete');
    assert.equal(c.snapshot().metrics.last_api_cost[index], peakCost / 2);
    assert.equal(c.snapshot().metrics.last_api_price_period, 'off_peak');
    assert.equal(c.snapshot().metrics.last_api_cost_basis, 'time_of_use_estimate');
    assert.equal(c.snapshot().metrics.last_api_cost[1 - index], 0);
    assert.equal(c.exportState().task_spent_nano[index], Math.round(peakCost * 1e9) * 1.5);
    assert.deepEqual(c.snapshot().metrics.reserved_cost, [0, 0]);
  }
});

test('mixed intervals and missing usage keep conservative charges and persist their basis', () => {
  let now = Date.parse('2026-10-26T00:59:00Z');
  const c = new ControlPlane(policySchema.parse({}), undefined, () => {}, () => now);
  const mixed = c.reserve('a', c.currentRound, model, 100);
  now = Date.parse('2026-10-26T01:01:00Z'); c.settle(mixed.id, usage, 'complete');
  assert.equal(c.snapshot().metrics.last_api_price_period, 'mixed');
  assert.equal(c.snapshot().metrics.last_api_cost_basis, 'peak_upper_bound');
  assert.deepEqual(c.snapshot().metrics.last_api_cost, [0.000432, 0]);
  now = Date.parse('2026-10-26T04:30:00Z');
  const unknown = c.reserve('a', c.currentRound, model, 100);
  const held = c.snapshot().metrics.reserved_cost;
  c.settle(unknown.id, null, 'unknown');
  assert.deepEqual(c.snapshot().metrics.last_api_cost, held);
  assert.equal(c.snapshot().metrics.last_api_cost_basis, 'peak_upper_bound');
  const restored = new ControlPlane(policySchema.parse({}), c.exportState(), () => {}, () => now);
  assert.deepEqual(restored.snapshot().metrics, c.snapshot().metrics);
});

test('legacy records keep previous charges and do not gain retroactive off-peak refunds', () => {
  const now = Date.parse('2026-10-26T04:30:00Z');
  const c = new ControlPlane(policySchema.parse({}), undefined, () => {}, () => now);
  const r = c.reserve('a', c.currentRound, model, 100);
  const saved = JSON.parse(JSON.stringify(c.exportState()));
  for (const item of saved.requests) for (const key of ['pricing_schedule_id', 'pricing_period', 'cost_basis', 'settled_rates']) delete item[key];
  const restored = new ControlPlane(policySchema.parse({}), saved, () => {}, () => now);
  assert.equal(restored.snapshot().metrics.last_api_status, 'unknown');
  assert.equal(restored.snapshot().metrics.last_api_cost_basis, 'peak_upper_bound');
  assert.deepEqual(restored.snapshot().metrics.task_cost, c.snapshot().metrics.reserved_cost);
  restored.settle(r.id, usage, 'complete');
  assert.deepEqual(restored.snapshot().metrics.task_cost, c.snapshot().metrics.reserved_cost);
});
