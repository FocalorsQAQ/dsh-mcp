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
  const connected = Boolean(state);
  const count = state?.runtime.online_count ?? '—';
  const title = t('dashboard.online', { count });
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
