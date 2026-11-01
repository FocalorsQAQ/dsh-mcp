import type { Config } from './config.ts';
import { createBackendFactory } from './backend.ts';
import { AgentManager } from './manager.ts';
import { createServer } from './server.ts';
import { DshError, type BackendFactory, type DeliveryTransport } from './types.ts';

/** Trusted UI/host API, deliberately not registered as model-facing MCP tools. */
export function createApplication(config: Config, backend: BackendFactory = createBackendFactory(config), deliver?: DeliveryTransport) {
  const manager = new AgentManager(config, backend, deliver);
  const controls = manager.controlPlane;
  const snapshot = () => ({ ...controls.snapshot(), runtime: manager.list() });
  const ui = {
    snapshot,
    updateSettings: (patch: unknown, expectedRevision: number) => { controls.updatePolicy(patch, expectedRevision); return snapshot(); },
    beginRound: (hostRoundId: string, expectedRevision: number) => { controls.beginRound(hostRoundId, expectedRevision); return snapshot(); },
    openManagementWindow: (window: 'api_keys' | 'models') => controls.windowIntent(window),
    refreshModels: () => controls.refreshModels(),
    subscribe: (listener: (value: ReturnType<typeof snapshot>) => void) => manager.subscribe(() => listener(snapshot())),
  };
  const discoveryMethods = new Set(['list', 'read', 'wait', 'listModel', 'listEffort', 'listDeliveries']);
  return { ui, createMcpServer: (discovery = false) => createServer(discovery ? new Proxy(manager, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (!discoveryMethods.has(String(key))) throw new DshError('SESSION_REQUIRED', 'This connection is for tool discovery. Start a chat-bound connection with CODEX_THREAD_ID or --session-id.');
        return Reflect.apply(value, target, args);
      };
    },
  }) : manager, discovery ? 'Catalog connection only; task execution requires a chat-bound MCP connection. ' :
    config.codex_thread_id ? 'Chat binding: ' + config.codex_thread_id + '. Tasks, queues and budgets are isolated to this chat. ' : ''), close: () => manager.shutdown() };
}

export type DshApplication = ReturnType<typeof createApplication>;
export type DshControlApi = DshApplication['ui'];
export type DshControlSnapshot = ReturnType<DshControlApi['snapshot']>;
export { loadConfig } from './config.ts';
export { listSessions, sessionDirectory } from './sessions.ts';
export type { Config } from './config.ts';
export { policySchema, policyPatchSchema, moneySchema } from './control-contract.ts';
export type { ControlPolicy, Money, AgentPolicyView, TokenUsage } from './control-contract.ts';
