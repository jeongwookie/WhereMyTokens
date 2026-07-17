import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ja from './locales/ja.json';

export type SupportedLanguage = 'en' | 'ja';
export type LanguagePreference = 'system' | SupportedLanguage;

// Electron renderer의 navigator.language는 Chromium이 app locale에서 채우므로 IPC 없이 시스템 언어를 추정할 수 있다.
export function detectSystemLanguage(): SupportedLanguage {
  const navLang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en';
  return navLang.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  return value === 'en' || value === 'ja' || value === 'system' ? value : 'system';
}

export function resolveLanguagePreference(preference: LanguagePreference): SupportedLanguage {
  return preference === 'system' ? detectSystemLanguage() : preference;
}

export function applyLanguagePreference(preference: LanguagePreference): void {
  void i18n.changeLanguage(resolveLanguagePreference(normalizeLanguagePreference(preference)));
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ja: { translation: ja },
    },
    lng: detectSystemLanguage(),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
  });

// CSP상 정적 splash는 bundle 로드 전까지 lang을 못 바꾸므로, i18n 상태와 html lang을 동기화한다.
function syncDocumentLang(lng: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lng.startsWith('ja') ? 'ja' : 'en';
}

syncDocumentLang(i18n.language);
i18n.on('languageChanged', syncDocumentLang);

export default i18n;
