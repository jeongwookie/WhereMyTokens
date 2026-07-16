import * as fs from 'fs';
import * as path from 'path';
import { isSafeLocalCwd } from '../../pathSafety';
import { readJsonlCwd } from '../../sessionMetadata';
import type { DiscoveredSession, ExcludedProjectMatcher, ProviderContext, ProviderSource, ProviderSourceList } from '../types';
import { describeRepoContext, projectKeysForCwd } from '../shared/repoContext';
import { isSourcePathInside, listJsonlFiles, normalizeSourcePath, sessionStateFromMtime, statMtimeMs } from '../shared/sourceFiles';
import { CLAUDE_PROJECTS_DIR, CLAUDE_SESSIONS_DIR } from './paths';
import { isClaudeAgentJsonlName, isClaudeJsonlName } from './logFiles';
import { createClaudeUsageIndexScanner } from './usageIndexScanner';

interface ClaudeRecentFile {
  filePath: string;
  mtimeMs: number;
  agentLog: boolean;
}

function sourceFromFile(filePath: string): ProviderSource {
  return {
    provider: 'claude',
    sourceId: normalizeSourcePath(filePath),
    filePath,
  };
}

function isClaudeAgentJsonlPath(filePath: string): boolean {
  return isClaudeAgentJsonlName(path.basename(filePath));
}

export function ownsClaudePath(filePath: string): boolean {
  return isSourcePathInside(CLAUDE_PROJECTS_DIR, filePath);
}

export function listRecentClaudeSources(_ctx: ProviderContext, limit: number): ProviderSourceList {
  const recentFiles: ClaudeRecentFile[] = [];

  try {
    const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(CLAUDE_PROJECTS_DIR, entry.name));
    for (const projectDir of projectDirs) {
      try {
        const files = fs.readdirSync(projectDir)
          .filter(isClaudeJsonlName);
        for (const file of files) {
          const filePath = path.join(projectDir, file);
          recentFiles.push({
            filePath,
            mtimeMs: statMtimeMs(filePath),
            agentLog: isClaudeAgentJsonlName(file),
          });
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  const byRecentMtime = (a: ClaudeRecentFile, b: ClaudeRecentFile) =>
    b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath);
  const sessionFiles = recentFiles
    .filter(entry => !entry.agentLog)
    .sort(byRecentMtime);
  const agentFiles = recentFiles
    .filter(entry => entry.agentLog)
    .sort(byRecentMtime);
  const selected = new Map<string, ClaudeRecentFile>();
  for (const entry of sessionFiles.slice(0, limit)) selected.set(entry.filePath, entry);
  for (const entry of agentFiles.slice(0, limit)) selected.set(entry.filePath, entry);

  const files = [...selected.values()]
    .sort((a, b) => Number(a.agentLog) - Number(b.agentLog) || byRecentMtime(a, b))
    .map(entry => entry.filePath);

  return {
    sources: files.map(sourceFromFile),
    truncated: sessionFiles.length > limit || agentFiles.length > limit,
  };
}

export function listAllClaudeSources(): ProviderSourceList {
  const files: string[] = [];
  try {
    const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    for (const dir of projectDirs) {
      files.push(...listJsonlFiles(path.join(CLAUDE_PROJECTS_DIR, dir), Number.POSITIVE_INFINITY, false));
    }
  } catch { /* skip */ }

  return { sources: files.map(sourceFromFile), truncated: false };
}

export function buildClaudeUsageIndexSource(_ctx: ProviderContext, source: ProviderSource) {
  const stat = fs.statSync(source.filePath);
  const relative = path.relative(CLAUDE_PROJECTS_DIR, source.filePath);
  const projectDir = relative.split(path.sep)[0];
  return {
    descriptor: {
      sourceId: `claude:${normalizeSourcePath(source.filePath)}`,
      provider: 'claude' as const,
      kind: 'file' as const,
      parserVersion: 1,
      version: {
        token: `${stat.size}:${stat.mtimeMs}`,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      },
    },
    scanner: createClaudeUsageIndexScanner(source.filePath, {
      baseProjectKeys: projectDir ? [projectDir] : [],
    }),
  };
}

export function readClaudeSourceCwd(source: ProviderSource): string | null {
  return readJsonlCwd(source.filePath, 'claude');
}

export function claudeWatchTargets(_ctx: ProviderContext, mode: 'recent' | 'wide'): string[] {
  if (mode !== 'wide') return [];
  const targets: string[] = [];
  if (fs.existsSync(CLAUDE_SESSIONS_DIR)) targets.push(CLAUDE_SESSIONS_DIR);
  if (fs.existsSync(CLAUDE_PROJECTS_DIR)) targets.push(CLAUDE_PROJECTS_DIR.replace(/\\/g, '/') + '/**/*.jsonl');
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
      sessionId: path.basename(source.filePath, '.jsonl'),
      cwd,
      projectName: repoContext.projectName,
      startedAt: stat.birthtime,
      entrypoint: 'cli',
      source: 'Terminal',
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
  const relative = path.relative(CLAUDE_PROJECTS_DIR, source.filePath);
  const projectDir = relative.split(path.sep)[0];
  const cwd = readClaudeSourceCwd(source);
  return excludedMatcher([projectDir, ...(cwd ? projectKeysForCwd(cwd) : [])]);
}
