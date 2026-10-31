import { z } from 'zod';
import { DshError } from './types.ts';
import { PriceCatalog, type ModelPricing } from './prices.ts';

export interface ModelInfo {
  billing_currencies?: Array<'USD' | 'CNY'>;
  id: string;
  name: string;
  context_window: number | null;
  max_output_tokens: number | null;
  input_modalities: string[];
  effort_levels: string[];
  source: 'bundled' | 'api';
  fetched_at: string | null;
  pricing: ModelPricing | null;
  pricing_error?: string;
}
const bundled: ModelInfo[] = [
  ['deepseek-flash', 'DeepSeek-V4.1-Flash-1017'],
  ['deepseek-v4-flash', 'DeepSeek-V4.1-Flash-1017 (legacy alias)'],
  ['deepseek-v4-flash-vision-exp', 'DeepSeek-V4.1-Flash-1017 (legacy alias)'],
  ['deepseek-v4-pro', 'DeepSeek-V4-Pro-0813'],
].map(([id, name]) => ({ id: id!, name: name!, context_window: 1_048_576, max_output_tokens: 393_216,
  input_modalities: id === 'deepseek-v4-pro' ? ['text'] : ['text', 'image'], effort_levels: ['low', 'high', 'max'],
  source: 'bundled', fetched_at: null, pricing: null }));

const listingSchema = z.object({ data: z.array(z.object({
  id: z.string().min(1).max(200), name: z.string().max(300).optional(),
  context_window: z.number().int().positive().optional(), max_output_tokens: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()).optional(),
  effort: z.object({ supported_levels: z.array(z.string()) }).optional(),
})).max(1000) });

/** Model discovery and pricing are separate: /models does not establish a billing price. */
export class ModelCatalog {
  private readonly eligible = new Set([...bundled.map(model => model.id), 'gpt-5-mini']);
  constructor(private readonly prices = new PriceCatalog()) {}
  private entries: ModelInfo[] = [...structuredClone(bundled), {
    id: 'gpt-5-mini', name: 'GPT-5 mini', context_window: 400000, max_output_tokens: 128000,
    input_modalities: ['text', 'image'], effort_levels: ['minimal', 'low', 'medium', 'high'], source: 'bundled', fetched_at: null,
    billing_currencies: ['USD'],
    pricing: null,
  }];
  pricingStatus() { const { files, revision } = this.prices.snapshot(); return { files, revision }; }
  list(): ModelInfo[] {
    const snapshot = this.prices.snapshot();
    return structuredClone(this.entries).map(model => {
      if (!this.eligible.has(model.id)) return { ...model, pricing: null };
      const status = snapshot.files.find(file => file.provider === (model.id === 'gpt-5-mini' ? 'openai' : 'deepseek'))!;
      return { ...model, pricing: snapshot.prices[model.id] ?? null,
        ...(!status.valid ? { pricing_error: status.path + ': ' + status.error } : {}) };
    });
  }
  get(id: string): ModelInfo | undefined { return this.list().find(model => model.id === id); }
  async refresh(options: { apiKey: string; baseURL?: string; fetch?: typeof fetch }): Promise<ModelInfo[]> {
    if (!options.apiKey) throw new DshError('API_KEY_REQUIRED', 'Configure an API key before refreshing models.');
    const base = providerBaseURL(options.baseURL);
    const response = await (options.fetch ?? fetch)(base + '/models', {
      headers: { Authorization: 'Bearer ' + options.apiKey }, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new DshError('MODEL_DISCOVERY', 'Model listing failed with HTTP ' + response.status + '.');
    const body = await response.text();
    if (body.length > 1_000_000) throw new DshError('MODEL_DISCOVERY', 'Model listing exceeds the response limit.');
    const listing = listingSchema.parse(JSON.parse(body));
    const at = new Date().toISOString();
    const updates = listing.data.map(item => {
      const known = this.get(item.id);
      // A changed capacity needs a reviewed reservation envelope, not an automatic price assumption.
      const capacityReviewed = known && (!item.context_window || item.context_window <= (known.context_window ?? 0)) &&
        (!item.max_output_tokens || item.max_output_tokens <= (known.max_output_tokens ?? 0));
      if (!capacityReviewed) this.eligible.delete(item.id);
      return { id: item.id, name: item.name ?? item.id, context_window: item.context_window ?? null,
        max_output_tokens: item.max_output_tokens ?? null, input_modalities: item.input_modalities ?? [],
        effort_levels: item.effort?.supported_levels ?? [], source: 'api' as const, fetched_at: at,
        ...(known?.billing_currencies ? { billing_currencies: known.billing_currencies } : {}), pricing: null };
    });
    this.entries = [...updates, ...this.entries.filter(item => !updates.some(update => update.id === item.id))];
    return this.list();
  }
}

/** Credentials never follow redirects or leave the explicitly configured provider origin. */
export function providerBaseURL(value = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new DshError('PROVIDER_URL', 'Provider URL must use HTTPS (HTTP is allowed only for loopback tests).');
  }
  return url.toString().replace(/\/+$/, '').replace(/\/(?:anthropic(?:\/v1)?|v1)$/, '');
}
