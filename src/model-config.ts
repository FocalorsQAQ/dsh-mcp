import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DshError } from './types.ts';
import { CredentialRegistry } from './credentials.ts';
import type { ApiEntry } from './credential-contract.ts';
import { modelSaveSchema, modelToggleSchema, modelRemoveSchema, modelEntrySchema, probeReceiptSchema,
  type ModelDraft, type ModelConfigSnapshot, type ProbePlan, type ProbeReceipt } from './model-config-contract.ts';
import { probeModel, probeRequest } from './model-probe.ts';

const schema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative().safe(),
  entries: z.array(modelEntrySchema).max(500), attempts: z.array(probeReceiptSchema).max(100) }).strict();
type State = z.infer<typeof schema>;
type Pending = { plan: ProbePlan; api: ApiEntry; revision: number };
export class ModelRegistry {
  private queue: Promise<unknown> = Promise.resolve();
  private plans = new Map<string, Pending>();
  private active = new Map<string, AbortController>();
  constructor(private readonly path: string, private readonly credentials: CredentialRegistry, private readonly fetcher: typeof fetch = fetch) {}
  private read(): State {
    try {
      if (statSync(this.path).size > 2_000_000) throw new Error('Size');
      const state = schema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      const enabled = state.entries.filter(item => item.enabled).map(item => item.model_id);
      if (new Set(enabled).size !== enabled.length || new Set(state.entries.map(item => item.id)).size !== state.entries.length) throw new Error('Duplicates');
      for (const attempt of state.attempts) if (attempt.status === 'pending' && !this.active.has(attempt.id)) {
        attempt.status = 'unknown'; attempt.error_code = 'MODEL_VERIFY_UNKNOWN'; attempt.finished_at = new Date().toISOString();
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, revision: 0, entries: [], attempts: [] };
      throw new DshError('MODEL_STORAGE', 'Cannot read model configuration.');
    }
  }
  private check(state: State, expected: number) { if (state.revision !== expected) throw new DshError('MODEL_CONFLICT', 'Model configuration changed.'); }
  private write(state: State) {
    this.check(this.read(), state.revision);
    const next = schema.parse({ ...state, revision: state.revision + 1 });
    const temp = this.path + '.' + randomUUID() + '.tmp';
    try { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); renameSync(temp, this.path); }
    catch { throw new DshError('MODEL_STORAGE', 'Cannot save model configuration.'); }
    finally { try { unlinkSync(temp); } catch {} }
    state.revision = next.revision;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> { const work = this.queue.then(action); this.queue = work.catch(() => {}); return work; }
  snapshot(): ModelConfigSnapshot {
    const state = this.read(), apis = this.credentials.metadata();
    return { revision: state.revision, apis, attempts: state.attempts,
      entries: state.entries.map(entry => {
        const api = apis.find(api => api.id === entry.api_id);
        const available = !!api && api.protocol === entry.source_protocol && api.base_url === entry.source_base_url;
        return { ...entry, api_name: api?.name ?? null, source_available: available,
          effective_enabled: entry.enabled && available, verification_valid: entry.verified && available };
      }) };
  }
  async list(): Promise<ModelConfigSnapshot> { return this.snapshot(); }
  private async validate(input: unknown) {
    const command = modelSaveSchema.parse(input), state = this.read(); this.check(state, command.expected_revision);
    if (state.entries.length >= 500) throw new DshError('MODEL_CAPACITY', 'Model list full.');
    if (state.entries.some(item => item.api_id === command.draft.api_id && item.model_id === command.draft.model_id)) throw new DshError('MODEL_DUPLICATE', 'This API/model pair already exists.');
    const api = (await this.credentials.list()).entries.find(api => api.id === command.draft.api_id);
    if (!api) throw new DshError('API_NOT_FOUND', 'Source API missing.');
    const draft = command.draft;
    if (api.protocol === 'deepseek') draft.reasoning_levels = ['none', 'low', 'high', 'max'];
    else if (draft.reasoning_levels === null) throw new DshError('MODEL_REASONING', 'Declare reasoning levels or no reasoning support.');
    return { draft, api, state };
  }
  private append(state: State, draft: ModelDraft, api: ApiEntry, verificationId: string | null) {
    state.entries.push({ ...draft, reasoning_levels: draft.reasoning_levels ?? [], id: randomUUID(), enabled: false,
      verified: verificationId !== null, verification_id: verificationId, created_at: new Date().toISOString(), source_protocol: api.protocol, source_base_url: api.base_url });
  }
  save(input: unknown) { return this.serial(async () => {
    const { draft, api, state } = await this.validate(input); this.append(state, draft, api, null); this.write(state); return this.list();
  }); }
  toggle(input: unknown) { return this.serial(async () => {
    const command = modelToggleSchema.parse(input), state = this.read(); this.check(state, command.expected_revision);
    const entry = state.entries.find(item => item.id === command.id);
    if (!entry) throw new DshError('MODEL_NOT_FOUND', 'Model removed.');
    const rows = await this.list();
    if (command.enabled && !rows.entries.find(item => item.id === entry.id)?.source_available) throw new DshError('MODEL_SOURCE', 'Source API changed or removed.');
    if (command.enabled && state.entries.some(item => item.id !== entry.id && item.enabled && rows.entries.find(row => row.id === item.id)?.source_available && item.model_id === entry.model_id))
      throw new DshError('MODEL_ID_ENABLED', 'This exact model ID is already enabled.');
    // Stale/orphaned sources cannot retain an enabled slot indefinitely.
    for (const item of state.entries) if (!rows.entries.find(row => row.id === item.id)?.source_available) item.enabled = false;
    entry.enabled = command.enabled; this.write(state); return this.list();
  }); }
  remove(input: unknown) { return this.serial(async () => {
    const command = modelRemoveSchema.parse(input), state = this.read(); this.check(state, command.expected_revision);
    if (!state.entries.some(item => item.id === command.id)) throw new DshError('MODEL_NOT_FOUND', 'Model removed.');
    state.entries = state.entries.filter(item => item.id !== command.id); this.write(state); return this.list();
  }); }
  async prepare(input: unknown): Promise<ProbePlan> {
    const { draft, api, state } = await this.validate(input), request = probeRequest(api, draft);
    this.plans.clear(); // One pending native confirmation per management window.
    const plan: ProbePlan = { token: randomUUID(), draft, api_name: api.name, protocol: api.protocol, base_url: api.base_url,
      output_limit: request.output_limit, reasoning: request.reasoning, expires_at: new Date(Date.now() + 300000).toISOString() };
    this.plans.set(plan.token, { plan, api, revision: state.revision }); return structuredClone(plan);
  }
  cancel(token: string) { this.plans.delete(token); }
  close() { this.plans.clear(); for (const controller of this.active.values()) controller.abort(); }
  confirm(token: string) {
    const pending = this.plans.get(token); this.plans.delete(token); // Consume before any asynchronous work.
    return this.serial(async () => {
      if (!pending || Date.now() > Date.parse(pending.plan.expires_at)) throw new DshError('MODEL_CONFIRMATION', 'Confirmation missing or expired.');
      const { draft, api, state } = await this.validate({ draft: pending.plan.draft, expected_revision: pending.revision });
      if (api.protocol !== pending.api.protocol || api.base_url !== pending.api.base_url) throw new DshError('API_CONFLICT', 'Endpoint changed after confirmation.');
      const id = randomUUID(), controller = new AbortController(); this.active.set(id, controller);
      const receipt: ProbeReceipt = { id, model_id: draft.model_id, api_id: api.id, status: 'pending', started_at: new Date().toISOString(), finished_at: null,
        input_tokens: null, output_tokens: null, error_code: null, http_status: null };
      state.attempts = [...state.attempts.slice(-99), receipt];
      try {
        this.write(state); // Durable intent before an external request.
        try {
          const result = await this.credentials.withCredential(api.id, api, key => probeModel(api, draft, key, controller.signal, this.fetcher));
          Object.assign(receipt, result);
        } catch { receipt.status = 'failed'; receipt.error_code = 'MODEL_VERIFY_CREDENTIAL'; }
        receipt.finished_at = new Date().toISOString();
        if (receipt.status === 'verified') this.append(state, draft, api, receipt.id);
        this.write(state); return { snapshot: await this.list(), receipt };
      } finally { this.active.delete(id); }
    });
  }
}
