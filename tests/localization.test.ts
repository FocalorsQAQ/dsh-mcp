import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { languages, normalizeLocale, startupLocale, translate } from '../desktop/localization.mjs';

const read = (locale: string): Record<string, string> => JSON.parse(readFileSync(new URL('../resources/locales/' + locale + '.json', import.meta.url), 'utf8'));

test('every supported language has the complete catalog and preserves interpolation parameters', () => {
  const reference = read('zh-CN');
  const parameters = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const locale of Object.keys(languages)) {
    const catalog = read(locale);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(reference).sort(), locale + ' must translate every key');
    for (const [key, text] of Object.entries(catalog)) {
      assert.equal(typeof text, 'string'); assert(text.trim(), key + ' must not be empty');
      assert.deepEqual(parameters(text), parameters(reference[key]!), locale + ': ' + key);
    }
  }
});

test('explicit language overrides saved preference, while unknown languages fall back without loading paths', () => {
  assert.equal(startupLocale(undefined, 'en-US'), 'en-US');
  assert.equal(startupLocale('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(startupLocale('fr-FR', 'en-US'), 'en-US');
  assert.equal(startupLocale(undefined, undefined), 'zh-CN');
  assert.equal(normalizeLocale('en_GB'), 'en-US');
  assert.equal(normalizeLocale('../../credentials'), undefined);
});

test('desktop dialogs translate placeholders, zero usage and unknown errors in the selected language', () => {
  assert.equal(translate('en-US', 'runtime.active', { count: 0, limit: 4 }), '0 / 4 top-level agents running');
  assert.equal(translate('en-US', 'model.verifiedSaved', { input: 0, output: 2 }), 'Model verified and saved. Reported usage: 0 input / 2 output tokens.');
  assert.equal(translate('en-US', 'error.UNEXPECTED'), translate('en-US', 'error.default'));
  assert.equal(translate('zh-CN', 'model.confirmCost'), read('zh-CN')['model.confirmCost']);
});
