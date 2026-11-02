import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [join(root, 'desktop', 'main.mjs'), ...process.argv.slice(2)], {
  cwd: root, detached: true, stdio: 'ignore', windowsHide: true, env,
});
await once(child, 'spawn'); child.unref();
process.stdout.write(process.argv.includes('--quit') ? 'dsh 控制窗关闭请求已发送。\n' : 'dsh 控制窗已启动。可立即配置下一轮任务。\n');
