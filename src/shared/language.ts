export function isSimplifiedChineseLocale(locale: string): boolean {
  const normalized = locale.toLowerCase().replace(/_/g, '-');
  const [language, ...subtags] = normalized.split('-');
  if (language !== 'zh' || subtags.includes('hant')) return false;
  if (subtags.includes('hans')) return true;
  return subtags.length === 0 || ['cn', 'sg', 'my'].includes(subtags[0]);
}
