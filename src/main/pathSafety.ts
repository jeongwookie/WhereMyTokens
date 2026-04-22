import * as path from 'path';

export function isSafeLocalCwd(cwd: string): boolean {
  if (!cwd || cwd.includes('\0')) return false;
  if (!path.isAbsolute(cwd)) return false;

  const normalized = cwd.replace(/\//g, '\\');
  if (process.platform === 'win32') {
    if (/^\\\\[.?]\\/.test(normalized)) return false;
    if (normalized.startsWith('\\\\')) {
      return /^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\/i.test(normalized);
    }
    return /^[a-z]:\\/i.test(normalized);
  } else if (cwd.startsWith('//')) {
    return false;
  }

  return true;
}
