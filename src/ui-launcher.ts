import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { projectRoot, type Config } from './config.ts';

/** Launch separately from MCP so the renderer cannot write to the protocol's stdout. */
export async function launchControlUi(config: Config, configPath?: string, sessionId?: string): Promise<void> {
  if (!config.ui_auto_start) return;
  const main = join(projectRoot, 'desktop/main.mjs');
  if (!existsSync(main) || !existsSync(join(projectRoot, 'dist-ui/index.html'))) {
    throw new Error('Control UI is missing. Build it with pnpm ui:build or reinstall the application.');
  }
  const require = createRequire(import.meta.url);
  const env = { ...process.env };
  // Codex may itself be Electron. Its Node-only mode must not reach our desktop app.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [main, '--auto-start',
    ...(configPath ? ['--config', resolve(configPath)] : []),
    '--workspace', config.workspace_root, '--data-dir', config.data_dir,
    ...(sessionId ? ['--session-id', sessionId] : []),
  ], { cwd: projectRoot, detached: true, stdio: 'ignore', windowsHide: true, env });
  await once(child, 'spawn');
  child.unref();
}
