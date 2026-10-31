import fallback from '../../resources/locales/zh-CN.json';
import languages from '../../resources/languages.json';
import { useSyncExternalStore } from 'react';

// Add a matching catalog and a languages.json entry, then rebuild both UI surfaces.
const catalogs = import.meta.glob<Record<string, string>>('../../resources/locales/*.json', { eager: true, import: 'default' });
let locale = Object.hasOwn(languages, window.dsh.locale) ? window.dsh.locale : 'zh-CN';
let messages: Record<string, string> = { ...fallback, ...catalogs[`../../resources/locales/${locale}.json`] };
const listeners = new Set<() => void>();
let generation = 0;
export { languages };
export type LocalizedNotice = { key: string; parameters?: Record<string, string | number>; suffix?: string; error: boolean };
export function t(key: string, parameters: Record<string, string | number> = {}): string {
  const template = messages[key] ?? (key.startsWith('error.') ? messages['error.default'] : key);
  return template.replace(/\{(\w+)\}/g, (match, name) => String(parameters[name] ?? match));
}
function updateDocument() {
  document.documentElement.lang = locale;
  document.title = t(location.hash === '#api-keys' ? 'api.title' : location.hash === '#models' ? 'model.title' : 'app.title');
}
function applyLocale(value: string) {
  if (!Object.hasOwn(languages, value)) return;
  locale = value;
  messages = { ...fallback, ...catalogs[`../../resources/locales/${locale}.json`] };
  updateDocument();
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useLocale() { return useSyncExternalStore(subscribe, () => locale); }
export async function changeLocale(value: string) {
  const result = await window.dsh.language.set(value);
  if (result.ok) { applyLocale(result.value); return null; }
  return result.code;
}
updateDocument();
window.dsh.language.subscribe(value => { generation++; applyLocale(value); });
// A window may finish loading after a switch. Do not let an older query response
// overwrite a newer broadcast. React rerenders in place without clearing forms.
const initialGeneration = generation;
void window.dsh.language.get().then(result => {
  if (result.ok && generation === initialGeneration) applyLocale(result.value);
}).catch(() => { /* Keep the launch locale if the window is already closing. */ });
