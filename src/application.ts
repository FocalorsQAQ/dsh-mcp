import type { Config } from './config.ts';
import { createBackendFactory } from './backend.ts';
import { AgentManager } from './manager.ts';
import { createServer } from './server.ts';
import type { BackendFactory, DeliveryTransport } from './types.ts';

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
  return { ui, createMcpServer: () => createServer(manager), close: () => manager.shutdown() };
}

export type DshApplication = ReturnType<typeof createApplication>;
export type DshControlApi = DshApplication['ui'];
export type DshControlSnapshot = ReturnType<DshControlApi['snapshot']>;
export { loadConfig } from './config.ts';
export type { Config } from './config.ts';
export { policySchema, policyPatchSchema, moneySchema } from './control-contract.ts';
export type { ControlPolicy, Money, AgentPolicyView, TokenUsage } from './control-contract.ts';
