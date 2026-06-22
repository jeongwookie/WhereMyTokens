import * as path from 'path';
import type { DiscoveredSession, ProviderContext, SessionState } from '../types';
import { describeRepoContext } from '../shared/repoContext';
import { isSafeLocalCwd } from '../../pathSafety';
import { fileUriToPath, parseTimestampMs } from './pathUtils';
import { findAntigravityServersCached, getTrajectorySummariesCached } from './runtimeCache';
import { antigravityCascadeSummaryKey, antigravityServerOwnerKey } from './serverIdentity';
import type { AntigravityServerInfo, AntigravityTrajectorySummary } from './types';

export const SESSION_DISCOVERY_LIMIT = 48;
const FULL_SESSION_DISCOVERY_LIMIT = 200;

function deadlineMs(ctx: ProviderContext): number {
  return Date.now() + Math.min(ctx.scanBudgetMs ?? 8_000, 8_000);
}

function remainingTimeoutMs(stopAt: number): number {
  return Math.max(1, Math.min(8_000, stopAt - Date.now()));
}

function stateFromMtime(timestampMs: number, nowMs: number): SessionState {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return 'idle';
  const diffMin = (nowMs - timestampMs) / 60000;
  if (diffMin < 2) return 'active';
  if (diffMin < 15) return 'waiting';
  return 'idle';
}

function summaryCwd(summary: AntigravityTrajectorySummary): string | null {
  return fileUriToPath(summary.workspaces?.[0]?.workspaceFolderAbsoluteUri);
}

function isSafeAntigravityCwd(cwd: string): boolean {
  if (!cwd || cwd.includes('\0')) return false;
  return isSafeLocalCwd(cwd) || /^[A-Za-z]:[\\/]/.test(cwd);
}

export function rankAntigravitySummaries(
  summaries: Record<string, AntigravityTrajectorySummary>,
  nowMs: number,
  includeFullHistory: boolean,
): Array<[string, AntigravityTrajectorySummary]> {
  const limit = includeFullHistory ? FULL_SESSION_DISCOVERY_LIMIT : SESSION_DISCOVERY_LIMIT;
  return Object.entries(summaries)
    .filter((entry): entry is [string, AntigravityTrajectorySummary] =>
      !!entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1]))
    .sort((a, b) =>
      parseTimestampMs(b[1].lastModifiedTime ?? b[1].createdTime, 0)
      - parseTimestampMs(a[1].lastModifiedTime ?? a[1].createdTime, 0)
    )
    .slice(0, limit);
}

export function trajectorySummaryToSession(
  summaryKey: string,
  summary: AntigravityTrajectorySummary,
  nowMs: number,
): DiscoveredSession | null {
  const cwd = summaryCwd(summary);
  if (!cwd || !isSafeAntigravityCwd(cwd)) return null;

  const repoContext = describeRepoContext(cwd);
  const lastModifiedMs = parseTimestampMs(summary.lastModifiedTime ?? summary.createdTime, 0);
  const createdMs = parseTimestampMs(summary.createdTime, lastModifiedMs || nowMs);
  const title = typeof summary.summary === 'string' && summary.summary.trim()
    ? summary.summary.trim()
    : path.basename(cwd);

  return {
    provider: 'antigravity',
    pid: null,
    sessionId: summaryKey,
    cwd,
    projectName: repoContext.projectName || title,
    startedAt: new Date(createdMs),
    entrypoint: 'antigravity',
    source: 'Antigravity',
    state: stateFromMtime(lastModifiedMs, nowMs),
    jsonlPath: null,
    summaryKey,
    lastModified: lastModifiedMs > 0 ? new Date(lastModifiedMs) : null,
    isWorktree: repoContext.isWorktree,
    worktreeBranch: repoContext.worktreeBranch,
    gitBranch: repoContext.gitBranch,
    mainRepoName: repoContext.mainRepoName,
  };
}

export async function discoverAntigravitySessionsFromServers(
  ctx: ProviderContext,
  servers: AntigravityServerInfo[],
  stopAt = deadlineMs(ctx),
): Promise<DiscoveredSession[]> {
  const summaries: Record<string, AntigravityTrajectorySummary> = {};

  for (const server of servers) {
    if (Date.now() >= stopAt) break;
    const response = await getTrajectorySummariesCached(server, ctx.nowMs, remainingTimeoutMs(stopAt));
    if (Date.now() >= stopAt) break;
    const ownerKey = antigravityServerOwnerKey(server);
    for (const [cascadeId, summary] of Object.entries(response?.trajectorySummaries ?? {})) {
      const summaryKey = antigravityCascadeSummaryKey(ownerKey, cascadeId);
      if (!summaries[summaryKey]) summaries[summaryKey] = summary;
    }
  }

  return rankAntigravitySummaries(summaries, ctx.nowMs, ctx.includeFullHistory)
    .map(([summaryKey, summary]) => trajectorySummaryToSession(summaryKey, summary, ctx.nowMs))
    .filter((session): session is DiscoveredSession => !!session);
}

export async function discoverAntigravitySessions(ctx: ProviderContext): Promise<DiscoveredSession[]> {
  const stopAt = deadlineMs(ctx);
  const servers = await findAntigravityServersCached(ctx.nowMs, remainingTimeoutMs(stopAt));
  return discoverAntigravitySessionsFromServers(ctx, servers, stopAt);
}
