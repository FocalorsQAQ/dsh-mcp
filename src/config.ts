import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DshError } from './types.ts';
import { policySchema } from './control-contract.ts';
import { billingConfigSchema } from './billing.ts';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configSchema = z.object({
  workspace_root: z.string().default('.'),
  data_dir: z.string().default('.dsh-mcp'),
  ui_auto_start: z.boolean().default(process.platform === 'win32'),
  session_idle_timeout_ms: z.number().int().min(1000).max(1800000).default(60000),
  model_config_dir: z.string().optional(),
  model: z.string().min(1).default('deepseek-v4-flash'),
  provider: z.string().min(1).default('deepseek-official'),
  reasoning_effort: z.string().min(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  control: policySchema.default(() => policySchema.parse({})),
  billing: billingConfigSchema.default(() => billingConfigSchema.parse({})),
  max_concurrent_agents: z.number().int().min(1).max(32).default(4),
  max_agents: z.number().int().min(1).max(1000).default(100),
  max_pending_messages: z.number().int().min(1).max(1000).default(64),
  max_events: z.number().int().min(10).max(10000).default(1000),
  max_context_chars: z.number().int().min(1000).max(10000000).default(1000000),
  codex_home: z.string().optional(),
  codex_thread_id: z.uuid().optional(),
  completion_delivery: z.object({
    mode: z.enum(['off', 'app_tools', 'codex_queue']).default('off'),
    thread_id: z.uuid().optional(),
    command: z.string().min(1).optional(),
    max_chars: z.number().int().min(500).max(12000).default(6000),
    timeout_ms: z.number().int().min(1000).max(60000).default(15000),
  }).strict().default({ mode: 'off', max_chars: 6000, timeout_ms: 15000 }),
  initialize_timeout_ms: z.number().int().min(1000).max(120000).default(30000),
  turn_timeout_ms: z.number().int().min(1000).max(86400000).default(1800000),
  permission_mode: z.enum(['read-only', 'workspace-write']).default('workspace-write'),
  dsh_bin: z.string().optional(),
  patches: z.array(z.string()).default([]),
  env_vars: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']),
}).strict();
export type Config = z.infer<typeof configSchema>;

export function loadConfig(configPath?: string, overrides: { workspace?: string; dataDir?: string } = {}): Config {
  const path = configPath ? resolve(configPath) : undefined;
  const base = path ? dirname(path) : process.cwd();
  const raw: unknown = path ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const config = configSchema.parse(raw);
  config.workspace_root = realpathSync(resolve(base, overrides.workspace ?? config.workspace_root));
  if (!statSync(config.workspace_root).isDirectory()) throw new DshError('CONFIG', 'workspace_root must be a directory.');
  config.data_dir = resolve(base, overrides.dataDir ?? config.data_dir);
  if (config.model_config_dir) config.model_config_dir = resolve(base, config.model_config_dir);
  config.billing.rules = resolve(base, config.billing.rules);
  if (config.billing.python.includes('/') || config.billing.python.includes('\\')) config.billing.python = resolve(base, config.billing.python);
  if (config.codex_home) config.codex_home = resolve(base, config.codex_home);
  config.patches = config.patches.map(patch => realpathSync(resolve(base, patch)));
  if (config.dsh_bin) config.dsh_bin = realpathSync(resolve(base, config.dsh_bin));
  return config;
}

/** Validate the actual directory, including junctions and symlinks, before launching a child. */
export function agentDirectory(config: Config, requested?: string): string {
  const path = realpathSync(resolve(config.workspace_root, requested ?? '.'));
  const rel = relative(config.workspace_root, path);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || !statSync(path).isDirectory()) {
    throw new DshError('WORKSPACE', 'Agent cwd must be an existing directory inside workspace_root.');
  }
  return path;
}

/** Forward operating-system essentials and explicit provider variables, not unrelated credentials. */
export function childEnvironment(config: Config): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'PROGRAMFILES',
    'PROGRAMFILES(X86)', 'PROGRAMDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM',
    ...config.env_vars.map(name => name.toUpperCase()),
  ]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
  env.DSH_PERMISSION_MODE = config.permission_mode;
  env.DSH_TELEMETRY_MODE = 'DISABLED';
  return env;
}
