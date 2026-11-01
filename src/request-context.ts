import { z } from 'zod';
import { DshError } from './types.ts';

/** Codex supplies caller identity in MCP request metadata, outside model arguments. */
export function requestSessionId(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) return undefined;
  const candidates: unknown[] = [];
  const collect = (value: Record<string, unknown>) => {
    for (const key of ['threadId', 'thread_id']) if (value[key] !== undefined) candidates.push(value[key]);
  };
  collect(meta);
  const raw = meta['x-codex-turn-metadata'];
  if (raw !== undefined) {
    let value: unknown = raw;
    if (typeof raw === 'string') {
      try { value = JSON.parse(raw); } catch { throw new DshError('SESSION_IDENTITY', 'Invalid Codex request metadata.'); }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DshError('SESSION_IDENTITY', 'Invalid Codex request metadata.');
    collect(value as Record<string, unknown>);
  }
  if (!candidates.length) return undefined;
  const ids = candidates.map(value => {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new DshError('SESSION_IDENTITY', 'The host must provide a valid chat UUID.');
    return parsed.data.toLowerCase();
  });
  if (new Set(ids).size !== 1) throw new DshError('SESSION_IDENTITY', 'Conflicting chat identities in request metadata.');
  return ids[0];
}
