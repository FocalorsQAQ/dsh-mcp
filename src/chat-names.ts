import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Read only Codex's title index, keyed by exact UUID. Never infer identity from a title or a recent chat. */
export function readChatNames(ids: string[], codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')): Map<string, string> {
  const wanted = new Set(ids.filter(id => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)).map(id => id.toLowerCase()));
  const names = new Map<string, { title: string; updated: number }>();
  if (!wanted.size) return new Map();
  let fd: number | undefined;
  try {
    fd = openSync(join(codexHome, 'session_index.jsonl'), 'r');
    const size = fstatSync(fd).size;
    if (size > 16 * 1024 * 1024) return new Map();
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) { const count = readSync(fd, bytes, offset, size - offset, offset); if (!count) break; offset += count; }
    const lines = bytes.subarray(0, offset).toString('utf8').split('\n');
    lines.pop(); // Ignore an uncommitted final record during an index append.
    for (const line of lines) {
      try {
        const item = JSON.parse(line), id = typeof item?.id === 'string' ? item.id.toLowerCase() : '';
        if (!wanted.has(id) || typeof item.thread_name !== 'string') continue;
        const title = item.thread_name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 240);
        const updated = Date.parse(item.updated_at);
        if (!title || !Number.isFinite(updated)) continue;
        if (!names.has(id) || updated >= names.get(id)!.updated) names.set(id, { title, updated });
      } catch { /* A malformed metadata row must not hide other valid names. */ }
    }
  } catch { /* Missing/unavailable index falls back to the chat ID, never another chat's name. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return new Map([...names].map(([id, item]) => [id, item.title]));
}
