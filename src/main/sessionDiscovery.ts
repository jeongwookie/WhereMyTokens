import * as fs from 'fs';
import * as path from 'path';
import { isSafeLocalCwd } from './pathSafety';
import { readCodexSessionHeader, readJsonlCwd } from './sessionMetadata';
import { getUsageLogSources, mapCwdForSource, sourceLabel, UsageLogSource } from './wslPaths';

export type SessionState = 'active' | 'waiting' | 'idle' | 'compacting';
export type TrackingProvider = 'claude' | 'codex' | 'both';
export type SessionProvider = 'claude' | 'codex';

export interface DiscoveredSession {
  provider: SessionProvider;
  pid: number | null;
  sessionId: string;
  cwd: string;
  rawCwd: string | null;
  projectName: string;
  startedAt: Date;
  entrypoint: string;
  source: string;
  logSource: string;
  state: SessionState;
  jsonlPath: string | null;
  lastModified: Date | null;
  isWorktree: boolean;
  worktreeBranch: string | null;
  gitBranch: string | null;
  mainRepoName: string | null;
}

const WINDOWS_SOURCE = getUsageLogSources(false)[0];
const SESSIONS_DIR = WINDOWS_SOURCE.claudeSessionsDir;
const PROJECTS_DIR = WINDOWS_SOURCE.claudeProjectsDir;
const CODEX_SESSIONS_DIR = WINDOWS_SOURCE.codexSessionsDir;
const worktreeCache = new Map<string, { mainName: string; branch: string } | null>();

function encodeCwd(cwd: string): string {
  // "C:\dev\app" → "C--dev-app" (encode path to flat name)
  return cwd.replace(/:/g, '-').replace(/[\\/]/g, '-');
}

function detectWorktree(cwd: string): { mainName: string; branch: string } | null {
  // cwd부터 상위 디렉토리를 순회하며 .git 파일(워크트리 마커) 탐색
  let dir = cwd;
  while (true) {
    try {
      const gitFile = path.join(dir, '.git');
      const stat = fs.statSync(gitFile);
      if (!stat.isFile()) return null;  // .git이 디렉토리면 일반 저장소 — 워크트리 아님
      const content = fs.readFileSync(gitFile, 'utf-8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (!match) return null;
      const gitdir = match[1].trim().replace(/\//g, path.sep);
      // gitdir example: C:\dev\my-app\.git\worktrees\feature-branch
      const worktreesIdx = gitdir.toLowerCase().indexOf('.git' + path.sep + 'worktrees');
      if (worktreesIdx < 0) return null;
      const mainGitPath = gitdir.substring(0, worktreesIdx);  // C:\dev\my-app\
      const branch = path.basename(gitdir);                    // feature-branch
      const mainName = path.basename(mainGitPath.replace(/[/\\]$/, ''));
      return { mainName, branch };
    } catch {
      // 이 디렉토리에 .git 없음 — 상위로 이동
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;  // 파일시스템 루트 도달
    dir = parent;
  }
}

function entrypointToSource(entrypoint: string, provider: SessionProvider = 'claude'): string {
  const map: Record<string, string> = {
    'cli': 'Terminal',
    'exec': provider === 'codex' ? 'Codex Exec' : 'Terminal',
    'vscode': provider === 'codex' ? 'VS Code' : 'VS Code',
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

function detectWorktreeCached(cwd: string): { mainName: string; branch: string } | null {
  if (worktreeCache.has(cwd)) return worktreeCache.get(cwd) ?? null;
  const value = detectWorktree(cwd);
  worktreeCache.set(cwd, value);
  return value;
}

function readHeadBranch(gitDir: string): string | null {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    const prefix = 'ref: refs/heads/';
    if (head.startsWith(prefix)) return head.slice(prefix.length);
  } catch { /* ignore */ }
  return null;
}

function detectGitBranch(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const marker = path.join(dir, '.git');
    try {
      const stat = fs.statSync(marker);
      if (stat.isDirectory()) return readHeadBranch(marker);
      if (stat.isFile()) {
        const content = fs.readFileSync(marker, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (!match) return null;
        const rawGitDir = match[1].trim().replace(/\//g, path.sep);
        const gitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(dir, rawGitDir);
        return readHeadBranch(gitDir);
      }
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function detectGitBranchCached(cwd: string): string | null {
  return detectGitBranch(cwd);
}

export function projectKeysForCwd(cwd: string): string[] {
  if (!isSafeLocalCwd(cwd)) return [];
  const keys = new Set<string>();
  const worktreeInfo = detectWorktreeCached(cwd);
  if (worktreeInfo?.mainName) keys.add(worktreeInfo.mainName);
  const baseName = path.basename(cwd);
  if (baseName) keys.add(baseName);
  keys.add(encodeCwd(cwd));
  return [...keys];
}

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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findClaudeProjectDir(rawCwd: string, source: UsageLogSource): string | null {
  const encoded = encodeCwd(rawCwd);
  const exact = path.join(source.claudeProjectsDir, encoded);
  if (fs.existsSync(exact)) return exact;

  try {
    const dirs = fs.readdirSync(source.claudeProjectsDir);
    const match = dirs.find(d => d.toLowerCase() === encoded.toLowerCase());
    return match ? path.join(source.claudeProjectsDir, match) : null;
  } catch {
    return null;
  }
}

function newestJsonlForCwd(dirPath: string, mappedCwd: string, source: UsageLogSource): string | null {
  try {
    const candidates = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
      .map(file => path.join(dirPath, file))
      .filter(file => readJsonlCwd(file, 'claude', source) === mappedCwd)
      .map(file => ({ file, mtime: getJsonlLastModified(file)?.getTime() ?? 0 }))
      .sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.file ?? null;
  } catch {
    return null;
  }
}

function findJsonlPath(rawCwd: string, mappedCwd: string, sessionId: string, source: UsageLogSource): string | null {
  const dirPath = findClaudeProjectDir(rawCwd, source);
  if (!dirPath) return null;

  const candidate = path.join(dirPath, `${sessionId}.jsonl`);
  if (fs.existsSync(candidate)) return candidate;

  // 최신 Claude Code는 sessions/*.json의 sessionId와 projects/*.jsonl 파일명이 다를 수 있다.
  return newestJsonlForCwd(dirPath, mappedCwd, source);
}

function getJsonlLastModified(jsonlPath: string | null): Date | null {
  if (!jsonlPath) return null;
  try {
    return fs.statSync(jsonlPath).mtime;
  } catch {
    return null;
  }
}

function calcState(alive: boolean | null, lastModified: Date | null): SessionState {
  if (alive === false) return 'idle';
  if (!lastModified) return 'idle';
  const diffMs = Date.now() - lastModified.getTime();
  const diffMin = diffMs / 60000;
  if (diffMin < 2) return 'active';
  if (diffMin < 15) return 'waiting';
  return 'idle';
}

function shouldIncludeProvider(filter: TrackingProvider, provider: SessionProvider): boolean {
  return filter === 'both' || filter === provider;
}

function discoverClaudeSessions(source: UsageLogSource): DiscoveredSession[] {
  if (!fs.existsSync(source.claudeSessionsDir)) return [];

  const results: DiscoveredSession[] = [];

  let files: string[] = [];
  try {
    files = fs.readdirSync(source.claudeSessionsDir).filter(f => f.endsWith('.json'));
  } catch { return []; }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(source.claudeSessionsDir, file), 'utf-8');
      const meta = JSON.parse(raw);
      const { pid, sessionId, cwd: rawCwd, startedAt, entrypoint = 'cli', name: _name } = meta;
      if (!pid || !sessionId || !rawCwd) continue;
      const cwd = mapCwdForSource(source, rawCwd);
      if (!cwd || !isSafeLocalCwd(cwd)) continue;

      const alive = source.kind === 'wsl' ? null : isProcessAlive(pid);
      const jsonlPath = findJsonlPath(rawCwd, cwd, sessionId, source);
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
        rawCwd,
        projectName: worktreeInfo ? `${worktreeInfo.mainName}` : projectName,
        startedAt: new Date(startedAt),
        entrypoint,
        source: sourceLabel(source, entrypointToSource(entrypoint, 'claude')),
        logSource: source.label,
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

  // Sort by most recent activity
  return results.sort((a, b) => {
    const ta = a.lastModified?.getTime() ?? a.startedAt.getTime();
    const tb = b.lastModified?.getTime() ?? b.startedAt.getTime();
    return tb - ta;
  });
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

function discoverCodexSessions(source: UsageLogSource): DiscoveredSession[] {
  if (!fs.existsSync(source.codexSessionsDir)) return [];

  const results: DiscoveredSession[] = [];
  const files = listCodexJsonlFiles(source.codexSessionsDir);

  for (const filePath of files) {
    try {
      const header = readCodexSessionHeader(filePath, source);
      const payload = header?.payload;
      if (!payload) continue;

      const rawCwd = typeof payload.cwd === 'string' ? payload.cwd : '';
      if (!rawCwd) continue;
      const cwd = mapCwdForSource(source, rawCwd);
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
      const entrypoint = codexEntrypointFromSource(sourceRaw);
      const projectName = path.basename(cwd);
      const worktreeInfo = detectWorktreeCached(cwd);
      const gitBranch = detectGitBranchCached(cwd);

      results.push({
        provider: 'codex',
        pid: null,
        sessionId,
        cwd,
        rawCwd,
        projectName: worktreeInfo ? `${worktreeInfo.mainName}` : projectName,
        startedAt,
        entrypoint,
        source: sourceLabel(source, codexSourceLabel(entrypoint, originator)),
        logSource: source.label,
        state: calcState(null, stat.mtime),
        jsonlPath: filePath,
        lastModified: stat.mtime,
        isWorktree: !!worktreeInfo,
        worktreeBranch: worktreeInfo?.branch ?? null,
        gitBranch,
        mainRepoName: worktreeInfo?.mainName ?? null,
      });
    } catch { /* skip malformed */ }
  }

  return results.sort((a, b) => {
    const ta = a.lastModified?.getTime() ?? a.startedAt.getTime();
    const tb = b.lastModified?.getTime() ?? b.startedAt.getTime();
    return tb - ta;
  });
}

export function discoverSessions(provider: TrackingProvider = 'both', enableWslTracking = false): DiscoveredSession[] {
  const results: DiscoveredSession[] = [];
  for (const source of getUsageLogSources(enableWslTracking)) {
    if (shouldIncludeProvider(provider, 'claude')) results.push(...discoverClaudeSessions(source));
    if (shouldIncludeProvider(provider, 'codex')) results.push(...discoverCodexSessions(source));
  }

  return results.sort((a, b) => {
    const ta = a.lastModified?.getTime() ?? a.startedAt.getTime();
    const tb = b.lastModified?.getTime() ?? b.startedAt.getTime();
    return tb - ta;
  });
}

export { CODEX_SESSIONS_DIR, PROJECTS_DIR as CLAUDE_PROJECTS_DIR, SESSIONS_DIR as CLAUDE_SESSIONS_DIR };
