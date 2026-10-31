import { z } from 'zod';
import { apiProtocolSchema, type ApiEntry } from './credential-contract.ts';

export const modelDraftSchema = z.object({ api_id: z.uuid(), model_id: z.string().trim().min(1).max(200),
  reasoning_levels: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).max(16).nullable(),
}).strict().refine(value => !value.reasoning_levels || new Set(value.reasoning_levels).size === value.reasoning_levels.length);
export type ModelDraft = z.infer<typeof modelDraftSchema>;
export const modelSaveSchema = z.object({ draft: modelDraftSchema, expected_revision: z.number().int().nonnegative().safe() }).strict();
export const modelToggleSchema = z.object({ id: z.uuid(), enabled: z.boolean(), expected_revision: z.number().int().nonnegative().safe() }).strict();
export const modelRemoveSchema = modelToggleSchema.omit({ enabled: true });
export const probeReceiptSchema = z.object({ id: z.uuid(), model_id: z.string(), api_id: z.uuid(),
  status: z.enum(['pending', 'verified', 'failed', 'unknown']), started_at: z.iso.datetime(), finished_at: z.iso.datetime().nullable(),
  input_tokens: z.number().int().nonnegative().safe().nullable(), output_tokens: z.number().int().nonnegative().safe().nullable(),
  error_code: z.string().nullable(), http_status: z.number().int().nullable() });
export type ProbeReceipt = z.infer<typeof probeReceiptSchema>;
export const modelEntrySchema = z.object({ id: z.uuid(), api_id: z.uuid(), model_id: z.string().min(1).max(200),
  reasoning_levels: z.array(z.string()).max(16), enabled: z.boolean(), verified: z.boolean(), created_at: z.iso.datetime(),
  source_protocol: apiProtocolSchema, source_base_url: z.string(), verification_id: z.uuid().nullable() }).strict();
export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type ModelRow = ModelEntry & { api_name: string | null; source_available: boolean; effective_enabled: boolean; verification_valid: boolean };
export interface ModelConfigSnapshot { revision: number; entries: ModelRow[]; apis: ApiEntry[]; attempts: ProbeReceipt[] }
export interface ProbePlan { token: string; draft: ModelDraft; api_name: string; protocol: ApiEntry['protocol']; base_url: string;
  output_limit: number; reasoning: string | null; expires_at: string }
