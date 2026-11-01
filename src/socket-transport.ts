import type { Socket } from 'node:net';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Read only the bounded authentication line, leaving subsequent MCP bytes queued. */
export function handshakeLine(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('Local session handshake timed out.')), 3000);
    const closed = () => finish(new Error('Local session connection closed.'));
    const fail = (error: Error) => finish(error);
    const data = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf(10);
      if ((end < 0 && pending.length > 8192) || end > 8192) { finish(new Error('Invalid session handshake.')); return; }
      if (end < 0) return;
      socket.pause();
      if (pending.length > end + 1) socket.unshift(pending.subarray(end + 1));
      try { finish(undefined, JSON.parse(pending.subarray(0, end).toString('utf8'))); }
      catch { finish(new Error('Invalid session handshake.')); }
    };
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer); socket.off('data', data); socket.off('close', closed); socket.off('error', fail);
      if (error) reject(error); else resolve(value);
    };
    socket.on('data', data); socket.once('close', closed); socket.once('error', fail); socket.resume();
  });
}

export class SocketMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private buffer = new ReadBuffer({ maxBufferSize: 8_000_000 });
  constructor(private socket: Socket) {}
  async start() {
    this.socket.on('data', chunk => {
      try {
        this.buffer.append(chunk);
        let message;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (error) { this.onerror?.(error as Error); this.socket.destroy(); }
    });
    this.socket.on('error', error => this.onerror?.(error));
    this.socket.once('close', () => this.onclose?.());
    this.socket.resume();
  }
  async send(message: JSONRPCMessage) {
    await new Promise<void>((resolve, reject) => this.socket.write(serializeMessage(message), error => error ? reject(error) : resolve()));
  }
  async close() { this.socket.destroy(); }
}
