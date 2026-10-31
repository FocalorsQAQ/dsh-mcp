import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve as absolute } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { CredentialRegistry, type CredentialCipher } from './credentials.ts';
import { projectRoot } from './config.ts';
import { DshError } from './types.ts';

/** One-shot local pipe, never stdout. OS decryption does not require the UI to be open. */
export const createHostCipher = (directory: string): CredentialCipher => ({
  available: async () => process.platform === 'win32',
  encrypt: async () => { throw new DshError('API_ENCRYPTION', 'Use the API management window to add keys.'); },
  decrypt: bytes => new Promise((resolve, reject) => {
    const pipe = '\\\\.\\pipe\\dsh-credential-' + randomBytes(32).toString('hex');
    let socket: Socket | undefined, child: ReturnType<typeof spawn> | undefined, done = false;
    const finish = (secret?: string) => {
      if (done) return; done = true; clearTimeout(timer); socket?.destroy(); server.close();
      if (!secret) child?.kill();
      if (secret) resolve(secret); else reject(new DshError('API_ENCRYPTION', 'Cannot unlock API credential.'));
    };
    const server = createServer(connection => {
      if (socket || done) { connection.destroy(); return; }
      socket = connection; let data = '';
      connection.setEncoding('utf8');
      connection.on('data', value => { data += value; if (data.length > 24000) finish(); });
      connection.on('error', () => finish());
      connection.on('end', () => { try { const value = JSON.parse(data); data = ''; finish(typeof value.secret === 'string' ? value.secret : undefined); } catch { finish(); } });
      connection.write(bytes.toString('base64') + '\n');
    });
    const timer = setTimeout(() => finish(), 15000);
    server.on('error', () => finish());
    server.listen(pipe, () => {
      try {
      const executable = createRequire(import.meta.url)('electron') as string;
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(executable, ['--no-sandbox', '--disable-gpu', join(projectRoot, 'desktop/credential-helper.cjs'), '--dsh-pipe=' + pipe, '--dsh-home=' + absolute(directory, 'desktop')],
        { env, windowsHide: true, stdio: 'ignore' });
      child.on('error', () => finish());
      child.on('exit', () => { if (!socket) finish(); });
      } catch { finish(); }
    });
  }),
});
export const hostCredentials = (directory: string) => new CredentialRegistry(join(directory, 'credentials.json'), createHostCipher(directory));
