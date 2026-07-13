import fs from 'node:fs';
import path from 'node:path';

// Shared helper for tests that used to assert against hardcoded English UI copy in .tsx/.ts
// source. Since the i18n work moved that copy into src/renderer/i18n/locales/{en,ja}.json and
// replaced it in source with t('some.key') calls, tests should assert either (a) that the
// correct translation key is wired up at a given call site, or (b) that en.json still holds the
// expected literal text — not that the literal English sentence appears in the component source.

let cachedEn = null;
let cachedJa = null;

function readLocale(fileName) {
  const filePath = path.resolve('src', 'renderer', 'i18n', 'locales', fileName);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function enStrings() {
  if (!cachedEn) cachedEn = readLocale('en.json');
  return cachedEn;
}

export function jaStrings() {
  if (!cachedJa) cachedJa = readLocale('ja.json');
  return cachedJa;
}

function lookup(strings, dottedKey) {
  const value = dottedKey.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), strings);
  if (typeof value !== 'string') throw new Error(`Missing locale string for key "${dottedKey}"`);
  return value;
}

// The English string for a translation key, e.g. enText('trendBreakdownCard.collapse') -> 'Collapse'.
export function enText(dottedKey) {
  return lookup(enStrings(), dottedKey);
}

export function jaText(dottedKey) {
  return lookup(jaStrings(), dottedKey);
}

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches a t('some.key') / t("some.key") call site in source, regardless of quote style or
// trailing interpolation-options argument, e.g. t('some.key', { count }).
export function tCallRegex(dottedKey) {
  return new RegExp(`t\\(['"]${escapeRegExp(dottedKey)}['"]`);
}

// Matches the literal English copy for a key, for use against rendered HTML/text output
// (where the harness has pinned i18n to 'en') rather than raw component source.
export function enTextRegex(dottedKey, flags) {
  return new RegExp(escapeRegExp(enText(dottedKey)), flags);
}
