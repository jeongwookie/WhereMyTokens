import * as path from 'path';

function isWindowsDriveAbsolute(value: string): boolean {
  return /^[a-z]:\\/i.test(value);
}

function isWslUncPath(value: string): boolean {
  const match = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\|$)/i.exec(value);
  if (!match) return false;
  const distro = match[1].trim();
  if (!distro || distro === '.' || distro === '..') return false;
  return !value.split('\\').filter(Boolean).some(part => part === '.' || part === '..');
}

export function isSafeLocalCwd(cwd: string): boolean {
  if (!cwd || cwd.includes('\0')) return false;

  const normalized = cwd.replace(/\//g, '\\');
  if (isWslUncPath(normalized)) return true;
  if (process.platform === 'win32' && isWindowsDriveAbsolute(normalized)) return true;
  if (!path.isAbsolute(cwd)) return false;

  if (process.platform === 'win32') {
    if (normalized.startsWith('\\\\')) return false;
    if (/^\\\\[.?]\\/.test(normalized)) return false;
  } else if (cwd.startsWith('//')) {
    return false;
  }

  return true;
}
