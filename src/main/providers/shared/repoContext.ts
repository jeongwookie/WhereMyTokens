import * as fs from 'fs';
import * as path from 'path';
import { isSafeLocalCwd } from '../../pathSafety';

const worktreeCache = new Map<string, { mainName: string; branch: string } | null>();

export function encodeCwd(cwd: string): string {
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

export { detectWorktreeCached, detectGitBranchCached };
