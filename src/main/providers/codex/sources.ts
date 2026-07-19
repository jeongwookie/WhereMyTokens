import * as fs from 'fs';
import * as path from 'path';
import { isSafeLocalCwd } from '../../pathSafety';
import { readCodexSessionHeader, readJsonlCwd } from '../../sessionMetadata';
import { describeCodexSource } from './discovery';
import type { DiscoveredSession, ExcludedProjectMatcher, ProviderContext, ProviderSource, ProviderSourceList } from '../types';
import { describeRepoContext, projectKeysForCwd } from '../shared/repoContext';
import { isSourcePathInside, listJsonlFiles, normalizeSourcePath, sessionStateFromMtime, statMtimeMs, statMtimeMsOrNull } from '../shared/sourceFiles';
import { CODEX_SESSIONS_DIR, CODEX_USAGE_DIRS } from './paths';
import { createCodexUsageIndexScanner } from './usageIndexScanner';

function sourceFromFile(filePath: string): ProviderSource {
  return {
    provider: 'codex',
    sourceId: `codex:${codexSessionDedupeKey(filePath)}`,
    filePath,
  };
}

export function ownsCodexPath(filePath: string): boolean {
  return CODEX_USAGE_DIRS.some(root => isSourcePathInside(root, filePath));
}

function readSubdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

export function listRecentCodexSources(_ctx: ProviderContext, limit: number): ProviderSourceList {
  const files: string[] = [];
  const targetCount = limit + 1;
  const dayDirs: Array<{ dir: string; mtimeMs: number }> = [];

  for (const year of readSubdirs(CODEX_SESSIONS_DIR)) {
    const yearDir = path.join(CODEX_SESSIONS_DIR, year);
    for (const month of readSubdirs(yearDir)) {
      const monthDir = path.join(yearDir, month);
      for (const day of readSubdirs(monthDir)) {
        const dayDir = path.join(monthDir, day);
        dayDirs.push({ dir: dayDir, mtimeMs: statMtimeMs(dayDir) });
      }
    }
  }

  dayDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const dayDir of dayDirs) {
    if (files.length >= targetCount) break;
    const remaining = targetCount - files.length;
    const recentFiles = listJsonlFiles(dayDir.dir, remaining, true)
      .map(filePath => ({ filePath, mtimeMs: statMtimeMs(filePath) }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    files.push(...recentFiles.map(entry => entry.filePath));
  }

  const truncated = files.length > limit;
  if (truncated) files.length = limit;
  return { sources: files.map(sourceFromFile), truncated };
}

function codexSessionDedupeKey(filePath: string): string {
  const basename = path.basename(filePath, '.jsonl');
  const filenameSessionId = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
  if (filenameSessionId) return filenameSessionId.toLowerCase();
  const header = readCodexSessionHeader(filePath);
  const sessionId = typeof header?.payload.id === 'string' && header.payload.id.trim()
    ? header.payload.id.trim()
    : basename;
  return sessionId.toLowerCase();
}

function codexUsageRootRank(filePath: string): number | null {
  const index = CODEX_USAGE_DIRS.findIndex(root => isSourcePathInside(root, filePath));
  return index >= 0 ? index : null;
}

export function listAllCodexSources(): ProviderSourceList {
  const deduped = new Map<string, { filePath: string; rank: number; mtimeMs: number }>();

  for (const root of CODEX_USAGE_DIRS) {
    if (!fs.existsSync(root)) continue;
    for (const filePath of listJsonlFiles(root, Number.POSITIVE_INFINITY, false)) {
      const rank = codexUsageRootRank(filePath);
      if (rank == null) continue;
      const mtimeMs = statMtimeMsOrNull(filePath);
      if (mtimeMs == null) continue;
      const key = codexSessionDedupeKey(filePath);
      const current = deduped.get(key);
      if (!current
        || rank < current.rank
        || (rank === current.rank && mtimeMs > current.mtimeMs)
        || (rank === current.rank && mtimeMs === current.mtimeMs && filePath.localeCompare(current.filePath) < 0)) {
        deduped.set(key, { filePath, rank, mtimeMs });
      }
    }
  }

  const files = [...deduped.values()]
    .sort((a, b) => a.rank - b.rank || a.filePath.localeCompare(b.filePath))
    .map(entry => entry.filePath);
  return { sources: files.map(sourceFromFile), truncated: false };
}

export function buildCodexUsageIndexSource(_ctx: ProviderContext, source: ProviderSource) {
  const stat = fs.statSync(source.filePath);
  return {
    descriptor: {
      sourceId: `codex:${codexSessionDedupeKey(source.filePath)}`,
      provider: 'codex' as const,
      kind: 'file' as const,
      parserVersion: 3,
      version: {
        token: `${stat.size}:${stat.mtimeMs}`,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      },
    },
    scanner: createCodexUsageIndexScanner(source.filePath),
  };
}

export function readCodexSourceCwd(source: ProviderSource): string | null {
  return readJsonlCwd(source.filePath, 'codex');
}

export function codexWatchTargets(_ctx: ProviderContext, mode: 'recent' | 'wide'): string[] {
  if (mode !== 'wide' || !fs.existsSync(CODEX_SESSIONS_DIR)) return [];
  return [CODEX_SESSIONS_DIR.replace(/\\/g, '/') + '/**/*.jsonl'];
}

export function buildStartupCodexSession(_ctx: ProviderContext, source: ProviderSource): DiscoveredSession | null {
  const cwd = readCodexSourceCwd(source);
  if (!cwd || !isSafeLocalCwd(cwd)) return null;

  try {
    const stat = fs.statSync(source.filePath);
    const header = readCodexSessionHeader(source.filePath);
    const payload = header?.payload;
    const sessionId = typeof payload?.id === 'string' && payload.id.trim()
      ? payload.id.trim()
      : path.basename(source.filePath, '.jsonl');
    const startedAtRaw = typeof payload?.timestamp === 'string'
      ? payload.timestamp
      : (header?.timestamp ?? '');
    const startedAt = startedAtRaw ? new Date(startedAtRaw) : stat.birthtime;
    const originator = typeof payload?.originator === 'string' ? payload.originator : null;
    const { entrypoint, source: sourceLabel } = describeCodexSource(payload?.source, originator);
    const repoContext = describeRepoContext(cwd);

    return {
      provider: 'codex',
      pid: null,
      sessionId,
      cwd,
      projectName: repoContext.projectName,
      startedAt,
      entrypoint,
      source: sourceLabel,
      state: sessionStateFromMtime(stat.mtime),
      jsonlPath: source.filePath,
      lastModified: stat.mtime,
      isWorktree: repoContext.isWorktree,
      worktreeBranch: repoContext.worktreeBranch,
      gitBranch: repoContext.gitBranch,
      mainRepoName: repoContext.mainRepoName,
    };
  } catch {
    return null;
  }
}

export function isExcludedCodexSource(
  source: ProviderSource,
  excludedMatcher: ExcludedProjectMatcher,
): boolean {
  if (!excludedMatcher.hasExclusions) return false;
  const cwd = readCodexSourceCwd(source);
  return !!cwd && excludedMatcher(projectKeysForCwd(cwd));
}
