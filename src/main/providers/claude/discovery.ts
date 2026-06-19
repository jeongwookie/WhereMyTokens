import * as fs from 'fs';
import { isSafeLocalCwd } from '../../pathSafety';
import { readJsonlCwdForSource } from '../../sessionMetadata';
import type { DiscoveredSession, DiscoverSessionsOptions, ProviderContext } from '../types';
import { calcState, entrypointToSource, isProcessAlive, sessionSortTime } from '../shared/session';
import { detectGitBranchCached, detectWorktreeCached, encodeCwd } from '../shared/repoContext';
import {
  basenameForLogPath,
  getUsageLogSources,
  joinLogPath,
  mapCwdForSource,
  sourceLabel,
  type UsageLogSource,
} from '../../wslPaths';

const DEFAULT_RECENT_CLAUDE_SESSION_LIMIT = 48;
const claudeProjectDirCache = new Map<string, { mtimeMs: number; size: number; dirs: Map<string, string> }>();

function findClaudeProjectDir(rawCwd: string, source: UsageLogSource): string | null {
  const encoded = encodeCwd(rawCwd);
  const candidate = joinLogPath(source, source.claudeProjectsDir, encoded);
  if (fs.existsSync(candidate)) return candidate;

  // 대소문자 불일치 보정은 한 번 만든 디렉터리 맵을 재사용한다.
  try {
    const stat = fs.statSync(source.claudeProjectsDir);
    let sourceCache = claudeProjectDirCache.get(source.id);
    if (!sourceCache || sourceCache.mtimeMs !== stat.mtimeMs || sourceCache.size !== stat.size) {
      sourceCache = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        dirs: new Map(fs.readdirSync(source.claudeProjectsDir).map(dirName => [dirName.toLowerCase(), dirName])),
      };
      claudeProjectDirCache.set(source.id, sourceCache);
    }
    const match = sourceCache.dirs.get(encoded.toLowerCase());
    return match ? joinLogPath(source, source.claudeProjectsDir, match) : null;
  } catch { /* ignore */ }
  return null;
}

function newestJsonlForCwd(
  dirPath: string,
  mappedCwd: string,
  source: UsageLogSource,
  usedJsonlPaths: Set<string>,
): string | null {
  try {
    const candidates = fs.readdirSync(dirPath)
      .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'))
      .map(file => joinLogPath(source, dirPath, file))
      .filter(file => !usedJsonlPaths.has(file))
      .filter(file => readJsonlCwdForSource(file, 'claude', source) === mappedCwd)
      .map(file => ({ file, mtime: getJsonlLastModified(file)?.getTime() ?? 0 }))
      .sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.file ?? null;
  } catch {
    return null;
  }
}

function findJsonlPath(
  rawCwd: string,
  mappedCwd: string,
  sessionId: string,
  source: UsageLogSource,
  usedJsonlPaths: Set<string>,
): string | null {
  const dirPath = findClaudeProjectDir(rawCwd, source);
  if (!dirPath) return null;

  const candidate = joinLogPath(source, dirPath, `${sessionId}.jsonl`);
  if (fs.existsSync(candidate)) return candidate;

  // Newer Claude Code builds may not reuse sessions/*.json session IDs as JSONL filenames.
  return newestJsonlForCwd(dirPath, mappedCwd, source, usedJsonlPaths);
}

function getJsonlLastModified(jsonlPath: string | null): Date | null {
  if (!jsonlPath) return null;
  try {
    return fs.statSync(jsonlPath).mtime;
  } catch {
    return null;
  }
}

function collectClaudeSessions(ctx: ProviderContext, options: DiscoverSessionsOptions = {}): DiscoveredSession[] {
  const results: DiscoveredSession[] = [];

  for (const logSource of getUsageLogSources(ctx.settings.enableWslTracking)) {
    if (!fs.existsSync(logSource.claudeSessionsDir)) continue;

    let files: string[] = [];
    try {
      files = fs.readdirSync(logSource.claudeSessionsDir).filter(f => f.endsWith('.json'));
    } catch { continue; }

    const sessionFiles = files
      .map(file => {
        try {
          const raw = fs.readFileSync(joinLogPath(logSource, logSource.claudeSessionsDir, file), 'utf-8');
          const meta = JSON.parse(raw) as Record<string, unknown>;
          const startedAtMs = typeof meta.startedAt === 'string' ? new Date(meta.startedAt).getTime() : 0;
          return { file, meta, startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : 0 };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { file: string; meta: Record<string, unknown>; startedAtMs: number } => !!entry)
      .sort((a, b) => b.startedAtMs - a.startedAtMs || b.file.localeCompare(a.file));
    const usedJsonlPaths = new Set<string>();

    for (const { meta } of sessionFiles) {
      try {
        const { pid, sessionId, cwd: rawCwd, startedAt, entrypoint = 'cli', name: _name } = meta;
        if (typeof pid !== 'number'
          || typeof sessionId !== 'string'
          || typeof rawCwd !== 'string'
          || typeof startedAt !== 'string'
          || typeof entrypoint !== 'string') continue;
        const cwd = mapCwdForSource(logSource, rawCwd);
        if (!cwd || !isSafeLocalCwd(cwd)) continue;

        const alive = logSource.kind === 'wsl' ? null : isProcessAlive(pid);
        const jsonlPath = findJsonlPath(rawCwd, cwd, sessionId, logSource, usedJsonlPaths);
        if (jsonlPath) usedJsonlPaths.add(jsonlPath);
        const lastModified = getJsonlLastModified(jsonlPath);
        const state = calcState(alive, lastModified);

        // Prefer meta.name (set by Claude Code), fall back to cwd basename
        const projectName = (typeof _name === 'string' && _name.trim()) ? _name.trim() : basenameForLogPath(cwd);

        // Worktree detection: .git is a file when it's a worktree
        const worktreeInfo = detectWorktreeCached(cwd);
        const gitBranch = detectGitBranchCached(cwd);

        results.push({
          provider: 'claude',
          pid,
          sessionId,
          cwd,
          projectName: worktreeInfo ? `${worktreeInfo.mainName}` : projectName,
          startedAt: new Date(startedAt),
          entrypoint,
          source: sourceLabel(logSource, entrypointToSource(entrypoint, 'claude')),
          state,
          jsonlPath,
          lastModified,
          isWorktree: !!worktreeInfo,
          worktreeBranch: worktreeInfo?.branch ?? null,
          gitBranch,
          mainRepoName: worktreeInfo?.mainName ?? null,
          logSourceKind: logSource.kind,
        });
      } catch { /* skip malformed */ }
    }
  }

  const sorted = results.sort((a, b) => sessionSortTime(b) - sessionSortTime(a));
  if ((options.scope ?? 'recent-active') !== 'recent-active') return sorted;
  return sorted
    .filter(session => session.state === 'active' || session.state === 'waiting')
    .slice(0, options.maxClaudeSessions ?? DEFAULT_RECENT_CLAUDE_SESSION_LIMIT);
}

export function discoverClaudeSessions(ctx: ProviderContext): DiscoveredSession[] {
  return collectClaudeSessions(ctx, {
    scope: ctx.includeFullHistory ? 'all' : 'recent-active',
    trackedJsonlPaths: [...ctx.prioritySourceIds],
  });
}
