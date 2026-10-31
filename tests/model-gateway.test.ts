import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlPlane } from '../src/control-plane.ts';
import { policySchema } from '../src/control-contract.ts';
import { startModelGateway, UsageStream } from '../src/model-gateway.ts';

const model = 'deepseek-v4-flash';
const frames = (input = 12, hit = 5, output = 8) => [
  { type: 'message_start', message: { usage: { input_tokens: input, cache_read_input_tokens: hit, output_tokens: 0 } } },
  { type: 'message_delta', usage: { output_tokens: output } }, { type: 'message_stop' },
].map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('');
const body = { model, max_tokens: 16000, stream: true, messages: [{ role: 'user', content: 'fixture' }] };

test('OpenAI receipts count cached input and all output, and reject missing or invalid terminal receipts', () => {
  const response = { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20,
    input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 15 } } } };
  const stream = new UsageStream('openai_responses'); stream.push(Buffer.from('data: ' + JSON.stringify(response) + '\n\n'));
  assert.deepEqual(stream.result(), { input_cache_miss: 40, input_cache_hit: 60, output: 20 });
  const missing = new UsageStream('openai_responses'); missing.push(Buffer.from('data: {"type":"response.created"}\n\n')); assert.equal(missing.result(), null);
  const malformed = new UsageStream('openai_responses');
  response.response.usage.input_tokens_details.cached_tokens = 101;
  malformed.push(Buffer.from('data: ' + JSON.stringify(response) + '\n\n')); assert.equal(malformed.result(), null);
  const chat = new UsageStream('openai_chat');
  chat.push(Buffer.from('data: {"usage":{"prompt_tokens":20,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":12}}}\n\ndata: [DONE]\n\n'));
  assert.deepEqual(chat.result(), { input_cache_miss: 8, input_cache_hit: 12, output: 5 });
});

test('Responses gateway binds route, disables paid tools and premium tiers, and meters terminal usage', async t => {
  const c = new ControlPlane(policySchema.parse({ task_budget: [1, 0] }), undefined, () => {});
  let calls = 0;
  const gateway = await startModelGateway({ protocol: 'openai_responses', baseURL: 'https://api.openai.com/v1', model: 'gpt-5-mini', apiKey: '',
    credential: async use => use('synthetic-only'),
    meter: { reserve: (model, cap) => c.reserve('x', c.currentRound, model, cap), settle: (...args) => c.settle(...args) },
    fetch: (async (url, init) => {
      calls++; assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer synthetic-only');
      const payload = JSON.parse(init!.body as string); assert.equal(payload.store, false); assert.equal(payload.service_tier, 'default');
      assert(c.snapshot().metrics.reserved_cost[0] > 0);
      return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":15,"output_tokens":4,"input_tokens_details":{"cached_tokens":10}}}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch });
  t.after(() => gateway.close());
  const send = (extra = {}) => fetch(gateway.url + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer ' + gateway.token },
    body: JSON.stringify({ model: 'gpt-5-mini', input: 'fixture', max_output_tokens: 16, stream: true, ...extra }) });
  assert.equal((await send({ tools: [{ type: 'web_search' }] })).status, 400);
  assert.equal((await send({ service_tier: 'priority' })).status, 400);
  assert.equal(calls, 0);
  await (await send()).text(); assert.equal(calls, 1);
  assert.deepEqual(c.snapshot().metrics.last_api_tokens, { input_cache_miss: 5, input_cache_hit: 10, output: 4 });
});

test('a parsed terminal receipt survives upstream disconnect after the terminal frame', async t => {
  const c = new ControlPlane(policySchema.parse({}), undefined, () => {});
  const gateway = await startModelGateway({ model, apiKey: 'synthetic-only',
    meter: { reserve: (m, cap) => c.reserve('x', c.currentRound, m, cap), settle: (...args) => c.settle(...args) },
    fetch: (async () => {
      let n = 0;
      return new Response(new ReadableStream({ pull(controller) { if (n++ === 0) controller.enqueue(Buffer.from(frames())); else controller.error(new Error('disconnect after terminal')); } }),
        { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch });
  t.after(() => gateway.close());
  try { await (await fetch(gateway.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': gateway.token }, body: JSON.stringify(body) })).text(); } catch {}
  assert.equal(c.snapshot().metrics.last_api_status, 'settled');
  assert.deepEqual(c.snapshot().metrics.last_api_tokens, { input_cache_miss: 12, input_cache_hit: 5, output: 8 });
});

test('usage parser handles UTF-8 chunk boundaries, cache creation, missing and malformed receipts', () => {
  const parsed = new UsageStream(); const buffer = Buffer.from(frames());
  for (const byte of buffer) parsed.push(new Uint8Array([byte]));
  assert.deepEqual(parsed.result(), { input_cache_miss: 12, input_cache_hit: 5, output: 8 });
  const missing = new UsageStream(); missing.push(Buffer.from(frames().replace('"message_stop"', '"incomplete"')));
  assert.equal(missing.result(), null);
  const malformed = new UsageStream(); malformed.push(Buffer.from(frames(-1)));
  assert.equal(malformed.result(), null);
  const noOutput = new UsageStream(); noOutput.push(Buffer.from(frames().replace('"output_tokens":8', '"other":8')));
  assert.equal(noOutput.result(), null, 'initial zero output is not a final usage receipt');
  const cached = new UsageStream(); cached.push(Buffer.from(frames().replace('"input_tokens":12', '"input_tokens":12,"cache_creation_input_tokens":3')));
  assert.equal(cached.result()?.input_cache_miss, 15);
  const terminalDelta = new UsageStream();
  terminalDelta.push(Buffer.from('data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}\n\n'));
  assert.deepEqual(terminalDelta.result(), { input_cache_miss: 12, input_cache_hit: 0, output: 8 }, 'final delta already establishes usage if the client closes before message_stop');
});

test('gateway authenticates, reserves before I/O, binds model, meters receipt and blocks unmetered routes', async t => {
  const control = new ControlPlane(policySchema.parse({ round_budget: [0.34, 0] }), undefined, () => {});
  let calls = 0;
  const gateway = await startModelGateway({ model, apiKey: 'provider-secret-fixture',
    meter: { reserve: (m, tokens) => control.reserve('a', control.currentRound, m, tokens), settle: (...args) => control.settle(...args) },
    fetch: (async (url, init) => {
      calls++; assert(String(url).endsWith('/anthropic/v1/messages'));
      assert(control.snapshot().metrics.reserved_cost[0] > 0, 'must persist before network I/O');
      assert.equal((init!.headers as Record<string, string>)['x-api-key'], 'provider-secret-fixture');
      return new Response(frames(), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch,
  });
  t.after(() => gateway.close());
  const send = (payload: unknown, path = '/v1/messages', token = gateway.token) => fetch(gateway.url + path, {
    method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal((await send(body, '/v1/messages', 'invalid')).status, 403);
  assert.equal((await send(body, '/search')).status, 400);
  assert.equal((await send({ ...body, model: 'other' })).status, 400);
  assert.equal((await send({ ...body, tools: [{ type: 'web_search_20250305' }] })).status, 400);
  assert.equal(calls, 0);
  const response = await send(body); assert.equal(response.status, 200); await response.text();
  assert.equal(calls, 1);
  assert.deepEqual(control.snapshot().metrics.last_api_tokens, { input_cache_miss: 12, input_cache_hit: 5, output: 8 });
  assert.equal(control.snapshot().metrics.reserved_cost[0], 0);
  control.updatePolicy({ enabled: false }, control.snapshot().revision);
  assert.equal((await send(body)).status, 400); assert.equal(calls, 1);
});

test('parallel gateway calls share one reservation pool and lost usage remains charged', async t => {
  const control = new ControlPlane(policySchema.parse({ task_budget: [0.34, 0] }), undefined, () => {});
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const gateway = await startModelGateway({ model, apiKey: 'fixture',
    meter: { reserve: (m, tokens) => control.reserve('a', control.currentRound, m, tokens), settle: (...args) => control.settle(...args) },
    fetch: (async () => {
      calls++; entered(); await new Promise<void>(resolve => { release = resolve; });
      return new Response('data: {"type":"message_start"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch,
  });
  t.after(() => gateway.close());
  const send = () => fetch(gateway.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': gateway.token }, body: JSON.stringify(body) });
  const first = send(); await ready;
  const second = await send(); assert.equal(second.status, 400); assert.equal(calls, 1);
  release(); await (await first).text();
  assert.equal(control.snapshot().metrics.last_api_status, 'unknown');
  assert(control.snapshot().metrics.task_cost[0] > 0.3);
  assert.equal((await send()).status, 400); assert.equal(calls, 1);
});

test('gateway never follows provider redirects, and HTTP rejection is separate from unknown failure', async t => {
  const control = new ControlPlane(policySchema.parse({}), undefined, () => {});
  let status = 429;
  const gateway = await startModelGateway({ model, apiKey: 'fixture',
    meter: { reserve: (m, tokens) => control.reserve('a', control.currentRound, m, tokens), settle: (...args) => control.settle(...args) },
    fetch: (async (_url, init) => { assert.equal(init!.redirect, 'error'); return new Response('', { status }); }) as typeof fetch,
  });
  t.after(() => gateway.close());
  const send = () => fetch(gateway.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': gateway.token }, body: JSON.stringify(body) });
  await (await send()).text(); assert.deepEqual(control.snapshot().metrics.task_cost, [0, 0]);
  status = 500; await (await send()).text(); assert(control.snapshot().metrics.task_cost[0] > 0);
  assert.equal(control.snapshot().metrics.last_api_status, 'unknown');
});
