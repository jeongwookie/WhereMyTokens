import * as path from 'path';

function isWindowsDriveAbsolute(value: string): boolean {
  return /^[a-z]:\\/i.test(value);
}

function isWslUncPath(value: string): boolean {
  return /^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\/i.test(value);
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
