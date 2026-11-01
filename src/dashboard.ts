import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Config } from './config.ts';
import { OutsourcingSwitch } from './global-control.ts';
import { UiClient } from './ui-client.ts';
import { listSessions, sessionDirectory } from './sessions.ts';
import { readChatNames } from './chat-names.ts';

/** Shared settings plus a read-only view of all live services. No chat selection or model call required. */
export class Dashboard {
  readonly defaults: OutsourcingSwitch;
  private clients = new Map<string, { client: UiClient; workspace: string; off: () => void }>();
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private offDefaults: () => void;
  constructor(private readonly config: Config) {
    this.defaults = new OutsourcingSwitch(config.control_config_dir ?? config.data_dir, config.billing.python, config.control);
    this.offDefaults = this.defaults.subscribe(() => this.emit());
  }
  private emit() { for (const fn of this.listeners) { try { fn(); } catch { /* Isolated observers. */ } } }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  refresh() {
    const entries = listSessions(this.config.data_dir).map(row => ({ id: row.id, workspace: row.workspace, directory: sessionDirectory(this.config.data_dir, row.id) }));
    if (existsSync(join(this.config.data_dir, 'ui-endpoint.json'))) entries.push({ id: 'legacy', workspace: this.config.workspace_root, directory: this.config.data_dir });
    for (const [id, row] of this.clients) if (!entries.some(item => item.id === id)) { row.off(); row.client.close(); this.clients.delete(id); }
    for (const row of entries) if (!this.clients.has(row.id)) {
      const client = new UiClient(row.directory, row.workspace);
      this.clients.set(row.id, { client, workspace: row.workspace, off: client.subscribe(() => this.emit()) }); client.reconnect();
    }
    this.emit();
  }
  start() { if (this.timer) return; this.refresh(); this.timer = setInterval(() => this.refresh(), 1000); this.timer.unref(); }
  snapshot() {
    const names = readChatNames([...this.clients.keys()].filter(id => id !== 'legacy'), this.config.codex_home);
    const works = [...this.clients].flatMap(([id, row]) => {
      const connection = row.client.snapshot();
      if (connection.status !== 'connected' || !connection.snapshot) return [];
      const runtime = connection.snapshot.runtime;
      const agents = runtime.agents.filter(agent => agent.online ?? ['starting', 'running', 'pausing', 'stopping'].includes(agent.status))
        .map(agent => ({ id: agent.id, name: agent.task_name, path: agent.path, model: agent.model, reasoning_effort: agent.reasoning_effort ?? null }));
      return agents.length ? [{ id, title: names.get(id) ?? basename(row.workspace), agents }] : [];
    });
    return { global_control: this.defaults.status(), runtime: { online_count: works.reduce((sum, work) => sum + work.agents.length, 0), works },
      workspace_name: basename(this.config.workspace_root), workspace_root: this.config.workspace_root };
  }
  updateSettings(patch: unknown, revision: number) { this.defaults.updateSettings(patch, revision); return this.snapshot(); }
  close() { clearInterval(this.timer); this.offDefaults(); for (const row of this.clients.values()) { row.off(); row.client.close(); } this.clients.clear(); this.listeners.clear(); }
}
export type DashboardState = ReturnType<Dashboard['snapshot']>;
