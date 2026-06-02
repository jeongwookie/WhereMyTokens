import type { ProviderContext } from '../types';
import { AntigravityLsClient } from './lsClient';
import { buildModelLabelMap } from './models';
import { parseTimestampMs } from './pathUtils';
import { getTrajectorySummariesCached, getUserStatusCached } from './runtimeCache';
import {
  mergeAntigravityCalls,
  parseAntigravityGmEntries,
  shouldEnrichForTokens,
} from './gmParser';
import type { AntigravityServerInfo, AntigravityTrajectorySummary } from './types';
import { AntigravityUsageCacheStore } from './usageCacheStore';

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
  const summaries = (response as { trajectorySummaries?: Record<string, AntigravityTrajectorySummary> } | null)?.trajectorySummaries ?? {};
  return Object.entries(summaries)
    .map(([cascadeId, summary]) => ({
      cascadeId,
      title: typeof summary.summary === 'string' ? summary.summary : '',
      lastModifiedMs: parseTimestampMs(summary.lastModifiedTime ?? summary.createdTime, nowMs),
      stepCount: typeof summary.stepCount === 'number' ? summary.stepCount : 0,
      status: cascadeStatus(summary),
    }))
    .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
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
      const labelMap = buildModelLabelMap(status?.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? []);
      const trajectorySummaries = await getTrajectorySummariesCached(server, ctx.nowMs, remainingTimeoutMs(stopAt));
      if (!trajectorySummaries) {
        partial = true;
        continue;
      }

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

        const cached = this.cacheStore.getSnapshot().cascades[cascade.cascadeId];
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
        let rawGm: Record<string, unknown>[] = [];
        try {
          const lightweight = await client.getCascadeTrajectoryGeneratorMetadata(
            cascade.cascadeId,
            remainingTimeoutMs(stopAt),
          );
          rawGm = lightweight.generatorMetadata ?? [];
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
              full.trajectory?.generatorMetadata ?? [],
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
            cascadeId: cascade.cascadeId,
            title: cascade.title,
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
