import { z } from 'zod';

export const apiProtocolSchema = z.enum(['deepseek', 'openai_chat', 'openai_responses', 'anthropic']);
export type ApiProtocol = z.infer<typeof apiProtocolSchema>;
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const url = z.string().trim().max(2048).refine(value => {
  try {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
      (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)));
  } catch { return false; }
}, 'Invalid API base URL.');
export const apiMetadataSchema = z.object({ name: z.string().trim().min(1).max(80),
  protocol: apiProtocolSchema, base_url: url });
export const apiAddSchema = apiMetadataSchema.extend({ api_key: z.string().trim().min(1).max(8192),
  expected_revision: z.number().int().nonnegative().safe() }).strict();
export const apiUpdateSchema = apiMetadataSchema.extend({ id: z.uuid(),
  expected_revision: z.number().int().nonnegative().safe() }).strict();
export const apiRemoveSchema = z.object({ id: z.uuid(), expected_revision: z.number().int().nonnegative().safe() }).strict();
export interface ApiEntry { id: string; name: string; protocol: ApiProtocol; base_url: string; created_at: string; updated_at: string }
export interface ApiRegistrySnapshot { revision: number; entries: ApiEntry[]; encryption_available: boolean }
export type ApiAdd = z.infer<typeof apiAddSchema>;
export type ApiUpdate = z.infer<typeof apiUpdateSchema>;
export type ApiRemove = z.infer<typeof apiRemoveSchema>;
