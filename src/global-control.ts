import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DshError } from './types.ts';

export const globalControlSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative().safe(), enabled: z.boolean() }).strict();
export const outsourcingCommandSchema = z.object({ enabled: z.boolean(), expected_revision: z.number().int().nonnegative().safe() }).strict();
export type GlobalControlState = z.infer<typeof globalControlSchema>;
export type GlobalControlStatus = { available: true; state: GlobalControlState } | { available: false; state: null; error: string };

/** Shared user-owned gate. Read synchronously at dispatch; polling only drives UI/catalog notifications. */
export class OutsourcingSwitch {
  private readonly path: string;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private signature = '';
  constructor(readonly directory: string, private readonly python = 'python', initialEnabled = true) {
    this.path = join(directory, 'outsourcing.json');
    if (!existsSync(this.path)) this.command({ operation: 'initialize', initial_enabled: initialEnabled });
  }
  snapshot(): GlobalControlState {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid switch file.');
      return globalControlSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch { throw new DshError('GLOBAL_CONTROL_STORAGE', 'Cannot read the global outsourcing switch; outsourcing is disabled.'); }
  }
  status(): GlobalControlStatus {
    try { return { available: true, state: this.snapshot() }; }
    catch { return { available: false, state: null, error: 'GLOBAL_CONTROL_STORAGE' }; }
  }
  get enabled(): boolean { const status = this.status(); return status.available && status.state.enabled; }
  assertEnabled(): void {
    if (!this.snapshot().enabled) throw new DshError('OUTSOURCING_DISABLED', '外包已禁用');
  }
  private command(input: Record<string, unknown>): GlobalControlState {
    const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
    const result = spawnSync(this.python, ['-I', '-B', fileURLToPath(new URL('../runtime/global_control.py', import.meta.url))], {
      input: JSON.stringify({ ...input, directory: this.directory }), encoding: 'utf8', timeout: 5000, maxBuffer: 16384, windowsHide: true, shell: false, env,
    });
    if (result.error || result.status !== 0) throw new DshError('GLOBAL_CONTROL_STORAGE', 'Cannot run the global switch storage helper.');
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw new DshError('GLOBAL_CONTROL_STORAGE', 'Invalid switch storage response.'); }
    if (response.ok !== true) throw new DshError(response.code ?? 'GLOBAL_CONTROL_STORAGE', response.message ?? 'Cannot update the global switch.');
    return globalControlSchema.parse(response.state);
  }
  setEnabled(enabled: boolean, expectedRevision: number): GlobalControlState {
    const input = outsourcingCommandSchema.parse({ enabled, expected_revision: expectedRevision });
    const result = this.command({ operation: 'update', ...input });
    this.refresh(); return result;
  }
  private refresh() {
    const next = JSON.stringify(this.status());
    if (next === this.signature) return;
    this.signature = next;
    for (const listener of this.listeners) { try { listener(); } catch { /* Observers cannot bypass the gate. */ } }
  }
  subscribe(listener: () => void): () => void {
    if (!this.listeners.size) {
      this.signature = JSON.stringify(this.status());
      this.timer = setInterval(() => this.refresh(), 250); this.timer.unref();
    }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { clearInterval(this.timer); this.timer = undefined; } };
  }
}
