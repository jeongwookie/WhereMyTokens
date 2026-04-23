import * as path from 'path';

interface GitStatsLike {
  gitCommonDir: string | null;
  toplevel: string | null;
  commitsToday: number;
  linesAdded: number;
  linesRemoved: number;
  totalCommits: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  dailyAll?: unknown[];
}

export function normalizeGitPathKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function normalizeGitCwdKey(cwd: string): string {
  return normalizeGitPathKey(cwd) ?? cwd;
}

export function repoKeyFromGitStats(stats: Pick<GitStatsLike, 'gitCommonDir' | 'toplevel'> | null | undefined): string | null {
  return normalizeGitPathKey(stats?.gitCommonDir ?? stats?.toplevel ?? null);
}

export function isStaleGitStats(stats: GitStatsLike | null | undefined): boolean {
  if (!stats) return true;
  const hasTodayLines = stats.linesAdded > 0 || stats.linesRemoved > 0;
  const hasTotalLines = stats.totalLinesAdded > 0 || stats.totalLinesRemoved > 0;
  return (stats.commitsToday === 0 && hasTodayLines)
    || (stats.totalCommits === 0 && hasTotalLines)
    || stats.totalCommits < stats.commitsToday
    || stats.totalLinesAdded < stats.linesAdded
    || stats.totalLinesRemoved < stats.linesRemoved;
}

export function preferGitStats<T extends GitStatsLike>(current: T | null | undefined, candidate: T | null | undefined): T | null {
  if (!current) return candidate ?? null;
  if (!candidate) return current;

  const currentStale = isStaleGitStats(current);
  const candidateStale = isStaleGitStats(candidate);
  if (currentStale !== candidateStale) return candidateStale ? current : candidate;

  const currentScore = gitStatsQualityScore(current);
  const candidateScore = gitStatsQualityScore(candidate);
  return candidateScore > currentScore ? candidate : current;
}

function gitStatsQualityScore(stats: GitStatsLike): number {
  const todayLines = stats.linesAdded + stats.linesRemoved;
  const totalLines = stats.totalLinesAdded + stats.totalLinesRemoved;
  return (stats.totalCommits * 1_000_000) + (stats.commitsToday * 10_000) + totalLines + todayLines;
}
