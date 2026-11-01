import type { AgentManager } from './manager.ts';
import { DshError } from './types.ts';
import type { AgentPolicySource } from './control-contract.ts';

export type AgentTools = Pick<AgentManager, 'spawn' | 'sendMessage' | 'followup' | 'list' | 'read' | 'wait' | 'interrupt' | 'batchControl' | 'pause' | 'resume' | 'manageQueue'> &
  Partial<Pick<AgentManager, 'setConcurrency' | 'listDeliveries' | 'retryDelivery' | 'listModel' | 'listEffort'>> & { policySource?: AgentPolicySource };

/** The caller's identity is bound by the host, never chosen by model arguments. */
export function scopedTools(manager: AgentManager, callerId: string): AgentTools {
  const caller = manager.read(callerId).agent;
  const within = (path: string) => path.startsWith(caller.path + '/');
  const target = (value: string, allowSelf = false) => {
    const agent = manager.read(value).agent;
    if (!within(agent.path) && !(allowSelf && agent.id === callerId)) {
      throw new DshError('AGENT_SCOPE', 'An external agent may only control its own descendants.');
    }
    return agent.id;
  };
  const scoped: AgentTools = {
    listModel: () => manager.listModel(callerId), listEffort: model => manager.listEffort(model, callerId),
    policySource: {
      agentInfo: () => ({ ...manager.controlPlane.agentInfo(manager.agentRound(callerId)),
        selected_models: manager.listModel(callerId).models, model_selection_available: true }),
      assertEnabled: () => manager.controlPlane.assertEnabled(manager.agentRound(callerId)),
      subscribe: listener => manager.controlPlane.subscribe(listener),
    },
    spawn(options) {
      if (options.parent && manager.read(options.parent).agent.id !== callerId) {
        throw new DshError('AGENT_SCOPE', 'parent must be the calling external agent; omit it to use the bound caller.');
      }
      const state = manager.read(callerId).agent;
      if (['closed', 'stopping', 'interrupted', 'failed', 'pausing', 'paused'].includes(state.status)) {
        throw new DshError('STOPPING', 'The calling agent is no longer accepting child tasks.');
      }
      return manager.spawn({ ...options, parent: callerId, notify_on_completion: options.notify_on_completion ?? false });
    },
    sendMessage: (value, text) => manager.sendMessage(target(value), text, manager.agentRound(callerId)),
    followup: (value, text) => manager.followup(target(value), text, manager.agentRound(callerId)),
    interrupt: (value, close) => manager.interrupt(target(value), close),
    pause: value => manager.pause(target(value)),
    resume: value => manager.resume(target(value)),
    manageQueue: (value, options) => manager.manageQueue(target(value, ['list', 'read'].includes(options.action)), options),
    batchControl: options => manager.batchControl(options, callerId),
    read: (value, offset, maxChars) => manager.read(target(value, true), offset, maxChars),
    list(pathPrefix) {
      const prefix = pathPrefix?.replace(/\/$/, '') ?? caller.path;
      if (prefix !== caller.path && !within(prefix)) throw new DshError('AGENT_SCOPE', 'path_prefix must be inside the calling agent task tree.');
      return manager.list(prefix);
    },
    wait(options = {}, signal) {
      const targets = options.targets?.map(value => target(value)) ?? manager.list(caller.path).agents.filter(agent => within(agent.path)).map(agent => agent.id);
      return manager.wait({ ...options, targets }, signal);
    },
  };
  return new Proxy(scoped, {
    get(target, key) {
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? (...args: unknown[]) => manager.controlPlane.withRound(manager.agentRound(callerId), () => Reflect.apply(value, target, args)) : value;
    },
  });
}
