import * as fs from 'fs';
import * as path from 'path';
import { isSafeLocalCwd } from '../../pathSafety';
import { importUsageJsonlIntoSnapshot } from '../../usageLedgerImporter';
import { readJsonlCwdForSource } from '../../sessionMetadata';
import { scanJsonlSummaryCached } from '../../jsonlParser';
import type { DiscoveredSession, ExcludedProjectMatcher, ProviderContext, ProviderLedgerSource, ProviderSource, ProviderSourceList } from '../types';
import { describeRepoContext, projectKeysForCwd } from '../shared/repoContext';
import { isSourcePathInside, listJsonlFiles, normalizeSourcePath, sessionStateFromMtime, statMtimeMs } from '../shared/sourceFiles';
import { CLAUDE_PROJECTS_DIR, CLAUDE_SESSIONS_DIR } from './paths';
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
    provider: 'claude',
    sourceId: normalizeSourcePath(filePath),
    filePath,
    logSource,
  };
}

function isClaudeAgentJsonlPath(filePath: string): boolean {
  return basenameForLogPath(filePath).startsWith('agent-');
}

export function ownsClaudePath(filePath: string): boolean {
  return !!findUsageLogSourceForPath('claude', filePath, true)
    || isSourcePathInside(CLAUDE_PROJECTS_DIR, filePath);
}

export function listRecentClaudeSources(ctx: ProviderContext, limit: number): ProviderSourceList {
  const recentFiles: Array<{ filePath: string; mtimeMs: number }> = [];
  const projectDirLimit = Math.max(limit, 12);
  let truncated = false;

  for (const logSource of getUsageLogSources(ctx.settings.enableWslTracking)) {
    try {
      const projectDirs = fs.readdirSync(logSource.claudeProjectsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
          const dirPath = joinLogPath(logSource, logSource.claudeProjectsDir, entry.name);
          return { dirPath, mtimeMs: statMtimeMs(dirPath), logSource };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      truncated = truncated || projectDirs.length > projectDirLimit;

      for (const projectDir of projectDirs.slice(0, projectDirLimit)) {
        try {
          const files = fs.readdirSync(projectDir.dirPath)
            .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));
          for (const file of files) {
            const filePath = joinLogPath(projectDir.logSource, projectDir.dirPath, file);
            recentFiles.push({ filePath, mtimeMs: statMtimeMs(filePath) });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  const files = recentFiles
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(entry => entry.filePath);

  return {
    sources: files.slice(0, limit).map(filePath =>
      sourceFromFile(filePath, findUsageLogSourceForPath('claude', filePath, ctx.settings.enableWslTracking))
    ),
    truncated: truncated || files.length > limit,
  };
}

export function listAllClaudeSources(ctx: ProviderContext): ProviderSourceList {
  const files: string[] = [];
  for (const logSource of getUsageLogSources(ctx.settings.enableWslTracking)) {
    try {
      const projectDirs = fs.readdirSync(logSource.claudeProjectsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
      for (const dir of projectDirs) {
        files.push(...listJsonlFiles(joinLogPath(logSource, logSource.claudeProjectsDir, dir), Number.POSITIVE_INFINITY, false));
      }
    } catch { /* skip */ }
  }

  return {
    sources: files.map(filePath =>
      sourceFromFile(filePath, findUsageLogSourceForPath('claude', filePath, ctx.settings.enableWslTracking))
    ),
    truncated: false,
  };
}

export async function scanClaudeSourceSummary(ctx: ProviderContext, source: ProviderSource) {
  return scanJsonlSummaryCached(source.filePath, 'claude', ctx.jsonlCache, ctx.force);
}

export function buildClaudeLedgerSource(_ctx: ProviderContext, source: ProviderSource, priority = false): ProviderLedgerSource {
  const sourcePath = normalizeSourcePath(source.filePath);
  return {
    provider: 'claude',
    sourceId: source.sourceId,
    sourcePath,
    priority: priority || source.priority === true,
    importIntoSnapshot: (snapshot, nowMs) =>
      importUsageJsonlIntoSnapshot(snapshot, source.filePath, 'claude', nowMs),
  };
}

export function readClaudeSourceCwd(source: ProviderSource): string | null {
  return readJsonlCwdForSource(source.filePath, 'claude', source.logSource);
}

export function claudeWatchTargets(ctx: ProviderContext, mode: 'recent' | 'wide'): string[] {
  if (mode !== 'wide') return [];
  const targets: string[] = [];
  for (const logSource of getUsageLogSources(ctx.settings.enableWslTracking)) {
    if (fs.existsSync(logSource.claudeSessionsDir)) targets.push(logSource.claudeSessionsDir);
    if (fs.existsSync(logSource.claudeProjectsDir)) targets.push(logSource.claudeProjectsDir.replace(/\\/g, '/') + '/**/*.jsonl');
  }
  return targets;
}

export function buildStartupClaudeSession(_ctx: ProviderContext, source: ProviderSource): DiscoveredSession | null {
  if (isClaudeAgentJsonlPath(source.filePath)) return null;
  const cwd = readClaudeSourceCwd(source);
  if (!cwd || !isSafeLocalCwd(cwd)) return null;

  try {
    const stat = fs.statSync(source.filePath);
    const repoContext = describeRepoContext(cwd);
    return {
      provider: 'claude',
      pid: null,
      sessionId: basenameForLogPath(source.filePath).replace(/\.jsonl$/, ''),
      cwd,
      projectName: repoContext.projectName,
      startedAt: stat.birthtime,
      entrypoint: 'cli',
      source: sourceLabel(source.logSource, 'Terminal'),
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

export function isExcludedClaudeSource(
  source: ProviderSource,
  excludedMatcher: ExcludedProjectMatcher,
): boolean {
  if (!excludedMatcher.hasExclusions) return false;
  const root = source.logSource?.claudeProjectsDir ?? CLAUDE_PROJECTS_DIR;
  const relative = path.relative(root, source.filePath);
  const projectDir = relative.split(path.sep)[0] || basenameForLogPath(path.dirname(source.filePath));
  const cwd = readClaudeSourceCwd(source);
  return excludedMatcher([projectDir, ...(cwd ? projectKeysForCwd(cwd) : [])]);
}
