import { useEffect, useRef, useState } from 'react';
import type { DesktopState } from './bridge';
import { t } from './i18n';
import './orb.css';

export function FloatingOrb() {
  const [state, setState] = useState<DesktopState>();
  const pressed = useRef(false);
  useEffect(() => {
    const off = window.dsh.subscribe(setState);
    void window.dsh.getState().then(reply => { if (reply.ok) setState(reply.value); });
    return off;
  }, []);
  const connected = state?.connection.status === 'connected';
  const runtime = state?.connection.snapshot?.runtime;
  const count = connected && runtime ? runtime.active_count : '—';
  const selected = state?.sessions?.find(item => item.id === state.session_id);
  const session = state?.session_id && state.session_id !== 'legacy' ? (selected?.title ?? t('session.chat', { id: state.session_id.slice(0, 8) })) + '\n' : '';
  const title = session + (connected && runtime ? t('orb.tooltip', { count, limit: runtime.max_concurrent_agents }) : t('orb.disconnected'));
  const restore = () => void window.dsh.windowAction('restore');
  return <div className="orb-shell">
    <button className={'floating-orb ' + (connected ? 'online' : 'offline') + (typeof count === 'number' && count > 0 ? ' busy' : '')}
      aria-label={t('orb.restore')} title={title}
      onPointerDown={event => {
        if (event.button !== 0) return;
        pressed.current = true; event.currentTarget.setPointerCapture(event.pointerId);
        void window.dsh.dragOrb('start');
      }}
      onPointerMove={() => { if (pressed.current) void window.dsh.dragOrb('move'); }}
      onPointerUp={async event => {
        if (!pressed.current) return;
        pressed.current = false; event.currentTarget.releasePointerCapture(event.pointerId);
        const result = await window.dsh.dragOrb('end');
        if (result.ok && !result.value.dragged) restore();
      }}
      onPointerCancel={() => { pressed.current = false; void window.dsh.dragOrb('end'); }}
      onClick={event => { if (event.detail === 0) restore(); }}>
      <span className="orb-status" />
      <strong data-testid="orb-concurrency">{count}</strong>
      <span className="orb-caption">{connected ? t('orb.active') : t('orb.offline')}</span>
    </button>
  </div>;
}
