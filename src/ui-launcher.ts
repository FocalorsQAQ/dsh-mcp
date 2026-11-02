import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { projectRoot, type Config } from './config.ts';

/** Launch separately from MCP so the renderer cannot write to the protocol's stdout. */
export async function launchControlUi(config: Config, configPath?: string, sessionId?: string): Promise<void> {
  if (!config.ui_auto_start) return;
  // An installed companion owns automatic startup, independently of lazy MCP connections.
  // Leave a panel the user closed alone until the next Codex desktop process starts.
  if (process.platform === 'win32' && configPath) {
    try {
      const receipt = JSON.parse(readFileSync(join(projectRoot, 'ui-startup-registration.json'), 'utf8'));
      if (receipt.registered === true && typeof receipt.config === 'string' &&
          resolve(receipt.config).toLowerCase() === resolve(configPath).toLowerCase()) return;
    } catch { /* Source/manual installs without a companion retain the MCP fallback. */ }
  }
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
