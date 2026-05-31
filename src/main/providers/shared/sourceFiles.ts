import * as fs from 'fs';
import * as path from 'path';
import type { SessionState } from '../types';

export function normalizeSourcePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function listJsonlFiles(dir: string, maxFiles = Number.POSITIVE_INFINITY, descending = false): string[] {
  const files: string[] = [];

  const walk = (currentDir: string): void => {
    if (files.length >= maxFiles) return;
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true })
        .sort((a, b) => descending ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= maxFiles) break;
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
      }
    } catch { /* skip */ }
  };

  walk(dir);
  return files;
}

export function statMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function sessionStateFromMtime(lastModified: Date | null): SessionState {
  if (!lastModified) return 'idle';
  const diffMin = (Date.now() - lastModified.getTime()) / 60000;
  if (diffMin < 2) return 'active';
  if (diffMin < 15) return 'waiting';
  return 'idle';
}
