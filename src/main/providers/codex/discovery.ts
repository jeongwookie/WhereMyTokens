import * as fs from 'fs';
import { isSafeLocalCwd } from '../../pathSafety';
import { readCodexSessionHeaderForSource } from '../../sessionMetadata';
import type { DiscoveredSession, DiscoverSessionsOptions, ProviderContext } from '../types';
import { calcState, entrypointToSource, sessionSortTime, trackedJsonlSet } from '../shared/session';
import { describeRepoContext } from '../shared/repoContext';
import { isSourcePathInside, normalizeSourcePath } from '../shared/sourceFiles';
import {
  basenameForLogPath,
  findUsageLogSourceForPath,
  getUsageLogSources,
  joinLogPath,
  mapCwdForSource,
  sourceLabel,
  type UsageLogSource,
} from '../../wslPaths';

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

function listCodexJsonlFiles(dir: string, logSource?: UsageLogSource): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = joinLogPath(logSource, dir, entry.name);
      if (entry.isDirectory()) results.push(...listCodexJsonlFiles(fullPath, logSource));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(fullPath);
    }
  } catch { /* ignore */ }
  return results;
}

function listRecentCodexJsonlFiles(ctx: ProviderContext, maxFiles: number, trackedPaths: Set<string>): string[] {
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
    const logSource = findUsageLogSourceForPath('codex', trackedPath, ctx.settings.enableWslTracking);
    if (!logSource || !isSourcePathInside(logSource.codexSessionsDir, trackedPath)) continue;
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
  for (const logSource of getUsageLogSources(ctx.settings.enableWslTracking)) {
    for (const year of readSubdirs(logSource.codexSessionsDir)) {
      const yearDir = joinLogPath(logSource, logSource.codexSessionsDir, year);
      for (const month of readSubdirs(yearDir)) {
        const monthDir = joinLogPath(logSource, yearDir, month);
        for (const day of readSubdirs(monthDir)) {
          const dayDir = joinLogPath(logSource, monthDir, day);
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(dayDir).mtimeMs; } catch { /* skip */ }
          dayDirs.push({ dir: dayDir, mtimeMs });
        }
      }
    }
  }

  dayDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const dayDir of dayDirs) {
    if (files.length >= targetCount) break;
    const logSource = findUsageLogSourceForPath('codex', dayDir.dir, ctx.settings.enableWslTracking);
    for (const filePath of listCodexJsonlFiles(dayDir.dir, logSource)) {
      pushFile(filePath);
      if (files.length >= targetCount) break;
    }
  }

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles + trackedPaths.size)
    .map(entry => entry.filePath);
}

function collectCodexSessions(ctx: ProviderContext, options: DiscoverSessionsOptions = {}): DiscoveredSession[] {
  const results: DiscoveredSession[] = [];
  const scope = options.scope ?? 'recent-active';
  const tracked = trackedJsonlSet(options.trackedJsonlPaths);
  const files = scope === 'all'
    ? getUsageLogSources(ctx.settings.enableWslTracking).flatMap(source => listCodexJsonlFiles(source.codexSessionsDir, source))
    : listRecentCodexJsonlFiles(ctx, options.maxCodexFiles ?? DEFAULT_RECENT_CODEX_FILE_LIMIT, tracked);

  for (const filePath of files) {
    try {
      const logSource = findUsageLogSourceForPath('codex', filePath, ctx.settings.enableWslTracking);
      const header = readCodexSessionHeaderForSource(filePath, logSource);
      const payload = header?.payload;
      if (!payload) continue;

      const rawCwd = typeof payload.cwd === 'string' ? payload.cwd : '';
      if (!rawCwd) continue;
      const cwd = mapCwdForSource(logSource, rawCwd);
      if (!cwd) continue;
      if (!isSafeLocalCwd(cwd)) continue;

      const stat = fs.statSync(filePath);
      const sessionId = typeof payload.id === 'string' ? payload.id : basenameForLogPath(filePath).replace(/\.jsonl$/, '');
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
        source: sourceLabel(logSource, source),
        state: calcState(null, stat.mtime),
        jsonlPath: filePath,
        lastModified: stat.mtime,
        isWorktree: repoContext.isWorktree,
        worktreeBranch: repoContext.worktreeBranch,
        gitBranch: repoContext.gitBranch,
        mainRepoName: repoContext.mainRepoName,
        logSourceKind: logSource?.kind,
      });
    } catch { /* skip malformed */ }
  }

  return results.sort((a, b) => sessionSortTime(b) - sessionSortTime(a));
}

export function discoverCodexSessions(ctx: ProviderContext): DiscoveredSession[] {
  return collectCodexSessions(ctx, {
    scope: ctx.includeFullHistory ? 'all' : 'recent-active',
    trackedJsonlPaths: [...ctx.prioritySourceIds],
  });
}
