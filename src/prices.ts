import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEEPSEEK_SCHEDULE_ID } from './pricing-time.ts';

export interface ModelPricing {
  /** Per million tokens: cache miss, cache hit, output. */
  USD: [number, number, number]; CNY: [number, number, number];
  basis: 'peak_upper_bound'; verified_at: string; valid_until: string; source: string; schedule_id: string;
}
const rate = z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative(), z.number().finite().nonnegative()]);
const metadata = { verified_at: z.iso.date(), valid_until: z.iso.datetime({ offset: true }), source: z.string().min(1) };
const datesOrdered = (value: { verified_at: string; valid_until: string }) => Date.parse(value.valid_until) > Date.parse(value.verified_at);
const deepseekSchema = z.object({ ...metadata,
  flash: z.object({ USD: rate, CNY: rate }).strict(), pro: z.object({ USD: rate, CNY: rate }).strict(),
}).strict().refine(datesOrdered, { path: ['valid_until'], message: 'Must be after verified_at.' });
const openaiSchema = z.object({ ...metadata, 'gpt-5-mini': z.object({ USD: rate }).strict() })
  .strict().refine(datesOrdered, { path: ['valid_until'], message: 'Must be after verified_at.' });
export const defaultPriceDirectory = fileURLToPath(new URL('../billing/', import.meta.url));
export interface PriceFileStatus {
  provider: 'deepseek' | 'openai'; path: string; valid: boolean; error: string | null;
  verified_at: string | null; valid_until: string | null; expired: boolean;
}
interface LoadedPrices { prices: Record<string, ModelPricing>; files: PriceFileStatus[]; revision: string }

/** Small local files are read on demand, so editor saves/renames need no watcher or restart.
 * Invalid edits disable the affected provider; they never silently keep billing at an old rate.
 */
export class PriceCatalog {
  private cached?: { signature: string; value: Omit<LoadedPrices, 'revision'> };
  constructor(readonly directory = defaultPriceDirectory) {}

  snapshot(now = Date.now()): LoadedPrices {
    const sources = ([['deepseek', 'prices.json'], ['openai', 'openai-prices.json']] as const).map(([provider, filename]) => {
      const path = join(this.directory, filename);
      try {
        if (statSync(path).size > 65536) throw new Error('size');
        return { provider, path, body: readFileSync(path, 'utf8'), error: null };
      } catch { return { provider, path, body: '', error: 'Cannot read price file (maximum 64 KiB).' }; }
    });
    const signature = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
    if (signature !== this.cached?.signature) {
      const prices: Record<string, ModelPricing> = {}, files: PriceFileStatus[] = [];
      for (const source of sources) {
        const status: PriceFileStatus = { provider: source.provider, path: source.path, valid: false,
          error: source.error, verified_at: null, valid_until: null, expired: false };
        files.push(status);
        if (source.error) continue;
        try {
          const raw = JSON.parse(source.body);
          if (source.provider === 'deepseek') {
            const data = deepseekSchema.parse(raw);
            for (const id of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']) {
              prices[id] = { ...(id === 'deepseek-v4-pro' ? data.pro : data.flash), basis: 'peak_upper_bound',
                schedule_id: DEEPSEEK_SCHEDULE_ID, verified_at: data.verified_at, valid_until: data.valid_until, source: data.source };
            }
            Object.assign(status, { verified_at: data.verified_at, valid_until: data.valid_until });
          } else {
            const data = openaiSchema.parse(raw);
            prices['gpt-5-mini'] = { USD: data['gpt-5-mini'].USD, CNY: [0, 0, 0], basis: 'peak_upper_bound',
              schedule_id: 'openai-standard', verified_at: data.verified_at, valid_until: data.valid_until, source: data.source };
            Object.assign(status, { verified_at: data.verified_at, valid_until: data.valid_until });
          }
          status.valid = true;
        } catch (error) {
          status.error = error instanceof z.ZodError
            ? error.issues.map(issue => (issue.path.join('.') || 'root') + ': ' + issue.message).join('; ').slice(0, 2000)
            : 'Invalid JSON. Check commas, quotes and brackets.';
        }
      }
      this.cached = { signature, value: { prices, files } };
    }
    const result = structuredClone(this.cached!.value);
    for (const file of result.files) file.expired = !!file.valid_until && now >= Date.parse(file.valid_until);
    return { ...result, revision: signature + ':' + result.files.map(file => Number(file.expired)).join('') };
  }
}
