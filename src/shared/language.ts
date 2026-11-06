export type SupportedLanguage = 'en' | 'ja' | 'zh' | 'zh-TW';

export function isTraditionalChineseLocale(locale: string): boolean {
  const normalized = locale.toLowerCase().replace(/_/g, '-');
  const [language, ...subtags] = normalized.split('-');
  return language === 'zh' && (
    subtags.includes('hant') ||
    (!subtags.includes('hans') && subtags.some(tag => ['tw', 'hk', 'mo'].includes(tag)))
  );
}

export function resolveSystemLanguage(locale: string): SupportedLanguage {
  const normalized = locale.toLowerCase().replace(/_/g, '-');
  if (isTraditionalChineseLocale(normalized)) return 'zh-TW';
  if (isSimplifiedChineseLocale(normalized)) return 'zh';
  if (normalized === 'ja' || normalized.startsWith('ja-')) return 'ja';
  return 'en';
}

export function isSimplifiedChineseLocale(locale: string): boolean {
  const normalized = locale.toLowerCase().replace(/_/g, '-');
  const [language, ...subtags] = normalized.split('-');
  if (language !== 'zh' || subtags.includes('hant')) return false;
  if (subtags.includes('hans')) return true;
  return subtags.length === 0 || ['cn', 'sg', 'my'].includes(subtags[0]);
}
