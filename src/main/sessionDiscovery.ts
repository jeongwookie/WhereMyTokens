import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type SessionState = 'active' | 'waiting' | 'idle' | 'compacting';
export type TrackingProvider = 'claude' | 'codex' | 'both';
export type SessionProvider = 'claude' | 'codex';

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
  mainRepoName: string | null;
}

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

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

  // Case mismatch correction: scan directory directly
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR);
    const match = dirs.find(d => d.toLowerCase() === encoded.toLowerCase());
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

function discoverClaudeSessions(): DiscoveredSession[] {
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

      const alive = isProcessAlive(pid);
      const jsonlPath = findJsonlPath(cwd, sessionId);
      const lastModified = getJsonlLastModified(jsonlPath);
      const state = calcState(alive, lastModified);

      // Prefer meta.name (set by Claude Code), fall back to cwd basename
      const projectName = (meta.name && meta.name.trim()) ? meta.name.trim() : path.basename(cwd);

      // Worktree detection: .git is a file when it's a worktree
      const worktreeInfo = detectWorktree(cwd);

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

function readFirstJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { return JSON.parse(line) as Record<string, unknown>; }
      catch { return null; }
    }
  } catch { /* ignore */ }
  return null;
}

function discoverCodexSessions(): DiscoveredSession[] {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return [];

  const results: DiscoveredSession[] = [];
  const files = listCodexJsonlFiles(CODEX_SESSIONS_DIR);

  for (const filePath of files) {
    try {
      const first = readFirstJsonObject(filePath);
      const payload = first?.payload as Record<string, unknown> | undefined;
      if (first?.type !== 'session_meta' || !payload) continue;

      const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
      if (!cwd) continue;

      const stat = fs.statSync(filePath);
      const sessionId = typeof payload.id === 'string' ? payload.id : path.basename(filePath, '.jsonl');
      const startedAtRaw = typeof payload.timestamp === 'string'
        ? payload.timestamp
        : (typeof first.timestamp === 'string' ? first.timestamp : '');
      const startedAt = startedAtRaw ? new Date(startedAtRaw) : stat.birthtime;
      const sourceRaw = payload.source;
      const entrypoint = typeof sourceRaw === 'string' ? sourceRaw : 'codex';
      const projectName = path.basename(cwd);
      const worktreeInfo = detectWorktree(cwd);

      results.push({
        provider: 'codex',
        pid: null,
        sessionId,
        cwd,
        projectName: worktreeInfo ? `${worktreeInfo.mainName}` : projectName,
        startedAt,
        entrypoint,
        source: entrypointToSource(entrypoint, 'codex'),
        state: calcState(null, stat.mtime),
        jsonlPath: filePath,
        lastModified: stat.mtime,
        isWorktree: !!worktreeInfo,
        worktreeBranch: worktreeInfo?.branch ?? null,
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

export function discoverSessions(provider: TrackingProvider = 'both'): DiscoveredSession[] {
  const results: DiscoveredSession[] = [];
  if (shouldIncludeProvider(provider, 'claude')) results.push(...discoverClaudeSessions());
  if (shouldIncludeProvider(provider, 'codex')) results.push(...discoverCodexSessions());

  return results.sort((a, b) => {
    const ta = a.lastModified?.getTime() ?? a.startedAt.getTime();
    const tb = b.lastModified?.getTime() ?? b.startedAt.getTime();
    return tb - ta;
  });
}

export { CODEX_SESSIONS_DIR, PROJECTS_DIR as CLAUDE_PROJECTS_DIR, SESSIONS_DIR as CLAUDE_SESSIONS_DIR };
