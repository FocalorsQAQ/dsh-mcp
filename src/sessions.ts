import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.ts';
import { policySchema } from './control-contract.ts';
import { DshError } from './types.ts';

export const sessionIdSchema = z.union([z.uuid(), z.literal('discovery')]);
export const sessionInfoSchema = z.object({ version: z.literal(1), id: sessionIdSchema,
  workspace: z.string(), created_at: z.iso.datetime(), pid: z.number().int().positive() }).strict();
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

/** Each chat owns its registry and ledger. Provider configuration remains in the shared directory. */
export function sessionDirectory(base: string, id: string, create = false): string {
  id = sessionIdSchema.parse(id).toLowerCase();
  if (create) mkdirSync(base, { recursive: true });
  const root = realpathSync(base);
  let path = root;
  for (const part of ['chats', id]) {
    path = join(path, part);
    if (!existsSync(path) && create) {
      try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw new DshError('SESSION_PATH', 'Chat storage must be a regular directory.');
  }
  return path;
}

export function sessionConfig(base: Config, id: string): Config {
  const data = sessionDirectory(base.data_dir, id, true);
  let control = base.control;
  // Retain the old user-selected limits as defaults, never copy another chat's tasks or charges.
  const legacy = join(base.data_dir, 'state.json');
  if (!existsSync(join(data, 'state.json')) && existsSync(legacy)) {
    if (!lstatSync(legacy).isFile()) throw new DshError('STATE', 'Legacy policy storage must be a regular file.');
    const saved = JSON.parse(readFileSync(legacy, 'utf8'));
    if (saved.control?.policy) control = policySchema.parse(saved.control.policy);
  }
  return { ...base, data_dir: data, model_config_dir: base.model_config_dir ?? base.data_dir, control,
    codex_thread_id: id === 'discovery' ? undefined : id,
    completion_delivery: { ...base.completion_delivery,
      ...(id === 'discovery' ? { mode: 'off' as const, thread_id: undefined } : { thread_id: id }) } };
}

export function writeSessionInfo(base: string, info: SessionInfo): void {
  const path = join(sessionDirectory(base, info.id, true), 'session.json');
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(sessionInfoSchema.parse(info)), { mode: 0o600 });
  renameSync(temporary, path);
}

export function listSessions(base: string): SessionInfo[] {
  if (!existsSync(base)) return [];
  const parent = join(realpathSync(base), 'chats');
  if (!existsSync(parent) || lstatSync(parent).isSymbolicLink()) return [];
  const result: SessionInfo[] = [];
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
    try {
      const directory = sessionDirectory(base, entry.name);
      const metadata = join(directory, 'session.json');
      if (!lstatSync(metadata).isFile()) continue;
      const info = sessionInfoSchema.parse(JSON.parse(readFileSync(metadata, 'utf8')));
      if (info.id === entry.name) result.push(info);
    } catch { /* An incomplete or invalid entry must not prevent other chats from appearing. */ }
  }
  return result.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100);
}

export function selectedSessionId(config: Config, explicit?: string): string {
  const id = explicit ?? process.env.CODEX_THREAD_ID ?? config.codex_thread_id ?? 'discovery';
  return sessionIdSchema.parse(id).toLowerCase();
}
