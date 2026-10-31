import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import type { DshControlApi } from './application.ts';
import { settingsCommandSchema, windowIntentSchema, type UiEnvelope } from './ui-protocol.ts';
import { DshError, errorText } from './types.ts';

/** Private UI transport around the application API. Never registered as agent tools. */
export async function startUiBridge(ui: DshControlApi, dataDir: string) {
  const token = randomBytes(32).toString('hex'), serverId = randomUUID();
  const expected = Buffer.from('Bearer ' + token);
  const endpointPath = join(dataDir, 'ui-endpoint.json');
  const streams = new Set<ServerResponse>();
  let sequence = 0;
  let closed = false;
  let lastPeriod: string | undefined;
  let lastPriceRevision: string | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const envelope = (): UiEnvelope => {
    const snapshot = ui.snapshot(); lastPeriod = snapshot.pricing.current_period; lastPriceRevision = snapshot.pricing.catalog.revision;
    return { server_id: serverId, sequence: ++sequence, snapshot };
  };
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const body = async (req: IncomingMessage): Promise<unknown> => {
    const parts: Buffer[] = []; let size = 0;
    for await (const part of req) {
      size += part.length;
      if (size > 8192) throw new DshError('INPUT', 'Control request exceeds the size limit.');
      parts.push(Buffer.from(part));
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  };
  const push = () => {
    scheduled = undefined;
    if (closed || !streams.size) return;
    const data = 'data: ' + JSON.stringify(envelope()) + '\n\n';
    for (const stream of streams) {
      if (stream.writableLength > 2_000_000) { stream.destroy(); continue; }
      stream.write(data);
    }
  };
  const unsubscribe = ui.subscribe(() => { if (!closed && !scheduled) scheduled = setTimeout(push, 40); });
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const actual = Buffer.from(req.headers.authorization ?? '');
        if (closed || req.headers.origin || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          json(res, 403, { error: { code: 'FORBIDDEN', message: 'UI authorization required.' } }); return;
        }
        if (req.method === 'GET' && req.url === '/v1/snapshot') { json(res, 200, envelope()); return; }
        if (req.method === 'GET' && req.url === '/v1/events') {
          if (streams.size >= 8) { json(res, 429, { error: { code: 'CAPACITY', message: 'Too many control windows.' } }); return; }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          streams.add(res); res.once('close', () => streams.delete(res));
          res.write('data: ' + JSON.stringify(envelope()) + '\n\n'); return;
        }
        if (req.method === 'PATCH' && req.url === '/v1/settings') {
          const command = settingsCommandSchema.parse(await body(req));
          ui.updateSettings(command.patch, command.expected_revision);
          json(res, 200, envelope()); return;
        }
        if (req.method === 'POST' && req.url === '/v1/window-intent') {
          const command = windowIntentSchema.parse(await body(req));
          json(res, 200, ui.openManagementWindow(command.window)); return;
        }
        json(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown control operation.' } });
      } catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        const code = error instanceof DshError ? error.code : error instanceof ZodError || error instanceof SyntaxError ? 'INPUT' : 'INTERNAL';
        json(res, code === 'CONTROL_CONFLICT' ? 409 : code === 'INPUT' ? 400 : 500,
          { error: { code, message: code === 'INPUT' ? 'Invalid control input.' : errorText(error) } });
      }
    })();
  });
  server.requestTimeout = 10000;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('UI bridge did not bind a TCP port.');
    const endpoint = { version: 1 as const, server_id: serverId, pid: process.pid,
      url: 'http://127.0.0.1:' + address.port, token };
    const temporary = endpointPath + '.' + serverId + '.tmp';
    writeFileSync(temporary, JSON.stringify(endpoint), { mode: 0o600 }); renameSync(temporary, endpointPath);
    const heartbeat = setInterval(() => {
      if (closed || !streams.size) return;
      try {
        const snapshot = ui.snapshot();
        if (snapshot.pricing.current_period !== lastPeriod || snapshot.pricing.catalog.revision !== lastPriceRevision) { push(); return; }
        for (const stream of streams) if (!stream.writableLength) stream.write(': alive\n\n');
      } catch { for (const stream of streams) stream.destroy(); streams.clear(); }
    }, 10000);
    heartbeat.unref();
    let closing: Promise<void> | undefined;
    return { endpoint,
      close() {
        return closing ??= (async () => {
          closed = true; unsubscribe(); clearTimeout(scheduled); clearInterval(heartbeat);
          for (const stream of streams) stream.end(); streams.clear();
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          try {
            if (JSON.parse(readFileSync(endpointPath, 'utf8')).server_id === serverId) unlinkSync(endpointPath);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        })();
      },
    };
  } catch (error) { unsubscribe(); server.closeAllConnections(); server.close(); throw error; }
}
