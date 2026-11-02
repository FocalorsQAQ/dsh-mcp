import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ControlPolicy, Money } from '../../src/control-contract.ts';
import type { DesktopState } from './bridge';
import { Icon } from './icons';
import { t, useLocale, type LocalizedNotice } from './i18n';
import { LanguageSelector } from './language-selector';
import { ApiManager } from './api-manager';
import { ModelManager } from './model-manager';
import './style.css';
import './density.css';
import './language.css';
import './dashboard.css';

const blank: DesktopState = { global_control: { available: false, state: null, error: 'loading' }, runtime: { online_count: 0, works: [] }, workspace_name: '', workspace_root: '', window: { compact: false } };
const defaults: ControlPolicy = { enabled: false, max_root_agents: 4, allow_secondary: false, restrict_to_caller_workspace: false, max_depth_user: 1,
  max_children_user: 1, round_budget: null, task_budget: null, billing_currency: 'USD' };

function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <button className={'toggle ' + (checked ? 'on' : '')} role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

function NumberField({ label, value, max, disabled, onChange }: { label: string; value: number; max: number; disabled: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setText(String(value)); }, [value]);
  const commit = () => {
    editing.current = false;
    const next = Number(text);
    if (!text.trim() || !Number.isSafeInteger(next) || next < 0 || next > max) { setText(String(value)); return; }
    if (next !== value) { setText(String(value)); onChange(next); }
  };
  return <div className="stepper">
    <button aria-label={t("stepper.decrease") + label} disabled={disabled || value <= 0} onClick={() => onChange(value - 1)}><Icon name="minus" size={13} /></button>
    <input aria-label={label} type="text" inputMode="numeric" value={text} disabled={disabled} onFocus={() => { editing.current = true; }} onChange={event => setText(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setText(String(value)); editing.current = false; } }} />
    <button aria-label={t("stepper.increase") + label} disabled={disabled || value >= max} onClick={() => onChange(value + 1)}><Icon name="plus" size={13} /></button>
  </div>;
}

function Budget({ label, value, currency, disabled, onChange }: { label: string; value: Money | null; currency: 'USD' | 'CNY'; disabled: boolean; onChange: (value: Money | null) => void }) {
  const [usd, setUsd] = useState(String(value?.[0] ?? ''));
  const [cny, setCny] = useState(String(value?.[1] ?? ''));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) { setUsd(String(value?.[0] ?? '')); setCny(String(value?.[1] ?? '')); } }, [value?.[0], value?.[1], value === null, disabled]);
  const commit = (side: 0 | 1) => {
    editing.current = false;
    if (value === null) return;
    const next: Money = [...value];
    next[side] = Number((side === 0 ? usd : cny) || 0);
    if (next.some(item => !Number.isFinite(item) || item < 0 || item > 1000000)) { setUsd(String(value[0])); setCny(String(value[1])); return; }
    if (next.some((item, index) => item !== value[index])) onChange(next);
  };
  return <div className="budget-row">
    <div className="budget-label"><span>{label}</span><label className="limit-check"><input aria-label={label + t("budget.limitLabel")} type="checkbox" checked={value !== null} disabled={disabled} onChange={event => onChange(event.target.checked ? [Number(usd) || (currency === 'USD' ? 1 : 0), Number(cny) || (currency === 'CNY' ? 10 : 0)] : null)} />{value === null ? t("budget.unlimited") : t("budget.limited")}</label></div>
    <div className={'money-inputs ' + (value === null ? 'unlimited' : '')}>
      <label><span>USD</span><input aria-label={label + t("budget.usd")} placeholder={value === null ? t("budget.unlimited") : '0.00'} value={value === null ? '' : usd} disabled={disabled || value === null} inputMode="decimal" onFocus={() => { editing.current = true; }} onChange={event => setUsd(event.target.value)} onBlur={() => commit(0)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
      <span className="currency-plus">+</span>
      <label><span>CNY</span><input aria-label={label + t("budget.cny")} placeholder={value === null ? t("budget.unlimited") : '0.00'} value={value === null ? '' : cny} disabled={disabled || value === null} inputMode="decimal" onFocus={() => { editing.current = true; }} onChange={event => setCny(event.target.value)} onBlur={() => commit(1)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
    </div>
  </div>;
}

function App() {
  const [state, setState] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<LocalizedNotice | null>(null);
  const current = useRef(state); current.current = state;
  const busy = useRef(false);
  useEffect(() => {
    const off = window.dsh.subscribe(setState);
    void window.dsh.getState().then(result => { if (result.ok) setState(result.value); });
    return off;
  }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(timer); }, [notice]);
  const global = state.global_control;
  const ready = global.available;
  const settings = ready ? global.state.settings : defaults;
  const unavailable = !ready || saving;
  const apply = async (patch: Partial<ControlPolicy>) => {
    const latest = current.current.global_control;
    if (busy.current || !latest.available) return;
    busy.current = true; setSaving(true); setNotice(null);
    try {
      const result = await window.dsh.updateSettings(patch, latest.state.revision);
      if (result.ok) setState(result.value);
      else { setNotice({ key: 'error.' + result.code, error: true }); const fresh = await window.dsh.getState(); if (fresh.ok) setState(fresh.value); }
    } catch { setNotice({ key: 'error.GLOBAL_CONTROL_STORAGE', error: true }); }
    finally { busy.current = false; setSaving(false); }
  };
  const action = async (name: 'compact' | 'close') => {
    try {
      const result = await window.dsh.windowAction(name);
      if (result.ok) setState(result.value);
      else setNotice({ key: 'error.' + result.code, error: true });
    } catch { setNotice({ key: 'error.SERVICE_STOP_UNCONFIRMED', error: true }); }
  };
  const placeholder = async (name: 'api_keys' | 'models') => {
    const result = await window.dsh.openManagementWindow(name);
    if (!result.ok) setNotice({ key: 'error.' + result.code, error: true });
  };
  return <div className={'app-shell ' + (state.window.compact ? 'compact' : '')}>
    <header className="titlebar">
      <div className="brand">{t('app.title')}</div>
      <div className="window-controls">
        <button aria-label={t(state.window.compact ? 'window.expand' : 'window.compact')} onClick={() => void action('compact')}><Icon name={state.window.compact ? 'expand' : 'collapse'} size={14} /></button>
      </div>
    </header>
    <main>
      <section className={'hero ' + (settings.enabled ? 'enabled' : '')}>
        <div className="hero-line"><div className="hero-heading"><span className="hero-symbol"><Icon name="agents" size={23} /></span><div><h1>{t('dashboard.settings')}</h1><p>{t(settings.enabled ? 'dashboard.enabled' : 'dashboard.disabled')}</p></div></div><Toggle label={t('outsourcing.enable')} checked={settings.enabled} disabled={unavailable} onChange={enabled => void apply({ enabled })} /></div>
        <p className="global-switch-note">{t('dashboard.snapshotHint')}</p>
        {ready && global.state.service_stop?.active && <p className="service-stopped-note">{t('service.stoppedHint')}</p>}
      </section>
      <details className="online-details" data-testid="online-details">
        <summary><Icon name="activity" size={15} /><strong>{t('dashboard.online', { count: state.runtime.online_count })}</strong><span>{t('dashboard.details')}</span></summary>
        {state.runtime.works.length ? state.runtime.works.map(work => <section className="work-group" key={work.id}>
          <h2>{work.title}</h2>
          {work.agents.map(agent => <div className="agent-detail" key={agent.id}><span title={agent.path}>{agent.name}</span><span>{agent.model}</span><small>{t('dashboard.effort')}: {agent.reasoning_effort ?? t('dashboard.defaultEffort')}</small></div>)}
        </section>) : <p className="online-empty">{t('dashboard.empty')}</p>}
      </details>
      <div className="expanded-content">
        <section className="control-section">
          <div className="section-heading"><span><Icon name="agents" size={15} />{t("agents.title")}</span><span className="quiet">{t("agents.userLimit")}</span></div>
          <div className="setting-row"><div><label>{t("agents.roots")}</label><p>{t("agents.rootsHint")}</p></div><NumberField label={t("agents.rootCount")}  value={settings.max_root_agents} max={32} disabled={unavailable} onChange={max_root_agents => void apply({ max_root_agents })} /></div>
          <div className="row-divider" />
          <div className="setting-row"><div><label>{t('workspace.restrict')}</label><p>{t(settings.restrict_to_caller_workspace ? 'workspace.restrictedHint' : 'workspace.unrestrictedHint')}</p></div><Toggle label={t('workspace.restrict')} checked={settings.restrict_to_caller_workspace} disabled={unavailable} onChange={restrict_to_caller_workspace => void apply({ restrict_to_caller_workspace })} /></div>
          <div className="row-divider" />
          <div className="setting-row"><div><label>{t("delegation.allow")}</label><p>{t("delegation.consentHint")}</p></div><Toggle label={t("delegation.allow")}  checked={settings.allow_secondary} disabled={unavailable} onChange={allow_secondary => void apply({ allow_secondary })} /></div>
          <div className={'nested-limits ' + (!settings.allow_secondary ? 'muted-controls' : '')}>
            <div><label>{t("delegation.depth")}</label><NumberField label={t("delegation.depth")}  value={settings.max_depth_user} max={32} disabled={unavailable || !settings.allow_secondary} onChange={max_depth_user => void apply({ max_depth_user })} /></div>
            <div><label title={t("delegation.childrenHint")} >{t("delegation.childrenTitle")}</label><NumberField label={t("delegation.children")}  value={settings.max_children_user} max={1000} disabled={unavailable || !settings.allow_secondary} onChange={max_children_user => void apply({ max_children_user })} /></div>
          </div>
        </section>

        <section className="control-section budget-section">
          <div className="section-heading"><span><Icon name="wallet" size={15} />{t("budget.title")}</span><span className="quiet">{t("budget.independent")}</span></div>
          <Budget label={t("budget.round")}  value={settings.round_budget} currency={settings.billing_currency} disabled={unavailable} onChange={round_budget => void apply({ round_budget })} />
          <Budget label={t("budget.task")}  value={settings.task_budget} currency={settings.billing_currency} disabled={unavailable} onChange={task_budget => void apply({ task_budget })} />
          <div className="budget-foot"><span title={t("billing.hint")} >{t("billing.title")}</span><div className="segmented small" aria-label={t("billing.title")} >{(['USD', 'CNY'] as const).map(currency => <button key={currency} aria-label={t("billing.use", { currency })} aria-pressed={settings.billing_currency === currency} disabled={unavailable} onClick={() => void apply({ billing_currency: currency })}>{currency}</button>)}</div></div>
        </section>

        <div className="management-buttons"><button aria-label={t("management.keysTitle")} onClick={() => void placeholder('api_keys')}><Icon name="key" /><span>{t("management.keys")}</span><small>{t("management.manage")}</small><Icon name="arrow" size={12} /></button><button aria-label={t("management.modelsTitle")} onClick={() => void placeholder('models')}><Icon name="model" /><span>{t("management.models")}</span><small>{t("management.manage")}</small><Icon name="arrow" size={12} /></button></div>

      </div>
    </main>
    {!state.window.compact && <div className="service-close-area"><button disabled={saving} onClick={() => void action('close')}>{t('service.close')}</button></div>}
    <footer><span className="project-name">{t('dashboard.future')}</span><LanguageSelector /><span className={'save-state ' + (saving ? 'saving' : '')}>{saving ? t('save.pending') : ready ? <><Icon name="check" size={12} />{t('save.synced')}</> : t('error.GLOBAL_CONTROL_STORAGE')}</span></footer>
    {notice && <div className="toast error" role="alert"><span>{t(notice.key, notice.parameters)}</span><button aria-label={t('notice.close')} onClick={() => setNotice(null)}><Icon name="close" size={12} /></button></div>}
  </div>;
}

function LocalizedRoot() {
  useLocale();
  return location.hash === '#api-keys' ? <ApiManager /> : location.hash === '#models' ? <ModelManager /> : <App />;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><LocalizedRoot /></React.StrictMode>);
