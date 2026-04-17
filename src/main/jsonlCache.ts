/**
 * JSONL 파일 파싱 결과 캐시 — mtime 기반 캐시 히트 + 증분 파싱 지원
 */
import { ParsedFile } from './jsonlParser';

export interface CacheEntry {
  mtimeMs: number;       // 마지막 확인된 mtime
  fileSize: number;      // 마지막 확인된 파일 크기 (바이트)
  byteOffset: number;    // 마지막으로 파싱 완료한 바이트 위치
  parsed: ParsedFile;
  // requestId → entries 배열 인덱스 (증분 파싱 시 dedup 유지)
  seenMap: Map<string, number>;
}

export class JsonlCache {
  private cache = new Map<string, CacheEntry>();

  get(filePath: string): CacheEntry | null {
    return this.cache.get(filePath) ?? null;
  }

  set(filePath: string, entry: CacheEntry): void {
    this.cache.set(filePath, entry);
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
