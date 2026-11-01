import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRegistry } from './model-config.ts';
import { hostCredentials } from './host-credentials.ts';
import { DshError } from './types.ts';
import type { Config } from './config.ts';
import type { ModelRow, ModelEntry } from './model-config-contract.ts';

export type ModelBinding = Pick<ModelRow, 'id' | 'api_id' | 'model_id' | 'source_protocol' | 'source_base_url'>;
export class RuntimeModels {
  readonly registry: ModelRegistry;
  readonly directory: string;
  constructor(config: Config) {
    this.directory = config.model_config_dir ?? config.data_dir;
    this.registry = new ModelRegistry(join(this.directory, 'model-config.json'), hostCredentials(this.directory));
  }
  get managed() { return existsSync(join(this.directory, 'model-config.json')); }
  selected() { return this.registry.snapshot().entries.filter(entry => entry.effective_enabled); }
  resolve(model: string, effort?: string, binding?: ModelBinding, snapshot?: ModelEntry[] | null) {
    if (snapshot === null) {
      if (binding) throw new DshError('MODEL_ROUTE_CHANGED', 'This task snapshot does not contain the saved model source.');
      return undefined;
    }
    if (snapshot === undefined && !this.managed && !binding) return undefined;
    let row: ModelRow | undefined;
    if (snapshot !== undefined) {
      const entry = snapshot.find(item => item.model_id === model);
      if (entry) {
        const api = hostCredentials(this.directory).metadata().find(api => api.id === entry.api_id);
        if (!api || api.protocol !== entry.source_protocol || api.base_url !== entry.source_base_url) throw new DshError('MODEL_ROUTE_CHANGED', 'The snapshot API source was removed or changed.');
        row = { ...entry, api_name: api.name, source_available: true, effective_enabled: true, verification_valid: entry.verified };
      }
    } else row = this.selected().find(entry => entry.model_id === model);
    if (!row) throw new DshError('MODEL_DISABLED', 'Model is not enabled: ' + model);
    if (effort !== undefined && !row.reasoning_levels.includes(effort)) throw new DshError('MODEL_EFFORT', 'Undeclared reasoning effort for model: ' + model);
    if (binding && JSON.stringify(this.bind(row)) !== JSON.stringify(binding)) throw new DshError('MODEL_ROUTE_CHANGED', 'The saved agent model source changed; create a new agent.');
    return row;
  }
  bind(row: ModelRow): ModelBinding { return { id: row.id, api_id: row.api_id, model_id: row.model_id,
    source_protocol: row.source_protocol, source_base_url: row.source_base_url }; }
  currency(model: string, snapshot?: ModelEntry[] | null): 'USD' | 'CNY' | undefined {
    const row = this.resolve(model, undefined, undefined, snapshot);
    if (!row) return undefined;
    if (row.model_id.startsWith('deepseek-') && row.source_protocol === 'deepseek' && row.source_base_url === 'https://api.deepseek.com') return 'CNY';
    if (row.model_id === 'gpt-5-mini' && ['openai_responses', 'openai_chat'].includes(row.source_protocol) && row.source_base_url === 'https://api.openai.com/v1') return 'USD';
    throw new DshError('MODEL_UNPRICED', 'This endpoint needs a reviewed billing adapter before agent dispatch.');
  }
}
