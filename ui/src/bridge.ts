import type { UiConnectionState } from '../../src/ui-protocol.ts';
import type { ControlPolicy } from '../../src/control-contract.ts';
import type { ApiRegistrySnapshot, ApiAdd, ApiUpdate, ApiRemove } from '../../src/credential-contract';
import type { ModelDraft, ModelConfigSnapshot, ProbeReceipt } from '../../src/model-config-contract';
import type { GlobalControlStatus } from '../../src/global-control';
export type DesktopState = { connection: UiConnectionState; global_control?: GlobalControlStatus; session_id?: string;
  sessions?: { id: string; title?: string | null; workspace: string; created_at: string }[]; window: { compact: boolean; floating: boolean } };
type Reply<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
declare global {
  interface Window {
    dsh: {
      locale: string;
      language: {
        get(): Promise<Reply<string>>;
        set(locale: string): Promise<Reply<string>>;
        subscribe(listener: (locale: string) => void): () => void;
      };
      models: {
        list(): Promise<Reply<ModelConfigSnapshot>>;
        save(input: { draft: ModelDraft; expected_revision: number }): Promise<Reply<ModelConfigSnapshot>>;
        toggle(input: { id: string; enabled: boolean; expected_revision: number }): Promise<Reply<ModelConfigSnapshot>>;
        remove(input: { id: string; expected_revision: number }): Promise<Reply<ModelConfigSnapshot>>;
        verify(input: { draft: ModelDraft; expected_revision: number }): Promise<Reply<{ cancelled: true } | { cancelled: false; snapshot: ModelConfigSnapshot; receipt: ProbeReceipt }>>;
        close(): Promise<Reply<void>>;
      };
      apis: {
        list(): Promise<Reply<ApiRegistrySnapshot>>;
        add(input: ApiAdd): Promise<Reply<ApiRegistrySnapshot>>;
        update(input: ApiUpdate): Promise<Reply<ApiRegistrySnapshot>>;
        remove(input: ApiRemove): Promise<Reply<ApiRegistrySnapshot>>;
        close(): Promise<Reply<void>>;
      };
      getState(): Promise<Reply<DesktopState>>;
      setOutsourcingEnabled(enabled: boolean, revision: number): Promise<Reply<DesktopState>>;
      updateSettings(patch: Partial<ControlPolicy>, revision: number, sessionId?: string): Promise<Reply<DesktopState>>;
      selectSession(id: string): Promise<Reply<DesktopState>>;
      openManagementWindow(window: 'api_keys' | 'models'): Promise<Reply<unknown>>;
      reconnect(): Promise<Reply<DesktopState>>;
      windowAction(action: 'compact' | 'minimize' | 'restore' | 'close'): Promise<Reply<DesktopState>>;
      dragOrb(action: 'start' | 'move' | 'end'): Promise<Reply<{ dragged: boolean }>>;
      subscribe(listener: (state: DesktopState) => void): () => void;
    };
  }
}
