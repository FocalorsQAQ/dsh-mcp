import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DshError } from './types.ts';
import type { Money, RequestCharge, TokenUsage } from './control-contract.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const billingConfigSchema = z.object({
  python: z.string().min(1).default('python'),
  rules: z.string().min(1).default(resolve(root, 'billing/rules.py')),
  timeout_ms: z.number().int().min(100).max(10000).default(2000),
}).strict();
export type BillingConfig = z.infer<typeof billingConfigSchema>;
const money = z.tuple([z.number().int().nonnegative().safe(), z.number().int().nonnegative().safe()]);
const rates = z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative(), z.number().finite().nonnegative()]);
const quoteSchema = z.object({ max_tokens: z.number().int().positive().safe(), reserved_nano: money,
  rates, context: z.record(z.string(), z.json()) }).strict();
const settlementSchema = z.object({ cost_nano: money, settled_rates: rates.nullable(),
  pricing_period: z.enum(['peak', 'off_peak', 'mixed', 'unknown']),
  cost_basis: z.enum(['peak_upper_bound', 'time_of_use_estimate', 'custom_estimate']) }).strict();

/** Synchronous, bounded local calls preserve the host's atomic reservation section. */
export class PythonBilling {
  constructor(private readonly config: BillingConfig = billingConfigSchema.parse({})) {}
  private hash() { return createHash('sha256').update(readFileSync(this.config.rules)).digest('hex'); }
  private invoke(operation: 'quote' | 'settle', input: unknown) {
    // Do not forward provider credentials to the calculator. This is trusted local
    // user code, not an OS sandbox; it still runs with the user's filesystem access.
    const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
    const result = spawnSync(this.config.python, ['-I', '-B', resolve(root, 'billing/runner.py'), this.config.rules], {
      input: JSON.stringify({ version: 1, operation, input }), encoding: 'utf8', timeout: this.config.timeout_ms,
      maxBuffer: 65536, windowsHide: true, shell: false, env,
    });
    if (result.error || result.status !== 0) throw new Error('Python billing process failed.');
    const response = z.object({ version: z.literal(1), result: z.unknown() }).strict().parse(JSON.parse(result.stdout));
    return response.result;
  }
  quote(input: { model: string; currency: 'USD' | 'CNY'; rates: [number, number, number]; input_limit: number;
    max_tokens: number; available_nano: Money | null; started_at: string }) {
    try {
      const hash = this.hash();
      const raw = this.invoke('quote', input);
      if (this.hash() !== hash) throw new Error('Rules changed during quote.');
      if (raw && typeof raw === 'object' && 'error' in raw && raw.error === 'BUDGET_RESERVATION')
        throw new DshError('BUDGET_RESERVATION', 'Remaining shared budget cannot cover the conservative input reservation. No API request was sent.');
      const result = quoteSchema.parse(raw);
      if (result.max_tokens > input.max_tokens || result.reserved_nano[input.currency === 'USD' ? 1 : 0] !== 0)
        throw new Error('Invalid billing envelope.');
      if (JSON.stringify(result.context).length > 16384) throw new Error('Billing context too large.');
      return { ...result, rules_hash: hash };
    } catch (error) {
      if (error instanceof DshError) throw error;
      throw new DshError('BILLING_ENGINE', 'Python billing failed; check the interpreter, rules and protocol. No API request was sent.');
    }
  }
  settle(request: RequestCharge, usage: TokenUsage, finishedAt: string, period: 'peak' | 'off_peak' | 'mixed' | 'unknown') {
    // Old reservations without a pinned calculator must keep their full reservation.
    if (!request.billing_rules_hash || this.hash() !== request.billing_rules_hash) throw new Error('Billing rules changed.');
    const result = settlementSchema.parse(this.invoke('settle', { model: request.model, currency: request.currency,
      usage, started_at: request.started_at, finished_at: finishedAt, period, context: request.billing_context }));
    if (this.hash() !== request.billing_rules_hash || result.cost_nano[request.currency === 'USD' ? 1 : 0] !== 0)
      throw new Error('Invalid billing settlement.');
    return result;
  }
}
