import * as path from 'path';

export function isSafeLocalCwd(cwd: string): boolean {
  if (!cwd || cwd.includes('\0')) return false;
  if (!path.isAbsolute(cwd)) return false;

  const normalized = cwd.replace(/\//g, '\\');
  if (process.platform === 'win32') {
    if (normalized.startsWith('\\\\')) return false;
    if (/^\\\\[.?]\\/.test(normalized)) return false;
  } else if (cwd.startsWith('//')) {
    return false;
  }

  return true;
}
