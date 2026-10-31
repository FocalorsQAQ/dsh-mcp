import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DshError } from './types.ts';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
type Item = Record<string, unknown>;
const record = (value: unknown): value is Item => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(record).filter(block => ['text', 'input_text', 'output_text'].includes(String(block.type)))
    .map(block => typeof block.text === 'string' ? block.text : '').join('\n');
}

/** Export visible archival history, not hidden reasoning, permissions, or an exact model request. */
export function parseCodexRollout(data: string, threadId: string, workspace: string) {
  const lines = data.split('\n');
  // A live writer may be midway through its final JSON record. Committed lines must still parse.
  if (!data.endsWith('\n')) lines.pop();
  let metadata: Item | undefined;
  let compactions = 0;
  const messages: Item[] = [];
  const calls = new Map<string, Item>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { throw new DshError('CODEX_FORMAT', 'Invalid committed JSONL record in Codex rollout.'); }
    if (!record(entry) || !record(entry.payload)) throw new DshError('CODEX_FORMAT', 'Unsupported Codex rollout envelope.');
    const payload = entry.payload;
    if (entry.type === 'session_meta') { if (metadata) throw new DshError('CODEX_FORMAT', 'Duplicate session metadata.'); metadata = payload; }
    if (entry.type === 'compacted') compactions++;
    if (entry.type !== 'response_item') continue;
    if (payload.type === 'message' && ['user', 'assistant'].includes(String(payload.role))) {
      if (payload.channel === 'analysis') continue;
      const content = text(payload.content);
      if (content) messages.push({ role: payload.role, text: content });
    } else if (['function_call', 'custom_tool_call'].includes(String(payload.type)) && typeof payload.call_id === 'string') {
      const call = { role: 'tool_call', call_id: payload.call_id, name: payload.name,
        input: payload.type === 'function_call' ? payload.arguments : payload.input };
      calls.set(payload.call_id, call);
      messages.push(call);
    } else if (['function_call_output', 'custom_tool_call_output'].includes(String(payload.type)) && typeof payload.call_id === 'string') {
      const call = calls.get(payload.call_id);
      if (call) {
        call.completed = true;
        messages.push({ role: 'tool_result', call_id: payload.call_id, text: text(payload.output) });
      }
    }
  }
  if (!metadata || metadata.id !== threadId) throw new DshError('CODEX_IDENTITY', 'Codex rollout does not match the requested thread ID.');
  if (typeof metadata.cwd !== 'string' || realpathSync(metadata.cwd) !== realpathSync(workspace)) {
    throw new DshError('CODEX_WORKSPACE', 'Codex thread cwd must match the configured workspace_root.');
  }
  const visible = messages.filter(item => item.role !== 'tool_call' || item.completed === true)
    .map(({ completed: _completed, ...item }) => item);
  return { source: 'codex-local-rollout', thread_id: threadId, cli_version: metadata.cli_version,
    history_kind: 'visible_archive', compactions, messages: visible };
}

/** Resolve by exact thread UUID and metadata, never by recency or conversation contents. */
function readRolloutSnapshot(options: { threadId: string; codexHome?: string }): string {
  if (!uuid.test(options.threadId)) throw new DshError('CODEX_IDENTITY', 'A valid Codex thread UUID is required.');
  const root = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  const matches: string[] = [];
  const scan = (directory: string, depth: number) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) scan(path, depth + 1);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('-' + options.threadId + '.jsonl')) matches.push(path);
    }
  };
  scan(join(root, 'sessions'), 0);
  if (matches.length !== 1) throw new DshError('CODEX_SOURCE', 'Expected exactly one local rollout for this thread; found ' + matches.length + '.');
  const fd = openSync(matches[0]!, 'r');
  let data: string;
  try {
    const size = fstatSync(fd).size;
    if (size > 64 * 1024 * 1024) throw new DshError('CODEX_SIZE', 'Codex rollout exceeds the 64 MiB reader limit. Supply a summary explicitly.');
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (!count) break;
      offset += count;
    }
    data = bytes.subarray(0, offset).toString('utf8');
  } finally { closeSync(fd); }
  return data;
}

export function readCodexContext(options: { threadId: string; codexHome?: string; workspace: string; maxChars: number }) {
  const snapshot = parseCodexRollout(readRolloutSnapshot(options), options.threadId, options.workspace);
  const serialized = JSON.stringify(snapshot);
  if (serialized.length > options.maxChars) throw new DshError('CONTEXT_TOO_LARGE', 'Codex visible history exceeds max_context_chars. Supply a summary or raise the configured limit.');
  return { context: serialized, thread_id: options.threadId, message_count: snapshot.messages.length,
    chars: serialized.length, compactions: snapshot.compactions };
}

/** Read genuine caller attribution for a same-chat desktop callback, without exporting conversation text. */
export function readCodexCaller(options: { threadId: string; codexHome?: string; workspace: string }) {
  const data = readRolloutSnapshot(options);
  const lines = data.split('\n');
  if (!data.endsWith('\n')) lines.pop();
  let meta: Item | undefined;
  let turnId: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry.type === 'session_meta') meta = entry.payload;
    if ((entry.type === 'turn_context' || (entry.type === 'event_msg' && entry.payload?.type === 'task_started')) && typeof entry.payload?.turn_id === 'string') turnId = entry.payload.turn_id;
  }
  if (meta?.id !== options.threadId || typeof meta.cwd !== 'string' || realpathSync(meta.cwd) !== realpathSync(options.workspace)) {
    throw new DshError('CODEX_IDENTITY', 'Cannot verify the callback chat and workspace.');
  }
  if (!turnId) throw new DshError('CODEX_IDENTITY', 'The callback chat has no recorded turn identity.');
  return { threadId: options.threadId, turnId };
}
