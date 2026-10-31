import { useEffect, useRef, useState } from 'react';
import type { ApiEntry, ApiProtocol, ApiRegistrySnapshot } from '../../src/credential-contract';
import { t, type LocalizedNotice } from './i18n';
import { Icon } from './icons';
import './api-manager.css';

const protocols: ApiProtocol[] = ['deepseek', 'openai_chat', 'openai_responses', 'anthropic'];
const defaults: Record<ApiProtocol, string> = { deepseek: 'https://api.deepseek.com', openai_chat: 'https://api.openai.com/v1',
  openai_responses: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com' };
type Draft = { name: string; protocol: ApiProtocol; base_url: string; api_key?: string };

function ApiForm({ entry, busy, encrypted, onSave, onRemove, onCancel }: { entry?: ApiEntry; busy: boolean; encrypted: boolean;
  onSave: (draft: Draft) => Promise<void>; onRemove: () => void; onCancel: () => void }) {
  const [name, setName] = useState(entry?.name ?? '');
  const [protocol, setProtocol] = useState<ApiProtocol>(entry?.protocol ?? 'deepseek');
  const [base, setBase] = useState(entry?.base_url ?? defaults.deepseek);
  const [confirm, setConfirm] = useState(false);
  const secret = useRef<HTMLInputElement>(null);
  return <form className="api-form" onSubmit={event => {
    event.preventDefault();
    const draft: Draft = { name, protocol, base_url: protocol === 'deepseek' ? defaults.deepseek : base };
    if (!entry) { draft.api_key = secret.current?.value ?? ''; if (secret.current) secret.current.value = ''; }
    void onSave(draft);
  }}>
    <div className="api-form-heading"><span className="api-symbol"><Icon name="key" size={22} /></span><div><h2>{t(entry ? 'api.editTitle' : 'api.newTitle')}</h2><p>{t(entry ? 'api.editHint' : 'api.newHint')}</p></div></div>
    <fieldset disabled={busy}>
      <label className="api-field"><span>{t('api.name')}</span><input autoFocus required maxLength={80} aria-label={t('api.name')} value={name} onChange={event => setName(event.target.value)} placeholder={t('api.namePlaceholder')} autoComplete="off" /></label>
      <label className="api-field"><span>{t('api.protocol')}</span><select aria-label={t('api.protocol')} value={protocol} onChange={event => {
        const next = event.target.value as ApiProtocol;
        if (protocol === 'deepseek' || base === defaults[protocol] || next === 'deepseek') setBase(defaults[next]);
        setProtocol(next);
      }}>{protocols.map(item => <option key={item} value={item}>{t('protocol.' + item)}</option>)}</select></label>
      {protocol !== 'deepseek' && <label className="api-field"><span>{t('api.baseUrl')}</span><input required type="url" maxLength={2048} aria-label={t('api.baseUrl')} value={base} onChange={event => setBase(event.target.value)} autoComplete="off" spellCheck={false} /><small>{t('api.baseHint')}</small></label>}
      {entry ? <div className="api-protected"><Icon name="key" size={16} /><div><strong>{t('api.keySaved')}</strong><p>{t('api.noReveal')}</p></div></div> :
        <label className="api-field"><span>{t('api.key')}</span><input ref={secret} required type="password" maxLength={8192} aria-label={t('api.key')} placeholder={t('api.keyPlaceholder')} autoComplete="new-password" spellCheck={false} data-lpignore="true" /><small>{t('api.keyHint')}</small></label>}
      {!encrypted && <p className="api-warning" role="alert">{t('error.API_ENCRYPTION')}</p>}
      <div className="api-form-actions"><button className="api-primary" type="submit" disabled={!entry && !encrypted}>{t(busy ? 'save.pending' : 'api.save')}</button><button type="button" className="api-secondary" onClick={onCancel}>{t('api.cancel')}</button></div>
      {entry && <div className="api-delete">
        {confirm ? <><p>{t('api.deleteConfirm', { name: entry.name })}</p><div><button type="button" className="api-danger" onClick={onRemove}>{t('api.deleteYes')}</button><button type="button" className="api-secondary" onClick={() => setConfirm(false)}>{t('api.cancel')}</button></div></> :
          <button type="button" className="api-danger" onClick={() => setConfirm(true)}>{t('api.delete')}</button>}
      </div>}
    </fieldset>
  </form>;
}

export function ApiManager() {
  const [snapshot, setSnapshot] = useState<ApiRegistrySnapshot | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [notice, setNotice] = useState<LocalizedNotice | null>(null);
  const refresh = async () => {
    const result = await window.dsh.apis.list();
    if (result.ok) { setSnapshot(result.value); return result.value; }
    setNotice({ key: 'error.' + result.code, error: true }); return null;
  };
  useEffect(() => { document.title = t('api.title'); void refresh(); }, []);
  const selected = snapshot?.entries.find(entry => entry.id === selection);
  const mutate = async (action: () => ReturnType<typeof window.dsh.apis.list>, success: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setNotice(null);
    try {
      const result = await action();
      if (result.ok) { setSnapshot(result.value); setSelection(null); setNotice({ key: success, error: false }); }
      else { setNotice({ key: 'error.' + result.code, error: true }); if (result.code === 'API_CONFLICT' || result.code === 'API_NOT_FOUND') { await refresh(); setSelection(null); } }
    } catch { setNotice({ key: 'error.API_STORAGE', error: true }); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="app-shell api-shell">
    <header className="titlebar"><div className="brand">{t('api.title')}</div><div className="window-controls"><button className="close-button" aria-label={t('api.close')} title={t('api.close')} onClick={() => void window.dsh.apis.close()}><Icon name="close" size={16} /></button></div></header>
    <div className="api-intro"><h1>{t('api.heading')}</h1><p>{t('api.subtitle')}</p></div>
    {notice && <div className={'api-notice ' + (notice.error ? 'error' : '')} role={notice.error ? 'alert' : 'status'}>{t(notice.key, notice.parameters)}{notice.suffix}</div>}
    <div className="api-workspace">
      <aside className="api-sidebar"><div className="api-list-heading"><span>{t('api.loaded')}</span><small>{snapshot?.entries.length ?? '—'}</small><button title={t('api.refresh')} aria-label={t('api.refresh')} disabled={busy} onClick={() => void refresh()}><Icon name="refresh" size={13} /></button></div>
        <div className="api-list" role="list" aria-label={t('api.loaded')}>
          {snapshot?.entries.map(entry => <div role="listitem" key={entry.id}><button className={'api-entry ' + (selection === entry.id ? 'active' : '')} disabled={busy} onClick={() => { setSelection(entry.id); setNotice(null); }}><span className="api-entry-icon"><Icon name="key" size={15} /></span><span className="api-entry-copy"><strong>{entry.name}</strong><small>{t('protocol.' + entry.protocol)}</small><span title={entry.base_url}>{entry.base_url}</span></span></button></div>)}
          {snapshot?.entries.length === 0 && <div className="api-empty"><Icon name="key" size={24} /><p>{t('api.empty')}</p><small>{t('api.emptyHint')}</small></div>}
        </div>
        <button className="api-add" disabled={busy || !snapshot || !snapshot.encryption_available} onClick={() => { setSelection('new'); setNotice(null); }}><Icon name="plus" size={15} />{t('api.add')}</button>
      </aside>
      <section className="api-detail">
        {snapshot && (selection === 'new' || selected) ? <ApiForm key={selection} entry={selected} busy={busy} encrypted={snapshot.encryption_available}
          onSave={draft => mutate(() => selected ? window.dsh.apis.update({ id: selected.id, name: draft.name, protocol: draft.protocol, base_url: draft.base_url, expected_revision: snapshot.revision }) :
            window.dsh.apis.add({ ...draft, api_key: draft.api_key ?? '', expected_revision: snapshot.revision }), 'api.saved')}
          onRemove={() => void mutate(() => window.dsh.apis.remove({ id: selected!.id, expected_revision: snapshot.revision }), 'api.deleted')}
          onCancel={() => setSelection(null)} /> : <div className="api-detail-empty"><Icon name="key" size={34} /><h2>{t('api.select')}</h2><p>{t('api.selectHint')}</p>{snapshot && !snapshot.encryption_available && <p className="api-warning">{t('error.API_ENCRYPTION')}</p>}</div>}
      </section>
    </div>
    <footer><span><Icon name="key" size={12} /> {t('api.storageNote')}</span><span>{t('api.stageNote')}</span></footer>
  </div>;
}
