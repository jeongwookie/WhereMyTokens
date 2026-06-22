import * as path from 'path';

export function fileUriToPath(uri: unknown): string | null {
  if (typeof uri !== 'string') return null;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return null;
    let filePath = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
    return filePath.replace(/\//g, path.sep);
  } catch {
    return null;
  }
}

export function maskEmail(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.includes('@')) return undefined;
  const [name, domain] = value.split('@');
  if (!name || !domain) return value;
  const visible = name.length <= 2 ? `${name[0] ?? ''}*` : `${name.slice(0, 2)}***`;
  return `${visible}@${domain}`;
}

export function parseTimestampMs(value: unknown, fallbackMs: number): number {
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber > 10_000_000_000 ? asNumber : asNumber * 1000;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  return fallbackMs;
}
