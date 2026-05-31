import * as fs from 'fs';
import * as path from 'path';
import { isSafeLocalCwd } from '../../pathSafety';
import type { DiscoveredSession, DiscoverSessionsOptions, ProviderContext } from '../types';
import { calcState, entrypointToSource, isProcessAlive, sessionSortTime } from '../shared/session';
import { detectGitBranchCached, detectWorktreeCached, encodeCwd } from '../shared/repoContext';
import { CLAUDE_PROJECTS_DIR, CLAUDE_SESSIONS_DIR } from './paths';

const DEFAULT_RECENT_CLAUDE_SESSION_LIMIT = 48;
let claudeProjectDirCache: Map<string, string> | null = null;

function findJsonlPath(cwd: string, sessionId: string): string | null {
  const encoded = encodeCwd(cwd);
  const candidate = path.join(CLAUDE_PROJECTS_DIR, encoded, `${sessionId}.jsonl`);
  if (fs.existsSync(candidate)) return candidate;

  // 대소문자 불일치 보정은 한 번 만든 디렉터리 맵을 재사용한다.
  try {
    if (!claudeProjectDirCache) {
      claudeProjectDirCache = new Map(
        fs.readdirSync(CLAUDE_PROJECTS_DIR).map(dirName => [dirName.toLowerCase(), dirName])
      );
    }
    const match = claudeProjectDirCache.get(encoded.toLowerCase());
    if (match) {
      const p = path.join(CLAUDE_PROJECTS_DIR, match, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return null;
}

function getJsonlLastModified(jsonlPath: string | null): Date | null {
  if (!jsonlPath) return null;
  try {
    return fs.statSync(jsonlPath).mtime;
  } catch {
    return null;
  }
}

function collectClaudeSessions(options: DiscoverSessionsOptions = {}): DiscoveredSession[] {
  if (!fs.existsSync(CLAUDE_SESSIONS_DIR)) return [];

  const results: DiscoveredSession[] = [];

  let files: string[] = [];
  try {
    files = fs.readdirSync(CLAUDE_SESSIONS_DIR).filter(f => f.endsWith('.json'));
  } catch { return []; }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, file), 'utf-8');
      const meta = JSON.parse(raw);
      const { pid, sessionId, cwd, startedAt, entrypoint = 'cli', name: _name } = meta;
      if (!pid || !sessionId || !cwd) continue;
      if (!isSafeLocalCwd(cwd)) continue;

      const alive = isProcessAlive(pid);
      const jsonlPath = findJsonlPath(cwd, sessionId);
      const lastModified = getJsonlLastModified(jsonlPath);
      const state = calcState(alive, lastModified);

      // Prefer meta.name (set by Claude Code), fall back to cwd basename
      const projectName = (meta.name && meta.name.trim()) ? meta.name.trim() : path.basename(cwd);

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
        source: entrypointToSource(entrypoint, 'claude'),
        state,
        jsonlPath,
        lastModified,
        isWorktree: !!worktreeInfo,
        worktreeBranch: worktreeInfo?.branch ?? null,
        gitBranch,
        mainRepoName: worktreeInfo?.mainName ?? null,
      });
    } catch { /* skip malformed */ }
  }

  const sorted = results.sort((a, b) => sessionSortTime(b) - sessionSortTime(a));
  if ((options.scope ?? 'recent-active') !== 'recent-active') return sorted;
  return sorted
    .filter(session => session.state === 'active' || session.state === 'waiting')
    .slice(0, options.maxClaudeSessions ?? DEFAULT_RECENT_CLAUDE_SESSION_LIMIT);
}

export function discoverClaudeSessions(ctx: ProviderContext): DiscoveredSession[] {
  return collectClaudeSessions({
    scope: ctx.includeFullHistory ? 'all' : 'recent-active',
    trackedJsonlPaths: [...ctx.prioritySourceIds],
  });
}
