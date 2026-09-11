import { emptyBreakdownDelta, type BreakdownDelta } from '../../shared/breakdownTypes';
import type { ProviderId } from '../../shared/quotaTypes';
import {
  emptyUsageMetrics,
  type StoredUsageSource,
  type UsageBreakdownData,
  type UsageBreakdownQuery,
  type UsageCompactionResult,
  type UsageEntry,
  type UsageEntryProjection,
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
import { UsageEntryProjectionBuilder } from './entryProjection';
import { usageRetentionCutoffs } from './retention';
import { canonicalSessionProjection, executionFingerprint, identityAccepts, reviseClaudePayload, sameExecutionOrigin, validUsageRevision, type ExecutionIdentity } from './executionIdentity';
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
  private identities = new Map<string, ExecutionIdentity>();

  identitySource(provider: ProviderId, key: string): string | undefined {
    this.assertOpen();
    return this.identities.get(provider + '\0' + key)?.sourceId;
  }

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
    const nextIdentities = new Map(this.identities);
    const keyFor = (key: string) => `${commit.source.provider}\0${key}`;
    const owner = (key: string) => nextIdentities.get(keyFor(key));
    for (const seed of commit.batch.identitySeeds ?? []) {
      const retained = nextEntries.get(commit.source.sourceId)?.get(seed.requestId);
      const known = owner(seed.key);
      if (retained && known?.sourceId === commit.source.sourceId && known.requestId === `protected:${seed.requestId}`) {
        for (const [key, alias] of nextIdentities) {
          if (key.startsWith(commit.source.provider + '\0') && alias.sourceId === known.sourceId && alias.requestId === known.requestId) {
            nextIdentities.set(key, { sourceId: known.sourceId, requestId: retained.requestId, timestampMs: retained.timestampMs,
              originId: retained.identityOrigin ?? '', fingerprint: executionFingerprint(retained) });
          }
        }
      }
      if (!known) nextIdentities.set(keyFor(seed.key), { sourceId: commit.source.sourceId,
        requestId: retained?.requestId ?? `protected:${seed.requestId}`, timestampMs: retained?.timestampMs ?? seed.timestampMs,
        originId: retained?.identityOrigin ?? '', fingerprint: retained ? executionFingerprint(retained) : '' });
    }
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

    const identityIssues = new Set<string>();
    const crossUpdates: Array<{ known: ExecutionIdentity; previous: UsageEntry; entry: UsageEntry }> = [];
    const suffix = commit.source.sourceId.slice(commit.source.sourceId.indexOf(':cascade:'));
    const uncertainCascade = !storedSource && commit.source.provider === 'antigravity' && commit.source.sourceId.includes(':cascade:')
      && [...this.sources.values()].find(s => s.descriptor.provider === 'antigravity'
        && s.descriptor.sourceId !== commit.source.sourceId && s.descriptor.sourceId.endsWith(suffix)
        && ((s.descriptor.parserVersion < 2 || s.descriptor.sourceId.startsWith('antigravity:unknown:'))
          && !s.providerMetadata?.resolvedUsageScope || commit.source.sourceId.startsWith('antigravity:unknown:')));
    if (uncertainCascade && !commit.source.sourceId.startsWith('antigravity:unknown:')) {
      nextSources.set(uncertainCascade.descriptor.sourceId, { ...uncertainCascade,
        providerMetadata: { ...uncertainCascade.providerMetadata, resolvedUsageScope: commit.source.sourceId } });
    }
    const entriesToCommit = [...commit.batch.entries].map(entry => ({ ...entry })).filter(entry => {
      const keys = [entry.identityKey, ...(entry.identityAliases ?? [])].filter((k): k is string => !!k);
      const protect = (): void => {
        for (const key of keys) if (!owner(key)) nextIdentities.set(keyFor(key), { sourceId: commit.source.sourceId,
          requestId: 'protected:' + entry.requestId, timestampMs: entry.timestampMs, originId: '', fingerprint: '' });
      };
      if (uncertainCascade) { protect(); return false; }
      const scopeWitness = entry.provider === 'antigravity' && entry.identityOrigin ? owner(entry.identityOrigin) : undefined;
      const witnessedScope = scopeWitness ? nextSources.get(scopeWitness.sourceId)?.providerMetadata?.resolvedUsageScope : undefined;
      if (scopeWitness && scopeWitness.sourceId !== commit.source.sourceId
        && (commit.source.sourceId.startsWith('antigravity:unknown:')
          || scopeWitness.sourceId.startsWith('antigravity:unknown:') && (!witnessedScope || witnessedScope === commit.source.sourceId))) {
        protect(); return false;
      }
      const knownValues = keys.map(owner).filter((v): v is ExecutionIdentity => !!v);
      const known = knownValues[0];
      if (knownValues.some(v => v.sourceId !== known?.sourceId || v.requestId !== known?.requestId)) { identityIssues.add('identity-conflict'); return false; }
      if (known && known.sourceId !== commit.source.sourceId) {
        if (sameExecutionOrigin(entry, known) && executionFingerprint(entry) === known.fingerprint) return false;
        const previous = this.entries.get(known.sourceId)?.get(known.requestId);
        const resumeState = this.sources.get(known.sourceId)?.checkpoint.resumeState;
        if (previous && validUsageRevision(entry, previous, known, resumeState ? JSON.parse(resumeState).payload : {}, commit.batch.sessionProjection?.payload)) crossUpdates.push({ known, previous, entry: { ...entry, requestId: known.requestId } });
        else identityIssues.add('cross-source-execution-conflict');
        return false;
      }
      if (known) {
        for (const key of keys) if (!owner(key)) nextIdentities.set(keyFor(key), known);
        if (!known.requestId.startsWith('protected:')) entry.requestId = known.requestId;
        entry.timestampMs = known.timestampMs;
      }
      if (!identityAccepts(entry, commit.source.sourceId, known)) return false;
      if (known) {
        const previous = existingEntries.get(known.requestId);
        if (!previous || known.fingerprint === executionFingerprint(entry)) return false;
        const oldPayload = storedSource?.checkpoint.resumeState ? JSON.parse(storedSource.checkpoint.resumeState).payload ?? {} : {};
        if (!validUsageRevision(entry, previous, known, oldPayload, commit.batch.sessionProjection?.payload)) {
          identityIssues.add('identity-conflict'); return false;
        }
      }
      for (const key of keys) if (!owner(key)) nextIdentities.set(keyFor(key), { sourceId: commit.source.sourceId, requestId: entry.requestId, timestampMs: entry.timestampMs, originId: entry.identityOrigin ?? '', fingerprint: executionFingerprint(entry) });
      if (entry.provider === 'antigravity' && entry.identityOrigin && !owner(entry.identityOrigin)) {
        nextIdentities.set(keyFor(entry.identityOrigin), { sourceId: commit.source.sourceId, requestId: entry.requestId,
          timestampMs: entry.timestampMs, originId: entry.identityOrigin, fingerprint: executionFingerprint(entry) });
      }
      return true;
    });
    for (const link of commit.batch.identityLinks ?? []) {
      const target = owner(link.target), existing = owner(link.alias);
      if (!target) continue;
      if (existing && (existing.sourceId !== target.sourceId || existing.requestId !== target.requestId)) {
        identityIssues.add('identity-conflict'); continue;
      }
      if (!existing) nextIdentities.set(keyFor(link.alias), { ...target });
    }
    for (const entry of entriesToCommit) {
      const previous = existingEntries.get(entry.requestId);
      if (previous && !replacedEntries.has(entry.requestId)) replacedEntries.set(entry.requestId, previous);
      sourceEntries.set(entry.requestId, cloneEntry(entry));
    }
    const bucketDeltas = new Map<string, UsageBucketDelta>();
    collectUsageBucketDeltas(bucketDeltas, commit.source.sourceId, [...replacedEntries.values()], -1);
    collectUsageBucketDeltas(bucketDeltas, commit.source.sourceId, entriesToCommit, 1);
    for (const update of crossUpdates) {
      const e = update.entry;
      const entries = new Map(nextEntries.get(update.known.sourceId));
      entries.set(e.requestId, cloneEntry(e)); nextEntries.set(update.known.sourceId, entries);
      collectUsageBucketDeltas(bucketDeltas, update.known.sourceId, [update.previous], -1);
      collectUsageBucketDeltas(bucketDeltas, update.known.sourceId, [e], 1);
      const original = nextSources.get(update.known.sourceId)!;
      if (original.checkpoint.resumeState) {
        const resume = JSON.parse(original.checkpoint.resumeState);
        const payload = reviseClaudePayload(resume.payload ?? {}, e.requestId, commit.batch.sessionProjection?.payload ?? {});
        if (payload) nextSources.set(update.known.sourceId, { ...original, checkpoint: { ...original.checkpoint, resumeState: JSON.stringify({ ...resume, payload }) } });
      }
      const hot = nextSessions.get(update.known.sourceId);
      if (hot) {
        const payload = reviseClaudePayload(hot.payload, e.requestId, commit.batch.sessionProjection?.payload ?? {});
        if (payload) nextSessions.set(update.known.sourceId, { ...hot, payload });
      }
    }
    const identityUpdates = new Map<string, UsageEntry>();
    for (const e of entriesToCommit) identityUpdates.set(commit.source.sourceId + '\0' + e.requestId, e);
    for (const update of crossUpdates) identityUpdates.set(update.known.sourceId + '\0' + update.entry.requestId, update.entry);
    for (const [key, known] of nextIdentities) {
      const e = identityUpdates.get(known.sourceId + '\0' + known.requestId);
      if (e) nextIdentities.set(key, { ...known, originId: e.identityOrigin ?? '', fingerprint: executionFingerprint(e) });
    }
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
      ...(commit.batch.providerMetadata || identityIssues.size || storedSource?.providerMetadata?.resolvedUsageScope ? { providerMetadata: {
        ...commit.batch.providerMetadata,
        ...(storedSource?.providerMetadata?.resolvedUsageScope ? { resolvedUsageScope: storedSource.providerMetadata.resolvedUsageScope } : {}),
        accountingIssues: [
          ...((commit.batch.providerMetadata?.accountingIssues as string[] | undefined) ?? []),
          ...identityIssues,
        ],
      } } : {}),
    });

    if (commit.batch.sessionProjection === null || (commit.mode === 'rebuild' && commit.batch.sessionProjection === undefined)) {
      nextSessions.delete(commit.source.sourceId);
    } else if (commit.batch.sessionProjection) {
      nextSessions.set(commit.source.sourceId, canonicalSessionProjection(commit.batch.sessionProjection, owner));
    }

    this.sources = nextSources;
    this.identities = nextIdentities;
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

  async queryEntryProjection(query: UsageEntryQuery): Promise<UsageEntryProjection> {
    this.assertOpen();
    const excludedProjects = new Set((query.excludedProjectKeys ?? []).map(key => key.toLowerCase()));
    const builder = new UsageEntryProjectionBuilder();
    for (const [sourceId, entries] of this.entries) {
      const source = this.sources.get(sourceId);
      if (!source) continue;
      for (const entry of entries.values()) {
        if (queryAccepts(query, source, entry, excludedProjects)) builder.add(entry);
      }
    }
    return builder.build();
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
    this.identities.clear();
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
