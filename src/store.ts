import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DshError, stateSchema, type SavedState } from './types.ts';

/** Exclusive local registry. Harness itself owns the durable conversation logs. */
export class StateStore {
  private readonly path: string;
  private readonly lock: string;
  private readonly token = randomUUID();
  private ownsLock = false;

  constructor(readonly directory: string, private readonly python = 'python') {
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, 'state.json');
    this.lock = join(directory, 'server.lock');
    this.acquire();
    try { this.cleanTemporaryFiles(); } catch (error) { this.close(); throw error; }
  }

  private lockOperation(operation: 'acquire' | 'release'): { recovered: boolean; previous_pid?: number | null } {
    const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
    const result = spawnSync(this.python, ['-I', '-B', fileURLToPath(new URL('../runtime/state_lock.py', import.meta.url))], {
      input: JSON.stringify({ operation, directory: this.directory, pid: process.pid, token: this.token }),
      encoding: 'utf8', timeout: 5000, maxBuffer: 16384, windowsHide: true, shell: false, env,
    });
    if (result.error || result.status !== 0) throw new DshError('LOCK_HELPER', 'Cannot run the registry lock helper; check billing.python (Python 3.10+).');
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw new DshError('LOCK_HELPER', 'Invalid registry lock helper response.'); }
    if (response.ok !== true) throw new DshError(response.code ?? 'LOCK_HELPER', response.message ?? 'Registry ownership could not be established.');
    return response;
  }

  private acquire(): void {
    const result = this.lockOperation('acquire');
    this.ownsLock = true;
    if (result.recovered) {
      // The previous host is proven dead. Its UI token must not survive recovery.
      const endpoint = join(this.directory, 'ui-endpoint.json');
      try {
        if (JSON.parse(readFileSync(endpoint, 'utf8')).pid === result.previous_pid) unlinkSync(endpoint);
      } catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') { this.close(); throw error; } }
    }
  }

  private cleanTemporaryFiles(): void {
    // Only our atomic-write leftovers, in this directory, after exclusive ownership.
    // Never follow junctions or delete sessions, snapshots, credentials or arbitrary *.tmp files.
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    const pattern = new RegExp('^(?:state\\.json|ui-endpoint\\.json|server\\.lock|last-recovery\\.json)\\.' + uuid + '\\.tmp$');
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (entry.isFile() && pattern.test(entry.name)) unlinkSync(join(this.directory, entry.name));
    }
  }

  read(): SavedState {
    if (!existsSync(this.path)) return { version: 1, cursor: 0, agents: [], events: [], deliveries: [], workspaces: [] };
    // Invalid data must not silently replace existing sessions with an empty registry.
    return stateSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
  }

  write(state: SavedState): void {
    if (!this.ownsLock) throw new DshError('CLOSED', 'The state store has been closed.');
    if (JSON.parse(readFileSync(this.lock, 'utf8')).token !== this.token) throw new DshError('LOCKED', 'Registry lock ownership changed unexpectedly.');
    const temporary = this.path + '.' + this.token + '.tmp';
    try {
      const fd = openSync(temporary, 'w', 0o600);
      try { writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  close(): void {
    if (!this.ownsLock) return;
    this.lockOperation('release');
    this.ownsLock = false;
  }
}
