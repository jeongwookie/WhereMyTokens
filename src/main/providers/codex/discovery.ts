import * as fs from 'fs';
import * as path from 'path';
import { isSafeLocalCwd } from '../../pathSafety';
import { readCodexSessionHeader } from '../../sessionMetadata';
import type { DiscoveredSession, DiscoverSessionsOptions, ProviderContext } from '../types';
import { calcState, entrypointToSource, sessionSortTime, trackedJsonlSet } from '../shared/session';
import { describeRepoContext } from '../shared/repoContext';
import { isSourcePathInside, normalizeSourcePath } from '../shared/sourceFiles';
import { CODEX_SESSIONS_DIR } from './paths';

const DEFAULT_RECENT_CODEX_FILE_LIMIT = 96;

function codexEntrypointFromSource(sourceRaw: unknown): string {
  if (typeof sourceRaw === 'string' && sourceRaw.trim()) return sourceRaw.trim();
  if (sourceRaw && typeof sourceRaw === 'object') {
    const subagent = (sourceRaw as Record<string, unknown>).subagent;
    if (typeof subagent === 'string' && subagent.trim()) return `subagent:${subagent.trim()}`;
  }
  return 'codex';
}

function codexSourceLabel(entrypoint: string, originator: string | null): string {
  if (originator?.toLowerCase().includes('codex desktop')) return 'Codex Desktop';
  if (entrypoint.startsWith('subagent:')) return 'Codex Subagent';
  return entrypointToSource(entrypoint, 'codex');
}

export function describeCodexSource(sourceRaw: unknown, originator: string | null): {
  entrypoint: string;
  source: string;
} {
  const entrypoint = codexEntrypointFromSource(sourceRaw);
  return {
    entrypoint,
    source: codexSourceLabel(entrypoint, originator),
  };
}

function listCodexJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...listCodexJsonlFiles(fullPath));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(fullPath);
    }
  } catch { /* ignore */ }
  return results;
}

function listRecentCodexJsonlFiles(maxFiles: number, trackedPaths: Set<string>): string[] {
  const files: Array<{ filePath: string; mtimeMs: number }> = [];
  const seen = new Set<string>();
  const targetCount = maxFiles + trackedPaths.size + 1;

  const pushFile = (filePath: string): void => {
    const normalized = normalizeSourcePath(filePath);
    if (seen.has(normalized)) return;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { return; }
    seen.add(normalized);
    files.push({ filePath, mtimeMs });
  };

  for (const trackedPath of trackedPaths) {
    if (!isSourcePathInside(CODEX_SESSIONS_DIR, trackedPath)) continue;
    pushFile(trackedPath);
  }

  const readSubdirs = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      return [];
    }
  };

  const dayDirs: Array<{ dir: string; mtimeMs: number }> = [];
  for (const year of readSubdirs(CODEX_SESSIONS_DIR)) {
    const yearDir = path.join(CODEX_SESSIONS_DIR, year);
    for (const month of readSubdirs(yearDir)) {
      const monthDir = path.join(yearDir, month);
      for (const day of readSubdirs(monthDir)) {
        const dayDir = path.join(monthDir, day);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(dayDir).mtimeMs; } catch { /* skip */ }
        dayDirs.push({ dir: dayDir, mtimeMs });
      }
    }
  }

  dayDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const dayDir of dayDirs) {
    if (files.length >= targetCount) break;
    for (const filePath of listCodexJsonlFiles(dayDir.dir)) {
      pushFile(filePath);
      if (files.length >= targetCount) break;
    }
  }

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles + trackedPaths.size)
    .map(entry => entry.filePath);
}

function collectCodexSessions(options: DiscoverSessionsOptions = {}): DiscoveredSession[] {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return [];

  const results: DiscoveredSession[] = [];
  const scope = options.scope ?? 'recent-active';
  const tracked = trackedJsonlSet(options.trackedJsonlPaths);
  const files = scope === 'all'
    ? listCodexJsonlFiles(CODEX_SESSIONS_DIR)
    : listRecentCodexJsonlFiles(options.maxCodexFiles ?? DEFAULT_RECENT_CODEX_FILE_LIMIT, tracked);

  for (const filePath of files) {
    try {
      const header = readCodexSessionHeader(filePath);
      const payload = header?.payload;
      if (!payload) continue;

      const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
      if (!cwd) continue;
      if (!isSafeLocalCwd(cwd)) continue;

      const stat = fs.statSync(filePath);
      const sessionId = typeof payload.id === 'string' ? payload.id : path.basename(filePath, '.jsonl');
      const startedAtRaw = typeof payload.timestamp === 'string'
        ? payload.timestamp
        : (header.timestamp ?? '');
      const startedAt = startedAtRaw ? new Date(startedAtRaw) : stat.birthtime;
      const sourceRaw = payload.source;
      const originator = typeof payload.originator === 'string' ? payload.originator : null;
      const { entrypoint, source } = describeCodexSource(sourceRaw, originator);
      const repoContext = describeRepoContext(cwd);

      results.push({
        provider: 'codex',
        pid: null,
        sessionId,
        cwd,
        projectName: repoContext.projectName,
        startedAt,
        entrypoint,
        source,
        state: calcState(null, stat.mtime),
        jsonlPath: filePath,
        lastModified: stat.mtime,
        isWorktree: repoContext.isWorktree,
        worktreeBranch: repoContext.worktreeBranch,
        gitBranch: repoContext.gitBranch,
        mainRepoName: repoContext.mainRepoName,
      });
    } catch { /* skip malformed */ }
  }

  return results.sort((a, b) => sessionSortTime(b) - sessionSortTime(a));
}

export function discoverCodexSessions(ctx: ProviderContext): DiscoveredSession[] {
  return collectCodexSessions({
    scope: ctx.includeFullHistory ? 'all' : 'recent-active',
    trackedJsonlPaths: [...ctx.prioritySourceIds],
  });
}
