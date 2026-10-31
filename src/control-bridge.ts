import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.ts';
import type { AgentTools } from './control.ts';

/** One loopback MCP connection per worker; the capability binds all calls to its task tree. */
export async function startControlBridge(tools: AgentTools) {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from('Bearer ' + token);
  const caller = tools.list().agents[0]!;
  const mcp = createServer(tools, 'You are the external agent ' + caller.path + ' (' + caller.id + '). ' +
    'Your max_depth=' + caller.max_depth + ', max_children=' + caller.max_children + '. ' +
    'spawn_agent always creates your direct child; omit parent. You can only inspect or control your task tree. ' +
    'Secondary delegation must use your own model and API source; omit model to inherit them. Reasoning effort defaults to yours; an explicit effort must be declared for your model. This uses dsh-managed Harness workers, not Harness native subagent tools. ' +
    'Use wait_agent and read_agent to collect child results. Child completion messages to Codex are disabled by default.');
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  await mcp.connect(transport);
  const http = createHttpServer((req, res) => {
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (req.url !== '/mcp' || actual.length !== expected.length || !timingSafeEqual(actual, expected) || req.headers.origin) {
      res.writeHead(403); res.end(); return;
    }
    void transport.handleRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve(); });
    });
  } catch (error) { await mcp.close(); throw error; }
  const address = http.address();
  if (!address || typeof address === 'string') { await mcp.close(); http.close(); throw new Error('Cannot start worker control bridge.'); }
  let closing: Promise<void> | undefined;
  return {
    url: 'http://127.0.0.1:' + address.port + '/mcp', token,
    close() {
      closing ??= (async () => {
        await mcp.close();
        http.closeAllConnections();
        await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      })();
      return closing;
    },
  };
}
