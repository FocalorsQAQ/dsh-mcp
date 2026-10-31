import { createConnection } from 'node:net';
import { endianness } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DshError } from './types.ts';

/** Version-sensitive adapter to the desktop App's supplied local tool pipe; no server discovery. */
export function appToolRequest(pipe: string, method: string, params: object, timeoutMs = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection(pipe);
    let pending = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new DshError('DELIVERY_UNKNOWN', 'Desktop App tool request timed out; do not resend without checking the chat.')), timeoutMs);
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new DshError('DELIVERY_UNKNOWN', 'Desktop App pipe closed before acknowledgement.')));
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      const frame = Buffer.alloc(4 + body.length);
      if (endianness() === 'LE') frame.writeUInt32LE(body.length); else frame.writeUInt32BE(body.length);
      body.copy(frame, 4); socket.write(frame);
    });
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = endianness() === 'LE' ? pending.readUInt32LE() : pending.readUInt32BE();
        if (length > 8 * 1024 * 1024) return finish(new DshError('DELIVERY_PROTOCOL', 'Desktop App frame exceeds the supported limit.'));
        if (pending.length < length + 4) return;
        let response;
        try { response = JSON.parse(pending.subarray(4, 4 + length).toString('utf8')); }
        catch { return finish(new DshError('DELIVERY_PROTOCOL', 'Desktop App returned invalid JSON.')); }
        pending = pending.subarray(4 + length);
        if (response.id !== id) continue;
        if (response.error) return finish(new DshError('DELIVERY_REJECTED', 'Desktop App rejected the tool request (' + response.error.code + ').'));
        return finish(undefined, response.result);
      }
    });
  });
}

/** The destination is the same authorized calling chat; this adapter never selects other threads. */
export async function publishToCallingChat(options: { pipe: string; threadId: string; turnId: string; text: string; timeoutMs?: number }) {
  const result = await appToolRequest(options.pipe, 'tools/call', {
    callerSource: 'codex', namespace: 'codex_app', tool: 'send_message_to_thread', hostId: 'local',
    threadId: options.threadId, turnId: options.turnId, callId: 'dsh-result-' + randomUUID(),
    arguments: { threadId: options.threadId, prompt: options.text },
  }, options.timeoutMs);
  if (!result || typeof result !== 'object' || !('success' in result) || result.success !== true ||
    !('contentItems' in result) || !Array.isArray(result.contentItems)) {
    throw new DshError('DELIVERY_REJECTED', 'Desktop App did not accept the result message.');
  }
  for (const item of result.contentItems) {
    if (!item || typeof item !== 'object' || !('text' in item) || typeof item.text !== 'string') continue;
    try {
      const receipt = JSON.parse(item.text);
      if (receipt.threadId === options.threadId) return { thread_id: options.threadId, accepted: true };
    } catch { /* Non-JSON content cannot confirm the destination. */ }
  }
  throw new DshError('DELIVERY_UNKNOWN', 'Desktop App returned no matching thread receipt.');
}
