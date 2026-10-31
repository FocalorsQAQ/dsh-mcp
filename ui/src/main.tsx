import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ControlPolicy, Money } from '../../src/control-contract.ts';
import type { DesktopState } from './bridge';
import { Icon } from './icons';
import { t, useLocale, type LocalizedNotice } from './i18n';
import { LanguageSelector } from './language-selector';
import { ApiManager } from './api-manager';
import { ModelManager } from './model-manager';
import { FloatingOrb } from './floating-orb';
import './style.css';
import './density.css';
import './language.css';

const blank: DesktopState = { connection: { status: 'connecting', workspace_name: t("workspace.current"), workspace_root: '', snapshot: null, message: t("connection.connecting") }, window: { compact: false, floating: false } };
const defaults: ControlPolicy = { enabled: false, max_root_agents: 4, allow_secondary: false, max_depth_user: 1,
  max_children_user: 1, round_budget: null, task_budget: null, billing_currency: 'USD' };
const formatMoney = (value: number) => value.toFixed(2);
const formatTokens = (value?: number) => value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value);

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

function CurrencyPair({ value, missing = false }: { value?: Money; missing?: boolean }) {
  if (!value || missing) return <span className="empty-value">—</span>;
  return <span className="currency-pair">{formatMoney(value[0])} USD + {formatMoney(value[1])} CNY</span>;
}

function App() {
  const [state, setState] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<LocalizedNotice | null>(null);
  const [tokenScope, setTokenScope] = useState<'last' | 'total'>('last');
  const current = useRef(state); current.current = state;
  const busy = useRef(false);
  useEffect(() => {
    const off = window.dsh.subscribe(setState);
    void window.dsh.getState().then(result => { if (result.ok) setState(result.value); });
    return off;
  }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), notice.error ? 6000 : 3200); return () => clearTimeout(timer); }, [notice]);
  const connection = state.connection;
  const snapshot = connection.snapshot;
  const settings = snapshot?.settings ?? defaults;
  const connected = connection.status === 'connected';
  const unavailable = !connected || saving;
  const metrics = snapshot?.metrics;
  const usage = tokenScope === 'last' ? metrics?.last_api_tokens : metrics?.tokens;
  const period = snapshot?.pricing.current_period;
  const priceLabel = period === 'off_peak' ? t("pricing.offPeak") : period === 'peak' ? t("pricing.peak") : t("pricing.conservative");
  const apply = async (patch: Partial<ControlPolicy>) => {
    if (busy.current || current.current.connection.status !== 'connected') return;
    busy.current = true; setSaving(true); setNotice(null);
    try {
      const result = await window.dsh.updateSettings(patch, current.current.connection.snapshot!.revision);
      if (result.ok) setState(result.value);
      else {
        setNotice({ key: 'error.' + result.code, error: true });
        const fresh = await window.dsh.getState(); if (fresh.ok) setState(fresh.value);
      }
    } catch { setNotice({ key: 'error.offline', error: true }); }
    finally { busy.current = false; setSaving(false); }
  };
  const action = async (name: 'compact' | 'minimize' | 'close') => { const result = await window.dsh.windowAction(name); if (result.ok) setState(result.value); };
  const placeholder = async (name: 'api_keys' | 'models') => {
      const result = await window.dsh.openManagementWindow(name);
      if (!result.ok) setNotice({ key: 'error.' + result.code, error: true });
  };
  return <div className={'app-shell ' + (state.window.compact ? 'compact' : '')}>
    <header className="titlebar">
      <div className="brand">{t("app.title")}</div>
      <div className="window-controls">
        <button aria-label={state.window.compact ? t("window.expand") : t("window.compact")} title={state.window.compact ? t("window.expand") : t("window.compact")} onClick={() => void action('compact')}><Icon name={state.window.compact ? 'expand' : 'collapse'} size={14} /></button>
        <button aria-label={t("window.minimizeAria")}  title={t("window.minimize")}  onClick={() => void action('minimize')}><Icon name="minus" size={14} /></button>
        <button className="close-button" aria-label={t("window.close")}  title={t("window.closeHint")}  onClick={() => void action('close')}><Icon name="close" size={14} /></button>
      </div>
    </header>

    <main>
      <section className={'hero ' + (settings.enabled && connected ? 'enabled' : '')}>
        <div className="hero-line"><div className="hero-heading"><span className="hero-symbol"><Icon name="agents" size={23} /></span><div><h1>{!connected ? t("connection.waitTitle") : settings.enabled ? t("outsourcing.enabled") : t("outsourcing.disabled")}</h1><p>{!connected ? t("connection.syncHint") : settings.enabled ? t("outsourcing.enabledHint") : t("outsourcing.disabledHint")}</p></div></div><Toggle label={t("outsourcing.enable")}  checked={settings.enabled && connected} disabled={unavailable} onChange={enabled => void apply({ enabled })} /></div>
        <div className="hero-status"><span className={'connection-indicator ' + connection.status}><span className="dot" />{connected ? t("connection.connected") : connection.status === 'connecting' ? t("connection.pending") : t("connection.disconnected")}</span><span className="status-separator" /><span>{snapshot ? t("runtime.active", { count: snapshot.runtime.active_root_count, limit: settings.max_root_agents }) : t("agents.waiting")}</span><button className="inline-icon" aria-label={t("connection.reconnect")}  title={t("connection.reconnectHint")}  onClick={() => void window.dsh.reconnect()}><Icon name="refresh" size={13} /></button></div>
      </section>

      <div className="expanded-content">
        {!connected && <div className="connection-note" role="status"><span>{t(connection.status === "connecting" ? "connection.connecting" : snapshot ? "connection.lost" : "connection.waiting")}</span>{snapshot && <small>{t("connection.stale")}</small>}</div>}
        <section className="control-section">
          <div className="section-heading"><span><Icon name="agents" size={15} />{t("agents.title")}</span><span className="quiet">{t("agents.userLimit")}</span></div>
          <div className="setting-row"><div><label>{t("agents.roots")}</label><p>{t("agents.rootsHint")}</p></div><NumberField label={t("agents.rootCount")}  value={settings.max_root_agents} max={32} disabled={unavailable} onChange={max_root_agents => void apply({ max_root_agents })} /></div>
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

        <section className="usage-card">
          <div className="section-heading"><span><Icon name="activity" size={15} />{t("usage.title")}</span><span className="price-badge" title={t("pricing.hint")} ><Icon name="clock" size={11} />{snapshot ? priceLabel : t("pricing.waiting")}</span></div>
          <div className="cost-grid"><div><label>{t("usage.taskCost")}<span className="estimate">{t("usage.estimated")}</span></label><strong><CurrencyPair value={metrics?.task_cost} /></strong></div><div className="last-cost"><label>{t("usage.lastApi")}</label><strong><CurrencyPair value={metrics?.last_api_cost} missing={!metrics?.last_api_request_id} /></strong></div></div>
          <div className="tokens-heading"><span>{t("tokens.title")}</span><div className="segmented"><button aria-pressed={tokenScope === 'last'} onClick={() => setTokenScope('last')}>{t("tokens.last")}</button><button aria-pressed={tokenScope === 'total'} onClick={() => setTokenScope('total')}>{t("tokens.total")}</button></div></div>
          <div className="token-grid"><div><span>{t("tokens.miss")}</span><strong data-testid="token-miss">{formatTokens(usage?.input_cache_miss)}</strong></div><div><span>{t("tokens.hit")}</span><strong data-testid="token-hit">{formatTokens(usage?.input_cache_hit)}</strong></div><div><span>{t("tokens.output")}</span><strong data-testid="token-output">{formatTokens(usage?.output)}</strong></div></div>
          {metrics?.last_api_status === 'unknown' && <p className="usage-note">{t("usage.unknown")}</p>}
          {metrics?.accounting_blocked && <p className="usage-note error">{t("usage.blocked")}</p>}
          {snapshot?.pricing.catalog?.files.filter(file => !file.valid || file.expired).map(file =>
            <p className="usage-note error" key={file.provider} title={file.path + (file.error ? '\n' + file.error : '')}>
              {t(file.valid ? 'pricing.fileExpired' : 'pricing.fileInvalid', { provider: t('pricing.provider.' + file.provider) })}
            </p>)}
        </section>

        <div className="management-buttons"><button aria-label={t("management.keysTitle")} onClick={() => void placeholder('api_keys')}><Icon name="key" /><span>{t("management.keys")}</span><small>{t("management.manage")}</small><Icon name="arrow" size={12} /></button><button aria-label={t("management.modelsTitle")} onClick={() => void placeholder('models')}><Icon name="model" /><span>{t("management.models")}</span><small>{t("management.manage")}</small><Icon name="arrow" size={12} /></button></div>
      </div>
      <div className="compact-summary"><span>{t("usage.compactCost")}</span><CurrencyPair value={metrics?.task_cost} /><span className="compact-price">{snapshot ? priceLabel : '—'}</span></div>
    </main>
    <footer><span className="project-name" title={connection.workspace_root}><Icon name="folder" size={13} />{connection.workspace_name}</span><LanguageSelector /><span className={'save-state ' + (saving ? 'saving' : '')}>{saving ? <><span className="spinner" />{t("save.pending")}</> : connected ? <><Icon name="check" size={12} />{t("save.synced")}</> : t("connection.retry")}</span></footer>
    {notice && <div className={'toast ' + (notice.error ? 'error' : '')} role={notice.error ? 'alert' : 'status'}><Icon name={notice.error ? 'activity' : 'check'} size={14} /><span>{t(notice.key, notice.parameters)}{notice.suffix}</span><button aria-label={t("notice.close")}  onClick={() => setNotice(null)}><Icon name="close" size={12} /></button></div>}
  </div>;
}

function LocalizedRoot() {
  useLocale();
  return location.hash === '#api-keys' ? <ApiManager /> : location.hash === '#models' ? <ModelManager /> : location.hash === '#orb' ? <FloatingOrb /> : <App />;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><LocalizedRoot /></React.StrictMode>);
