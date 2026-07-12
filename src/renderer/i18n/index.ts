import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ja from './locales/ja.json';

export const LANGUAGE_STORAGE_KEY = 'wmt-language';

export type SupportedLanguage = 'en' | 'ja';
export type LanguagePreference = 'system' | SupportedLanguage;

// Electron's renderer process inherits navigator.language from the OS locale
// (Chromium sets it from app.getLocale() by default), so this needs no IPC round-trip.
function detectSystemLanguage(): SupportedLanguage {
  const navLang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en';
  return navLang.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

function readStoredPreference(): LanguagePreference | null {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === 'en' || stored === 'ja' || stored === 'system') return stored;
  } catch {
    // localStorage unavailable — fall through to system default
  }
  return null;
}

export function getLanguagePreference(): LanguagePreference {
  return readStoredPreference() ?? 'system';
}

export function resolveInitialLanguage(): SupportedLanguage {
  const stored = readStoredPreference();
  if (stored === 'en' || stored === 'ja') return stored;
  return detectSystemLanguage();
}

export function setLanguagePreference(preference: LanguagePreference): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    // ignore persistence failures (e.g. storage disabled)
  }
  const resolved = preference === 'system' ? detectSystemLanguage() : preference;
  void i18n.changeLanguage(resolved);
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ja: { translation: ja },
    },
    lng: resolveInitialLanguage(),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
  });

// Keep <html lang="..."> in sync (CSP forbids inline scripts, so the static splash
// markup can't do this before the bundle loads — it stays "en" until this runs).
function syncDocumentLang(lng: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lng.startsWith('ja') ? 'ja' : 'en';
}
syncDocumentLang(i18n.language);
i18n.on('languageChanged', syncDocumentLang);

export default i18n;
