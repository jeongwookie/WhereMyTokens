import { emptyBreakdownDelta, type BreakdownDelta } from '../../shared/breakdownTypes';
import type { ProviderId } from '../providers/types';
import {
  emptyUsageMetrics,
  type StoredUsageSource,
  type UsageBreakdownData,
  type UsageBreakdownQuery,
  type UsageCompactionResult,
  type UsageEntry,
  type UsageEntryQuery,
  type UsageFilter,
  type UsageIndexStorage,
  type UsageMetrics,
  type UsageModelTotal,
  type UsageQueryData,
  type UsageQuery,
  type UsageSessionProjection,
  type UsageSourceCommit,
  type UsageSourceDescriptor,
  type UsageTimeBucketTotal,
} from './types';
import { usageRetentionCutoffs } from './retention';
import {
  addUsageBreakdown,
  addUsageMetrics,
  collectUsageBucketDeltas,
  usageBucketStart,
  type UsageBucketDelta,
} from './usageBucketAggregation';

function cloneDescriptor(source: UsageSourceDescriptor): UsageSourceDescriptor {
  return {
    ...source,
    version: { ...source.version },
    projectKeys: [...(source.projectKeys ?? [])],
  };
}

function cloneEntry(entry: UsageEntry): UsageEntry {
  return {
    ...entry,
    ...(entry.breakdown ? { breakdown: { ...entry.breakdown } } : {}),
  };
}

function cloneProjection(projection: UsageSessionProjection): UsageSessionProjection {
  return {
    ...projection,
    payload: { ...projection.payload },
  };
}

function cloneBucket(bucket: UsageBucketDelta): UsageBucketDelta {
  return {
    ...bucket,
    metrics: { ...bucket.metrics },
    breakdown: { ...bucket.breakdown },
  };
}

function cloneSource(source: StoredUsageSource): StoredUsageSource {
  return {
    descriptor: cloneDescriptor(source.descriptor),
    checkpoint: { ...source.checkpoint },
    ...(source.sealedBeforeMs === undefined ? {} : { sealedBeforeMs: source.sealedBeforeMs }),
    ...(source.providerMetadata ? { providerMetadata: { ...source.providerMetadata } } : {}),
    ...(source.sessionProjection ? { sessionProjection: cloneProjection(source.sessionProjection) } : {}),
  };
}

function entriesAtOrAfterSeal(entries: readonly UsageEntry[], sealedBeforeMs: number | undefined): UsageEntry[] {
  if (sealedBeforeMs === undefined) return [...entries];
  return entries.filter(entry => entry.timestampMs >= sealedBeforeMs);
}

function queryAccepts(
  query: UsageFilter,
  source: StoredUsageSource,
  entry: UsageEntry,
  excludedProjects: ReadonlySet<string>,
): boolean {
  if ((source.descriptor.projectKeys ?? []).some(key => excludedProjects.has(key.toLowerCase()))) return false;
  if (query.providers && !query.providers.has(entry.provider)) return false;
  if (query.fromMs !== undefined && entry.timestampMs < query.fromMs) return false;
  if (query.toMs !== undefined && entry.timestampMs >= query.toMs) return false;
  return true;
}

export class InMemoryUsageIndexStorage implements UsageIndexStorage {
  private sources = new Map<string, StoredUsageSource>();
  private entries = new Map<string, Map<string, UsageEntry>>();
  private buckets = new Map<string, UsageBucketDelta>();
  private sessions = new Map<string, UsageSessionProjection>();
  private closed = false;

  async getSource(sourceId: string): Promise<StoredUsageSource | null> {
    this.assertOpen();
    const source = this.sources.get(sourceId);
    if (!source) return null;
    const sessionProjection = this.sessions.get(sourceId);
    return cloneSource({
      ...source,
      ...(sessionProjection ? { sessionProjection } : {}),
    });
  }

  async updateSourceDescriptor(source: UsageSourceDescriptor): Promise<void> {
    this.assertOpen();
    const current = this.sources.get(source.sourceId);
    if (!current) throw new Error(`Cannot update missing usage source ${source.sourceId}`);
    this.sources.set(source.sourceId, {
      ...cloneSource(current),
      descriptor: cloneDescriptor(source),
    });
  }

  async commitSource(commit: UsageSourceCommit): Promise<void> {
    this.assertOpen();
    const storedSource = this.sources.get(commit.source.sourceId);
    const nextSources = new Map(this.sources);
    const nextEntries = new Map(this.entries);
    const nextBuckets = new Map([...this.buckets].map(([key, bucket]) => [key, cloneBucket(bucket)]));
    const nextSessions = new Map(this.sessions);
    const existingEntries = new Map(nextEntries.get(commit.source.sourceId) ?? []);
    const sourceEntries = new Map(existingEntries);
    const replacedEntries = new Map<string, UsageEntry>();
    if (commit.mode === 'rebuild') {
      const coverage = commit.batch.rebuildCoverage;
      if (!coverage) throw new Error(`Usage source ${commit.source.sourceId} rebuild coverage is missing`);
      if (coverage.kind === 'full') {
        for (const [requestId, entry] of sourceEntries) replacedEntries.set(requestId, entry);
        sourceEntries.clear();
      }
      if (coverage.kind === 'range') {
        for (const [requestId, entry] of sourceEntries) {
          if (entry.timestampMs >= coverage.fromMs && entry.timestampMs < coverage.toMs) {
            replacedEntries.set(requestId, entry);
            sourceEntries.delete(requestId);
          }
        }
      }
    }

    const entriesToCommit = entriesAtOrAfterSeal(commit.batch.entries, storedSource?.sealedBeforeMs);
    for (const entry of entriesToCommit) {
      const previous = existingEntries.get(entry.requestId);
      if (previous && !replacedEntries.has(entry.requestId)) replacedEntries.set(entry.requestId, previous);
      sourceEntries.set(entry.requestId, cloneEntry(entry));
    }
    const bucketDeltas = new Map<string, UsageBucketDelta>();
    collectUsageBucketDeltas(bucketDeltas, commit.source.sourceId, [...replacedEntries.values()], -1);
    collectUsageBucketDeltas(bucketDeltas, commit.source.sourceId, entriesToCommit, 1);
    for (const [key, delta] of bucketDeltas) {
      const bucket = nextBuckets.get(key) ?? {
        ...delta,
        metrics: emptyUsageMetrics(),
        breakdown: emptyBreakdownDelta(),
      };
      addUsageMetrics(bucket.metrics, delta.metrics);
      addUsageBreakdown(bucket.breakdown, delta.breakdown);
      if (bucket.metrics.requestCount < 0) throw new Error(`UsageIndex bucket delta underflow for ${commit.source.sourceId}`);
      if (bucket.metrics.requestCount === 0) nextBuckets.delete(key);
      else nextBuckets.set(key, bucket);
    }
    nextEntries.set(commit.source.sourceId, sourceEntries);
    nextSources.set(commit.source.sourceId, {
      descriptor: cloneDescriptor(commit.source),
      checkpoint: { ...commit.batch.checkpoint },
      ...(storedSource?.sealedBeforeMs === undefined ? {} : { sealedBeforeMs: storedSource.sealedBeforeMs }),
      ...(commit.batch.providerMetadata ? { providerMetadata: { ...commit.batch.providerMetadata } } : {}),
    });

    if (commit.batch.sessionProjection === null || (commit.mode === 'rebuild' && commit.batch.sessionProjection === undefined)) {
      nextSessions.delete(commit.source.sourceId);
    } else if (commit.batch.sessionProjection) {
      nextSessions.set(commit.source.sourceId, cloneProjection(commit.batch.sessionProjection));
    }

    this.sources = nextSources;
    this.entries = nextEntries;
    this.buckets = nextBuckets;
    this.sessions = nextSessions;
  }

  async queryUsage(query: UsageQuery): Promise<UsageQueryData> {
    this.assertOpen();
    const excludedProjects = new Set((query.excludedProjectKeys ?? []).map(key => key.toLowerCase()));
    const aggregate = emptyUsageMetrics();
    const byProvider: Partial<Record<ProviderId, UsageMetrics>> = {};
    const modelMap = new Map<string, UsageModelTotal>();
    const bucketMap = new Map<number, UsageTimeBucketTotal>();
    const addContribution = (
      provider: ProviderId,
      modelName: string,
      bucketStartMs: number,
      metrics: UsageMetrics,
    ) => {
      addUsageMetrics(aggregate, metrics);
      byProvider[provider] ??= emptyUsageMetrics();
      addUsageMetrics(byProvider[provider]!, metrics);
      const modelKey = `${provider}\0${modelName}`;
      const model = modelMap.get(modelKey) ?? {
        provider,
        model: modelName,
        metrics: emptyUsageMetrics(),
      };
      addUsageMetrics(model.metrics, metrics);
      modelMap.set(modelKey, model);
      const bucket = bucketMap.get(bucketStartMs) ?? { bucketStartMs, metrics: emptyUsageMetrics() };
      addUsageMetrics(bucket.metrics, metrics);
      bucketMap.set(bucketStartMs, bucket);
    };

    for (const bucket of this.buckets.values()) {
      const source = this.sources.get(bucket.sourceId);
      if (!source || bucket.kind !== query.grain) continue;
      if ((source.descriptor.projectKeys ?? []).some(key => excludedProjects.has(key.toLowerCase()))) continue;
      if (query.providers && !query.providers.has(bucket.provider)) continue;
      if (query.fromMs !== undefined && bucket.bucketStartMs < query.fromMs) continue;
      if (query.toMs !== undefined && bucket.bucketStartMs >= query.toMs) continue;
      addContribution(bucket.provider, bucket.model, bucket.bucketStartMs, bucket.metrics);
    }

    return {
      grain: query.grain,
      aggregate,
      byProvider,
      models: [...modelMap.values()].sort((a, b) => b.metrics.totalTokens - a.metrics.totalTokens),
      buckets: [...bucketMap.values()].sort((a, b) => a.bucketStartMs - b.bucketStartMs),
    };
  }

  async queryEntries(query: UsageEntryQuery): Promise<UsageEntry[]> {
    this.assertOpen();
    const excludedProjects = new Set((query.excludedProjectKeys ?? []).map(key => key.toLowerCase()));
    const result: UsageEntry[] = [];
    for (const [sourceId, entries] of this.entries) {
      const source = this.sources.get(sourceId);
      if (!source) continue;
      for (const entry of entries.values()) {
        if (queryAccepts(query, source, entry, excludedProjects)) result.push(cloneEntry(entry));
      }
    }
    return result.sort((a, b) => a.timestampMs - b.timestampMs || a.requestId.localeCompare(b.requestId));
  }

  async queryBreakdown(query: UsageBreakdownQuery): Promise<UsageBreakdownData> {
    this.assertOpen();
    const excludedProjects = new Set((query.excludedProjectKeys ?? []).map(key => key.toLowerCase()));
    const aggregate = emptyBreakdownDelta();
    const bucketMap = new Map<number, BreakdownDelta>();

    const addContribution = (bucketStartMs: number, breakdown: BreakdownDelta) => {
      addUsageBreakdown(aggregate, breakdown);
      const bucket = bucketMap.get(bucketStartMs) ?? emptyBreakdownDelta();
      addUsageBreakdown(bucket, breakdown);
      bucketMap.set(bucketStartMs, bucket);
    };

    for (const bucket of this.buckets.values()) {
      const source = this.sources.get(bucket.sourceId);
      if (!source || bucket.kind !== query.grain) continue;
      if ((source.descriptor.projectKeys ?? []).some(key => excludedProjects.has(key.toLowerCase()))) continue;
      if (query.providers && !query.providers.has(bucket.provider)) continue;
      if (query.fromMs !== undefined && bucket.bucketStartMs < query.fromMs) continue;
      if (query.toMs !== undefined && bucket.bucketStartMs >= query.toMs) continue;
      addContribution(bucket.bucketStartMs, bucket.breakdown);
    }

    return {
      grain: query.grain,
      aggregate,
      buckets: [...bucketMap.entries()]
        .map(([bucketStartMs, breakdown]) => ({ bucketStartMs, breakdown }))
        .sort((a, b) => a.bucketStartMs - b.bucketStartMs),
    };
  }

  async readSessionProjections(sourceIds?: readonly string[]): Promise<UsageSessionProjection[]> {
    this.assertOpen();
    const requested = sourceIds ? new Set(sourceIds) : null;
    return [...this.sessions.values()]
      .filter(projection => !requested || requested.has(projection.sourceId))
      .map(cloneProjection)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async compact(nowMs: number): Promise<UsageCompactionResult> {
    this.assertOpen();
    const cutoffs = usageRetentionCutoffs(nowMs);
    let deletedRequestRows = 0;
    let deletedHourBuckets = 0;
    let deletedDayBuckets = 0;
    for (const entries of this.entries.values()) {
      for (const [requestId, entry] of entries) {
        if (entry.timestampMs < cutoffs.requestMs) {
          entries.delete(requestId);
          deletedRequestRows += 1;
        }
      }
    }
    for (const [key, bucket] of this.buckets) {
      if (bucket.kind === 'hour' && bucket.bucketStartMs < cutoffs.hourMs) {
        this.buckets.delete(key);
        deletedHourBuckets += 1;
      } else if (bucket.kind === 'day' && bucket.bucketStartMs < cutoffs.dayMs) {
        this.buckets.delete(key);
        deletedDayBuckets += 1;
      }
    }
    for (const [sourceId, source] of this.sources) {
      this.sources.set(sourceId, {
        ...source,
        sealedBeforeMs: Math.max(source.sealedBeforeMs ?? 0, cutoffs.requestMs),
      });
    }
    return { deletedRequestRows, deletedHourBuckets, deletedDayBuckets };
  }

  async reset(): Promise<void> {
    this.assertOpen();
    this.sources.clear();
    this.entries.clear();
    this.buckets.clear();
    this.sessions.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('InMemoryUsageIndexStorage is closed');
  }
}
