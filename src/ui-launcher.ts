import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { projectRoot, type Config } from './config.ts';

const execute = promisify(execFile);

/** Check the live Windows companion, repairing only an installation that already owns startup. */
export async function ensureDesktopCompanion(configPath: string, root = projectRoot): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const receipt = JSON.parse(readFileSync(join(root, 'ui-startup-registration.json'), 'utf8'));
    if (receipt.registered !== true || typeof receipt.config !== 'string' ||
        resolve(receipt.config).toLowerCase() !== resolve(configPath).toLowerCase()) return false;
  } catch { return false; }
  const bundledPython = join(root, 'bin/python/python.exe');
  await execute(existsSync(bundledPython) ? bundledPython : 'python', ['-I', '-B',
    join(root, 'runtime/codex_watch.py'), '--root', root, '--config', resolve(configPath), '--ensure-running'],
  { cwd: root, windowsHide: true, timeout: 25000, maxBuffer: 65536 });
  return true;
}

/** Launch separately from MCP so the renderer cannot write to the protocol's stdout. */
export async function launchControlUi(config: Config, configPath?: string, sessionId?: string): Promise<void> {
  if (!config.ui_auto_start) return;
  // A registration receipt alone cannot prove the listener survived a Codex restart.
  // A healthy companion preserves manual closure until the next desktop generation.
  if (process.platform === 'win32' && configPath) {
    try {
      if (await ensureDesktopCompanion(configPath)) return;
    } catch {
      process.stderr.write('[dsh UI] Desktop companion unavailable; opening the control window directly.\n');
    }
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
  // Do not apply STARTUPINFO/SW_HIDE to a GUI executable: it can defeat BrowserWindow.show().
  ], { cwd: projectRoot, detached: true, stdio: 'ignore', windowsHide: false, env });
  await once(child, 'spawn');
  child.unref();
}
