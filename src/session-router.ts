import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ServerRouting, ToolExtra } from './server.ts';
import { requestSessionId } from './request-context.ts';
import { DshError } from './types.ts';

type Entry = { client: Promise<Client>; active: number; used: number };

/** A shared Codex connection carries separate chat identities on individual requests. */
export class SessionRouter implements ServerRouting {
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private connect: (id: string) => Promise<Client>, private idleMs = 60000) {
    this.timer = setInterval(() => {
      for (const [id, entry] of this.entries) {
        if (entry.active || Date.now() - entry.used < this.idleMs) continue;
        this.entries.delete(id); void entry.client.then(client => client.close()).catch(() => {});
      }
    }, Math.min(1000, idleMs));
    this.timer.unref();
  }
  private async withClient<T>(id: string, action: (client: Client) => Promise<T>): Promise<T> {
    if (this.closed) throw new DshError('SESSION_CLOSED', 'The chat router is stopping.');
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= 64) throw new DshError('CAPACITY', 'The shared connection has too many active chat routes.');
      entry = { client: this.connect(id), active: 0, used: Date.now() };
      this.entries.set(id, entry);
      const generation = entry;
      void entry.client.then(async client => {
        client.onclose = () => { if (this.entries.get(id) === generation) this.entries.delete(id); };
        if (this.closed) await client.close();
      }).catch(() => { if (this.entries.get(id) === generation) this.entries.delete(id); });
    }
    entry.active++;
    try { return await action(await entry.client); }
    finally { entry.active--; entry.used = Date.now(); }
  }
  async tool(name: string, input: Record<string, unknown>, extra: ToolExtra, fallback: Parameters<ServerRouting['tool']>[3]) {
    const id = requestSessionId(extra._meta);
    if (!id) return fallback(); // Only catalog model queries are allowed by the application facade.
    return this.withClient(id, async client => CallToolResultSchema.parse(await client.callTool({ name, arguments: input, _meta: extra._meta }, CallToolResultSchema,
      { signal: extra.signal, timeout: 90000 })));
  }
  async policy(extra: ToolExtra) {
    const uri = 'dsh://control/status', id = requestSessionId(extra._meta);
    if (!id) return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ session_required: true,
      message: 'Supply the calling chat in host request metadata to read its policy. No chat budget is shared through this catalog.' }) }] };
    return this.withClient(id, client => client.readResource({ uri, _meta: extra._meta }, { signal: extra.signal }));
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    const entries = [...this.entries.values()]; this.entries.clear();
    await Promise.allSettled(entries.map(async entry => (await entry.client).close()));
  }
}
