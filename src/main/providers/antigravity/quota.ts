import type {
  ProviderContext,
  ProviderModelQuota,
  ProviderQuotaSnapshot,
} from '../types';
import { defaultQuotaModeForModel, normalizeAntigravityModel } from './models';
import { parseTimestampMs } from './pathUtils';
import { resolveAntigravityPriceForModel } from './pricing';
import { findAntigravityServersCached, getTrajectorySummariesCached, getUserStatusCached } from './runtimeCache';
import type {
  AntigravityModelConfig,
  AntigravityServerInfo,
  AntigravityTrajectorySummariesResponse,
  AntigravityUserStatusResponse,
} from './types';

function deadlineMs(ctx: ProviderContext): number {
  return Date.now() + Math.min(ctx.scanBudgetMs ?? 8_000, 8_000);
}

function remainingTimeoutMs(stopAt: number): number {
  return Math.max(1, Math.min(8_000, stopAt - Date.now()));
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function remainingPctFromFraction(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return clampPercent(Math.max(0, Math.min(1, value)) * 100);
}

function resetMsFromValue(value: unknown, nowMs: number): number | null {
  if (value == null) return null;
  const parsed = parseTimestampMs(value, NaN);
  return Number.isFinite(parsed) ? Math.max(0, parsed - nowMs) : null;
}

export function parseAntigravityModelQuotas(
  configs: AntigravityModelConfig[],
  nowMs: number,
): ProviderModelQuota[] {
  return configs
    .filter(config => !!config.quotaInfo)
    .map((config): ProviderModelQuota | null => {
      const remainingPct = remainingPctFromFraction(config.quotaInfo?.remainingFraction);
      if (remainingPct == null) return null;
      const model = config.modelOrAlias?.model || config.label || 'unknown';
      const label = config.label || model;
      const resetMs = resetMsFromValue(config.quotaInfo?.resetTime, nowMs);
      const usageModel = normalizeAntigravityModel(model, new Map([[model, label]]));
      return {
        model,
        label,
        statsWindowKey: `model.${model}`,
        remainingPct,
        resetMs,
        defaultMode: defaultQuotaModeForModel(label, model),
        usageModel,
        visualKind: 'percentOnly',
        cacheMetricTitle: 'Cache read / prompt tokens',
        hideCost: !resolveAntigravityPriceForModel(usageModel, `${model} ${label}`),
      };
    })
    .filter((quota): quota is ProviderModelQuota => !!quota);
}

function newestCascadeMs(value: AntigravityTrajectorySummariesResponse | null): number {
  const summaries = value?.trajectorySummaries ?? {};
  let newest = 0;
  for (const summary of Object.values(summaries)) {
    newest = Math.max(
      newest,
      parseTimestampMs(summary.lastModifiedTime ?? summary.createdTime, 0),
    );
  }
  return newest;
}

interface CandidateQuota {
  server: AntigravityServerInfo;
  snapshot: ProviderQuotaSnapshot;
  newestCascadeMs: number;
}

function candidateScore(candidate: CandidateQuota): number {
  let score = 0;
  if (candidate.newestCascadeMs > 0) score += Math.min(candidate.newestCascadeMs / 1000, 9_000_000);
  if (candidate.server.processStartedAtMs) score += candidate.server.processStartedAtMs / 10_000;
  return score;
}

function snapshotFromStatus(response: AntigravityUserStatusResponse, nowMs: number): ProviderQuotaSnapshot {
  const userStatus = response.userStatus;
  const rawConfigs = userStatus?.cascadeModelConfigData?.clientModelConfigs;
  const configs = Array.isArray(rawConfigs)
    ? rawConfigs.filter((config): config is AntigravityModelConfig => !!config && typeof config === 'object' && !Array.isArray(config))
    : [];
  return {
    provider: 'antigravity',
    source: 'localRpc',
    capturedAt: nowMs,
    planName: userStatus?.planStatus?.planInfo?.planName,
    models: parseAntigravityModelQuotas(configs, nowMs),
    status: {
      connected: true,
      code: 'connected',
      label: 'Connected',
      severity: 'ok',
    },
  };
}

function unavailableSnapshot(ctx: ProviderContext, code: string, label: string, detail: string): ProviderQuotaSnapshot {
  return {
    provider: 'antigravity',
    source: 'localRpc',
    capturedAt: ctx.nowMs,
    models: [],
    status: {
      connected: false,
      code,
      label,
      detail,
      severity: 'warning',
    },
  };
}

export async function fetchAntigravityQuotaFromServers(
  ctx: ProviderContext,
  servers: AntigravityServerInfo[],
  stopAt = deadlineMs(ctx),
): Promise<ProviderQuotaSnapshot> {
  const pastDeadline = () => Date.now() >= stopAt;

  if (servers.length === 0) {
    return unavailableSnapshot(
      ctx,
      'not-running',
      'Start Antigravity',
      'Antigravity quota is available only while Antigravity IDE is running and signed in.',
    );
  }

  const candidates: CandidateQuota[] = [];
  for (const server of servers) {
    if (pastDeadline()) break;
    try {
      const status = await getUserStatusCached(server, ctx.nowMs, remainingTimeoutMs(stopAt));
      const trajectories = pastDeadline()
        ? null
        : await getTrajectorySummariesCached(server, ctx.nowMs, remainingTimeoutMs(stopAt));
      candidates.push({
        server,
        snapshot: snapshotFromStatus(status, ctx.nowMs),
        newestCascadeMs: newestCascadeMs(trajectories),
      });
    } catch {
      // Try the next local language server.
    }
  }

  if (candidates.length === 0) {
    return unavailableSnapshot(
      ctx,
      'unavailable',
      'Antigravity unavailable',
      'Antigravity is running, but WhereMyTokens could not read quota from its local service.',
    );
  }

  return candidates.sort((a, b) => candidateScore(b) - candidateScore(a))[0].snapshot;
}

export async function fetchAntigravityQuota(ctx: ProviderContext): Promise<ProviderQuotaSnapshot | null> {
  const stopAt = deadlineMs(ctx);
  const servers = await findAntigravityServersCached(ctx.nowMs, remainingTimeoutMs(stopAt));
  return fetchAntigravityQuotaFromServers(ctx, servers, stopAt);
}
