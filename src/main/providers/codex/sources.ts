import * as fs from 'fs';
import { isSafeLocalCwd } from '../../pathSafety';
import { importUsageJsonlIntoSnapshot } from '../../usageLedgerImporter';
import { readCodexSessionHeaderForSource, readJsonlCwdForSource } from '../../sessionMetadata';
import { scanJsonlSummaryCached } from '../../jsonlParser';
import { describeCodexSource } from './discovery';
import type { DiscoveredSession, ExcludedProjectMatcher, ProviderContext, ProviderLedgerSource, ProviderSource, ProviderSourceList } from '../types';
import { describeRepoContext, projectKeysForCwd } from '../shared/repoContext';
import { isSourcePathInside, listJsonlFiles, normalizeSourcePath, sessionStateFromMtime, statMtimeMs, statMtimeMsOrNull } from '../shared/sourceFiles';
import { CODEX_USAGE_DIRS } from './paths';
import {
  basenameForLogPath,
  findUsageLogSourceForPath,
  getUsageLogSources,
  joinLogPath,
  sourceLabel,
  type UsageLogSource,
} from '../../wslPaths';

function sourceFromFile(filePath: string, logSource?: UsageLogSource): ProviderSource {
  return {
    provider: 'codex',
    sourceId: normalizeSourcePath(filePath),
    filePath,
    logSource,
  };
}

export function ownsCodexPath(filePath: string): boolean {
  return !!findUsageLogSourceForPath('codex', filePath, true)
    || CODEX_USAGE_DIRS.some(root => isSourcePathInside(root, filePath));
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

export function listRecentCodexSources(ctx: ProviderContext, limit: number): ProviderSourceList {
  const files: string[] = [];
  const targetCount = limit + 1;
  const dayDirs: Array<{ dir: string; mtimeMs: number }> = [];

  for (const logSource of getUsageLogSources(ctx.settings.enableWslTracking)) {
    for (const year of readSubdirs(logSource.codexSessionsDir)) {
      const yearDir = joinLogPath(logSource, logSource.codexSessionsDir, year);
      for (const month of readSubdirs(yearDir)) {
        const monthDir = joinLogPath(logSource, yearDir, month);
        for (const day of readSubdirs(monthDir)) {
          const dayDir = joinLogPath(logSource, monthDir, day);
          dayDirs.push({ dir: dayDir, mtimeMs: statMtimeMs(dayDir) });
        }
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
  return {
    sources: files.map(filePath =>
      sourceFromFile(filePath, findUsageLogSourceForPath('codex', filePath, ctx.settings.enableWslTracking))
    ),
    truncated,
  };
}

function codexSessionDedupeKey(filePath: string, logSource?: UsageLogSource): string {
  const header = readCodexSessionHeaderForSource(filePath, logSource);
  const sessionId = typeof header?.payload.id === 'string' && header.payload.id.trim()
    ? header.payload.id.trim()
    : basenameForLogPath(filePath).replace(/\.jsonl$/, '');
  return `${logSource?.id ?? 'windows'}:${sessionId.toLowerCase()}`;
}

function codexUsageRootRank(filePath: string, logSource?: UsageLogSource): number | null {
  const roots = logSource?.codexUsageDirs ?? CODEX_USAGE_DIRS;
  const index = roots.findIndex(root => isSourcePathInside(root, filePath));
  return index >= 0 ? index : null;
}

export function listAllCodexSources(ctx: ProviderContext): ProviderSourceList {
  const deduped = new Map<string, { filePath: string; rank: number; mtimeMs: number; logSource?: UsageLogSource }>();

  for (const logSource of getUsageLogSources(ctx.settings.enableWslTracking)) {
    for (const root of logSource.codexUsageDirs) {
      if (!fs.existsSync(root)) continue;
      for (const filePath of listJsonlFiles(root, Number.POSITIVE_INFINITY, false)) {
        const rank = codexUsageRootRank(filePath, logSource);
        if (rank == null) continue;
        const mtimeMs = statMtimeMsOrNull(filePath);
        if (mtimeMs == null) continue;
        const key = codexSessionDedupeKey(filePath, logSource);
        const current = deduped.get(key);
        if (!current
          || rank < current.rank
          || (rank === current.rank && mtimeMs > current.mtimeMs)
          || (rank === current.rank && mtimeMs === current.mtimeMs && filePath.localeCompare(current.filePath) < 0)) {
          deduped.set(key, { filePath, rank, mtimeMs, logSource });
        }
      }
    }
  }

  const sources = [...deduped.values()]
    .sort((a, b) => a.rank - b.rank || a.filePath.localeCompare(b.filePath))
    .map(entry => sourceFromFile(entry.filePath, entry.logSource));
  return { sources, truncated: false };
}

export async function scanCodexSourceSummary(ctx: ProviderContext, source: ProviderSource) {
  return scanJsonlSummaryCached(source.filePath, 'codex', ctx.jsonlCache, ctx.force);
}

export function buildCodexLedgerSource(_ctx: ProviderContext, source: ProviderSource, priority = false): ProviderLedgerSource {
  const sourcePath = normalizeSourcePath(source.filePath);
  return {
    provider: 'codex',
    sourceId: source.sourceId,
    sourcePath,
    priority: priority || source.priority === true,
    importIntoSnapshot: (snapshot, nowMs) =>
      importUsageJsonlIntoSnapshot(snapshot, source.filePath, 'codex', nowMs, source.logSource),
  };
}

export function readCodexSourceCwd(source: ProviderSource): string | null {
  return readJsonlCwdForSource(source.filePath, 'codex', source.logSource);
}

export function codexWatchTargets(ctx: ProviderContext, mode: 'recent' | 'wide'): string[] {
  if (mode !== 'wide') return [];
  const targets: string[] = [];
  for (const logSource of getUsageLogSources(ctx.settings.enableWslTracking)) {
    if (fs.existsSync(logSource.codexSessionsDir)) {
      targets.push(logSource.codexSessionsDir.replace(/\\/g, '/') + '/**/*.jsonl');
    }
  }
  return targets;
}

export function buildStartupCodexSession(_ctx: ProviderContext, source: ProviderSource): DiscoveredSession | null {
  const cwd = readCodexSourceCwd(source);
  if (!cwd || !isSafeLocalCwd(cwd)) return null;

  try {
    const stat = fs.statSync(source.filePath);
    const header = readCodexSessionHeaderForSource(source.filePath, source.logSource);
    const payload = header?.payload;
    const sessionId = typeof payload?.id === 'string' && payload.id.trim()
      ? payload.id.trim()
      : basenameForLogPath(source.filePath).replace(/\.jsonl$/, '');
    const startedAtRaw = typeof payload?.timestamp === 'string'
      ? payload.timestamp
      : (header?.timestamp ?? '');
    const startedAt = startedAtRaw ? new Date(startedAtRaw) : stat.birthtime;
    const originator = typeof payload?.originator === 'string' ? payload.originator : null;
    const { entrypoint, source: sourceName } = describeCodexSource(payload?.source, originator);
    const repoContext = describeRepoContext(cwd);

    return {
      provider: 'codex',
      pid: null,
      sessionId,
      cwd,
      projectName: repoContext.projectName,
      startedAt,
      entrypoint,
      source: sourceLabel(source.logSource, sourceName),
      state: sessionStateFromMtime(stat.mtime),
      jsonlPath: source.filePath,
      lastModified: stat.mtime,
      isWorktree: repoContext.isWorktree,
      worktreeBranch: repoContext.worktreeBranch,
      gitBranch: repoContext.gitBranch,
      mainRepoName: repoContext.mainRepoName,
      logSourceKind: source.logSource?.kind,
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
