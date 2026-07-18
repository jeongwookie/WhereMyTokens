import type {
  StoredUsageSource,
  UsageBreakdownQuery,
  UsageBreakdownResult,
  UsageEntry,
  UsageEntryQuery,
  UsageEntryProjection,
  UsageIndex,
  UsageIndexCoverage,
  UsageIndexHealth,
  UsageIndexStorage,
  UsageQuery,
  UsageQueryResult,
  UsageScanMode,
  UsageSessionProjection,
  UsageSourceBatch,
  UsageSourceDescriptor,
  UsageSourceRefreshResult,
  UsageSourceScanner,
} from './types';
import type { ProviderId } from '../providers/types';

type CoverageSourceStatus = 'queued' | 'scanning' | 'indexed' | 'failed';

interface ProviderCoverageState {
  discoveryComplete: boolean;
  sources: Map<string, CoverageSourceStatus>;
}

export const USAGE_COMPACTION_INTERVAL_MS = 60 * 60 * 1000;

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function assertDescriptor(source: UsageSourceDescriptor): void {
  if (!source.sourceId.trim()) throw new Error('Usage sourceId must not be empty');
  if (!source.version.token.trim()) throw new Error(`Usage source ${source.sourceId} has an empty version token`);
  if (!Number.isInteger(source.parserVersion) || source.parserVersion < 1) {
    throw new Error(`Usage source ${source.sourceId} has invalid parserVersion ${source.parserVersion}`);
  }
  if (source.version.size !== undefined && !finiteNonNegative(source.version.size)) {
    throw new Error(`Usage source ${source.sourceId} has invalid size ${source.version.size}`);
  }
  if (source.version.mtimeMs !== undefined && !finiteNonNegative(source.version.mtimeMs)) {
    throw new Error(`Usage source ${source.sourceId} has invalid mtimeMs ${source.version.mtimeMs}`);
  }
  if (source.projectKeys?.some(key => typeof key !== 'string')) {
    throw new Error(`Usage source ${source.sourceId} has invalid project attribution`);
  }
}

function normalizeProjectKeys(projectKeys: readonly string[]): string[] {
  return [...new Set(projectKeys.map(key => key.trim().toLowerCase()).filter(Boolean))].sort();
}

function normalizeQuery<T extends UsageEntryQuery>(query: T): T {
  if (!query.excludedProjectKeys) return query;
  return {
    ...query,
    excludedProjectKeys: normalizeProjectKeys(query.excludedProjectKeys),
  };
}

function normalizeDescriptor(source: UsageSourceDescriptor): UsageSourceDescriptor {
  return {
    ...source,
    ...(source.projectKeys === undefined ? {} : { projectKeys: normalizeProjectKeys(source.projectKeys) }),
    version: { ...source.version },
  };
}

function assertMetric(value: number, field: string, sourceId: string, requestId: string): void {
  if (!finiteNonNegative(value)) {
    throw new Error(`Usage source ${sourceId} request ${requestId} has invalid ${field}`);
  }
}

function assertEntry(source: UsageSourceDescriptor, entry: UsageEntry): void {
  if (entry.provider !== source.provider) {
    throw new Error(
      `Usage source ${source.sourceId} returned provider ${entry.provider}; expected ${source.provider}`,
    );
  }
  if (!entry.requestId.trim()) throw new Error(`Usage source ${source.sourceId} returned an empty requestId`);
  if (!entry.model.trim()) throw new Error(`Usage source ${source.sourceId} request ${entry.requestId} has an empty model`);
  if (!finiteNonNegative(entry.timestampMs)) {
    throw new Error(`Usage source ${source.sourceId} request ${entry.requestId} has invalid timestampMs`);
  }
  assertMetric(entry.inputTokens, 'inputTokens', source.sourceId, entry.requestId);
  assertMetric(entry.outputTokens, 'outputTokens', source.sourceId, entry.requestId);
  assertMetric(entry.cacheCreationTokens, 'cacheCreationTokens', source.sourceId, entry.requestId);
  assertMetric(entry.cacheReadTokens, 'cacheReadTokens', source.sourceId, entry.requestId);
  assertMetric(entry.costUSD, 'costUSD', source.sourceId, entry.requestId);
  assertMetric(entry.cacheSavingsUSD, 'cacheSavingsUSD', source.sourceId, entry.requestId);
  if (entry.breakdown) {
    for (const [key, value] of Object.entries(entry.breakdown)) {
      assertMetric(value, `breakdown.${key}`, source.sourceId, entry.requestId);
    }
  }
}

function assertBatch(
  source: UsageSourceDescriptor,
  stored: StoredUsageSource | null,
  mode: UsageScanMode,
  batch: UsageSourceBatch,
): void {
  const coverage = batch.rebuildCoverage;
  if (batch.projectKeys?.some(key => typeof key !== 'string')) {
    throw new Error(`Usage source ${source.sourceId} returned invalid project attribution`);
  }
  if (mode === 'rebuild' && !coverage) {
    throw new Error(`Usage source ${source.sourceId} rebuild did not declare reconstructible coverage`);
  }
  if (coverage?.kind === 'range') {
    if (!finiteNonNegative(coverage.fromMs)
      || !finiteNonNegative(coverage.toMs)
      || coverage.toMs <= coverage.fromMs) {
      throw new Error(`Usage source ${source.sourceId} returned invalid rebuild coverage`);
    }
  }

  const requestIds = new Set<string>();
  for (const entry of batch.entries) {
    assertEntry(source, entry);
    if (coverage?.kind === 'none') {
      throw new Error(`Usage source ${source.sourceId} returned entries with empty rebuild coverage`);
    }
    if (coverage?.kind === 'range'
      && (entry.timestampMs < coverage.fromMs || entry.timestampMs >= coverage.toMs)) {
      throw new Error(`Usage source ${source.sourceId} returned an entry outside rebuild coverage`);
    }
    if (requestIds.has(entry.requestId)) {
      throw new Error(`Usage source ${source.sourceId} returned duplicate requestId ${entry.requestId}`);
    }
    requestIds.add(entry.requestId);
  }

  if (source.kind === 'file') {
    const byteOffset = batch.checkpoint.byteOffset;
    if (byteOffset === undefined || !finiteNonNegative(byteOffset)) {
      throw new Error(`File usage source ${source.sourceId} returned an invalid byteOffset`);
    }
    const previousOffset = stored?.checkpoint.byteOffset;
    if (mode === 'tail' && previousOffset !== undefined && byteOffset < previousOffset) {
      throw new Error(`File usage source ${source.sourceId} moved its tail checkpoint backwards`);
    }
  }

  const projection = batch.sessionProjection;
  if (projection) {
    if (projection.sourceId !== source.sourceId || projection.provider !== source.provider) {
      throw new Error(`Usage source ${source.sourceId} returned a session projection for another source`);
    }
    if (!finiteNonNegative(projection.updatedAt) || !finiteNonNegative(projection.byteSize)) {
      throw new Error(`Usage source ${source.sourceId} returned invalid session projection metadata`);
    }
  }
}

function sameVersion(stored: StoredUsageSource, source: UsageSourceDescriptor): boolean {
  return stored.descriptor.provider === source.provider
    && stored.descriptor.kind === source.kind
    && stored.descriptor.parserVersion === source.parserVersion
    && stored.descriptor.version.token === source.version.token;
}

function sameProjects(stored: StoredUsageSource, source: UsageSourceDescriptor): boolean {
  const current = source.projectKeys;
  if (current === undefined) return true;
  const previous = stored.descriptor.projectKeys ?? [];
  return previous.length === current.length
    && previous.every((key, index) => key === current[index]);
}

function appendOnlyFileAlreadyIndexed(stored: StoredUsageSource, source: UsageSourceDescriptor): boolean {
  if (source.kind !== 'file' || stored.descriptor.kind !== 'file') return false;
  if (stored.descriptor.parserVersion !== source.parserVersion) return false;
  const previousSize = stored.descriptor.version.size;
  const currentSize = source.version.size;
  const previousOffset = stored.checkpoint.byteOffset;
  return previousSize !== undefined
    && currentSize !== undefined
    && previousOffset !== undefined
    && currentSize === previousSize
    && previousOffset === currentSize;
}

function selectScanMode(stored: StoredUsageSource | null, source: UsageSourceDescriptor): UsageScanMode {
  if (!stored) return 'rebuild';
  if (stored.descriptor.parserVersion !== source.parserVersion) return 'rebuild';

  if (source.kind === 'remote') return stored.checkpoint.cursor ? 'tail' : 'rebuild';

  const previousSize = stored.descriptor.version.size;
  const currentSize = source.version.size;
  const previousOffset = stored.checkpoint.byteOffset;
  if (previousSize === undefined || currentSize === undefined || previousOffset === undefined) return 'rebuild';
  return currentSize > previousSize && currentSize >= previousOffset ? 'tail' : 'rebuild';
}

export class DefaultUsageIndex implements UsageIndex {
  private closed = false;
  private resetEpoch = 0;
  private lastCompactionAtMs: number | null = null;
  private compactionPromise: Promise<void> | null = null;
  private readonly coverageByProvider = new Map<ProviderId, ProviderCoverageState>();

  constructor(
    private readonly storage: UsageIndexStorage,
    private readonly now: () => number = Date.now,
  ) {}

  getHealth(): UsageIndexHealth {
    return { state: 'ready' };
  }

  declareSources(
    provider: ProviderId,
    sources: readonly UsageSourceDescriptor[],
    discoveryComplete: boolean,
  ): void {
    this.assertOpen();
    const required = new Map<string, CoverageSourceStatus>();
    for (const source of sources) {
      const normalized = normalizeDescriptor(source);
      assertDescriptor(normalized);
      if (normalized.provider !== provider) {
        throw new Error(`Usage source ${normalized.sourceId} belongs to ${normalized.provider}, not ${provider}`);
      }
      if (required.has(normalized.sourceId)) {
        throw new Error(`Usage source ${normalized.sourceId} was declared more than once`);
      }
      required.set(normalized.sourceId, 'queued');
    }
    this.coverageByProvider.set(provider, { discoveryComplete, sources: required });
  }

  async refreshSource(
    source: UsageSourceDescriptor,
    scanner: UsageSourceScanner,
  ): Promise<UsageSourceRefreshResult> {
    this.assertOpen();
    const refreshEpoch = this.resetEpoch;
    const normalizedSource = normalizeDescriptor(source);
    assertDescriptor(normalizedSource);
    this.markCoverageSource(normalizedSource, 'scanning');
    try {
      const stored = await this.storage.getSource(normalizedSource.sourceId);
      this.assertRefreshCurrent(refreshEpoch);
      if (stored && (stored.descriptor.provider !== normalizedSource.provider || stored.descriptor.kind !== normalizedSource.kind)) {
        throw new Error(`Usage source ${normalizedSource.sourceId} changed provider or source kind`);
      }
      if (stored && appendOnlyFileAlreadyIndexed(stored, normalizedSource)) {
        if (!sameVersion(stored, normalizedSource) || !sameProjects(stored, normalizedSource)) {
          await this.storage.updateSourceDescriptor({
            ...normalizedSource,
            projectKeys: normalizeProjectKeys(
              normalizedSource.projectKeys
                ?? stored.descriptor.projectKeys
                ?? [],
            ),
          });
          this.assertRefreshCurrent(refreshEpoch);
        }
        this.markCoverageSource(normalizedSource, 'indexed');
        return { sourceId: normalizedSource.sourceId, status: 'unchanged', scannedEntries: 0 };
      }
      if (stored && sameVersion(stored, normalizedSource)) {
        if (!sameProjects(stored, normalizedSource)) {
          await this.storage.updateSourceDescriptor(normalizedSource);
          this.assertRefreshCurrent(refreshEpoch);
        }
        this.markCoverageSource(normalizedSource, 'indexed');
        return { sourceId: normalizedSource.sourceId, status: 'unchanged', scannedEntries: 0 };
      }

      const mode = selectScanMode(stored, normalizedSource);
      const batch = await scanner.scan({
        mode,
        source: normalizedSource,
        checkpoint: mode === 'tail' ? stored?.checkpoint ?? null : null,
        previousSessionProjection: mode === 'tail' ? stored?.sessionProjection ?? null : null,
      });
      this.assertRefreshCurrent(refreshEpoch);
      assertBatch(normalizedSource, stored, mode, batch);
      const committedSource: UsageSourceDescriptor = {
        ...normalizedSource,
        projectKeys: normalizeProjectKeys(
          batch.projectKeys
            ?? normalizedSource.projectKeys
            ?? stored?.descriptor.projectKeys
            ?? [],
        ),
      };
      await this.storage.commitSource({ mode, source: committedSource, batch });
      this.assertRefreshCurrent(refreshEpoch);
      this.markCoverageSource(normalizedSource, 'indexed');
      return {
        sourceId: normalizedSource.sourceId,
        status: mode === 'tail' ? 'tailed' : 'rebuilt',
        scannedEntries: batch.entries.length,
      };
    } catch (error) {
      if (refreshEpoch === this.resetEpoch) this.markCoverageSource(normalizedSource, 'failed');
      throw error;
    }
  }

  async queryUsage(request: UsageQuery): Promise<UsageQueryResult> {
    this.assertOpen();
    await this.compactCommittedUsage();
    const result = await this.storage.queryUsage(normalizeQuery(request));
    return { ...result, coverage: this.coverageFor(request.providers) };
  }

  async queryBreakdown(request: UsageBreakdownQuery): Promise<UsageBreakdownResult> {
    this.assertOpen();
    await this.compactCommittedUsage();
    const result = await this.storage.queryBreakdown(normalizeQuery(request));
    return { ...result, coverage: this.coverageFor(request.providers) };
  }

  async readProjectionEntries(request: UsageEntryQuery): Promise<UsageEntry[]> {
    this.assertOpen();
    await this.compactCommittedUsage();
    return this.storage.queryEntries(normalizeQuery(request));
  }

  async readProjectionEntryData(request: UsageEntryQuery): Promise<UsageEntryProjection> {
    this.assertOpen();
    await this.compactCommittedUsage();
    return this.storage.queryEntryProjection(normalizeQuery(request));
  }

  readSessionProjections(sourceIds?: readonly string[]): Promise<UsageSessionProjection[]> {
    this.assertOpen();
    return this.storage.readSessionProjections(sourceIds);
  }

  async reset(): Promise<void> {
    this.assertOpen();
    this.resetEpoch += 1;
    await this.storage.reset();
    this.lastCompactionAtMs = null;
    this.coverageByProvider.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.storage.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('UsageIndex is closed');
  }

  private assertRefreshCurrent(refreshEpoch: number): void {
    if (refreshEpoch !== this.resetEpoch) {
      throw new Error('Usage source refresh was invalidated by UsageIndex reset');
    }
  }

  private async compactCommittedUsage(): Promise<void> {
    const nowMs = this.now();
    if (!this.compactionPromise
      && this.lastCompactionAtMs !== null
      && nowMs - this.lastCompactionAtMs < USAGE_COMPACTION_INTERVAL_MS) return;
    if (!this.compactionPromise) {
      this.compactionPromise = this.storage.compact(nowMs)
        .then(() => {
          this.lastCompactionAtMs = nowMs;
        })
        .finally(() => {
          this.compactionPromise = null;
        });
    }
    await this.compactionPromise;
  }

  private markCoverageSource(source: UsageSourceDescriptor, status: CoverageSourceStatus): void {
    const coverage = this.coverageByProvider.get(source.provider) ?? {
      discoveryComplete: false,
      sources: new Map<string, CoverageSourceStatus>(),
    };
    coverage.sources.set(source.sourceId, status);
    this.coverageByProvider.set(source.provider, coverage);
  }

  private coverageFor(providers: ReadonlySet<ProviderId> | undefined): UsageIndexCoverage {
    const selectedProviders = providers ? [...providers] : [...this.coverageByProvider.keys()];
    let requiredSourceCount = 0;
    let indexedSourceCount = 0;
    let pendingSourceCount = 0;
    let failedSourceCount = 0;
    let discoveryComplete = selectedProviders.length > 0;
    for (const provider of selectedProviders) {
      const coverage = this.coverageByProvider.get(provider);
      if (!coverage) {
        discoveryComplete = false;
        continue;
      }
      discoveryComplete = discoveryComplete && coverage.discoveryComplete;
      for (const status of coverage.sources.values()) {
        requiredSourceCount += 1;
        if (status === 'indexed') indexedSourceCount += 1;
        else if (status === 'failed') failedSourceCount += 1;
        else pendingSourceCount += 1;
      }
    }
    return {
      state: discoveryComplete && pendingSourceCount === 0 && failedSourceCount === 0 ? 'complete' : 'incomplete',
      requiredSourceCount,
      indexedSourceCount,
      pendingSourceCount,
      failedSourceCount,
    };
  }
}
