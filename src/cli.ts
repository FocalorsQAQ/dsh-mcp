#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { createApplication } from './application.ts';
import { errorText } from './types.ts';
import { startUiBridge } from './ui-bridge.ts';
import { launchControlUi } from './ui-launcher.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    config: { type: 'string' }, workspace: { type: 'string' }, 'data-dir': { type: 'string' },
    doctor: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    process.stdout.write('dsh-mcp [--config path.json] [--workspace directory] [--data-dir directory]\n' +
      'Starts the dsh MCP server over stdio. Diagnostics go to stderr.\n' +
      'dsh-mcp --doctor   Print local configuration and dependency status, without calling a model.\n');
    return;
  }
  const configPath = values.config ?? process.env.DSH_MCP_CONFIG;
  const config = loadConfig(configPath, { workspace: values.workspace, dataDir: values['data-dir'] });
  if (values.doctor) {
    const require = createRequire(import.meta.url);
    const cliManifest = require.resolve('@deepseek-ai/dsh/package.json');
    const cli = JSON.parse(readFileSync(cliManifest, 'utf8'));
    const sdk = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-sdk-client/package.json'), 'utf8'));
    const bin = config.dsh_bin ?? resolve(dirname(cliManifest), cli.bin.dsh);
    process.stdout.write(JSON.stringify({
      server: 'dsh', node: process.version, cli_version: cli.version, sdk_version: sdk.version,
      versions_match: cli.version === sdk.version, cli_exists: existsSync(bin),
      workspace_root: config.workspace_root, data_dir: config.data_dir, model: config.model,
      provider: config.provider, permission_mode: config.permission_mode,
      api_key_present: Boolean(process.env.DEEPSEEK_API_KEY), base_url_override_present: Boolean(process.env.DEEPSEEK_BASE_URL),
      max_concurrent_agents: config.max_concurrent_agents,
    }, null, 2) + '\n');
    return;
  }
  const application = createApplication(config);
  let uiBridge: Awaited<ReturnType<typeof startUiBridge>>;
  try { uiBridge = await startUiBridge(application.ui, config.data_dir); }
  catch (error) { await application.close(); throw error; }
  const server = application.createMcpServer();
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  const shutdown = () => {
    closing ??= (async () => {
      // A failed UI shutdown must not skip worker/gateway cleanup.
      for (const close of [() => uiBridge.close(), () => application.close(), () => server.close()]) {
        try { await close(); }
        catch (error) {
          process.stderr.write('[dsh] Shutdown failed: ' + errorText(error) + '\n');
          process.exitCode = 1;
        }
      }
    })();
    return closing;
  };
  // EOF is the MCP client's ownership signal. Reap external workers before exiting.
  process.stdin.once('end', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  server.server.onclose = () => void shutdown();
  let uiStarted = false;
  server.server.oninitialized = () => {
    if (closing || uiStarted) return;
    uiStarted = true;
    // UI startup is optional and must never delay or fail the MCP handshake/tools.
    void launchControlUi(config, configPath).catch(error => {
      process.stderr.write('[dsh] Could not open the control window: ' + errorText(error) + '\n');
    });
  };
  try { await server.connect(transport); }
  catch (error) { await shutdown(); throw error; }
}

main().catch(error => { process.stderr.write('[dsh] ' + errorText(error) + '\n'); process.exitCode = 1; });
