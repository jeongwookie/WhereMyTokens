import type {
  ProviderContext,
} from '../types';
import type { ProviderQuotaSnapshot, QuotaEntry, QuotaUsageBinding } from '../../../shared/quotaTypes';
import { normalizeQuotaPeriod } from '../../../shared/quotaDomain';
import { defaultQuotaModeForModel, normalizeAntigravityModel } from './models';
import { maskEmail, parseTimestampMs } from './pathUtils';
import { resolveAntigravityPriceForModel } from './pricing';
import {
  findAntigravityServersCached,
  getQuotaSummaryCached,
  getTrajectorySummariesCached,
  getUserStatusCached,
} from './runtimeCache';
import type {
  AntigravityModelConfig,
  AntigravityQuotaSummaryBucket,
  AntigravityQuotaSummaryGroup,
  AntigravityQuotaSummaryResponse,
  AntigravityServerInfo,
  AntigravityTrajectorySummariesResponse,
  AntigravityUserStatusResponse,
} from './types';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUOTA_SUMMARY_GROUPS = 32;
const MAX_QUOTA_SUMMARY_BUCKETS = 32;

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

function summaryBucketDurationMs(bucket: AntigravityQuotaSummaryBucket): number | null {
  if (bucket.window) {
    switch (bucket.window.toLowerCase()) {
      case 'weekly':
      case '7d': return WEEK_MS;
      case '5h': return FIVE_HOURS_MS;
      default: return null;
    }
  }
  const text = `${bucket.bucketId ?? ''} ${bucket.displayName ?? ''}`.toLowerCase();
  if (text.includes('weekly') || text.includes('week') || text.includes('7d')) return WEEK_MS;
  if (text.includes('five hour') || text.includes('five-hour') || text.includes('5h') || text.includes('session')) {
    return FIVE_HOURS_MS;
  }
  return null;
}

function summaryTargetAbbreviation(label: string): string {
  if (/claude|gpt/i.test(label)) return 'CG';
  const words = label.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const initials = words.map(word => word[0]).join('');
  return (initials.length >= 2 ? initials : words.join('')).slice(0, 3) || 'A';
}

function summaryUsageBindings(
  groups: AntigravityQuotaSummaryGroup[],
  configs: AntigravityModelConfig[],
): Map<number, QuotaUsageBinding> {
  const resetGroups = new Map<number, Set<number>>();
  groups.forEach((group, groupIndex) => {
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets.slice(0, MAX_QUOTA_SUMMARY_BUCKETS) : []) {
      if (!bucket || remainingPctFromFraction(bucket.remainingFraction) == null) continue;
      const reset = resetAtFromValue(bucket.resetTime);
      if (reset == null) continue;
      const owners = resetGroups.get(reset) ?? new Set<number>();
      owners.add(groupIndex);
      resetGroups.set(reset, owners);
    }
  });
  const modelGroups = new Map<string, { value: string; owners: Set<number | null> }>();
  for (const config of configs) {
    const reset = resetAtFromValue(config.quotaInfo?.resetTime);
    const owners = reset == null ? undefined : resetGroups.get(reset);
    const groupIndex = owners?.size === 1 ? owners.values().next().value! : null;
    for (const value of [config.label, config.modelOrAlias?.model, config.modelId]) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const key = value.trim().toLowerCase();
      const model = modelGroups.get(key) ?? { value: value.trim(), owners: new Set<number | null>() };
      model.owners.add(groupIndex);
      modelGroups.set(key, model);
    }
  }
  const bindings = new Map<number, QuotaUsageBinding>();
  for (const { value, owners } of modelGroups.values()) {
    if (owners.size !== 1) continue;
    const groupIndex = owners.values().next().value;
    if (groupIndex == null) continue;
    let binding = bindings.get(groupIndex);
    if (!binding || binding.kind !== 'models') {
      binding = { kind: 'models', matchers: [] };
      bindings.set(groupIndex, binding);
    }
    binding.matchers.push({ kind: 'exact', value });
  }
  return bindings;
}

export function parseAntigravityQuotaSummary(
  response: AntigravityQuotaSummaryResponse,
  configs: AntigravityModelConfig[],
): QuotaEntry[] {
  const groups = Array.isArray(response.response?.groups)
    ? response.response.groups
    : Array.isArray(response.groups) ? response.groups : [];
  const boundedGroups = groups.slice(0, MAX_QUOTA_SUMMARY_GROUPS);
  const bindings = summaryUsageBindings(boundedGroups, configs);
  const entries: QuotaEntry[] = [];
  const seenGroupIds = new Set<string>();

  boundedGroups.forEach((group, groupIndex) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) return;
    const label = typeof group.displayName === 'string' && group.displayName.trim()
      ? group.displayName.trim()
      : `Antigravity quota ${groupIndex + 1}`;
    const baseGroupId = stableModelId(label);
    const groupId = seenGroupIds.has(baseGroupId) ? `${baseGroupId}-${groupIndex + 1}` : baseGroupId;
    seenGroupIds.add(groupId);
    const target: QuotaEntry['target'] = {
      id: `antigravity.group.summary.${groupId}`,
      label,
      defaultMode: 'simple',
      defaultOrder: 100 + groupIndex,
      taskbarAbbreviation: summaryTargetAbbreviation(label),
      cacheMetricTitle: 'Cache read / prompt tokens',
      hideCost: true,
    };
    const seenBucketIds = new Set<string>();
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];

    buckets.slice(0, MAX_QUOTA_SUMMARY_BUCKETS).forEach((bucket, bucketIndex) => {
      if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return;
      const remainingPct = remainingPctFromFraction(bucket.remainingFraction);
      if (remainingPct == null) return;
      const bucketLabel = typeof bucket.displayName === 'string' && bucket.displayName.trim()
        ? bucket.displayName.trim()
        : `Quota ${bucketIndex + 1}`;
      const baseBucketId = stableModelId(
        typeof bucket.bucketId === 'string' && bucket.bucketId.trim() ? bucket.bucketId : bucketLabel,
      );
      const bucketId = seenBucketIds.has(baseBucketId) ? `${baseBucketId}-${bucketIndex + 1}` : baseBucketId;
      seenBucketIds.add(bucketId);
      const durationMs = summaryBucketDurationMs(bucket);
      const resetsAt = resetAtFromValue(bucket.resetTime);
      const usageBinding = bindings.get(groupIndex);
      entries.push({
        key: `antigravity.summary.${groupId}.${bucketId}`,
        target,
        scope: { kind: 'model', label },
        state: 'limited',
        usedPct: clampPercent(100 - remainingPct),
        resetsAt,
        durationMs,
        durationInferred: false,
        period: normalizeQuotaPeriod(durationMs),
        ...(durationMs != null && resetsAt != null && usageBinding ? { usageBinding } : {}),
      });
    });
  });

  return entries;
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

function modelConfigsFromStatus(response: AntigravityUserStatusResponse): AntigravityModelConfig[] {
  const configs = response.userStatus?.cascadeModelConfigData?.clientModelConfigs;
  return Array.isArray(configs)
    ? configs.filter((config): config is AntigravityModelConfig => !!config && typeof config === 'object' && !Array.isArray(config))
    : [];
}

function snapshotFromStatus(
  response: AntigravityUserStatusResponse,
  nowMs: number,
  options: AntigravityQuotaParseOptions = {},
): ProviderQuotaSnapshot {
  const userStatus = response.userStatus;
  const configs = modelConfigsFromStatus(response);
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
      const legacySnapshot = snapshotFromStatus(status, ctx.nowMs, {
        inferDurationFromReset: ctx.settings.antigravityQuotaDurationPaceEnabled === true,
      });
      const summary = pastDeadline()
        ? null
        : await getQuotaSummaryCached(server, ctx.nowMs, remainingTimeoutMs(stopAt));
      const summaryEntries = summary ? parseAntigravityQuotaSummary(summary, modelConfigsFromStatus(status)) : [];
      const trajectories = pastDeadline()
        ? null
        : await getTrajectorySummariesCached(server, ctx.nowMs, remainingTimeoutMs(stopAt));
      candidates.push({
        server,
        snapshot: summaryEntries.length > 0
          ? { ...legacySnapshot, entries: summaryEntries }
          : legacySnapshot,
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
