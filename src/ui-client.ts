import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DshError } from './types.ts';
import { uiEndpointSchema, type UiEndpoint, type UiConnectionState, type UiEnvelope, type UiWindowIntent } from './ui-protocol.ts';

/** Node/Electron-main adapter. No connection token is ever sent to the renderer. */
export class UiClient {
  private state: UiConnectionState;
  private listeners = new Set<(state: UiConnectionState) => void>();
  private endpoint?: UiEndpoint;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private lastSequence = -1;
  private closed = false;
  constructor(private readonly dataDir: string, workspaceRoot: string, private readonly retryMs = 2000) {
    this.state = { status: 'connecting', workspace_name: basename(workspaceRoot), workspace_root: workspaceRoot,
      snapshot: null, message: '正在连接 dsh…' };
  }
  snapshot(): UiConnectionState { return structuredClone(this.state); }
  subscribe(listener: (state: UiConnectionState) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit() { for (const listener of this.listeners) { try { listener(this.snapshot()); } catch { /* Isolate UI observers. */ } } }
  private accept(value: UiEnvelope, endpoint: UiEndpoint) {
    if (this.endpoint?.server_id !== endpoint.server_id || value.server_id !== endpoint.server_id ||
        !Number.isSafeInteger(value.sequence) || value.sequence <= this.lastSequence) return;
    if (value.snapshot?.contract_version !== 1) throw new DshError('UI_VERSION', 'Control protocol version is not supported.');
    this.lastSequence = value.sequence;
    this.state = { ...this.state, snapshot: value.snapshot, status: 'connected', message: '' }; this.emit();
  }
  reconnect() {
    if (this.closed) return;
    this.generation++; this.abort?.abort(); clearTimeout(this.timer);
    this.state.status = 'connecting'; this.state.message = '正在连接 dsh…'; this.emit();
    void this.connect(this.generation);
  }
  private async connect(generation: number) {
    const abort = new AbortController(); this.abort = abort;
    let headerTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const endpoint = uiEndpointSchema.parse(JSON.parse(await readFile(join(this.dataDir, 'ui-endpoint.json'), 'utf8')));
      if (generation !== this.generation || this.closed) return;
      this.endpoint = endpoint; this.lastSequence = -1;
      headerTimeout = setTimeout(() => abort.abort(), 5000);
      const response = await fetch(endpoint.url + '/v1/events', { headers: { Authorization: 'Bearer ' + endpoint.token },
        signal: abort.signal, redirect: 'error' });
      clearTimeout(headerTimeout);
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Control stream unavailable.');
      const decoder = new TextDecoder(); let pending = '';
      for await (const chunk of response.body) {
        if (generation !== this.generation || this.closed) return;
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 8_000_000) throw new Error('Control event exceeds size limit.');
        for (;;) {
          const end = pending.indexOf('\n\n'); if (end < 0) break;
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          if (frame.startsWith('data: ')) this.accept(JSON.parse(frame.slice(6)), endpoint);
        }
      }
    } catch { /* Display a stable local status instead of network paths or credentials. */ }
    finally {
      clearTimeout(headerTimeout); abort.abort();
      if (generation === this.generation && !this.closed) {
        this.endpoint = undefined;
        this.state.status = 'disconnected';
        this.state.message = this.state.snapshot ? '连接已断开，正在重新连接。' : '等待 dsh 服务。在 Codex 中启动 dsh 后将自动连接。';
        this.emit(); this.timer = setTimeout(() => void this.connect(generation), this.retryMs); this.timer.unref();
      }
    }
  }
  private async request<T>(path: string, method: string, body: unknown, timeout = 5000) {
    const endpoint = this.endpoint;
    if (!endpoint || this.state.status !== 'connected') throw new DshError('UI_DISCONNECTED', '尚未连接 dsh 服务。');
    const response = await fetch(endpoint.url + path, { method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { Authorization: 'Bearer ' + endpoint.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json() as T & { error?: { code: string; message: string } };
    if (!response.ok) throw new DshError(value.error?.code ?? 'UI_REQUEST', value.error?.message ?? 'Control request failed.');
    if (this.endpoint?.server_id !== endpoint.server_id) throw new DshError('UI_DISCONNECTED', '服务已重启，请重新确认设置。');
    return { value, endpoint };
  }
  async updateSettings(patch: unknown, expectedRevision: number) {
    const result = await this.request<UiEnvelope>('/v1/settings', 'PATCH', { patch, expected_revision: expectedRevision });
    this.accept(result.value, result.endpoint); return this.snapshot();
  }
  async setOutsourcingEnabled(enabled: boolean, expectedRevision: number) {
    const result = await this.request<UiEnvelope>('/v1/outsourcing', 'PATCH', { enabled, expected_revision: expectedRevision });
    this.accept(result.value, result.endpoint); return this.snapshot();
  }
  async applyServiceStop() {
    const result = await this.request<UiEnvelope>('/v1/service-stop', 'POST', {}, 20000);
    this.accept(result.value, result.endpoint); return this.snapshot();
  }
  async openManagementWindow(window: 'api_keys' | 'models') {
    const result = await this.request<UiWindowIntent>('/v1/window-intent', 'POST', { window }); return result.value;
  }
  close() { this.closed = true; this.generation++; this.abort?.abort(); clearTimeout(this.timer); this.listeners.clear(); }
}
