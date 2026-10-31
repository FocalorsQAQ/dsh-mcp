import { z } from 'zod';
import { policyPatchSchema } from './control-contract.ts';
import type { DshControlApi, DshControlSnapshot } from './application.ts';

export type UiWindowIntent = ReturnType<DshControlApi['openManagementWindow']>;

export const uiEndpointSchema = z.object({
  version: z.literal(1), server_id: z.uuid(), pid: z.number().int().positive(),
  url: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/), token: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type UiEndpoint = z.infer<typeof uiEndpointSchema>;
export const settingsCommandSchema = z.object({ patch: policyPatchSchema, expected_revision: z.number().int().nonnegative() }).strict();
export const windowIntentSchema = z.object({ window: z.enum(['api_keys', 'models']) }).strict();
export interface UiEnvelope {
  server_id: string;
  sequence: number;
  snapshot: DshControlSnapshot;
}
export interface UiConnectionState {
  status: 'connecting' | 'connected' | 'disconnected';
  workspace_name: string;
  workspace_root: string;
  snapshot: DshControlSnapshot | null;
  message: string;
}
