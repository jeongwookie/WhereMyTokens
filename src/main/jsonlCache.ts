/**
 * JSONL 요약 캐시
 * - 메모리 LRU + 영속 캐시
 * - 파일 stat(mtime/size) 일치 시 재파싱 없이 재사용
 */
import * as path from 'path';
import Store from 'electron-store';
import { FileUsageSummary } from './jsonlTypes';

interface PersistedSummaryStore {
  cache: Record<string, FileUsageSummary>;
}

export class JsonlCache {
  private readonly MAX_SIZE = 256;
  private readonly MEMORY_TTL_MS = 30 * 60 * 1000;
  private cache = new Map<string, FileUsageSummary>();
  private persistedStore: Store<PersistedSummaryStore>;

  constructor() {
    this.persistedStore = new Store<PersistedSummaryStore>({
      name: 'jsonl-summary-cache',
      defaults: { cache: {} },
    });
  }

  private getPersistedCache(): Record<string, FileUsageSummary> {
    return this.persistedStore.get('cache');
  }

  private setPersistedEntry(filePath: string, entry: FileUsageSummary): void {
    const key = this.persistKey(filePath);
    const current = this.getPersistedCache();
    this.persistedStore.set('cache', { ...current, [key]: entry });
  }

  private normalizePath(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  private persistKey(filePath: string): string {
    const normalized = this.normalizePath(filePath);
    return Buffer.from(normalized, 'utf8').toString('base64url');
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

    const persisted = this.getPersistedCache()[this.persistKey(filePath)] ?? null;
    if (!persisted) return null;
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
    this.setPersistedEntry(filePath, touched);
  }

  invalidate(filePath: string): void {
    this.cache.delete(this.normalizePath(filePath));
    const key = this.persistKey(filePath);
    const current = this.getPersistedCache();
    if (!(key in current)) return;
    delete current[key];
    this.persistedStore.set('cache', current);
  }

  clearMemory(): void {
    this.cache.clear();
  }

  clearAll(): void {
    this.cache.clear();
    this.persistedStore.set('cache', {});
  }

  get size(): number {
    this.prune();
    return this.cache.size;
  }
}
