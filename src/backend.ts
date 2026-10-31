import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DeepSeekHarness, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { childEnvironment, projectRoot, type Config } from './config.ts';
import { DshError, type AgentBackend, type BackendFactory, type BackendNotice, type BackendSpec } from './types.ts';
import { startControlBridge } from './control-bridge.ts';
import { startModelGateway } from './model-gateway.ts';
import { hostCredentials } from './host-credentials.ts';
import { ModelCatalog } from './models.ts';
import type { CredentialRegistry } from './credentials.ts';

export function createBackendFactory(config: Config, adapters: { credentials?: CredentialRegistry; fetch?: typeof fetch } = {}): BackendFactory {
  return spec => new HarnessBackend(config, spec, adapters);
}

/** Drives the official CLI's sdk profile through the official SDK, never through a shell command. */
class HarnessBackend implements AgentBackend {
  private harness?: DeepSeekHarness;
  private session: ReturnType<DeepSeekHarness['session']> | undefined;
  private onNotice: ((notice: BackendNotice) => void) | undefined;
  private closed = false;
  private bridge?: Awaited<ReturnType<typeof startControlBridge>>;
  private readonly controlPatch?: string;
  private readonly meterPatch: string;
  private gateway?: Awaited<ReturnType<typeof startModelGateway>>;

  constructor(private readonly config: Config, private readonly spec: BackendSpec, private readonly adapters: { credentials?: CredentialRegistry; fetch?: typeof fetch } = {}) {
    mkdirSync(spec.home, { recursive: true });
    if (spec.control) this.controlPatch = join(spec.home, 'dsh-control.patch.yml');
    this.meterPatch = join(spec.home, 'dsh-meter.patch.yml');
  }

  private initializeHarness(): void {
    const config = this.config;
    const spec = this.spec;
    const env = childEnvironment(config);
    // The paid provider credential stays in the host. Workers receive only a scoped gateway token.
    env.DEEPSEEK_API_KEY = this.gateway!.token;
    env.DEEPSEEK_BASE_URL = this.gateway!.url;
    this.harness = new DeepSeekHarness({
      profile: 'sdk', dshHome: spec.home, cwd: spec.cwd, processCwd: spec.cwd,
      provider: spec.modelBinding && spec.modelBinding.source_protocol !== 'deepseek' ? 'dsh-managed' : config.provider, model: spec.model,
      ...(spec.reasoningEffort ? { reasoningEffort: ReasoningEffortId(spec.modelBinding?.source_protocol !== 'deepseek' && spec.modelBinding ? 'low' : spec.reasoningEffort === 'none' ? 'off' : spec.reasoningEffort) } : {}),
      ...(config.max_tokens ? { maxTokens: config.max_tokens } : {}),
      ...(config.dsh_bin ? { dshBin: config.dsh_bin } : {}),
      patches: [...config.patches, join(projectRoot, 'config', 'worker.patch.yml'), ...(this.controlPatch ? [this.controlPatch] : []), this.meterPatch],
      env, initializeTimeoutMs: config.initialize_timeout_ms,
      onUserQuestion: async request => {
        this.onNotice?.({ type: 'user_question', text: JSON.stringify(request.questions) });
        // This initial server has no interactive user-answer transport. It never invents consent.
        throw new Error('Interactive questions are not supported by dsh MCP v0.1. Send the question to the parent in the final response.');
      },
    });
  }

  async open(): Promise<void> {
    if (this.closed) throw new Error('Worker has been closed.');
    if (!this.spec.metering || this.config.provider !== 'deepseek-official') throw new DshError('METER_REQUIRED', 'This backend requires the DeepSeek official metering adapter.');
    const binding = this.spec.modelBinding;
    const credentials = this.adapters.credentials ?? hostCredentials(this.config.model_config_dir ?? this.config.data_dir);
    this.gateway = await startModelGateway({ meter: this.spec.metering, model: this.spec.model,
      protocol: binding?.source_protocol, baseURL: binding?.source_base_url,
      fetch: this.adapters.fetch,
      apiKey: binding ? '' : process.env.DEEPSEEK_API_KEY ?? '',
      ...(binding ? { credential: <T>(use: (key: string) => Promise<T>) => credentials.withCredential(binding.api_id,
        { protocol: binding.source_protocol, base_url: binding.source_base_url }, use) } : {}),
    });
    if (this.closed) { await this.gateway.close(); throw new Error('Worker was interrupted during gateway startup.'); }
    const info = new ModelCatalog().get(this.spec.model)!;
    const patches = !binding || binding.source_protocol === 'deepseek'
      ? [{ id: 'llm-deepseek', config: { baseURL: this.gateway.url } }]
      : [{ id: 'llm-deepseek', disabled: true }, { id: 'llm-pi-ai', config: { providers: { 'dsh-managed': {
        api: { openai_responses: 'openai-responses', openai_chat: 'openai-completions', anthropic: 'anthropic-messages' }[binding.source_protocol],
        apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: this.gateway.url + '/v1', transport: 'sse', retryPolicy: { mode: 'normal', maxRetries: 0 },
        models: [{ id: this.spec.model, contextWindow: info.context_window, maxTokens: info.max_output_tokens,
          input: ['text'], reasoningEfforts: this.spec.reasoningEffort ? { low: this.spec.reasoningEffort } : false }],
      } } } }];
    writeFileSync(this.meterPatch, JSON.stringify(patches), { mode: 0o600 });
    if (this.spec.control && this.controlPatch) {
      const bridge = await startControlBridge(this.spec.control);
      this.bridge = bridge;
      if (this.closed) { await bridge.close(); throw new Error('Worker was interrupted during startup.'); }
      // Resolve the installed plugin from the SDK dependency graph, rather than the upstream checkout.
      const require = createRequire(import.meta.url);
      const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-sdk-client'));
      writeFileSync(this.controlPatch, JSON.stringify([{ insert: [{ id: 'dsh-mcp-control',
        name: sdkRequire.resolve('@deepseek-ai/dsh-mcp-client'), config: {
          transport: 'streamable-http', serverName: 'dsh', url: bridge.url,
          headers: { Authorization: 'Bearer ' + bridge.token }, toolCallTimeoutMs: 70000,
          failOnStartupError: true, reconnect: { enabled: false },
        },
      }] }]), { mode: 0o600 });
    }
    this.initializeHarness();
    await this.harness!.start();
    if (this.closed) throw new Error('Worker was interrupted during startup.');
    this.session = this.spec.resume
      ? await this.harness!.resumeSession(this.spec.sessionId)
      : this.harness!.session(this.spec.sessionId);
    await this.session.getWorkingDirectory();
  }

  async run(message: string, onNotice: (notice: BackendNotice) => void) {
    if (!this.session || this.closed) throw new Error('Worker is not open.');
    this.onNotice = onNotice;
    try {
      // Wrapping ensures task text such as '/permissions ...' is not interpreted as a native command.
      const result = await this.session.run('External agent task from the parent agent:\n\n' + message, {
        onNotification: notification => this.observe(notification),
      });
      // The published 0.2.2-alpha.2 SDK exposes the terminal reason only in durable events.
      const terminal = result.events.findLast(event => event.type === 'turn/end');
      const reason = terminal?.data.reason;
      return {
        finalResponse: result.finalResponse, finishReason: reason?.kind ?? null,
        ...(reason?.kind === 'error' ? { diagnostic: reason.error.message } : {}),
      };
    } finally {
      this.onNotice = undefined;
    }
  }

  private observe(notification: HarnessNotification): void {
    if (notification.method !== 'session.event' || notification.params.sessionId !== this.spec.sessionId) return;
    const event = notification.params.event as { type?: string; data?: { message?: { content?: Array<{ type?: string; text?: string }> } } };
    if (event?.type === 'agent/inbox/spliced') {
      this.onNotice?.({ type: 'input_accepted', text: '' });
      return;
    }
    if (event?.type === 'tool/call' || event?.type === 'tool/result') {
      this.onNotice?.({ type: 'context_event', text: JSON.stringify(event) });
      return;
    }
    if (event?.type !== 'assistant/message') return;
    const text = event.data?.message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('');
    if (text) this.onNotice?.({ type: 'assistant_message', text });
  }

  async close(): Promise<void> {
    this.closed = true;
    const errors: unknown[] = [];
    // Revoke the paid gateway/control bridge even if worker exit could not be confirmed.
    for (const close of [() => this.harness?.close(), () => this.gateway?.close(), () => this.bridge?.close(),
      () => { if (this.controlPatch) rmSync(this.controlPatch, { force: true }); }, () => rmSync(this.meterPatch, { force: true })]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Worker cleanup was incomplete; its slot must remain reserved.');
  }
}
