import type { DashboardState } from '../../src/dashboard.ts';
import type { ControlPolicy } from '../../src/control-contract.ts';
import type { ApiRegistrySnapshot, ApiAdd, ApiUpdate, ApiRemove } from '../../src/credential-contract';
import type { ModelDraft, ModelConfigSnapshot, ProbeReceipt } from '../../src/model-config-contract';
export type DesktopState = DashboardState & { window: { compact: boolean } };
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
      updateSettings(patch: Partial<ControlPolicy>, revision: number): Promise<Reply<DesktopState>>;
      openManagementWindow(window: 'api_keys' | 'models'): Promise<Reply<unknown>>;
      reconnect(): Promise<Reply<DesktopState>>;
      windowAction(action: 'compact' | 'restore' | 'close'): Promise<Reply<DesktopState>>;
      subscribe(listener: (state: DesktopState) => void): () => void;
    };
  }
}
