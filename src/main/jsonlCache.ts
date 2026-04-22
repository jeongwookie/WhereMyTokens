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
  private readonly MAX_SIZE = 2000;
  private cache = new Map<string, CacheEntry>();

  get(filePath: string): CacheEntry | null {
    return this.cache.get(filePath) ?? null;
  }

  set(filePath: string, entry: CacheEntry): void {
    // LRU: 기존 항목이면 삭제 후 재삽입하여 최신으로 올림
    if (this.cache.has(filePath)) {
      this.cache.delete(filePath);
    } else {
      // 새 항목 추가 전 용량 초과 시 가장 오래된 항목 제거
      while (this.cache.size >= this.MAX_SIZE) {
        const oldest = this.cache.keys().next().value as string;
        this.cache.delete(oldest);
      }
    }
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
