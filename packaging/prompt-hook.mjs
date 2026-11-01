import { parseArgs } from 'node:util';
import { loadConfig } from '../dist/config.js';
import { handlePromptSubmission } from '../dist/prompt-hook.js';

try {
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  if (!values.config) throw new Error('A dsh configuration is required.');
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 20_000_000) throw new Error('Hook input exceeds its limit.');
    chunks.push(chunk);
  }
  const result = handlePromptSubmission(loadConfig(values.config), JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  // Do not expose user prompts, credential errors, or local paths in hook output.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
    additionalContext: '[dsh] 外包已禁用：本轮配置快照未能保存。Do not delegate through dsh in this turn: the submission snapshot could not be captured. Fix the local hook and submit a new task.' } }) + '\n');
  process.exitCode = 0; // The main task may proceed; MCP enforces missing-snapshot denial separately.
}
