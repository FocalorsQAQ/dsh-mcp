import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  workspace: { type: 'string' }, 'data-dir': { type: 'string' }, 'links-only': { type: 'boolean' },
} });
const inside = path => { const r = relative(root, path); return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
function safePath(value) {
  if (typeof value !== 'string' || !value.startsWith('node_modules/') || value.includes('\\')) throw new Error('Invalid runtime link.');
  const path = resolve(root, value); if (!inside(path)) throw new Error('Runtime link escapes installation.');
  return path;
}
const manifestPath = join(root, 'core-manifest.json');
if (!existsSync(manifestPath)) throw new Error('DeepSeek Harness CLI core is missing. Extract the matching core archive into this folder first.');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const app = JSON.parse(readFileSync(join(root, 'release-info.json'), 'utf8'));
if (manifest.core_version !== app.core_version || manifest.application_version !== app.version) throw new Error('Application/core versions do not match.');
// Check every target and parent before writing any link. Junctions require no administrator rights.
const links = manifest.links.map(({ path, target }) => {
  const from = safePath(path), to = safePath(target);
  if (!existsSync(to) || !inside(realpathSync(to))) throw new Error('Missing or external runtime dependency.');
  let parent = dirname(from);
  while (!existsSync(parent)) parent = dirname(parent);
  if (!inside(realpathSync(parent))) throw new Error('Runtime link parent escapes installation.');
  if (existsSync(from)) {
    if (!lstatSync(from).isSymbolicLink() || realpathSync(from) !== realpathSync(to)) throw new Error('Conflicting runtime dependency: ' + path);
  }
  return { from, to };
});
for (const { from, to } of links) {
  if (existsSync(from)) continue;
  mkdirSync(dirname(from), { recursive: true });
  symlinkSync(to, from, process.platform === 'win32' ? 'junction' : 'dir');
}
if (!values['links-only']) {
  const configPath = join(root, 'dsh.config.json');
  if (!existsSync(configPath)) {
    const workspace = resolve(values.workspace ?? join(process.env.USERPROFILE ?? root, 'Documents', 'dsh-workspace'));
    const dataDir = resolve(values['data-dir'] ?? join(process.env.LOCALAPPDATA ?? root, 'dsh-mcp', 'data'));
    mkdirSync(workspace, { recursive: true }); mkdirSync(dataDir, { recursive: true });
    const config = JSON.parse(readFileSync(join(root, 'dsh.config.example.json'), 'utf8'));
    config.workspace_root = workspace; config.data_dir = dataDir;
    config.billing.python = join(root, 'bin', 'python', 'python.exe');
    config.billing.rules = join(root, 'billing', 'rules.py');
    config.completion_delivery.mode = 'off';
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  }
  const q = value => JSON.stringify(value.replaceAll('\\', '/'));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const toml = [
    '# Add this section to your Codex MCP configuration. Existing settings are not modified automatically.',
    '[mcp_servers.dsh]', `command = ${q(join(root, 'bin/node/node.exe'))}`,
    `args = [${q(join(root, 'packaging/launch-server.mjs'))}, '--config', ${q(configPath)}]`,
    `cwd = ${q(config.workspace_root)}`,
    "env_vars = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'CODEX_THREAD_ID', 'CODEX_HOME', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_APP_RUNTIME_CLI_PATH']",
    'startup_timeout_sec = 30', 'tool_timeout_sec = 75', '',
  ].join('\n');
  writeFileSync(join(root, 'codex-mcp.toml'), toml);
}
console.log('Ready. Open Control UI.cmd. Codex configuration: codex-mcp.toml.');
