import { readFileSync } from 'node:fs';

export const languages = JSON.parse(readFileSync(new URL('../resources/languages.json', import.meta.url), 'utf8'));
const catalogs = Object.fromEntries(Object.keys(languages).map(locale => [locale,
  JSON.parse(readFileSync(new URL('../resources/locales/' + locale + '.json', import.meta.url), 'utf8'))]));

export function normalizeLocale(value) {
  if (typeof value !== 'string') return undefined;
  const canonical = value.trim().replaceAll('_', '-').toLowerCase();
  return Object.keys(languages).find(locale => locale.toLowerCase() === canonical)
    ?? (canonical === 'en' || canonical.startsWith('en-') ? 'en-US' : canonical === 'zh' || canonical === 'zh-hans' ? 'zh-CN' : undefined);
}
export function startupLocale(requested, saved) { return normalizeLocale(requested) ?? normalizeLocale(saved) ?? 'zh-CN'; }
export function translate(locale, key, parameters = {}) {
  const template = catalogs[normalizeLocale(locale) ?? 'zh-CN'][key] ?? catalogs['zh-CN'][key]
    ?? (key.startsWith('error.') ? catalogs[normalizeLocale(locale) ?? 'zh-CN']['error.default'] ?? catalogs['zh-CN']['error.default'] : key);
  return template.replace(/\{(\w+)\}/g, (match, name) => String(parameters[name] ?? match));
}
