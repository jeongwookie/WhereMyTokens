import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import language from '../dist/shared/language.js';
import ipc from '../dist/main/ipc.js';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: { contents: `export * from './src/renderer/theme';
    export { default as i18n, detectSystemLanguage, normalizeLanguagePreference } from './src/renderer/i18n';
    export { default as Help } from './src/renderer/views/HelpView';
    export { default as Settings } from './src/renderer/views/SettingsView';`, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports);
const ui = mod.exports;

test('Simplified Chinese detection respects script and region boundaries', () => {
  for (const locale of ['zh', 'zh-CN', 'zh_SG', 'zh-MY', 'zh-Hans', 'zh-Hans-HK']) assert.equal(language.isSimplifiedChineseLocale(locale), true, locale);
  for (const locale of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-CN', 'zh-CN-Hant', 'zh-cnot', 'en', 'ja-JP', '']) assert.equal(language.isSimplifiedChineseLocale(locale), false, locale);
});

test('renderer automatic language and document language stay in sync', async () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const doc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: '' } } });
    for (const [locale, expected] of [['zh-CN', 'zh'], ['zh-TW', 'en'], ['zh-Hant', 'en'], ['ja-JP', 'ja'], ['ko-KR', 'en']]) {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: locale } });
      assert.equal(ui.detectSystemLanguage(), expected);
      await ui.i18n.changeLanguage(expected);
      assert.equal(document.documentElement.lang, expected === 'zh' ? 'zh-CN' : expected);
    }
    assert.equal(ui.normalizeLanguagePreference('zh'), 'zh');
    assert.equal(ui.normalizeLanguagePreference('<script>'), 'system');
  } finally {
    if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator;
    if (doc) Object.defineProperty(globalThis, 'document', doc); else delete globalThis.document;
  }
});

test('CNY formatting uses the chosen rate while USD and KRW retain their conventions', () => {
  for (const fn of [ui.fmtCost, ui.fmtCostShort]) {
    assert.equal(fn(1, 'CNY', 7.2), '\u00a57.20');
    assert.equal(fn(0.01, 'CNY', 7.2), '\u00a50.0720');
    assert.equal(fn(1, 'CNY', 8), '\u00a58.00');
    assert.equal(fn(1, 'USD', 7.2), '$1.00');
    assert.equal(fn(1, 'KRW', 1400), `\u20a9${(1400).toLocaleString()}`);
  }
  assert.equal(ui.fmtCostShort(1_000_000, 'CNY', 7.2), '\u00a57.2M');
});

test('Chinese help and settings render localized content and editable CNY rate', async () => {
  await ui.i18n.changeLanguage('zh');
  const help = renderToStaticMarkup(React.createElement(ui.Help, { onBack() {} }));
  assert.match(help, /\u670d\u52a1\u5546\u8ddf\u8e2a/);
  assert.match(help, /CNY/);
  const settings = renderToStaticMarkup(React.createElement(ui.Settings, {
    settings: { ...ipc.DEFAULT_SETTINGS, language: 'zh', currency: 'CNY', usdToCny: 7.35 },
    providerQuotas: {}, onSave() {}, onBack() {},
  }));
  assert.match(settings, /value="zh" selected/);
  assert.match(settings, /value="CNY" selected/);
  assert.match(settings, /value="7.35"/);
  assert.doesNotMatch(settings, /settingsView\./);
});
