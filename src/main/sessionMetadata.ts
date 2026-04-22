import * as fs from 'fs';
import * as path from 'path';
import { isSafeLocalCwd } from './pathSafety';

export type JsonlProvider = 'claude' | 'codex';

export interface CodexSessionHeader {
  payload: Record<string, unknown>;
  timestamp: string | null;
}

export const CODEX_HEADER_READ_BYTES = 512 * 1024;

const CLAUDE_CWD_READ_BYTES = 64 * 1024;
const CLAUDE_CWD_MAX_LINES = 64;

interface FileCacheEntry<T> {
  mtimeMs: number;
  size: number;
  value: T;
}

interface MetadataReadResult<T> {
  ok: boolean;
  value: T;
}

export interface SessionMetadataCacheStats {
  bodyReads: number;
  cacheHits: number;
  cacheMisses: number;
}

const MAX_CACHE_SIZE = 2000;
const codexHeaderCache = new Map<string, FileCacheEntry<CodexSessionHeader | null>>();
const cwdCache = new Map<string, FileCacheEntry<string | null>>();
const cacheStats: SessionMetadataCacheStats = { bodyReads: 0, cacheHits: 0, cacheMisses: 0 };

function normalizedCacheKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function cacheKey(filePath: string, scope: string): string {
  return `${scope}:${normalizedCacheKey(filePath)}`;
}

function getCached<T>(cache: Map<string, FileCacheEntry<T>>, key: string, stat: fs.Stats): T | undefined {
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    cacheStats.cacheHits += 1;
    return cached.value;
  }
  cacheStats.cacheMisses += 1;
  return undefined;
}

function setCached<T>(cache: Map<string, FileCacheEntry<T>>, key: string, stat: fs.Stats, value: T): T {
  if (cache.has(key)) {
    cache.delete(key);
  } else {
    while (cache.size >= MAX_CACHE_SIZE) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
    }
  }
  cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

function readFilePrefix(filePath: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    cacheStats.bodyReads += 1;
    return buf.subarray(0, bytesRead).toString('utf-8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* skip */ }
    }
  }
}

function safeCwd(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return isSafeLocalCwd(value) ? value : null;
}

export function readCodexSessionHeader(filePath: string): CodexSessionHeader | null {
  return readCodexSessionHeaderResult(filePath).value;
}

function readCodexSessionHeaderResult(filePath: string): MetadataReadResult<CodexSessionHeader | null> {
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); }
  catch { return { ok: false, value: null }; }

  const key = cacheKey(filePath, 'codex-header');
  const cached = getCached(codexHeaderCache, key, stat);
  if (cached !== undefined) return { ok: true, value: cached };

  const text = readFilePrefix(filePath, CODEX_HEADER_READ_BYTES);
  if (text === null) return { ok: false, value: null };
  let fallback: CodexSessionHeader | null = null;
  let sessionMetaWithoutCwd: CodexSessionHeader | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const payload = obj.payload as Record<string, unknown> | undefined;
      if (!payload) continue;
      const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : null;
      if (obj.type === 'session_meta') {
        const header = { payload, timestamp };
        if (safeCwd(payload.cwd)) {
          return { ok: true, value: setCached(codexHeaderCache, key, stat, header) };
        }
        sessionMetaWithoutCwd = header;
        continue;
      }
      if (!fallback && obj.type === 'turn_context' && safeCwd(payload.cwd)) {
        fallback = { payload, timestamp };
      }
    } catch {
      continue;
    }
  }

  return { ok: true, value: setCached(codexHeaderCache, key, stat, fallback ?? sessionMetaWithoutCwd) };
}

export function readJsonlCwd(filePath: string, provider: JsonlProvider): string | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); }
  catch { return null; }

  const key = cacheKey(filePath, `cwd-${provider}`);
  const cached = getCached(cwdCache, key, stat);
  if (cached !== undefined) return cached;

  if (provider === 'codex') {
    const headerResult = readCodexSessionHeaderResult(filePath);
    if (!headerResult.ok) return null;
    const cwd = safeCwd(headerResult.value?.payload.cwd);
    return setCached(cwdCache, key, stat, cwd);
  }

  const text = readFilePrefix(filePath, CLAUDE_CWD_READ_BYTES);
  if (text === null) return null;
  for (const line of text.split('\n').slice(0, CLAUDE_CWD_MAX_LINES)) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line) as Record<string, unknown>;
      const cwd = safeCwd(data.cwd);
      if (cwd) return setCached(cwdCache, key, stat, cwd);
    } catch {
      continue;
    }
  }

  return setCached(cwdCache, key, stat, null);
}

export function invalidateSessionMetadataCache(filePath: string): void {
  codexHeaderCache.delete(cacheKey(filePath, 'codex-header'));
  cwdCache.delete(cacheKey(filePath, 'cwd-codex'));
  cwdCache.delete(cacheKey(filePath, 'cwd-claude'));
}

export function clearSessionMetadataCache(): void {
  codexHeaderCache.clear();
  cwdCache.clear();
  cacheStats.bodyReads = 0;
  cacheStats.cacheHits = 0;
  cacheStats.cacheMisses = 0;
}

export function getSessionMetadataCacheStats(): SessionMetadataCacheStats {
  return { ...cacheStats };
}
