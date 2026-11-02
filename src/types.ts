import { z } from 'zod';
import type { AgentTools } from './control.ts';
import { apiProtocolSchema } from './credential-contract.ts';
import type { ModelBinding } from './runtime-models.ts';
import { controlStateSchema, type MeteringPort } from './control-contract.ts';

export const statusSchema = z.enum(['starting', 'running', 'pausing', 'paused', 'stopping', 'idle', 'interrupted', 'failed', 'closed']);
export type AgentStatus = z.infer<typeof statusSchema>;
export const messageSchema = z.object({
  id: z.uuid(), text: z.string(), source: z.enum(['spawn', 'message', 'followup']), accepted_at: z.string(),
  edited_at: z.string().optional(),
  round_id: z.string().nullable().default(null),
});
export type QueuedMessage = z.infer<typeof messageSchema>;
export const agentSchema = z.object({
  service_revision: z.number().int().nonnegative().default(0),
  service_stop_id: z.uuid().optional(),
  last_round_id: z.string().optional(),
  id: z.uuid(), task_name: z.string(), path: z.string(), parent_id: z.uuid().nullable(),
  cwd: z.string(), model: z.string(), reasoning_effort: z.string().optional(),
  model_binding: z.object({ id: z.uuid(), api_id: z.uuid(), model_id: z.string(), source_protocol: apiProtocolSchema, source_base_url: z.string() }).optional(),
  session_id: z.string(), session_ready: z.boolean(), status: statusSchema,
  created_at: z.string(), updated_at: z.string(), turn: z.number().int().nonnegative(),
  pending: z.array(messageSchema), active_message: messageSchema.nullable(),
  pause_requested: z.boolean().default(false), queue_revision: z.number().int().nonnegative().default(0),
  final_response: z.string(), finish_reason: z.string().nullable(), error: z.string().nullable(),
  fork_turns: z.enum(['none', 'all']).default('none'),
  max_depth: z.number().int().nonnegative().default(0),
  max_children: z.number().int().nonnegative().default(1),
  context_source: z.object({ kind: z.enum(['dsh', 'codex', 'provided']), id: z.string().optional() }).nullable().default(null),
  notify_on_completion: z.boolean().default(false),
  reply_thread_id: z.uuid().nullable().default(null),
  inherited_context: z.string().default(''),
  context_applied: z.boolean().default(false),
  history_available: z.boolean().default(false),
  history: z.array(z.object({ role: z.enum(['user', 'assistant', 'tool']), text: z.string() })).default([]),
});
export type AgentRecord = z.infer<typeof agentSchema>;
const agentEventSchema = z.object({
  cursor: z.number().int().positive(), agent_id: z.uuid(), path: z.string(), at: z.string(),
  type: z.enum(['spawned', 'status', 'message_queued', 'queue_updated', 'assistant_message', 'user_question', 'recovered', 'delivery']),
  status: statusSchema, message: z.string().optional(),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;
export const eventSchema = z.union([agentEventSchema, z.object({
  cursor: z.number().int().positive(), at: z.string(),
  type: z.literal('concurrency_changed'), agent_id: z.null(), path: z.null(), status: z.null(),
  previous_max_concurrent_agents: z.number().int().min(1).max(32),
  max_concurrent_agents: z.number().int().min(1).max(32),
})]);
export type ManagerEvent = z.infer<typeof eventSchema>;
export const deliveryStatusSchema = z.enum(['pending', 'sending', 'published', 'queued', 'failed', 'unknown']);
const deliveryAttemptSchema = z.object({
  attempt: z.number().int().positive(), started_at: z.string(), finished_at: z.string().nullable(),
  status: z.enum(['sending', 'published', 'queued', 'failed', 'unknown']),
  queue_message_id: z.string().nullable(), error: z.string().nullable(),
  duplicate_risk_accepted: z.boolean().default(false),
});
export const deliverySchema = z.object({
  kind: z.enum(['completion', 'service_stopped']).default('completion'),
  id: z.string(), agent_id: z.uuid(), turn: z.number().int().nonnegative(), thread_id: z.uuid(),
  text: z.string(), transport: z.enum(['app_tools', 'codex_queue']).default('codex_queue'),
  status: deliveryStatusSchema,
  created_at: z.string(), updated_at: z.string(), queue_message_id: z.string().nullable(), error: z.string().nullable(),
  attempts: z.number().int().nonnegative().default(0),
  attempt_history: z.array(deliveryAttemptSchema).default([]),
  retry_allow_duplicate: z.boolean().default(false),
});
export type DeliveryRecord = z.infer<typeof deliverySchema>;
export type DeliveryTransport = (item: DeliveryRecord) => Promise<{ queue_message_id?: string; published?: boolean }>;
export const stateSchema = z.object({
  service_stop_id: z.uuid().optional(),
  version: z.literal(1), cursor: z.number().int().nonnegative(),
  agents: z.array(agentSchema), events: z.array(eventSchema),
  deliveries: z.array(deliverySchema).default([]),
  runtime_settings: z.object({ max_concurrent_agents: z.number().int().min(1).max(32) }).strict().optional(),
  control: controlStateSchema.optional(),
});
export type SavedState = z.infer<typeof stateSchema>;

export interface BackendSpec {
  id: string;
  sessionId: string;
  resume: boolean;
  cwd: string;
  home: string;
  model: string;
  reasoningEffort?: string;
  modelBinding?: ModelBinding;
  control?: AgentTools;
  metering?: MeteringPort;
}
export interface BackendResult { finalResponse: string; finishReason: string | null; diagnostic?: string }
export interface BackendNotice { type: 'assistant_message' | 'user_question' | 'context_event' | 'input_accepted'; text: string }
/** One runtime owns one persisted session. close() must settle only after the child exits. */
export interface AgentBackend {
  open(): Promise<void>;
  run(message: string, onNotice: (notice: BackendNotice) => void): Promise<BackendResult>;
  close(): Promise<void>;
}
export type BackendFactory = (spec: BackendSpec) => AgentBackend;

export class DshError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DshError'; }
}

/** Prevent credential-bearing environment values from entering logs or tool errors. */
export function errorText(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error)).slice(0, 6000);
}

export function redactText(value: string): string {
  let text = value;
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 6 && /key|token|secret|password|authorization/i.test(name)) {
      text = text.replaceAll(value, '[redacted]');
    }
  }
  return text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]');
}
