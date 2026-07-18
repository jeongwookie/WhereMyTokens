import type {
  ProviderContext,
} from '../types';
import type { ProviderQuotaSnapshot, QuotaEntry } from '../../../shared/quotaTypes';
import { normalizeQuotaPeriod } from '../../../shared/quotaDomain';
import { defaultQuotaModeForModel, normalizeAntigravityModel } from './models';
import { maskEmail, parseTimestampMs } from './pathUtils';
import { resolveAntigravityPriceForModel } from './pricing';
import { findAntigravityServersCached, getTrajectorySummariesCached, getUserStatusCached } from './runtimeCache';
import type {
  AntigravityModelConfig,
  AntigravityServerInfo,
  AntigravityTrajectorySummariesResponse,
  AntigravityUserStatusResponse,
} from './types';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface AntigravityQuotaParseOptions {
  inferDurationFromReset?: boolean;
}

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

function resetAtFromValue(value: unknown): number | null {
  if (value == null) return null;
  const parsed = parseTimestampMs(value, NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function durationMsFromReset(resetsAt: number | null, nowMs: number, enabled: boolean): number | null {
  if (!enabled || resetsAt == null || resetsAt <= nowMs) return null;
  return resetsAt - nowMs <= FIVE_HOURS_MS ? FIVE_HOURS_MS : WEEK_MS;
}

function stableModelId(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

export function parseAntigravityModelQuotas(
  configs: AntigravityModelConfig[],
  nowMs: number,
  options: AntigravityQuotaParseOptions = {},
): QuotaEntry[] {
  return configs
    .filter(config => !!config.quotaInfo)
    .map((config, index): QuotaEntry | null => {
      const remainingPct = remainingPctFromFraction(config.quotaInfo?.remainingFraction);
      if (remainingPct == null) return null;
      const model = config.modelOrAlias?.model || config.label || 'unknown';
      const label = config.label || model;
      const resetsAt = resetAtFromValue(config.quotaInfo?.resetTime);
      const durationMs = durationMsFromReset(resetsAt, nowMs, options.inferDurationFromReset === true);
      const usageModel = normalizeAntigravityModel(model, new Map([[model, label]]));
      const modelId = stableModelId(model);
      return {
        key: `antigravity.model.${modelId}`,
        target: {
          id: `antigravity.group.model.${modelId}`,
          label,
          defaultMode: defaultQuotaModeForModel(label, model),
          defaultOrder: 100 + index,
          taskbarAbbreviation: label.toUpperCase().match(/[A-Z0-9]/)?.[0] ?? 'A',
          cacheMetricTitle: 'Cache read / prompt tokens',
          hideCost: !resolveAntigravityPriceForModel(usageModel, `${model} ${label}`),
        },
        scope: { kind: 'model', label },
        state: 'limited',
        usedPct: clampPercent(100 - remainingPct),
        resetsAt,
        durationMs,
        durationInferred: durationMs != null,
        period: normalizeQuotaPeriod(durationMs),
        ...(durationMs != null ? {
          usageBinding: { kind: 'models' as const, matchers: [{ kind: 'exact' as const, value: usageModel }] },
        } : {}),
      };
    })
    .filter((quota): quota is QuotaEntry => !!quota);
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
  if (candidate.newestCascadeMs > 0) score += candidate.newestCascadeMs;
  if (candidate.server.processStartedAtMs) score += candidate.server.processStartedAtMs / 10_000;
  return score;
}

function snapshotFromStatus(
  response: AntigravityUserStatusResponse,
  nowMs: number,
  options: AntigravityQuotaParseOptions = {},
): ProviderQuotaSnapshot {
  const userStatus = response.userStatus;
  const rawConfigs = userStatus?.cascadeModelConfigData?.clientModelConfigs;
  const configs = Array.isArray(rawConfigs)
    ? rawConfigs.filter((config): config is AntigravityModelConfig => !!config && typeof config === 'object' && !Array.isArray(config))
    : [];
  const accountEmail = typeof userStatus?.email === 'string' && userStatus.email.trim().length > 0
    ? userStatus.email.trim()
    : undefined;
  const accountLabel = maskEmail(accountEmail);
  return {
    provider: 'antigravity',
    source: 'localRpc',
    capturedAt: nowMs,
    accountLabel,
    accountTooltip: accountLabel,
    planName: userStatus?.planStatus?.planInfo?.planName,
    entries: parseAntigravityModelQuotas(configs, nowMs, options),
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
    entries: [],
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
        snapshot: snapshotFromStatus(status, ctx.nowMs, {
          inferDurationFromReset: ctx.settings.antigravityQuotaDurationPaceEnabled === true,
        }),
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
