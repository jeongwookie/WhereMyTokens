import type { ProviderContext, ProviderUsageScanResult } from '../types';
import { buildModelLabelMap } from './models';
import { fileUriToPath, parseTimestampMs } from './pathUtils';
import { findAntigravityServersCached, getTrajectorySummariesCached, getUserStatusCached } from './runtimeCache';
import { antigravityCascadeSummaryKey, antigravityServerOwnerKey } from './serverIdentity';
import { projectKeysForCwd } from '../shared/repoContext';
import { createAntigravityUsageIndexScanner } from './usageIndexScanner';
import type { AntigravityServerInfo, AntigravityTrajectorySummary } from './types';

const DEFAULT_DEADLINE_MS = 8_000;
const DEFAULT_SCAN_LIMIT = 48;
const FULL_SCAN_LIMIT = 200;

function deadlineMs(ctx: ProviderContext): number {
  return Date.now() + Math.min(ctx.scanBudgetMs ?? DEFAULT_DEADLINE_MS, DEFAULT_DEADLINE_MS);
}

function remainingTimeoutMs(stopAt: number): number {
  return Math.max(1, Math.min(8_000, stopAt - Date.now()));
}

function newestCascadeMs(response: unknown): number {
  const rawSummaries = (response as { trajectorySummaries?: unknown } | null)?.trajectorySummaries;
  const summaries = rawSummaries && typeof rawSummaries === 'object' && !Array.isArray(rawSummaries)
    ? rawSummaries as Record<string, unknown>
    : {};
  let newest = 0;
  for (const summary of Object.values(summaries)) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) continue;
    const value = (summary as { lastModifiedTime?: unknown; createdTime?: unknown }).lastModifiedTime
      ?? (summary as { createdTime?: unknown }).createdTime;
    const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? new Date(value).getTime() : 0;
    if (Number.isFinite(timestamp)) newest = Math.max(newest, timestamp);
  }
  return newest;
}

async function selectPrimaryUsageServer(
  ctx: ProviderContext,
  servers: AntigravityServerInfo[],
  stopAt: number,
): Promise<AntigravityServerInfo | null> {
  let best: { server: AntigravityServerInfo; score: number } | null = null;
  for (const server of servers) {
    if (Date.now() >= stopAt) break;
    const trajectories = await getTrajectorySummariesCached(server, ctx.nowMs, remainingTimeoutMs(stopAt));
    const score = newestCascadeMs(trajectories) + ((server.processStartedAtMs ?? 0) / 10_000);
    if (!best || score > best.score) best = { server, score };
  }
  return best?.server ?? null;
}

function status(summary: AntigravityTrajectorySummary): string {
  return String(summary.status ?? summary.runStatus ?? '');
}

function isRunningStatus(value: string): boolean {
  return value.toLowerCase().includes('running');
}

function projectKeys(summary: AntigravityTrajectorySummary): string[] {
  const keys = new Set<string>();
  for (const workspace of summary.workspaces ?? []) {
    const cwd = fileUriToPath(workspace?.workspaceFolderAbsoluteUri);
    if (!cwd) continue;
    for (const key of projectKeysForCwd(cwd)) keys.add(key);
  }
  return [...keys];
}

export async function scanAntigravityUsageFromServers(
  ctx: ProviderContext,
  servers: AntigravityServerInfo[],
  stopAt = deadlineMs(ctx),
): Promise<ProviderUsageScanResult> {
  const primaryServer = await selectPrimaryUsageServer(ctx, servers, stopAt);
  if (!primaryServer) return { usageIndexSources: [], partial: servers.length > 0 };
  const [userStatus, trajectories] = await Promise.all([
    getUserStatusCached(primaryServer, ctx.nowMs, remainingTimeoutMs(stopAt)).catch(() => null),
    getTrajectorySummariesCached(primaryServer, ctx.nowMs, remainingTimeoutMs(stopAt)),
  ]);
  if (!trajectories) return { usageIndexSources: [], partial: true };

  const labels = buildModelLabelMap(userStatus?.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? []);
  const ownerKey = antigravityServerOwnerKey(primaryServer);
  const limit = ctx.includeFullHistory ? FULL_SCAN_LIMIT : DEFAULT_SCAN_LIMIT;
  const summaries = Object.entries(trajectories.trajectorySummaries ?? {})
    .filter((entry): entry is [string, AntigravityTrajectorySummary] =>
      !!entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1]))
    .map(([cascadeId, summary]) => ({
      cascadeId,
      summary,
      lastModifiedMs: parseTimestampMs(summary.lastModifiedTime ?? summary.createdTime, ctx.nowMs),
    }))
    .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  const usageIndexSources = summaries
    .slice(0, limit)
    .filter(({ summary }) => (typeof summary.stepCount === 'number' ? summary.stepCount : 0) > 0)
    .map(({ cascadeId, summary, lastModifiedMs }) => {
      const sourceId = antigravityCascadeSummaryKey(ownerKey, cascadeId);
      const stepCount = typeof summary.stepCount === 'number' ? summary.stepCount : 0;
      const runStatus = status(summary);
      return {
        descriptor: {
          sourceId,
          provider: 'antigravity' as const,
          kind: 'remote' as const,
          parserVersion: 1,
          version: {
            token: `${stepCount}:${lastModifiedMs}:${runStatus}${isRunningStatus(runStatus) ? `:live:${ctx.nowMs}` : ''}`,
            mtimeMs: lastModifiedMs,
          },
          projectKeys: projectKeys(summary),
        },
        scanner: createAntigravityUsageIndexScanner({
          server: primaryServer,
          cascadeId,
          stepCount,
          lastModifiedMs,
          modelLabels: labels,
          stopAt,
        }),
      };
    });
  return {
    usageIndexSources,
    partial: summaries.length > limit || Date.now() >= stopAt,
  };
}

export async function scanAntigravityUsage(ctx: ProviderContext): Promise<ProviderUsageScanResult> {
  const stopAt = deadlineMs(ctx);
  const servers = await findAntigravityServersCached(ctx.nowMs, remainingTimeoutMs(stopAt));
  return scanAntigravityUsageFromServers(ctx, servers, stopAt);
}
