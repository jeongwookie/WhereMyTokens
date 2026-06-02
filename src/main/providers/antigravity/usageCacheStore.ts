import Store from 'electron-store';
import type { UsageAggregate } from '../../usageLedgerTypes';
import {
  aggregateFromUsageEntry,
  type UsageLedgerProviderSlice,
} from '../../usageLedgerIngest';
import {
  addUsageAggregate,
  dayModelKey,
  emptyUsageAggregate,
  hourProviderKey,
  minuteKey,
  monthModelKey,
} from '../../usageLedgerAggregates';
import { sourceHashForIdentity } from '../../usageLedgerImporter';
import type { AntigravityUsageCall } from './gmParser';
import {
  antigravityCallFingerprint,
  antigravityCallRequestId,
} from './gmParser';
import { antigravityCascadeSummaryKey } from './serverIdentity';
import { antigravityUsageEntryFromCall } from './summary';

const ANTIGRAVITY_USAGE_CACHE_SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_CALL_RETENTION_MS = 395 * DAY_MS;
const MINUTE_RECENT_RETENTION_MS = 8 * DAY_MS;
const HOURLY_ACTIVITY_RETENTION_MS = 180 * DAY_MS;

export interface CachedAntigravityCall extends AntigravityUsageCall {
  requestId: string;
  fingerprint: string;
  firstSeenMs: number;
  lastSeenMs: number;
}

export interface CachedAntigravityCascade {
  ownerKey: string;
  cascadeId: string;
  projectKeys?: string[];
  totalSteps: number;
  status: string;
  lastModifiedMs: number;
  lastFetchedAtMs: number;
  calls: Record<string, CachedAntigravityCall>;
}

export interface AntigravityUsageCacheSnapshot {
  schemaVersion: number;
  cascades: Record<string, CachedAntigravityCascade>;
  lastCompactedAt: number;
}

export interface AntigravityCascadeUpdate {
  ownerKey: string;
  cascadeId: string;
  projectKeys?: string[];
  totalSteps: number;
  status: string;
  lastModifiedMs: number;
  fetchedAtMs: number;
  calls: AntigravityUsageCall[];
}

interface StoreLike {
  get(key: 'cache'): AntigravityUsageCacheSnapshot | undefined;
  set(key: 'cache', value: AntigravityUsageCacheSnapshot): void;
}

export function emptyAntigravityUsageCacheSnapshot(): AntigravityUsageCacheSnapshot {
  return {
    schemaVersion: ANTIGRAVITY_USAGE_CACHE_SCHEMA_VERSION,
    cascades: {},
    lastCompactedAt: 0,
  };
}

function objectRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, T>
    : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function int0(value: unknown): number {
  const numeric = finiteNumber(value);
  return numeric == null ? 0 : Math.max(0, Math.round(numeric));
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeCall(value: unknown): CachedAntigravityCall | null {
  const raw = objectRecord<unknown>(value);
  const cascadeId = stringValue(raw.cascadeId);
  const timestampMs = finiteNumber(raw.timestampMs);
  const firstSeenMs = finiteNumber(raw.firstSeenMs);
  const lastSeenMs = finiteNumber(raw.lastSeenMs);
  if (!cascadeId || timestampMs == null || firstSeenMs == null || lastSeenMs == null) return null;

  const contextMax = finiteNumber(raw.contextMax);
  return {
    cascadeId,
    executionId: stringValue(raw.executionId),
    stepIndices: Array.isArray(raw.stepIndices)
      ? raw.stepIndices.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
      : [],
    timestampMs,
    model: stringValue(raw.model) || 'antigravity',
    rawModel: stringValue(raw.rawModel) || stringValue(raw.model) || 'antigravity',
    inputTokens: int0(raw.inputTokens),
    outputTokens: int0(raw.outputTokens),
    cacheCreationTokens: int0(raw.cacheCreationTokens),
    cacheReadTokens: int0(raw.cacheReadTokens),
    thinkingTokens: int0(raw.thinkingTokens),
    responseTokens: int0(raw.responseTokens),
    toolNames: Array.isArray(raw.toolNames)
      ? raw.toolNames.filter((item): item is string => typeof item === 'string')
      : [],
    ...(contextMax == null ? {} : { contextMax }),
    requestId: stringValue(raw.requestId),
    fingerprint: stringValue(raw.fingerprint),
    firstSeenMs,
    lastSeenMs,
  };
}

function normalizeSnapshot(value: unknown): AntigravityUsageCacheSnapshot {
  const raw = objectRecord<unknown>(value);
  if (raw.schemaVersion !== ANTIGRAVITY_USAGE_CACHE_SCHEMA_VERSION) return emptyAntigravityUsageCacheSnapshot();

  const cascades: Record<string, CachedAntigravityCascade> = {};
  for (const [cacheKey, rawCascade] of Object.entries(objectRecord<unknown>(raw.cascades))) {
    const cascade = objectRecord<unknown>(rawCascade);
    const ownerKey = stringValue(cascade.ownerKey) || 'legacy';
    const cascadeId = stringValue(cascade.cascadeId) || cacheKey;
    const projectKeys = Array.isArray(cascade.projectKeys)
      ? cascade.projectKeys.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : undefined;
    const calls: Record<string, CachedAntigravityCall> = {};
    for (const [requestId, rawCall] of Object.entries(objectRecord<unknown>(cascade.calls))) {
      const call = normalizeCall(rawCall);
      if (call) calls[requestId] = { ...call, requestId: call.requestId || requestId };
    }
    cascades[`${ownerKey}:${cascadeId}`] = {
      ownerKey,
      cascadeId,
      projectKeys,
      totalSteps: int0(cascade.totalSteps),
      status: stringValue(cascade.status),
      lastModifiedMs: finiteNumber(cascade.lastModifiedMs) ?? 0,
      lastFetchedAtMs: finiteNumber(cascade.lastFetchedAtMs) ?? 0,
      calls,
    };
  }

  return {
    schemaVersion: ANTIGRAVITY_USAGE_CACHE_SCHEMA_VERSION,
    cascades,
    lastCompactedAt: finiteNumber(raw.lastCompactedAt) ?? 0,
  };
}

function addToRecord(record: Record<string, UsageAggregate>, key: string, aggregate: UsageAggregate): void {
  const current = record[key] ?? emptyUsageAggregate();
  addUsageAggregate(current, aggregate);
  record[key] = current;
}

function cascadeSourceKey(ownerKey: string, cascadeId: string): string {
  return antigravityCascadeSummaryKey(ownerKey, cascadeId);
}

function cascadeSourceHash(ownerKey: string, cascadeId: string): string {
  return sourceHashForIdentity(cascadeSourceKey(ownerKey, cascadeId));
}

export class AntigravityUsageCacheStore {
  private readonly store: StoreLike;

  constructor(store?: StoreLike) {
    this.store = store ?? new Store<{ cache: AntigravityUsageCacheSnapshot }>({
      name: 'antigravity-usage-cache',
      defaults: { cache: emptyAntigravityUsageCacheSnapshot() },
    }) as unknown as StoreLike;
  }

  getSnapshot(): AntigravityUsageCacheSnapshot {
    return normalizeSnapshot(this.store.get('cache'));
  }

  replaceSnapshot(snapshot: AntigravityUsageCacheSnapshot): void {
    this.store.set('cache', normalizeSnapshot(snapshot));
  }

  upsertCascade(update: AntigravityCascadeUpdate, nowMs = Date.now()): AntigravityUsageCacheSnapshot {
    const snapshot = this.getSnapshot();
    const ownerKey = update.ownerKey || 'legacy';
    const cacheKey = `${ownerKey}:${update.cascadeId}`;
    const current = snapshot.cascades[cacheKey];
    const calls = { ...(current?.calls ?? {}) };

    for (const call of update.calls) {
      const requestId = antigravityCallRequestId(call);
      const existing = calls[requestId];
      calls[requestId] = {
        ...call,
        requestId,
        fingerprint: antigravityCallFingerprint(call),
        firstSeenMs: existing?.firstSeenMs ?? nowMs,
        lastSeenMs: nowMs,
      };
    }

    snapshot.cascades[cacheKey] = {
      ownerKey,
      cascadeId: update.cascadeId,
      projectKeys: update.projectKeys,
      totalSteps: update.totalSteps,
      status: update.status,
      lastModifiedMs: update.lastModifiedMs,
      lastFetchedAtMs: update.fetchedAtMs,
      calls,
    };
    this.replaceSnapshot(snapshot);
    return snapshot;
  }

  compact(nowMs = Date.now()): AntigravityUsageCacheSnapshot {
    const snapshot = this.getSnapshot();
    const cutoff = nowMs - RAW_CALL_RETENTION_MS;
    for (const [cascadeId, cascade] of Object.entries(snapshot.cascades)) {
      cascade.calls = Object.fromEntries(
        Object.entries(cascade.calls).filter(([, call]) => call.timestampMs >= cutoff),
      );
      if (Object.keys(cascade.calls).length === 0) delete snapshot.cascades[cascadeId];
    }
    snapshot.lastCompactedAt = nowMs;
    this.replaceSnapshot(snapshot);
    return snapshot;
  }

  listCascades(ownerKey?: string): CachedAntigravityCascade[] {
    return Object.values(this.getSnapshot().cascades)
      .filter(cascade => !ownerKey || cascade.ownerKey === ownerKey)
      .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  }

  buildLedgerSlice(nowMs = Date.now(), ownerKey?: string): UsageLedgerProviderSlice {
    const minuteRecent: Record<string, UsageAggregate> = {};
    const recentRequestIndex: UsageLedgerProviderSlice['recentRequestIndex'] = {};
    const hourlyActivity: Record<string, UsageAggregate> = {};
    const dailyModel: Record<string, UsageAggregate> = {};
    const monthlyModel: Record<string, UsageAggregate> = {};
    const sourceCheckpoints: UsageLedgerProviderSlice['sourceCheckpoints'] = {};
    const sourceRepairRollup: Record<string, UsageAggregate> = {};
    const minuteCutoff = nowMs - MINUTE_RECENT_RETENTION_MS;
    const hourCutoff = nowMs - HOURLY_ACTIVITY_RETENTION_MS;

    for (const cascade of this.listCascades(ownerKey)) {
      const sourceKey = cascadeSourceKey(cascade.ownerKey, cascade.cascadeId);
      const sourceHash = cascadeSourceHash(cascade.ownerKey, cascade.cascadeId);
      let cascadeHasUsage = false;
      for (const call of Object.values(cascade.calls)) {
        const entry = antigravityUsageEntryFromCall(call);
        const aggregate = aggregateFromUsageEntry(entry);
        cascadeHasUsage = true;
        if (entry.timestampMs >= minuteCutoff) {
          const key = minuteKey(entry.timestampMs, 'antigravity', entry.model);
          addToRecord(minuteRecent, key, aggregate);
          recentRequestIndex[`${sourceHash}|${entry.requestId}`] = {
            minuteKey: key,
            aggregate: { ...aggregate },
            lastSeenMs: nowMs,
          };
        }
        if (entry.timestampMs >= hourCutoff) {
          addToRecord(hourlyActivity, hourProviderKey(entry.timestampMs, 'antigravity'), aggregate);
        }
        addToRecord(dailyModel, dayModelKey(entry.timestampMs, 'antigravity', entry.model), aggregate);
        addToRecord(monthlyModel, monthModelKey(entry.timestampMs, 'antigravity', entry.model), aggregate);
      }
      if (cascadeHasUsage) {
        sourceCheckpoints[sourceHash] = {
          provider: 'antigravity',
          sourceHash,
          sourceKey,
          lastImportedAt: nowMs,
          hasUsage: true,
        };
      }
    }

    return {
      provider: 'antigravity',
      minuteRecent,
      recentRequestIndex,
      hourlyActivity,
      dailyModel,
      monthlyModel,
      sourceCheckpoints,
      sourceRepairRollup,
    };
  }
}
