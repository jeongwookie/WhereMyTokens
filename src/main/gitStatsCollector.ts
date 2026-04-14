import { execSync } from 'child_process';

export interface GitStats {
  branch: string | null;
  toplevel: string | null;  // git repo root (for grouping worktrees)
  commitsToday: number;
  linesAdded: number;       // today
  linesRemoved: number;     // today
  commits7d: number;
  linesAdded7d: number;
  linesRemoved7d: number;
  commits30d: number;
  linesAdded30d: number;
  linesRemoved30d: number;
  totalCommits: number;     // all-time
  totalLinesAdded: number;
  totalLinesRemoved: number;
}

// cwd별 캐시 (60초 TTL)
const cache = new Map<string, { stats: GitStats; ts: number }>();
const CACHE_TTL = 60_000;

function parseNumstat(output: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const a = parseInt(parts[0], 10);
    const r = parseInt(parts[1], 10);
    if (!isNaN(a)) added += a;
    if (!isNaN(r)) removed += r;
  }
  return { added, removed };
}

function execGit(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    timeout: 5000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function getGitStats(cwd: string): GitStats | null {
  // 캐시 확인
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.stats;

  try {
    // 브랜치
    const branch = execGit('rev-parse --abbrev-ref HEAD', cwd) || null;

    // toplevel (worktree 그루핑용)
    let toplevel: string | null = null;
    try {
      toplevel = execGit('rev-parse --show-toplevel', cwd) || null;
    } catch { /* not a git repo */ }

    // 오늘 커밋 수
    const todayLog = execGit('log --since="midnight" --format="%H"', cwd);
    const commitsToday = todayLog ? todayLog.split('\n').length : 0;

    // 오늘 라인 변경
    const todayNumstat = execGit('log --since="midnight" --numstat --format=""', cwd);
    const today = parseNumstat(todayNumstat);

    // 7일 데이터
    const log7d = execGit('log --since="7 days ago" --format="%H"', cwd);
    const commits7d = log7d ? log7d.split('\n').length : 0;
    const numstat7d = execGit('log --since="7 days ago" --numstat --format=""', cwd);
    const d7 = parseNumstat(numstat7d);

    // 30일 데이터
    const log30d = execGit('log --since="30 days ago" --format="%H"', cwd);
    const commits30d = log30d ? log30d.split('\n').length : 0;
    const numstat30d = execGit('log --since="30 days ago" --numstat --format=""', cwd);
    const d30 = parseNumstat(numstat30d);

    // 전체 커밋 수
    let totalCommits = 0;
    try {
      const countStr = execGit('rev-list --count HEAD', cwd);
      totalCommits = parseInt(countStr, 10) || 0;
    } catch { /* empty repo */ }

    // 전체 라인 변경
    const allNumstat = execGit('log --numstat --format=""', cwd);
    const total = parseNumstat(allNumstat);

    const stats: GitStats = {
      branch,
      toplevel,
      commitsToday,
      linesAdded: today.added,
      linesRemoved: today.removed,
      commits7d,
      linesAdded7d: d7.added,
      linesRemoved7d: d7.removed,
      commits30d,
      linesAdded30d: d30.added,
      linesRemoved30d: d30.removed,
      totalCommits,
      totalLinesAdded: total.added,
      totalLinesRemoved: total.removed,
    };

    cache.set(cwd, { stats, ts: Date.now() });
    return stats;
  } catch {
    return null;
  }
}
