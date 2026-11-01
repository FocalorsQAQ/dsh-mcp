import { closeSync, openSync, readSync } from 'node:fs';
import { z } from 'zod';
import type { Config } from './config.ts';
import { TaskSnapshots, snapshotInstructions } from './task-snapshot.ts';

/** Only identity metadata is read; prompt text and conversation content are never persisted here. */
export function handlePromptSubmission(config: Config, value: unknown) {
  const input = z.object({ hook_event_name: z.literal('UserPromptSubmit'), session_id: z.uuid(), turn_id: z.uuid(),
    cwd: z.string().min(1), transcript_path: z.string().nullable().optional() }).parse(value);
  let chatId = input.session_id.toLowerCase();
  if (input.transcript_path) {
    // session_id can identify the session root for a fork. The supplied transcript identifies the exact chat.
    const fd = openSync(input.transcript_path, 'r');
    try {
      const buffer = Buffer.alloc(131072), count = readSync(fd, buffer, 0, buffer.length, 0);
      const first = buffer.subarray(0, count).toString('utf8').split('\n')[0]!;
      const meta = JSON.parse(first);
      if (meta.type !== 'session_meta') throw new Error('Missing transcript identity');
      chatId = z.uuid().parse(meta.payload?.id).toLowerCase();
    } finally { closeSync(fd); }
  }
  const snapshot = new TaskSnapshots(config).capture(chatId, input.turn_id, input.cwd);
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: snapshotInstructions(snapshot) } };
}
