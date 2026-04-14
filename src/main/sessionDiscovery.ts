import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type SessionState = 'active' | 'waiting' | 'idle' | 'compacting';

export interface DiscoveredSession {
  pid: number;
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

function entrypointToSource(entrypoint: string): string {
  const map: Record<string, string> = {
    'cli': 'Terminal',
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

function calcState(alive: boolean, lastModified: Date | null): SessionState {
  if (!alive) return 'idle';
  if (!lastModified) return 'idle';
  const diffMs = Date.now() - lastModified.getTime();
  const diffMin = diffMs / 60000;
  if (diffMin < 2) return 'active';
  if (diffMin < 15) return 'waiting';
  return 'idle';
}

export function discoverSessions(): DiscoveredSession[] {
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
        pid,
        sessionId,
        cwd,
        projectName: worktreeInfo ? `${worktreeInfo.mainName}` : projectName,
        startedAt: new Date(startedAt),
        entrypoint,
        source: entrypointToSource(entrypoint),
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
