/**
 * JSONL 요약 캐시
 * - 메모리 LRU + 영속 캐시
 * - 파일 stat(mtime/size) 일치 시 재파싱 없이 재사용
 */
import * as path from 'path';
import { createHash } from 'crypto';
import Store from 'electron-store';
import { FileUsageSummary, emptySessionSnapshot } from './jsonlTypes';

const PERSISTED_SCHEMA_VERSION = 2;

interface PersistedSummaryEntry {
  version: number;
  summary: FileUsageSummary;
}

interface PersistedSummaryStore {
  cache: Record<string, PersistedSummaryEntry>;
}

export class JsonlCache {
  private readonly MAX_SIZE = 256;
  private readonly MAX_PERSISTED_SIZE = 512;
  private readonly MEMORY_TTL_MS = 30 * 60 * 1000;
  private cache = new Map<string, FileUsageSummary>();
  private pendingPersisted = new Map<string, PersistedSummaryEntry | null>();
  private persistedStore: Store<PersistedSummaryStore>;

  constructor() {
    this.persistedStore = new Store<PersistedSummaryStore>({
      name: 'jsonl-summary-cache',
      defaults: { cache: {} },
    });
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private isNumberRecord(value: unknown): value is Record<string, number> {
    return this.isRecord(value) && Object.values(value).every(entry => typeof entry === 'number' && Number.isFinite(entry));
  }

  private isActivityBreakdown(value: unknown): boolean {
    if (!this.isRecord(value)) return false;
    const keys = ['read', 'editWrite', 'search', 'git', 'buildTest', 'terminal', 'thinking', 'response', 'subagents', 'web'] as const;
    return keys.every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));
  }

  private isCodexRateLimitWindow(value: unknown): boolean {
    return this.isRecord(value)
      && typeof value.pct === 'number'
      && Number.isFinite(value.pct)
      && typeof value.resetsAt === 'number'
      && Number.isFinite(value.resetsAt)
      && typeof value.observedAt === 'number'
      && Number.isFinite(value.observedAt);
  }

  private isSessionSnapshot(value: unknown): boolean {
    if (!this.isRecord(value)) return false;
    if (typeof value.modelName !== 'string') return false;
    if (typeof value.rawModel !== 'string') return false;
    if (typeof value.latestInputTokens !== 'number' || !Number.isFinite(value.latestInputTokens)) return false;
    if (typeof value.latestCacheCreationTokens !== 'number' || !Number.isFinite(value.latestCacheCreationTokens)) return false;
    if (typeof value.latestCacheReadTokens !== 'number' || !Number.isFinite(value.latestCacheReadTokens)) return false;
    if (value.contextMax != null && (typeof value.contextMax !== 'number' || !Number.isFinite(value.contextMax))) return false;
    if (!this.isNumberRecord(value.toolCounts)) return false;
    if (!this.isActivityBreakdown(value.activityBreakdown)) return false;
    if (value.activityBreakdownKind !== 'tokens' && value.activityBreakdownKind !== 'events') return false;
    if (value.codexRateLimits == null) return true;
    if (!this.isRecord(value.codexRateLimits)) return false;
    if (value.codexRateLimits.h5 != null && !this.isCodexRateLimitWindow(value.codexRateLimits.h5)) return false;
    if (value.codexRateLimits.week != null && !this.isCodexRateLimitWindow(value.codexRateLimits.week)) return false;
    return true;
  }

  private isRecentEntry(value: unknown): boolean {
    return this.isRecord(value)
      && typeof value.requestId === 'string'
      && typeof value.timestampMs === 'number'
      && Number.isFinite(value.timestampMs)
      && typeof value.model === 'string'
      && (value.provider === 'claude' || value.provider === 'codex' || value.provider === 'other')
      && typeof value.inputTokens === 'number'
      && Number.isFinite(value.inputTokens)
      && typeof value.outputTokens === 'number'
      && Number.isFinite(value.outputTokens)
      && typeof value.cacheCreationTokens === 'number'
      && Number.isFinite(value.cacheCreationTokens)
      && typeof value.cacheReadTokens === 'number'
      && Number.isFinite(value.cacheReadTokens)
      && typeof value.costUSD === 'number'
      && Number.isFinite(value.costUSD)
      && typeof value.cacheSavingsUSD === 'number'
      && Number.isFinite(value.cacheSavingsUSD);
  }

  private isHistoricalAggregate(value: unknown): boolean {
    if (!this.isRecord(value)) return false;
    const keys = ['requestCount', 'inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'totalTokens', 'costUSD', 'cacheSavingsUSD'] as const;
    return keys.every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));
  }

  private isHistoricalModelTotal(value: unknown): boolean {
    return this.isRecord(value)
      && typeof value.model === 'string'
      && (value.provider === 'claude' || value.provider === 'codex' || value.provider === 'other')
      && typeof value.tokens === 'number'
      && Number.isFinite(value.tokens)
      && typeof value.costUSD === 'number'
      && Number.isFinite(value.costUSD);
  }

  private isHistoricalBucket(value: unknown): boolean {
    return this.isRecord(value)
      && typeof value.timestampMs === 'number'
      && Number.isFinite(value.timestampMs)
      && this.isHistoricalAggregate(value);
  }

  private isHistoricalRollup(value: unknown): boolean {
    if (!this.isRecord(value)) return false;
    if (!this.isHistoricalAggregate(value.aggregate)) return false;
    if (!this.isRecord(value.modelTotals) || !this.isRecord(value.hourlyBuckets)) return false;
    return Object.values(value.modelTotals).every(entry => this.isHistoricalModelTotal(entry))
      && Object.values(value.hourlyBuckets).every(entry => this.isHistoricalBucket(entry));
  }

  private isRequestIndex(value: unknown): boolean {
    if (value == null) return true;
    if (!this.isRecord(value)) return false;
    return Object.values(value).every((entry) => {
      if (!this.isRecord(entry) || !this.isRecentEntry(entry)) return false;
      return entry.region === 'recent' || entry.region === 'historical';
    });
  }

  private hydratePersistedEntry(value: unknown): FileUsageSummary | null {
    if (!this.isRecord(value)) return null;
    if (value.version !== PERSISTED_SCHEMA_VERSION) return null;
    const summary = value.summary;
    if (!this.isRecord(summary)) return null;
    if (summary.provider !== 'claude' && summary.provider !== 'codex') return null;
    if (!this.isSessionSnapshot(summary.sessionSnapshot)) return null;
    if (!Array.isArray(summary.recentEntries) || !summary.recentEntries.every(entry => this.isRecentEntry(entry))) return null;
    if (!this.isHistoricalRollup(summary.historicalRollup)) return null;
    if (!this.isRequestIndex(summary.requestIndex)) return null;
    if (typeof summary.byteOffset !== 'number' || !Number.isFinite(summary.byteOffset)) return null;
    if (summary.pendingBytes != null && (typeof summary.pendingBytes !== 'number' || !Number.isFinite(summary.pendingBytes))) return null;
    if (typeof summary.mtimeMs !== 'number' || !Number.isFinite(summary.mtimeMs)) return null;
    if (typeof summary.size !== 'number' || !Number.isFinite(summary.size)) return null;
    if (typeof summary.lastAccessedAt !== 'number' || !Number.isFinite(summary.lastAccessedAt)) return null;
    return {
      ...summary,
      pendingText: undefined,
      pendingBytes: summary.pendingBytes ?? 0,
      rehydratedFromPersistence: true,
    } as FileUsageSummary;
  }

  private getPersistedCache(): Record<string, PersistedSummaryEntry> {
    const cache = this.persistedStore.get('cache') as unknown;
    return this.isRecord(cache) ? cache as Record<string, PersistedSummaryEntry> : {};
  }

  private toPersistedEntry(entry: FileUsageSummary): PersistedSummaryEntry {
    const sessionSnapshot = emptySessionSnapshot(entry.sessionSnapshot.activityBreakdownKind);
    sessionSnapshot.modelName = entry.sessionSnapshot.modelName;
    sessionSnapshot.rawModel = entry.sessionSnapshot.modelName || entry.sessionSnapshot.rawModel;
    sessionSnapshot.latestInputTokens = entry.sessionSnapshot.latestInputTokens;
    sessionSnapshot.latestCacheCreationTokens = entry.sessionSnapshot.latestCacheCreationTokens;
    sessionSnapshot.latestCacheReadTokens = entry.sessionSnapshot.latestCacheReadTokens;
    if (entry.sessionSnapshot.contextMax != null) sessionSnapshot.contextMax = entry.sessionSnapshot.contextMax;

    return {
      version: PERSISTED_SCHEMA_VERSION,
      summary: {
        ...entry,
        sessionSnapshot,
        recentEntries: entry.recentEntries.map(recentEntry => ({
          ...recentEntry,
          requestId: createHash('sha256').update(recentEntry.requestId).digest('base64url').slice(0, 16),
        })),
        requestIndex: undefined,
        pendingText: undefined,
        pendingBytes: entry.pendingBytes ?? 0,
        rehydratedFromPersistence: undefined,
      },
    };
  }

  private prunePersisted(current: Record<string, PersistedSummaryEntry>): Record<string, PersistedSummaryEntry> {
    const entries = Object.entries(current);
    if (entries.length <= this.MAX_PERSISTED_SIZE) return current;
    entries.sort((a, b) => {
      const aTs = this.hydratePersistedEntry(a[1])?.lastAccessedAt ?? 0;
      const bTs = this.hydratePersistedEntry(b[1])?.lastAccessedAt ?? 0;
      return bTs - aTs;
    });
    return Object.fromEntries(entries.slice(0, this.MAX_PERSISTED_SIZE));
  }

  private queuePersistedEntry(filePath: string, entry: FileUsageSummary): void {
    this.pendingPersisted.set(this.persistKey(filePath), this.toPersistedEntry(entry));
  }

  flushPersisted(): void {
    if (this.pendingPersisted.size === 0) return;
    const current = this.getPersistedCache();
    for (const [key, value] of this.pendingPersisted.entries()) {
      if (value) current[key] = value;
      else delete current[key];
    }
    this.pendingPersisted.clear();
    this.persistedStore.set('cache', this.prunePersisted(current));
  }

  private normalizePath(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  private persistKey(filePath: string): string {
    const normalized = this.normalizePath(filePath);
    return createHash('sha256').update(normalized).digest('base64url');
  }

  private touch(entry: FileUsageSummary, now = Date.now()): FileUsageSummary {
    return { ...entry, lastAccessedAt: now };
  }

  private prune(now = Date.now()): void {
    for (const [filePath, entry] of this.cache) {
      if (now - (entry.lastAccessedAt ?? 0) > this.MEMORY_TTL_MS) {
        this.cache.delete(filePath);
      }
    }

    while (this.cache.size > this.MAX_SIZE) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  get(filePath: string): FileUsageSummary | null {
    const key = this.normalizePath(filePath);
    const now = Date.now();
    this.prune(now);
    const memory = this.cache.get(key);
    if (memory) {
      const touched = this.touch(memory, now);
      this.cache.set(key, touched);
      return touched;
    }

    const persistKey = this.persistKey(filePath);
    const persistedCache = this.getPersistedCache();
    const persisted = this.hydratePersistedEntry(persistedCache[persistKey] ?? null);
    if (!persisted) {
      if (persistKey in persistedCache) {
        delete persistedCache[persistKey];
        this.persistedStore.set('cache', persistedCache);
      }
      return null;
    }
    const touched = this.touch(persisted, now);
    this.cache.set(key, touched);
    this.prune(now);
    return touched;
  }

  getFresh(filePath: string, mtimeMs: number, size: number): FileUsageSummary | null {
    const cached = this.get(filePath);
    if (!cached) return null;
    return cached.mtimeMs === mtimeMs && cached.size === size ? cached : null;
  }

  set(filePath: string, entry: FileUsageSummary): void {
    const key = this.normalizePath(filePath);
    const touched = this.touch(entry);
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, touched);
    this.prune();
    this.queuePersistedEntry(filePath, touched);
  }

  invalidate(filePath: string): void {
    this.cache.delete(this.normalizePath(filePath));
    this.pendingPersisted.set(this.persistKey(filePath), null);
  }

  clearMemory(): void {
    this.cache.clear();
  }

  clearAll(): void {
    this.cache.clear();
    this.pendingPersisted.clear();
    this.persistedStore.set('cache', {});
  }

  get size(): number {
    this.prune();
    return this.cache.size;
  }
}
