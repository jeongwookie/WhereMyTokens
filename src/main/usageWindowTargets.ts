import type { ProviderId, ProviderQuotaSnapshot } from './providers/types';

export interface ProviderWindowResetHints {
  weekResetMs?: number | null;
  h5ResetMs?: number | null;
}

export interface ProviderWindowTarget {
  provider: ProviderId;
  windowKey: string;
  startMs: number;
  modelIncludes?: string[];
}

export type ProviderWindowResetHintMap = Partial<Record<ProviderId, ProviderWindowResetHints>>;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const H5_MS = 5 * 60 * 60 * 1000;

function rollingWindowStart(durationMs: number, resetMs: number | null | undefined, fallbackStart: number, nowMs: number): number {
  if (resetMs && resetMs > 0 && resetMs <= durationMs) return nowMs - (durationMs - resetMs);
  return fallbackStart;
}

function quotaWindowDuration(quota: ProviderQuotaSnapshot | undefined, windowKey: string): number | undefined {
  const durationMs = quota?.windowDisplay?.[windowKey]?.durationMs;
  return Number.isFinite(durationMs) && durationMs && durationMs > 0 ? durationMs : undefined;
}

function quotaWindowStart(
  provider: ProviderId,
  quota: ProviderQuotaSnapshot | undefined,
  windowKey: string,
  resets: ProviderWindowResetHintMap,
  nowMs: number,
  weekStartMs: number,
): number {
  const hints = resets[provider];
  const durationMs = quotaWindowDuration(quota, windowKey);
  const windowResetMs = quota?.windows?.[windowKey]?.resetMs;
  if (windowKey === 'h5' || durationMs === H5_MS) {
    return rollingWindowStart(H5_MS, windowResetMs ?? hints?.h5ResetMs, nowMs - H5_MS, nowMs);
  }
  if (windowKey === 'week' || durationMs === WEEK_MS) {
    return rollingWindowStart(WEEK_MS, windowResetMs ?? hints?.weekResetMs, weekStartMs, nowMs);
  }
  if (durationMs) return rollingWindowStart(durationMs, windowResetMs, nowMs - durationMs, nowMs);
  return windowKey.toLowerCase().includes('h5') ? nowMs - H5_MS : weekStartMs;
}

function addWindowTarget(
  targets: Map<ProviderId, ProviderWindowTarget[]>,
  provider: ProviderId,
  windowKey: string,
  startMs: number,
  modelIncludes?: string[],
): void {
  if (!windowKey) return;
  const list = targets.get(provider) ?? [];
  list.push({ provider, windowKey, startMs, modelIncludes });
  targets.set(provider, list);
}

function windowModelIncludes(quota: ProviderQuotaSnapshot | undefined, windowKey: string): string[] | undefined {
  const includes = quota?.windowDisplay?.[windowKey]?.modelIncludes;
  if (!Array.isArray(includes)) return undefined;
  const normalized = includes
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim().toLowerCase());
  return normalized.length > 0 ? normalized : undefined;
}

export function targetAcceptsModel(target: ProviderWindowTarget, model: string): boolean {
  if (!target.modelIncludes?.length) return true;
  const normalizedModel = model.toLowerCase();
  return target.modelIncludes.some(fragment => normalizedModel.includes(fragment));
}

export function buildProviderWindowTargets(
  providers: Iterable<ProviderId>,
  providerQuotas: Partial<Record<ProviderId, ProviderQuotaSnapshot>> = {},
  resets: ProviderWindowResetHintMap = {},
  nowMs: number,
  weekStartMs: number,
): Map<ProviderId, ProviderWindowTarget[]> {
  const targets = new Map<ProviderId, ProviderWindowTarget[]>();
  const providerSet = new Set<ProviderId>(providers);
  for (const provider of Object.keys(providerQuotas) as ProviderId[]) providerSet.add(provider);

  for (const provider of providerSet) {
    const quota = providerQuotas[provider];
    for (const group of quota?.groups ?? []) {
      for (const windowKey of group.windowKeys) {
        addWindowTarget(
          targets,
          provider,
          windowKey,
          quotaWindowStart(provider, quota, windowKey, resets, nowMs, weekStartMs),
          windowModelIncludes(quota, windowKey),
        );
      }
    }

    if (!targets.has(provider)) {
      addWindowTarget(targets, provider, 'h5', quotaWindowStart(provider, quota, 'h5', resets, nowMs, weekStartMs));
      addWindowTarget(targets, provider, 'week', quotaWindowStart(provider, quota, 'week', resets, nowMs, weekStartMs));
    }
  }

  return targets;
}
