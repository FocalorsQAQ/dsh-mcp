import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { DshError, errorText } from './types.ts';
import { providerBaseURL } from './models.ts';
import type { MeteringPort, TokenUsage } from './control-contract.ts';
import type { ApiEntry } from './credential-contract.ts';

/** Parses only accounting fields. Prompt/completion content is never retained by the meter. */
export class UsageStream {
  constructor(private readonly protocol: ApiEntry['protocol'] = 'deepseek') {}
  private pending = '';
  private fields: Record<string, unknown> = {};
  private ended = false;
  private started = false;
  private outputReported = false;
  private terminalDelta = false;
  private invalid = false;
  private decoder = new TextDecoder();
  push(bytes: Uint8Array): void {
    this.pending += this.decoder.decode(bytes, { stream: true });
    if (this.pending.length > 4_000_000) { this.invalid = true; this.pending = ''; return; }
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match) break;
      const frame = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try {
        if (data === '[DONE]') { if (this.protocol === 'openai_chat') this.ended = true; continue; }
        const event = JSON.parse(data);
        if (this.protocol === 'openai_responses') {
          if (['response.completed', 'response.incomplete'].includes(event.type)) {
            if (this.ended) this.invalid = true;
            const usage = event.response?.usage;
            this.fields = { input_tokens: usage?.input_tokens, output_tokens: usage?.output_tokens,
              cached_tokens: usage?.input_tokens_details?.cached_tokens ?? 0 };
            this.started = true; this.ended = true; this.outputReported = true;
          }
          if (['error', 'response.failed'].includes(event.type)) this.invalid = true;
          continue;
        }
        if (this.protocol === 'openai_chat') {
          if (event.error) this.invalid = true;
          if (event.usage) {
            if (this.outputReported) this.invalid = true;
            this.fields = { input_tokens: event.usage.prompt_tokens, output_tokens: event.usage.completion_tokens,
              cached_tokens: event.usage.prompt_tokens_details?.cached_tokens ?? 0 };
            this.started = true; this.outputReported = true;
          }
          continue;
        }
        if (event.type === 'message_start') {
          if (this.started || this.ended) this.invalid = true;
          this.started = true; Object.assign(this.fields, event.message?.usage);
        }
        if (event.type === 'message_delta') {
          if (!this.started || this.ended) this.invalid = true;
          Object.assign(this.fields, event.usage);
          if (event.usage?.output_tokens !== undefined) this.outputReported = true;
          if (['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'pause_turn', 'refusal'].includes(event.delta?.stop_reason)) this.terminalDelta = true;
        }
        if (event.type === 'message_stop') { if (this.ended) this.invalid = true; this.ended = true; }
        if (event.type === 'error') this.invalid = true;
      } catch { this.invalid = true; }
    }
  }
  result(): TokenUsage | null {
    if (!this.started || (!this.ended && !this.terminalDelta) || !this.outputReported || this.invalid) return null;
    const f = this.fields;
    if (this.protocol === 'openai_responses' || this.protocol === 'openai_chat') {
      const values = [f.input_tokens, f.output_tokens, f.cached_tokens];
      if (!values.every(value => Number.isSafeInteger(value) && Number(value) >= 0) || Number(f.cached_tokens) > Number(f.input_tokens)) return null;
      return { input_cache_miss: Number(f.input_tokens) - Number(f.cached_tokens), input_cache_hit: Number(f.cached_tokens), output: Number(f.output_tokens) };
    }
    const values = [f.input_tokens, f.output_tokens, f.cache_read_input_tokens ?? 0, f.cache_creation_input_tokens ?? 0];
    if (!values.every(value => Number.isSafeInteger(value) && (value as number) >= 0)) return null;
    return { input_cache_miss: (f.input_tokens as number) + (f.cache_creation_input_tokens as number ?? 0),
      input_cache_hit: f.cache_read_input_tokens as number ?? 0, output: f.output_tokens as number };
  }
}

function failure(res: ServerResponse, status: number, error: unknown) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
    message: error instanceof DshError ? error.code + ': ' + error.message : errorText(error) } }));
}

/** All supported paid model requests pass this host-owned admission and accounting boundary. */
export async function startModelGateway(options: {
  meter: MeteringPort; model: string; apiKey: string; baseURL?: string; fetch?: typeof fetch;
  protocol?: ApiEntry['protocol']; credential?: <T>(use: (key: string) => Promise<T>) => Promise<T>;
}) {
  const protocol = options.protocol ?? 'deepseek';
  const base = protocol === 'deepseek' ? providerBaseURL(options.baseURL) : options.baseURL!.replace(/\/+$/, '');
  const endpoint = protocol === 'openai_responses' ? '/responses' : protocol === 'openai_chat' ? '/chat/completions' : '/messages';
  const token = randomBytes(32).toString('hex');
  const controllers = new Set<AbortController>();
  const operations = new Set<Promise<void>>();
  let closing = false;
  const handle = async (req: import('node:http').IncomingMessage, res: ServerResponse) => {
    let reservation: { id: string; max_tokens: number } | undefined;
    let settled = false;
    let sent = false;
    let usage: UsageStream | undefined;
    const controller = new AbortController();
    controllers.add(controller);
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const supplied = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '');
      if (closing || req.headers.origin || typeof supplied !== 'string' || supplied.length !== token.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { failure(res, 403, new Error('Forbidden')); return; }
      // Search/Fetch, Files, alternate protocols and provider-side paid tools need separate meters.
      if (req.method !== 'POST' || !(protocol === 'deepseek' ? ['/v1/messages', '/anthropic/v1/messages'] : ['/v1' + endpoint]).includes(req.url ?? '')) {
        failure(res, 400, new DshError('UNMETERED_ENDPOINT', 'This adapter only supports metered Messages requests.')); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 20_000_000) throw new DshError('REQUEST_SIZE', 'Model request exceeds 20 MB.');
        chunks.push(bytes);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (payload.model !== options.model || payload.stream !== true) throw new DshError('MODEL_ROUTE', 'Only the host-bound model and streaming Messages protocol are permitted.');
      const openai = protocol === 'openai_responses' || protocol === 'openai_chat';
      if (payload.tools?.some((tool: { type?: string }) => openai ? tool.type !== 'function' : tool.type && tool.type !== 'custom')) {
        throw new DshError('UNMETERED_TOOL', 'Provider-side paid tools require a dedicated cost adapter.');
      }
      if (!options.apiKey && !options.credential) throw new DshError('API_KEY_REQUIRED', 'Configure an API credential in the host.');
      if (openai) {
        if ((payload.n !== undefined && payload.n !== 1) || payload.background || payload.service_tier && payload.service_tier !== 'default')
          throw new DshError('UNMETERED_OPTION', 'Only one foreground response at standard pricing is supported.');
        payload.service_tier = 'default';
        if (protocol === 'openai_responses') payload.store = false;
        else payload.stream_options = { include_usage: true };
      }
      const cap = protocol === 'openai_responses' ? 'max_output_tokens' : protocol === 'openai_chat' ? 'max_completion_tokens' : 'max_tokens';
      const maximum = payload[cap] ?? payload.max_tokens;
      reservation = options.meter.reserve(payload.model, maximum);
      payload[cap] = reservation.max_tokens;
      if (cap !== 'max_tokens') delete payload.max_tokens;
      const dispatch = async (key: string) => {
        const headers: Record<string, string> = { 'content-type': 'application/json', authorization: 'Bearer ' + key };
        if (!openai) { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
        if (!openai && typeof req.headers['anthropic-beta'] === 'string') headers['anthropic-beta'] = req.headers['anthropic-beta'];
        sent = true;
        return (options.fetch ?? fetch)(protocol === 'deepseek' ? base + '/anthropic/v1/messages' : base + (protocol === 'anthropic' && !base.endsWith('/v1') ? '/v1' : '') + endpoint,
          { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: controller.signal });
      };
      const upstream = await (options.credential ? options.credential(dispatch) : dispatch(options.apiKey));
      if (!upstream.ok) {
        // Only explicit pre-inference rejection statuses refund their reservation.
        const rejected = [400, 401, 403, 404, 413, 422, 429].includes(upstream.status);
        options.meter.settle(reservation.id, null, rejected ? 'rejected' : 'unknown'); settled = true;
        await upstream.body?.cancel();
        failure(res, 400, new DshError('UPSTREAM_HTTP', 'Model API returned HTTP ' + upstream.status)); return;
      }
      if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) throw new DshError('MODEL_PROTOCOL', 'Expected a streaming Messages response.');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      usage = new UsageStream(protocol);
      for await (const chunk of upstream.body) {
        usage.push(chunk);
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      const tokens = usage.result();
      options.meter.settle(reservation.id, tokens, tokens ? 'complete' : 'unknown'); settled = true;
      res.end();
    } catch (error) {
      if (reservation && !settled) {
        // Network failures/cancellation may have been billed; never refund on a lost receipt.
        // A terminal receipt already parsed remains valid if the worker closes immediately afterwards.
        const tokens = usage?.result() ?? null;
        try { options.meter.settle(reservation.id, tokens, tokens ? 'complete' : sent ? 'unknown' : 'rejected'); } catch { /* storage failure already fails the host closed */ }
      }
      failure(res, 400, error);
    } finally { controllers.delete(controller); }
  };
  const server = createServer((req, res) => {
    const operation = handle(req, res); operations.add(operation);
    void operation.finally(() => operations.delete(operation));
  });
  server.requestTimeout = 30000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Model gateway did not bind a TCP port.');
  return { url: 'http://127.0.0.1:' + address.port, token,
    async close() {
      closing = true;
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
      await Promise.allSettled([...operations]);
    },
  };
}
