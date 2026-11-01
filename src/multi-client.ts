import { createConnection, createServer as createSocketServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig, projectRoot, type Config } from './config.ts';
import { createApplication } from './application.ts';
import { startUiBridge } from './ui-bridge.ts';
import { launchControlUi } from './ui-launcher.ts';
import { sessionConfig, sessionDirectory, selectedSessionId, writeSessionInfo } from './sessions.ts';
import { handshakeLine, SocketMcpTransport } from './socket-transport.ts';
import { DshError, errorText } from './types.ts';

const endpointSchema = z.object({ version: z.literal(1), host_id: z.uuid(), pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/), fingerprint: z.string(), session_id: z.string() }).strict();
const authSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), session_id: z.string(),
  app_tools_pipe: z.string().max(4096).optional() }).strict();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const fingerprint = (config: Config) => createHash('sha256').update(JSON.stringify({ config, root: projectRoot,
  version: JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version })).digest('hex');

async function connect(directory: string, id: string, expected: string): Promise<Socket> {
  const endpoint = endpointSchema.parse(JSON.parse(readFileSync(join(directory, 'mcp-endpoint.json'), 'utf8')));
  if (endpoint.session_id !== id) throw new DshError('SESSION_PATH', 'Session endpoint does not match its chat.');
  const socket = createConnection({ host: '127.0.0.1', port: endpoint.port });
  socket.on('error', () => {}); // Lifecycle errors are handled by the waiting connection/handshake.
  const timeout = setTimeout(() => socket.destroy(new Error('Local connection timed out.')), 1500);
  try {
    await once(socket, 'connect'); clearTimeout(timeout);
    const reply = handshakeLine(socket);
    socket.write(JSON.stringify({ token: endpoint.token, session_id: id,
      ...(process.env.CODEX_APP_TOOLS_PIPE_PATH ? { app_tools_pipe: process.env.CODEX_APP_TOOLS_PIPE_PATH } : {}) }) + '\n');
    if (!(await reply as { ok?: boolean })?.ok) throw new Error('Local session authentication failed.');
    if (endpoint.fingerprint !== expected) throw new DshError('SESSION_CONFIG_CHANGED', 'This chat still has a service using older settings. Close its MCP connections and retry after the idle timeout.');
    return socket;
  } catch (error) { clearTimeout(timeout); socket.destroy(); throw error; }
}

async function proxy(base: Config, id: string, args: string[]) {
  const directory = sessionDirectory(base.data_dir, id, true), expected = fingerprint(base);
  let socket: Socket | undefined, started = false;
  const deadline = Date.now() + 15000;
  while (!socket && Date.now() < deadline) {
    try { socket = await connect(directory, id, expected); }
    catch (error) {
      if (error instanceof DshError) throw error;
      if (!started) {
        started = true;
        const log = openSync(join(directory, 'host.log'), 'a', 0o600);
        try {
          const child = spawn(process.execPath, [join(projectRoot, 'packaging/launch-server.mjs'), ...args,
            '--serve-session', '--session-id', id], { detached: true, windowsHide: true,
            stdio: ['ignore', 'ignore', log], env: process.env, cwd: process.cwd() });
          await once(child, 'spawn'); child.unref();
        } finally { closeSync(log); }
      }
      await delay(100);
    }
  }
  if (!socket) throw new DshError('SESSION_START', 'The chat service did not start. See host.log in its chat data directory.');
  const connection = socket;
  const stop = () => connection.destroy();
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.stdout.once('error', stop);
  try {
    const closed = new Promise<void>(resolve => connection.once('close', () => resolve()));
    connection.pipe(process.stdout, { end: false }); process.stdin.pipe(connection); connection.resume();
    await closed;
  } finally {
    process.stdin.unpipe(connection); process.stdin.pause(); connection.unpipe(process.stdout); connection.destroy();
    process.off('SIGINT', stop); process.off('SIGTERM', stop); process.stdout.off('error', stop);
  }
}

async function host(base: Config, id: string, configPath?: string) {
  const config = sessionConfig(base, id), application = createApplication(config);
  let bridge;
  try { bridge = await startUiBridge(application.ui, config.data_dir); }
  catch (error) { await application.close(); throw error; }
  const hostId = randomUUID(), token = randomBytes(32).toString('hex');
  const endpointPath = join(config.data_dir, 'mcp-endpoint.json');
  const sockets = new Set<Socket>();
  const servers = new Set<ReturnType<typeof application.createMcpServer>>();
  let lastDisconnect = Date.now(), uiStarted = false, closing: Promise<void> | undefined;
  const listener = createSocketServer(socket => {
    if (closing || sockets.size >= 64) { socket.destroy(); return; }
    sockets.add(socket); socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); lastDisconnect = Date.now(); });
    void (async () => {
      let server: ReturnType<typeof application.createMcpServer> | undefined;
      try {
        const auth = authSchema.parse(await handshakeLine(socket));
        if (auth.session_id !== id || !timingSafeEqual(Buffer.from(auth.token, 'hex'), Buffer.from(token, 'hex'))) throw new Error('Unauthorized local connection.');
        if (auth.app_tools_pipe) process.env.CODEX_APP_TOOLS_PIPE_PATH = auth.app_tools_pipe;
        if (closing || socket.destroyed) { socket.destroy(); return; }
        server = application.createMcpServer(id === 'discovery'); servers.add(server);
        const connectionServer = server;
        server.server.onclose = () => { servers.delete(connectionServer); void connectionServer.close().catch(() => {}); };
        server.server.oninitialized = () => {
          if (closing || uiStarted || id === 'discovery') return;
          uiStarted = true;
          void launchControlUi(base, configPath, id).catch(error => process.stderr.write('[dsh UI] ' + errorText(error) + '\n'));
        };
        socket.write('{"ok":true}\n');
        await server.connect(new SocketMcpTransport(socket));
      } catch {
        if (server) { servers.delete(server); await server.close().catch(() => {}); }
        socket.destroy();
      }
    })();
  });
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const shutdown = () => closing ??= (async () => {
    clearInterval(idleTimer);
    if (listener.listening) listener.close();
    for (const server of servers) await server.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    try { await bridge.close(); } finally { await application.close(); }
    try { if (JSON.parse(readFileSync(endpointPath, 'utf8')).host_id === hostId) unlinkSync(endpointPath); } catch { /* Another generation owns cleanup. */ }
  })();
  const stop = () => { void shutdown().catch(error => { process.stderr.write('[dsh] ' + errorText(error) + '\n'); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Local session listener failed.');
    writeSessionInfo(base.data_dir, { version: 1, id, workspace: base.workspace_root, created_at: new Date().toISOString(), pid: process.pid });
    const temporary = endpointPath + '.' + hostId + '.tmp';
    writeFileSync(temporary, JSON.stringify({ version: 1, host_id: hostId, pid: process.pid, port: address.port,
      token, fingerprint: fingerprint(base), session_id: id }), { mode: 0o600 }); renameSync(temporary, endpointPath);
    idleTimer = setInterval(() => {
      if (sockets.size || Date.now() - lastDisconnect < base.session_idle_timeout_ms) return;
      try { if (application.ui.snapshot().runtime.active_count > 0) return; } catch { /* Stop a failed host cleanly. */ }
      stop();
    }, Math.min(1000, base.session_idle_timeout_ms));
    idleTimer.unref();
    await once(listener, 'close');
    await closing;
  } catch (error) { await shutdown(); throw error; }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

/** One stdio adapter per Codex connection, one shared worker host per chat. */
export async function multiClientMain(): Promise<void> {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' }, workspace: { type: 'string' }, 'data-dir': { type: 'string' },
      'session-id': { type: 'string' }, 'serve-session': { type: 'boolean' } } });
    const configPath = values.config ?? process.env.DSH_MCP_CONFIG;
    const base = loadConfig(configPath, { workspace: values.workspace, dataDir: values['data-dir'] });
    const id = selectedSessionId(base, values['session-id']);
    if (values['serve-session']) await host(base, id, configPath);
    else await proxy(base, id, process.argv.slice(2).filter((arg, index, args) => arg !== '--session-id' && !arg.startsWith('--session-id=') && args[index - 1] !== '--session-id'));
  } catch (error) { process.stderr.write('[dsh] ' + errorText(error) + '\n'); process.exitCode = 1; }
}
