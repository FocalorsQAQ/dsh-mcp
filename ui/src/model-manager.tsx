import { useEffect, useRef, useState } from 'react';
import type { ModelDraft, ModelConfigSnapshot } from '../../src/model-config-contract';
import type { ApiEntry } from '../../src/credential-contract';
import { t, type LocalizedNotice } from './i18n';
import { Icon } from './icons';
import './api-manager.css';
import './model-manager.css';

function NewModel({ apis, busy, save, cancel }: { apis: ApiEntry[]; busy: boolean; save: (draft: ModelDraft, verify: boolean) => void; cancel: () => void }) {
  const [apiId, setApiId] = useState(apis[0]?.id ?? '');
  const [modelId, setModelId] = useState('');
  const [levels, setLevels] = useState('');
  const [noReasoning, setNoReasoning] = useState(false);
  const api = apis.find(item => item.id === apiId);
  return <form className="api-form model-form" onSubmit={event => {
    event.preventDefault();
    const verify = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'verify';
    save({ api_id: apiId, model_id: modelId, reasoning_levels: api?.protocol === 'deepseek' ? null : noReasoning ? [] : levels.split(/[,，\s]+/).filter(Boolean) }, verify);
  }}>
    <div className="api-form-heading"><span className="api-symbol"><Icon name="model" size={22} /></span><div><h2>{t('model.add')}</h2><p>{t('model.addHint')}</p></div></div>
    <fieldset disabled={busy}>
      <label className="api-field"><span>{t('model.source')}</span><select required aria-label={t('model.source')} value={apiId} onChange={event => setApiId(event.target.value)}>{apis.map(item => <option key={item.id} value={item.id}>{item.name} · {t('protocol.' + item.protocol)}</option>)}</select></label>
      <label className="api-field"><span>{t('model.id')}</span><input required maxLength={200} aria-label={t('model.id')} value={modelId} onChange={event => setModelId(event.target.value)} autoComplete="off" spellCheck={false} placeholder={t('model.idPlaceholder')} /></label>
      {api?.protocol === 'deepseek' ? <div className="api-protected"><Icon name="model" size={17} /><p>{t('model.deepseekHint')}</p></div> : <>
        <label className="model-no-reasoning"><input type="checkbox" checked={noReasoning} onChange={event => setNoReasoning(event.target.checked)} />{t('model.noReasoning')}</label>
        {!noReasoning && <label className="api-field"><span>{t('model.levels')}</span><input required aria-label={t('model.levels')} value={levels} onChange={event => setLevels(event.target.value)} placeholder={t("model.levelsPlaceholder")} pattern=".*[a-z].*" autoComplete="off" spellCheck={false} /><small>{t('model.levelsHint')}</small></label>}
      </>}
      <div className="model-save-hint"><p>{t('model.saveHint')}</p><p>{t('model.verifyHint')}</p></div>
      <div className="api-form-actions model-form-actions"><button className="api-secondary" type="submit" value="save" disabled={!api}>{t('model.save')}</button><button className="api-primary" type="submit" value="verify" disabled={!api}>{t(busy ? 'model.working' : 'model.verifySave')}</button><button className="api-secondary" type="button" onClick={cancel}>{t('api.cancel')}</button></div>
    </fieldset>
  </form>;
}

export function ModelManager() {
  const [snapshot, setSnapshot] = useState<ModelConfigSnapshot | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), locked = useRef(false);
  const [notice, setNotice] = useState<LocalizedNotice | null>(null);
  const refresh = async () => {
    try {
      const result = await window.dsh.models.list();
      if (result.ok) setSnapshot(result.value); else setNotice({ key: 'error.' + result.code, error: true });
    } catch { setNotice({ key: 'error.MODEL_STORAGE', error: true }); }
  };
  useEffect(() => { document.title = t('model.title'); void refresh(); const focus = () => { if (!locked.current) void refresh(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, []);
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return; locked.current = true; setBusy(true); setNotice(null);
    try { await action(); } catch { setNotice({ key: 'error.MODEL_STORAGE', error: true }); }
    finally { locked.current = false; setBusy(false); }
  };
  const apply = async (action: () => ReturnType<typeof window.dsh.models.list>) => {
    const result = await action();
    if (result.ok) setSnapshot(result.value); else { setNotice({ key: 'error.' + result.code, error: true }); await refresh(); }
  };
  const save = (draft: ModelDraft, verify: boolean) => void run(async () => {
    const input = { draft, expected_revision: snapshot!.revision };
    if (!verify) {
      const result = await window.dsh.models.save(input);
      if (result.ok) { setSnapshot(result.value); setAdding(false); setNotice({ key: 'model.savedUnverified', error: false }); }
      else setNotice({ key: 'error.' + result.code, error: true });
    } else {
      const result = await window.dsh.models.verify(input);
      if (!result.ok) { setNotice({ key: 'error.' + result.code, error: true }); return; }
      if (result.value.cancelled) return;
      setSnapshot(result.value.snapshot);
      const receipt = result.value.receipt;
      if (receipt.status === 'verified') {
        setAdding(false); setNotice({ key: 'model.verifiedSaved', parameters: { input: receipt.input_tokens ?? '—', output: receipt.output_tokens ?? '—' }, error: false });
      } else setNotice({ key: 'error.' + receipt.error_code, suffix: receipt.http_status ? ` (HTTP ${receipt.http_status})` : '', error: true });
    }
  });
  const enabled = new Set(snapshot?.entries.filter(entry => entry.effective_enabled).map(entry => entry.model_id));
  return <div className="app-shell api-shell model-shell">
    <header className="titlebar"><div className="brand">{t('model.title')}</div><div className="window-controls"><button className="close-button" aria-label={t('model.close')} onClick={() => void window.dsh.models.close()}><Icon name="close" /></button></div></header>
    <div className="api-intro"><h1>{t('model.heading')}</h1><p>{t('model.subtitle')}</p></div>
    {notice && <div className={'api-notice ' + (notice.error ? 'error' : '')} role={notice.error ? 'alert' : 'status'}>{t(notice.key, notice.parameters)}{notice.suffix}</div>}
    <div className="api-workspace">
      <aside className="api-sidebar model-sidebar"><div className="api-list-heading"><span>{t('model.loaded')}</span><small>{snapshot?.entries.length ?? '—'}</small><button aria-label={t('model.refresh')} disabled={busy} onClick={() => void refresh()}><Icon name="refresh" size={13} /></button></div>
        <div className="api-list" role="list" aria-label={t('model.loaded')}>
          {snapshot?.entries.map(entry => {
            const conflict = enabled.has(entry.model_id) && !entry.effective_enabled;
            const label = (entry.api_name ?? t('model.missingApi')) + ' · ' + entry.model_id;
            return <div key={entry.id} role="listitem" className="model-item">
              <div className="model-row"><input type="checkbox" checked={entry.effective_enabled} disabled={busy || conflict || !entry.source_available} aria-label={t('model.enable', { name: label })} title={t(conflict ? 'model.duplicateDisabled' : !entry.source_available ? 'model.sourceChanged' : 'model.enableHint')} onChange={event => void run(() => apply(() => window.dsh.models.toggle({ id: entry.id, enabled: event.target.checked, expected_revision: snapshot.revision })))} />
                <div className="model-row-copy"><strong title={entry.model_id}>{entry.model_id}</strong><span title={entry.api_name ?? ''}>{entry.api_name ?? t('model.missingApi')}</span><small className={entry.verification_valid ? 'verified' : ''}>{t(!entry.source_available ? 'model.sourceChanged' : entry.verification_valid ? 'model.verified' : 'model.unverified')}</small></div>
                <button className="model-delete" disabled={busy} aria-label={t('model.delete', { name: label })} title={t('model.deleteShort')} onClick={() => setDeleting(entry.id)}><Icon name="close" size={15} /></button>
              </div>
              {deleting === entry.id && <div className="model-delete-confirm"><span>{t('model.deleteConfirm')}</span><button disabled={busy} onClick={() => void run(async () => { await apply(() => window.dsh.models.remove({ id: entry.id, expected_revision: snapshot.revision })); setDeleting(null); })}>{t('api.deleteYes')}</button><button disabled={busy} onClick={() => setDeleting(null)}>{t('api.cancel')}</button></div>}
            </div>;
          })}
          {snapshot?.entries.length === 0 && <div className="api-empty"><Icon name="model" size={27} /><p>{t('model.empty')}</p></div>}
        </div>
        <button className="api-add" disabled={busy || !snapshot?.apis.length} onClick={() => { setAdding(true); setNotice(null); }}><Icon name="plus" size={15} />{t('model.add')}</button>
        {snapshot?.apis.length === 0 && <p className="model-no-api">{t('model.noApi')}</p>}
      </aside>
      <section className="api-detail">{adding && snapshot ? <NewModel apis={snapshot.apis} busy={busy} save={save} cancel={() => setAdding(false)} /> : <div className="api-detail-empty"><Icon name="model" size={36} /><h2>{t('model.choose')}</h2><p>{t('model.chooseHint')}</p></div>}</section>
    </div>
    <footer><span>{t('model.footer')}</span><span>{t('model.routingLater')}</span></footer>
  </div>;
}
