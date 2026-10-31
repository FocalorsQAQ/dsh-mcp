// Host-only OS decryptor. No windows, renderer, network API calls, or reveal IPC.
const { app, safeStorage } = require('electron');
const path = require('node:path'), net = require('node:net');
const home = process.argv.find(value => value.startsWith('--dsh-home='))?.slice(11);
if (!home || !path.isAbsolute(home)) app.exit(1);
else app.setPath('userData', home);
app.whenReady().then(() => {
  const pipe = process.argv.find(value => value.startsWith('--dsh-pipe='))?.slice(11);
  if (!pipe?.startsWith('\\\\.\\pipe\\dsh-credential-')) return app.exit(1);
  const socket = net.createConnection(pipe);
  let input = '', running = false;
  socket.setEncoding('utf8');
  socket.on('error', () => app.exit(1));
  socket.on('close', () => app.quit());
  socket.on('data', async chunk => {
    if (running) return;
    input += chunk;
    if (input.length > 24000) return app.exit(1);
    if (!input.includes('\n')) return;
    running = true;
    try {
      const available = await safeStorage.isAsyncEncryptionAvailable();
      if (!available) throw new Error();
      const plain = (await safeStorage.decryptStringAsync(Buffer.from(input.trim(), 'base64'))).result;
      socket.end(JSON.stringify({ secret: plain }));
    } catch { socket.end(JSON.stringify({ error: 'API_ENCRYPTION' })); }
  });
});
