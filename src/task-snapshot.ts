import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Config } from './config.ts';
import { OutsourcingSwitch } from './global-control.ts';
import { RuntimeModels } from './runtime-models.ts';
import { taskSnapshotSchema, type TaskSnapshot } from './control-contract.ts';
import { DshError } from './types.ts';
import { realDirectory } from './workspaces.ts';

export class TaskSnapshots {
  constructor(private readonly config: Config) {}
  get directory() { return this.config.control_config_dir ?? this.config.data_dir; }
  private chatDirectory(chatId: string) {
    const id = z.uuid().parse(chatId).toLowerCase();
    const root = join(this.directory, 'task-snapshots'), directory = join(root, id);
    for (const path of [root, directory]) {
      try { if (lstatSync(path).isSymbolicLink()) throw new DshError('TASK_SNAPSHOT_STORAGE', 'Snapshot directories must not be links.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return directory;
  }
  read(chatId: string, turnId?: string): TaskSnapshot {
    try {
      const directory = this.chatDirectory(chatId);
      const id = z.uuid().parse(turnId ?? JSON.parse(readFileSync(join(directory, 'current.json'), 'utf8')).turn_id).toLowerCase();
      const path = join(directory, id + '.json'), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error('Invalid snapshot');
      const snapshot = taskSnapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      if (snapshot.chat_id !== chatId.toLowerCase() || snapshot.turn_id !== id) throw new Error('Mismatched identity');
      return snapshot;
    } catch (error) {
      if (error instanceof DshError) throw error;
      throw new DshError('TASK_SNAPSHOT_REQUIRED', '本轮尚未捕获外包配置。请在 Codex 中启用 dsh 的任务提交钩子，然后发布新任务。No valid submission snapshot is available for this turn.');
    }
  }
  capture(chatId: string, turnId: string, callerCwd: string): TaskSnapshot {
    chatId = z.uuid().parse(chatId).toLowerCase(); turnId = z.uuid().parse(turnId).toLowerCase();
    // Repeated prompt hooks/steering within one turn cannot refresh its limits or budget.
    try { return this.read(chatId, turnId); } catch (error) {
      if (!(error instanceof DshError) || error.code !== 'TASK_SNAPSHOT_REQUIRED') throw error;
    }
    const control = new OutsourcingSwitch(this.directory, this.config.billing.python, this.config.control);
    const selection = new RuntimeModels(this.config);
    let defaults = control.snapshot();
    let registry = selection.managed ? selection.registry.snapshot() : null;
    let stable = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const nextDefaults = control.snapshot(), nextRegistry = selection.managed ? selection.registry.snapshot() : null;
      if (nextDefaults.revision === defaults.revision && nextRegistry?.revision === registry?.revision) { stable = true; break; }
      defaults = nextDefaults; registry = nextRegistry;
    }
    if (!stable) throw new DshError('TASK_SNAPSHOT_STORAGE', 'Settings changed repeatedly while capturing this submission.');
    const models = registry?.entries.filter(row => row.effective_enabled).map(({ api_name, source_available, effective_enabled, verification_valid, ...entry }) => entry) ?? null;
    const snapshot = taskSnapshotSchema.parse({ version: 1, chat_id: chatId, turn_id: turnId, caller_cwd: realDirectory(callerCwd),
      captured_at: new Date().toISOString(), settings_revision: defaults.revision, settings: defaults.settings,
      model_revision: registry?.revision ?? null, models, legacy_model: this.config.model, legacy_effort: this.config.reasoning_effort });
    this.chatDirectory(chatId);
    const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
    const result = spawnSync(this.config.billing.python, ['-I', '-B', fileURLToPath(new URL('../runtime/task_snapshot.py', import.meta.url))], {
      input: JSON.stringify({ directory: this.directory, snapshot }), encoding: 'utf8', timeout: 5000,
      maxBuffer: 2_000_000, windowsHide: true, shell: false, env,
    });
    if (result.error || result.status !== 0) throw new DshError('TASK_SNAPSHOT_STORAGE', 'Cannot persist the submission snapshot.');
    const response = JSON.parse(result.stdout);
    if (response.ok !== true) throw new DshError('TASK_SNAPSHOT_STORAGE', 'Cannot persist the submission snapshot.');
    const saved = taskSnapshotSchema.parse(response.snapshot);
    if (saved.chat_id !== chatId || saved.turn_id !== turnId) throw new DshError('TASK_SNAPSHOT_STORAGE', 'Snapshot identity mismatch.');
    return saved;
  }
}

export function snapshotInstructions(snapshot: TaskSnapshot): string {
  const policy = snapshot.settings;
  const models = snapshot.models?.map(row => ({ model: row.model_id, reasoning_efforts: row.reasoning_levels })) ??
    [{ model: snapshot.legacy_model, reasoning_efforts: snapshot.legacy_effort ? [snapshot.legacy_effort] : [] }];
  return '[dsh task configuration / 本轮外包配置]\n' + JSON.stringify({ turn_id: snapshot.turn_id, settings_revision: snapshot.settings_revision,
    enabled: policy.enabled, max_root_agents: policy.max_root_agents, allow_secondary: policy.allow_secondary,
    restrict_to_caller_workspace: policy.restrict_to_caller_workspace, caller_workspace: snapshot.caller_cwd,
    max_depth_user: policy.max_depth_user, max_children_user: policy.max_children_user,
    round_budget: policy.round_budget, task_budget: policy.task_budget, billing_currency: policy.billing_currency, models }) + '\n' +
    (policy.enabled ? '本轮可使用 dsh。' : '外包已禁用。本轮不要调用 dsh 外包工具。') +
    ' Use create_workspace to register an existing local project or create a directory, then pass its workspace_id to spawn_agent. When restrict_to_caller_workspace is true, workspaces must stay within caller_workspace. Only the main agent can register workspaces; descendants inherit their parent workspace. This immutable snapshot applies to this host turn and all of its external descendants. UI edits apply to later submissions only. User shutdown of the DSH service immediately revokes even existing snapshots and stops all agents; re-enabling never restores an old turn. Budgets are [USD,CNY], enforced by code and shared across this main-agent turn. Read dsh.get_status for remaining budget; do not infer permission from old tool descriptions. No model argument can replace the host-bound snapshot.';
}
