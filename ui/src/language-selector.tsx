import { useState } from 'react';
import { changeLocale, languages, t, useLocale } from './i18n';

export function LanguageSelector() {
  const locale = useLocale();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  return <div className="language-control">
    <select aria-label={t('language.select')} title={t('language.select')} value={locale} disabled={busy}
      onChange={async event => {
        const next = event.target.value;
        setBusy(true); setError(null);
        try { setError(await changeLocale(next)); }
        catch { setError('UI_PREFERENCES'); }
        finally { setBusy(false); }
      }}>
      {Object.entries(languages).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select>
    {error && <span className="language-error" role="alert">{t('error.' + error)}</span>}
  </div>;
}
