import type { DiscoveredSession, SessionProvider, SessionState } from '../types';
import { normalizeSourcePath } from './sourceFiles';

export function sessionSortTime(session: Pick<DiscoveredSession, 'lastModified' | 'startedAt'>): number {
  return session.lastModified?.getTime() ?? session.startedAt.getTime();
}

export function trackedJsonlSet(paths: string[] = []): Set<string> {
  const tracked = new Set<string>();
  for (const filePath of paths) {
    if (!filePath) continue;
    tracked.add(normalizeSourcePath(filePath));
  }
  return tracked;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function calcState(alive: boolean | null, lastModified: Date | null): SessionState {
  if (alive === false) return 'idle';
  if (!lastModified) return 'idle';
  const diffMin = (Date.now() - lastModified.getTime()) / 60000;
  if (diffMin < 2) return 'active';
  if (diffMin < 15) return 'waiting';
  return 'idle';
}

export function entrypointToSource(entrypoint: string, provider: SessionProvider = 'claude'): string {
  const map: Record<string, string> = {
    'cli': 'Terminal',
    'exec': provider === 'codex' ? 'Codex Exec' : 'Terminal',
    'vscode': 'VS Code',
    'codex': 'Codex',
    'claude-vscode': 'VS Code',
    'claude-cursor': 'Cursor',
    'claude-jetbrains': 'JetBrains',
    'claude-xcode': 'Xcode',
    'claude-zed': 'Zed',
    'claude-windsurf': 'Windsurf',
    'claude-warp': 'Warp',
    'claude-iterm2': 'iTerm2',
    'claude-ghostty': 'Ghostty',
    'claude-terminal': 'Terminal',
    'iterm2': 'iTerm2',
    'warp': 'Warp',
    'ghostty': 'Ghostty',
    'zed': 'Zed',
    'windsurf': 'Windsurf',
  };
  return map[entrypoint] ?? entrypoint;
}
