import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isSafeLocalCwd } from './pathSafety';
import { readCodexSessionHeader } from './sessionMetadata';

export type SessionState = 'active' | 'waiting' | 'idle' | 'compacting';
export type TrackingProvider = 'claude' | 'codex' | 'both';
export type SessionProvider = 'claude' | 'codex';
export type SessionDiscoveryScope = 'recent-active' | 'all';

export interface DiscoverSessionsOptions {
  scope?: SessionDiscoveryScope;
  trackedJsonlPaths?: string[];
  maxClaudeSessions?: number;
  maxCodexFiles?: number;
}

export interface DiscoveredSession {
  provider: SessionProvider;
  pid: number | null;
  sessionId: string;
  cwd: string;
  projectName: string;
  startedAt: Date;
  entrypoint: string;
  source: string;
  state: SessionState;
  jsonlPath: string | null;
  lastModified: Date | null;
  isWorktree: boolean;
  worktreeBranch: string | null;
  gitBranch: string | null;
  mainRepoName: string | null;
}

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const DEFAULT_RECENT_CLAUDE_SESSION_LIMIT = 48;
const DEFAULT_RECENT_CODEX_FILE_LIMIT = 96;
const worktreeCache = new Map<string, { mainName: string; branch: string } | null>();
let claudeProjectDirCache: Map<string, string> | null = null;

function normalizeSessionPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sessionSortTime(session: Pick<DiscoveredSession, 'lastModified' | 'startedAt'>): number {
  return session.lastModified?.getTime() ?? session.startedAt.getTime();
}

function trackedJsonlSet(paths: string[] = []): Set<string> {
  const tracked = new Set<string>();
  for (const filePath of paths) {
    if (!filePath) continue;
    tracked.add(normalizeSessionPath(filePath));
  }
  return tracked;
}

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

export function describeRepoContext(cwd: string): {
  projectName: string;
  isWorktree: boolean;
  worktreeBranch: string | null;
  gitBranch: string | null;
  mainRepoName: string | null;
} {
  const worktreeInfo = detectWorktreeCached(cwd);
  return {
    projectName: worktreeInfo ? `${worktreeInfo.mainName}` : path.basename(cwd),
    isWorktree: !!worktreeInfo,
    worktreeBranch: worktreeInfo?.branch ?? null,
    gitBranch: detectGitBranchCached(cwd),
    mainRepoName: worktreeInfo?.mainName ?? null,
  };
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findJsonlPath(cwd: string, sessionId: string): string | null {
  const encoded = encodeCwd(cwd);
  const candidate = path.join(PROJECTS_DIR, encoded, `${sessionId}.jsonl`);
  if (fs.existsSync(candidate)) return candidate;

  // 대소문자 불일치 보정은 한 번 만든 디렉터리 맵을 재사용한다.
  try {
    if (!claudeProjectDirCache) {
      claudeProjectDirCache = new Map(
        fs.readdirSync(PROJECTS_DIR).map(dirName => [dirName.toLowerCase(), dirName])
      );
    }
    const match = claudeProjectDirCache.get(encoded.toLowerCase());
    if (match) {
      const p = path.join(PROJECTS_DIR, match, `${sessionId}.jsonl`);
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

function discoverClaudeSessions(options: DiscoverSessionsOptions = {}): DiscoveredSession[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];

  const results: DiscoveredSession[] = [];

  let files: string[] = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  } catch { return []; }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8');
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
    const normalized = normalizeSessionPath(filePath);
    if (seen.has(normalized)) return;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { return; }
    seen.add(normalized);
    files.push({ filePath, mtimeMs });
  };

  for (const trackedPath of trackedPaths) {
    if (!trackedPath.startsWith(normalizeSessionPath(CODEX_SESSIONS_DIR))) continue;
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

function discoverCodexSessions(options: DiscoverSessionsOptions = {}): DiscoveredSession[] {
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

function dedupeDiscoveredSessions(sessions: DiscoveredSession[]): DiscoveredSession[] {
  const deduped = new Map<string, DiscoveredSession>();
  for (const session of sessions) {
    const key = session.jsonlPath
      ? `${session.provider}:${normalizeSessionPath(session.jsonlPath)}`
      : `${session.provider}:${session.cwd}:${session.sessionId}`;
    const current = deduped.get(key);
    if (!current || sessionSortTime(session) >= sessionSortTime(current)) deduped.set(key, session);
  }
  return [...deduped.values()].sort((a, b) => sessionSortTime(b) - sessionSortTime(a));
}

export function discoverSessions(provider: TrackingProvider = 'both', options: DiscoverSessionsOptions = {}): DiscoveredSession[] {
  const results: DiscoveredSession[] = [];
  if (shouldIncludeProvider(provider, 'claude')) results.push(...discoverClaudeSessions(options));
  if (shouldIncludeProvider(provider, 'codex')) results.push(...discoverCodexSessions(options));
  return dedupeDiscoveredSessions(results);
}

export { CODEX_SESSIONS_DIR, PROJECTS_DIR as CLAUDE_PROJECTS_DIR, SESSIONS_DIR as CLAUDE_SESSIONS_DIR };
