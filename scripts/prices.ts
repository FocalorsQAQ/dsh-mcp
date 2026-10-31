import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { PriceCatalog } from '../src/prices.ts';

const { values } = parseArgs({ options: { edit: { type: 'string' }, directory: { type: 'string' } } });
const catalog = new PriceCatalog(values.directory);
const snapshot = catalog.snapshot();
if (values.edit) {
  const file = snapshot.files.find(file => file.provider === values.edit);
  if (!file) throw new Error('Use: pnpm prices:edit deepseek   OR   pnpm prices:edit openai');
  const editor = process.platform === 'win32' ? 'notepad.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  // Explicit user command: show the selected price file in the OS editor.
  const child = spawn(editor, [file.path], { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
  child.on('error', () => { process.stderr.write('Cannot open an editor. Edit this file directly: ' + file.path + '\n'); process.exitCode = 1; });
  child.unref();
  process.stdout.write(file.path + '\nNew requests reload saved prices automatically. Run pnpm prices:check to validate.\n');
} else {
  for (const file of snapshot.files) {
    process.stdout.write(file.provider + ': ' + (!file.valid ? 'INVALID' : file.expired ? 'EXPIRED' : 'OK') + '\n' + file.path + '\n');
    if (file.error) process.stdout.write(file.error + '\n');
    if (file.valid_until) process.stdout.write('Valid until: ' + file.valid_until + '\n');
  }
  process.stdout.write('Rates per 1,000,000 tokens: [uncached input, cached input, output]. USD and CNY are independent.\n');
  if (snapshot.files.some(file => !file.valid || file.expired)) process.exitCode = 1;
}
