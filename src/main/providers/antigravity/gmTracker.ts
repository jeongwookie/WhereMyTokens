import type { ProviderContext } from '../types';
import { AntigravityLsClient } from './lsClient';
import { buildModelLabelMap } from './models';
import { fileUriToPath, parseTimestampMs } from './pathUtils';
import { getTrajectorySummariesCached, getUserStatusCached } from './runtimeCache';
import { antigravityServerOwnerKey } from './serverIdentity';
import {
  mergeAntigravityCalls,
  parseAntigravityGmEntries,
  shouldEnrichForTokens,
} from './gmParser';
import type { AntigravityServerInfo, AntigravityTrajectorySummary } from './types';
import { AntigravityUsageCacheStore } from './usageCacheStore';
import { projectKeysForCwd } from '../shared/repoContext';

const DEFAULT_SCAN_LIMIT = 48;
const FULL_SCAN_LIMIT = 200;

interface TrackerCascade {
  cascadeId: string;
  title: string;
  lastModifiedMs: number;
  stepCount: number;
  status: string;
}

export interface AntigravityGmTrackerResult {
  scannedSources: number;
  partial: boolean;
}

function remainingTimeoutMs(stopAt: number): number {
  return Math.max(1, Math.min(8_000, stopAt - Date.now()));
}

function cascadeStatus(summary: AntigravityTrajectorySummary): string {
  return String(summary.status ?? summary.runStatus ?? '');
}

function isRunningStatus(status: string): boolean {
  return status === 'CASCADE_RUN_STATUS_RUNNING' || status.toLowerCase().includes('running');
}

function sortedCascades(response: unknown, nowMs: number): TrackerCascade[] {
  const rawSummaries = (response as { trajectorySummaries?: unknown } | null)?.trajectorySummaries;
  const summaries = rawSummaries && typeof rawSummaries === 'object' && !Array.isArray(rawSummaries)
    ? rawSummaries as Record<string, unknown>
    : {};
  return Object.entries(summaries)
    .filter((entry): entry is [string, AntigravityTrajectorySummary] =>
      !!entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1]))
    .map(([cascadeId, summary]) => ({
      cascadeId,
      title: typeof summary.summary === 'string' ? summary.summary : '',
      lastModifiedMs: parseTimestampMs(summary.lastModifiedTime ?? summary.createdTime, nowMs),
      stepCount: typeof summary.stepCount === 'number' ? summary.stepCount : 0,
      status: cascadeStatus(summary),
    }))
    .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
}

function summaryProjectKeys(summary: AntigravityTrajectorySummary | undefined): string[] | undefined {
  const keys = new Set<string>();
  for (const workspace of summary?.workspaces ?? []) {
    const cwd = fileUriToPath(workspace?.workspaceFolderAbsoluteUri);
    if (!cwd) continue;
    for (const key of projectKeysForCwd(cwd)) keys.add(key);
  }
  return keys.size > 0 ? [...keys] : undefined;
}

export class AntigravityGmTracker {
  constructor(private readonly cacheStore = new AntigravityUsageCacheStore()) {}

  async fetchAllFromServers(
    ctx: ProviderContext,
    servers: AntigravityServerInfo[],
    stopAt: number,
  ): Promise<AntigravityGmTrackerResult> {
    const scanLimit = ctx.includeFullHistory ? FULL_SCAN_LIMIT : DEFAULT_SCAN_LIMIT;
    const pastDeadline = () => Date.now() >= stopAt;
    let scannedSources = 0;
    let partial = false;
    const seenCascadeIds = new Set<string>();

    for (const server of servers) {
      if (pastDeadline()) {
        partial = true;
        break;
      }

      const status = await getUserStatusCached(server, ctx.nowMs, remainingTimeoutMs(stopAt)).catch(() => null);
      const ownerKey = antigravityServerOwnerKey(server);
      const labelMap = buildModelLabelMap(status?.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? []);
      const trajectorySummaries = await getTrajectorySummariesCached(server, ctx.nowMs, remainingTimeoutMs(stopAt));
      if (!trajectorySummaries) {
        partial = true;
        continue;
      }
      const rawSummaries = trajectorySummaries.trajectorySummaries ?? {};

      const cascades = sortedCascades(trajectorySummaries, ctx.nowMs);
      if (cascades.length > scanLimit) partial = true;

      for (const cascade of cascades.slice(0, scanLimit)) {
        if (seenCascadeIds.has(cascade.cascadeId)) continue;
        seenCascadeIds.add(cascade.cascadeId);
        if (cascade.stepCount === 0) continue;
        if (pastDeadline()) {
          partial = true;
          break;
        }

        const cached = this.cacheStore.getSnapshot().cascades[`${ownerKey}:${cascade.cascadeId}`];
        const wasRunning = cached ? isRunningStatus(cached.status) : false;
        const isRunning = isRunningStatus(cascade.status);
        const justBecameIdle = wasRunning && !isRunning;
        const hasCachedCalls = cached && Object.keys(cached.calls).length > 0;
        const cacheUpToDate = cached && cached.lastModifiedMs >= cascade.lastModifiedMs;
        if (hasCachedCalls && !isRunning && !justBecameIdle && cached.totalSteps === cascade.stepCount && cacheUpToDate) {
          continue;
        }

        scannedSources += 1;
        const client = new AntigravityLsClient(server);
        let rawGm: unknown[] = [];
        try {
          const lightweight = await client.getCascadeTrajectoryGeneratorMetadata(
            cascade.cascadeId,
            remainingTimeoutMs(stopAt),
          );
          rawGm = Array.isArray(lightweight.generatorMetadata) ? lightweight.generatorMetadata : [];
        } catch {
          partial = true;
          continue;
        }

        let calls = parseAntigravityGmEntries(cascade.cascadeId, rawGm, cascade.lastModifiedMs, labelMap);
        if (shouldEnrichForTokens({ stepCount: cascade.stepCount, rawGm, calls }) && !pastDeadline()) {
          try {
            const full = await client.getCascadeTrajectory(cascade.cascadeId, remainingTimeoutMs(stopAt));
            const embeddedCalls = parseAntigravityGmEntries(
              cascade.cascadeId,
              Array.isArray(full.trajectory?.generatorMetadata) ? full.trajectory.generatorMetadata : [],
              cascade.lastModifiedMs,
              labelMap,
            );
            calls = mergeAntigravityCalls(calls, embeddedCalls);
          } catch {
            partial = true;
          }
        }

        if (calls.length > 0) {
          this.cacheStore.upsertCascade({
            ownerKey,
            cascadeId: cascade.cascadeId,
            projectKeys: summaryProjectKeys(rawSummaries[cascade.cascadeId]),
            totalSteps: cascade.stepCount,
            status: cascade.status,
            lastModifiedMs: cascade.lastModifiedMs,
            fetchedAtMs: ctx.nowMs,
            calls,
          }, ctx.nowMs);
        }
      }
    }

    this.cacheStore.compact(ctx.nowMs);
    return { scannedSources, partial };
  }
}
