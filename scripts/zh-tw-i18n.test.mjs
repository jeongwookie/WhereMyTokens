import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveSystemLanguage, isTraditionalChineseLocale, isSimplifiedChineseLocale } = require('../dist/shared/language.js');
const locales = ['en', 'ja', 'zh', 'zh-TW'];
function flatten(value, prefix = '', out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') out.set(path, child);
    else flatten(child, path, out);
  }
  return out;
}
test('all locale keys and interpolation variables match English', () => {
  const reference = flatten(JSON.parse(readFileSync('src/renderer/i18n/locales/en.json', 'utf8')));
  const vars = (value) => [...value.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)].map(m => m[1]).sort();
  for (const locale of locales) {
    const strings = flatten(JSON.parse(readFileSync(`src/renderer/i18n/locales/${locale}.json`, 'utf8')));
    assert.deepEqual([...strings.keys()].sort(), [...reference.keys()].sort(), `${locale} keys`);
    for (const [key, original] of reference) assert.deepEqual(vars(strings.get(key)), vars(original), `${locale} ${key} variables`);
  }
});
test('traditional Chinese locale precedence and simplified compatibility', () => {
  for (const locale of ['zh-TW', 'zh_Hant', 'zh-HK', 'zh-MO', 'zh-Hant-HK', 'zh_Hant_TW']) {
    assert.equal(resolveSystemLanguage(locale), 'zh-TW', locale);
    assert.equal(isTraditionalChineseLocale(locale), true);
  }
  for (const locale of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN']) {
    assert.equal(resolveSystemLanguage(locale), 'zh', locale);
    assert.equal(isSimplifiedChineseLocale(locale), true);
  }
  assert.equal(resolveSystemLanguage('ja-JP'), 'ja');
  assert.equal(resolveSystemLanguage('en-US'), 'en');
});
