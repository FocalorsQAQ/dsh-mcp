import { z } from 'zod';
import { modelEntrySchema } from './model-config-contract.ts';

/** Wire money is always [USD, CNY]. Currencies are independent; no implicit FX. */
export const moneySchema = z.tuple([z.number().finite().min(0).max(1_000_000), z.number().finite().min(0).max(1_000_000)]);
export type Money = z.infer<typeof moneySchema>;
export const policySchema = z.object({
  enabled: z.boolean().default(true),
  max_root_agents: z.number().int().min(0).max(32).default(4),
  allow_secondary: z.boolean().default(false),
  restrict_to_caller_workspace: z.boolean().default(false),
  max_depth_user: z.number().int().min(0).max(32).default(1),
  max_children_user: z.number().int().min(0).max(1000).default(1),
  round_budget: moneySchema.nullable().default(null),
  task_budget: moneySchema.nullable().default(null),
  billing_currency: z.enum(['USD', 'CNY']).default('USD'),
}).strict();
export type ControlPolicy = z.infer<typeof policySchema>;
export const taskSnapshotSchema = z.object({ version: z.literal(1), chat_id: z.uuid(), turn_id: z.uuid(),
  captured_at: z.iso.datetime(), settings_revision: z.number().int().nonnegative().safe(), settings: policySchema,
  model_revision: z.number().int().nonnegative().safe().nullable(), models: z.array(modelEntrySchema).max(500).nullable(),
  legacy_model: z.string(), legacy_effort: z.string().optional(), caller_cwd: z.string(),
}).strict();
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
// Zod 4 applies defaults inside optional fields: remove them before deriving a PATCH schema.
const patchShape = Object.fromEntries(Object.entries(policySchema.shape).map(([key, field]) => [key, field.removeDefault().optional()])) as {
  [K in keyof typeof policySchema.shape]: z.ZodOptional<ReturnType<(typeof policySchema.shape)[K]['removeDefault']>>
};
export const policyPatchSchema = z.object(patchShape).strict();
export const tokenUsageSchema = z.object({
  input_cache_miss: z.number().int().nonnegative(),
  input_cache_hit: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
}).strict();
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
const nanoMoneySchema = z.tuple([z.number().int().nonnegative().safe(), z.number().int().nonnegative().safe()]);
export const requestChargeSchema = z.object({
  id: z.uuid(), agent_id: z.string(), round_id: z.string(), model: z.string(),
  started_at: z.string(), finished_at: z.string().nullable(),
  status: z.enum(['reserved', 'settled', 'unknown', 'rejected']),
  reserved_nano: nanoMoneySchema, cost_nano: nanoMoneySchema,
  usage: tokenUsageSchema.nullable(), currency: z.enum(['USD', 'CNY']),
  rates: z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()]),
  pricing_schedule_id: z.string().nullable().default(null),
  pricing_period: z.enum(['peak', 'off_peak', 'mixed', 'unknown']).nullable().default(null),
  cost_basis: z.enum(['peak_upper_bound', 'time_of_use_estimate', 'custom_estimate', 'no_charge']).default('peak_upper_bound'),
  billing_context: z.record(z.string(), z.json()).nullable().default(null),
  billing_rules_hash: z.string().nullable().default(null),
  billing_error: z.string().nullable().default(null),
  settled_rates: z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()]).nullable().default(null),
  input_limit: z.number().int().positive(), output_limit: z.number().int().positive(),
});
export type RequestCharge = z.infer<typeof requestChargeSchema>;
export const controlStateSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(), task_id: z.string(),
  policy: policySchema, current_round_id: z.string(),
  rounds: z.array(z.object({ id: z.string(), spent_nano: nanoMoneySchema, snapshot: taskSnapshotSchema.optional() })),
  task_spent_nano: nanoMoneySchema, tokens: tokenUsageSchema,
  requests: z.array(requestChargeSchema),
  last_request: requestChargeSchema.nullable(),
  accounting_blocked: z.boolean().default(false),
});
export type ControlState = z.infer<typeof controlStateSchema>;

export interface AgentPolicyView {
  enabled: boolean;
  message: string;
  max_root_agents: number;
  allow_secondary: boolean;
  restrict_to_caller_workspace: boolean;
  caller_workspace: string | null;
  max_depth_user: number;
  max_children_user: number;
  round_id: string;
  budget: Money | null;
  available_budget: Money | null;
  selected_models: string[] | null;
  model_selection_available: boolean;
  settings_revision?: number;
  captured_at?: string;
  snapshot_locked?: boolean;
}
export interface AgentPolicySource {
  agentInfo(roundId?: string): AgentPolicyView;
  assertEnabled(): void;
  subscribe(listener: () => void): () => void;
}

/** Request-scoped capability supplied by the host, never by an MCP argument. */
export interface MeteringPort {
  reserve(model: string, maxTokens: number): { id: string; max_tokens: number };
  settle(id: string, usage: TokenUsage | null, outcome: 'complete' | 'unknown' | 'rejected'): void;
}
