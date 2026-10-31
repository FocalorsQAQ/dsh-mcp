import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PythonBilling, billingConfigSchema } from '../src/billing.ts';
import { ControlPlane } from '../src/control-plane.ts';
import { policySchema } from '../src/control-contract.ts';
import { loadConfig } from '../src/config.ts';
import { createApplication } from '../src/application.ts';

const model = 'deepseek-v4-flash';
const now = () => Date.parse('2026-10-26T02:00:00Z');
const usage = { input_cache_miss: 1, input_cache_hit: 0, output: 1 };
const example = resolve('billing/examples/fixed_fee.py');
function plane(rules: string, policy = {}, options = {}) {
  return new ControlPlane(policySchema.parse(policy), undefined, () => {}, now,
    new PythonBilling(billingConfigSchema.parse({ rules, ...options })));
}
function temp() {
  const root = resolve('.test-output/billing'); mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'case-'));
}
function script(source: string) { const path = join(temp(), 'rules.py'); writeFileSync(path, source); return path; }
const normalQuote = 'def quote(r):\n return {"max_tokens":r["max_tokens"],"reserved_nano":[100,0],"rates":[0,0,0],"context":{}}\n';

test('custom Python fixed fee enforces shared budgets, refunds rejection and settles idempotently', () => {
  const c = plane(example, { round_budget: [0.015, 0] });
  const r = c.reserve('a', c.currentRound, model, 100);
  assert.throws(() => c.reserve('b', c.currentRound, model, 100), /Insufficient shared budget/);
  c.settle(r.id, null, 'rejected');
  assert.deepEqual(c.snapshot().metrics.task_cost, [0, 0]);
  const paid = c.reserve('a', c.currentRound, model, 100);
  c.settle(paid.id, usage, 'complete'); c.settle(paid.id, usage, 'complete');
  assert.deepEqual(c.snapshot().metrics.task_cost, [0.01, 0]);
  assert.equal(c.snapshot().metrics.last_api_cost_basis, 'custom_estimate');
  const yuan = plane(example, { billing_currency: 'CNY' });
  const next = yuan.reserve('a', yuan.currentRound, model, 100); yuan.settle(next.id, usage, 'complete');
  assert.deepEqual(yuan.snapshot().metrics.task_cost, [0, 0.01]);
});

test('custom calculator is configured through application and survives persisted state', async t => {
  const root = temp();
  writeFileSync(join(root, 'custom.py'), readFileSync(example));
  const path = join(root, 'config.json'); writeFileSync(path, JSON.stringify({ billing: { rules: './custom.py' } }));
  const config = loadConfig(path);
  assert.equal(config.billing.rules, join(root, 'custom.py'));
  const app = createApplication(config, spec => ({ async open() {}, async close() {}, async run() {
    const r = spec.metering!.reserve(model, 100); spec.metering!.settle(r.id, usage, 'complete');
    return { finalResponse: 'ok', finishReason: 'completed' };
  } }));
  t.after(() => app.close());
  // Configuration is exercised through the public application by creating a real MCP caller.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = app.createMcpServer(), client = new Client({ name: 'billing-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  await client.callTool({ name: 'spawn_agent', arguments: { task_name: 'billing', message: 'local mock only' } });
  for (let i = 0; i < 100 && app.ui.snapshot().metrics.last_api_status !== 'settled'; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(app.ui.snapshot().metrics.task_cost, [0.01, 0]);
  const saved = JSON.parse(readFileSync(join(config.data_dir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.control.last_request.billing_context, { fee_nano: [10000000, 0] });
  assert.equal(saved.control.last_request.billing_rules_hash.length, 64);
});

test('invalid, crashing, unavailable and timed-out Python never create a reservation', () => {
  const cases = [
    { rules: script('raise RuntimeError("bad")') },
    { rules: script('print("not-json")\ndef quote(r): return {}') },
    { rules: script('import time\ndef quote(r): time.sleep(5)'), timeout_ms: 100 },
    { rules: example, python: resolve('missing-python.exe') },
    { rules: script(normalQuote.replace('[100,0]', '[-1,0]')) },
    { rules: script(normalQuote.replace('[100,0]', '[0,100]')) },
    { rules: script(normalQuote.replace('r["max_tokens"]', 'r["max_tokens"]+1')) },
    { rules: script(normalQuote.replace('[100,0]', '[9007199254740992,0]')) },
  ];
  for (const { rules, ...options } of cases) {
    const c = plane(rules, {}, options);
    assert.throws(() => c.reserve('a', c.currentRound, model, 100), /Python billing failed/);
    assert.equal(c.exportState().requests.length, 0);
  }
});

test('settlement errors or edited rules retain full reservation and block future calls', () => {
  for (const edit of [false, true]) {
    const path = script(edit ? readFileSync(example, 'utf8') : normalQuote + 'def settle(r): return {"cost_nano":[-1,0]}\n');
    const c = plane(path); const r = c.reserve('a', c.currentRound, model, 100);
    const held = c.snapshot().metrics.reserved_cost;
    if (edit) writeFileSync(path, readFileSync(path, 'utf8') + '\n# changed during paid call\n');
    c.settle(r.id, usage, 'complete');
    assert.deepEqual(c.snapshot().metrics.task_cost, held);
    assert.equal(c.snapshot().metrics.last_api_status, 'unknown');
    assert.equal(c.exportState().last_request!.billing_error, 'BILLING_ENGINE');
    assert.throws(() => c.reserve('a', c.currentRound, model, 100), /blocked/);
  }
});

test('Python receives no provider key; crash recovery needs no interpreter', () => {
  const path = script('import os\nassert "DEEPSEEK_API_KEY" not in os.environ\n' + normalQuote);
  const before = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'test-not-real';
  try {
    const c = plane(path); c.reserve('a', c.currentRound, model, 100);
    const restored = new ControlPlane(policySchema.parse({}), c.exportState(), () => {}, now,
      new PythonBilling(billingConfigSchema.parse({ python: resolve('missing-python.exe') })));
    assert.deepEqual(restored.snapshot().metrics.task_cost, [0.0000001, 0]);
  } finally { if (before === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = before; }
});

test('Decimal rounds tiny charges upward and supports zero output prices', () => {
  const billing = new PythonBilling();
  const quote = billing.quote({ model, currency: 'USD', rates: [0.0000001, 0, 0], input_limit: 1,
    max_tokens: 100, available_nano: [1, 0], started_at: new Date(now()).toISOString() });
  assert.deepEqual(quote.reserved_nano, [1, 0]);
  assert.equal(quote.max_tokens, 100);
});

test('custom cost exceeding its quote is recorded and blocks later dispatch', () => {
  const path = script(normalQuote + 'def settle(r):\n return {"cost_nano":[200,0],"settled_rates":None,"pricing_period":"unknown","cost_basis":"custom_estimate"}\n');
  const c = plane(path); const r = c.reserve('a', c.currentRound, model, 100);
  c.settle(r.id, usage, 'complete');
  assert.equal(c.exportState().task_spent_nano[0], 200);
  assert.equal(c.snapshot().metrics.accounting_blocked, true);
  assert.throws(() => c.reserve('a', c.currentRound, model, 100), /blocked/);
});
