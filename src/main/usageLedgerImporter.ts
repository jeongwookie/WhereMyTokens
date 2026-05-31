import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  SourceCheckpoint,
  UsageAggregate,
  UsageLedgerSnapshot,
} from './usageLedgerTypes';
import {
  aggregateFromUsageEntry,
  cloneUsageLedgerSnapshot,
  importUsageEntriesIntoSnapshot,
} from './usageLedgerIngest';
import { CompactRecentEntry } from './jsonlTypes';
import { extractClaudeUsageLine, extractCodexUsageLine } from './jsonlUsageExtractor';
import { readCodexSessionHeader } from './sessionMetadata';

type ImportProvider = 'claude' | 'codex';

interface SourceEntry {
  entry: CompactRecentEntry & { provider: ImportProvider };
  aggregate: UsageAggregate;
}

interface SourceScanResult {
  entries: SourceEntry[];
  byteOffset: number;
  rawModel?: string;
}

export function normalizedSourcePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function sourceIdentityForPath(filePath: string, provider: ImportProvider): string {
  if (provider === 'codex') {
    const header = readCodexSessionHeader(filePath);
    const headerId = typeof header?.payload.id === 'string' && header.payload.id.trim()
      ? header.payload.id.trim()
      : '';
    const fallbackId = path.basename(filePath, '.jsonl').trim();
    return `codex:${headerId || fallbackId || normalizedSourcePath(filePath)}`;
  }
  return `claude:${normalizedSourcePath(filePath)}`;
}

export function sourceHashForIdentity(identity: string): string {
  return crypto.createHash('sha256').update(identity).digest('base64url');
}

export function sourceHashForPath(filePath: string, provider: ImportProvider = 'claude'): string {
  return sourceHashForIdentity(sourceIdentityForPath(filePath, provider));
}

async function scanJsonlLines(filePath: string, onLine: (line: string) => void, startOffset = 0): Promise<number> {
  const stream = fs.createReadStream(filePath, { start: startOffset });
  let buffer = Buffer.alloc(0);
  let consumedBytes = 0;
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = Buffer.concat([buffer, chunkBuffer]);
      while (true) {
        const newlineIndex = buffer.indexOf(0x0a);
        if (newlineIndex < 0) break;
        let lineBuffer = buffer.subarray(0, newlineIndex);
        buffer = buffer.subarray(newlineIndex + 1);
        consumedBytes += newlineIndex + 1;
        if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d) {
          lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
        }
        const line = lineBuffer.toString('utf8');
        if (line.trim()) onLine(line);
      }
    });
    stream.on('error', reject);
    stream.on('end', () => {
      let trailingBuffer = buffer;
      if (trailingBuffer.length > 0 && trailingBuffer[trailingBuffer.length - 1] === 0x0d) {
        trailingBuffer = trailingBuffer.subarray(0, trailingBuffer.length - 1);
      }
      const trailing = trailingBuffer.toString('utf8');
      if (trailing.trim()) {
        try {
          JSON.parse(trailing);
          onLine(trailing);
          consumedBytes += buffer.length;
        } catch {
          // Keep partial trailing JSONL out of the ledger until the next append completes it.
        }
      }
      resolve();
    });
  });
  return startOffset + consumedBytes;
}

async function collectSourceEntries(
  filePath: string,
  provider: ImportProvider,
  nowMs: number,
  startOffset = 0,
  fallbackRawModel = '',
  sourceIdentity = normalizedSourcePath(filePath),
): Promise<SourceScanResult> {
  if (provider === 'claude') {
    const byRequest = new Map<string, SourceEntry>();
    const byteOffset = await scanJsonlLines(filePath, (line) => {
      const extracted = extractClaudeUsageLine(line, nowMs);
      if (!extracted || extracted.entry.provider !== 'claude') return;
      const entry = extracted.entry as CompactRecentEntry & { provider: 'claude' };
      const current = byRequest.get(entry.requestId);
      if (current && current.entry.outputTokens >= entry.outputTokens) return;
      byRequest.set(entry.requestId, {
        entry,
        aggregate: aggregateFromUsageEntry(entry),
      });
    }, startOffset);
    return { entries: [...byRequest.values()], byteOffset };
  }

  const entries: SourceEntry[] = [];
  let rawModel = fallbackRawModel;
  const byteOffset = await scanJsonlLines(filePath, (line) => {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (payload && (obj.type === 'session_meta' || obj.type === 'turn_context' || (obj.type === 'event_msg' && payload.type === 'task_started'))) {
      const model = [
        payload.model,
        payload.model_name,
        payload.model_slug,
        payload.model_id,
        payload.requested_model,
        payload.default_model,
      ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (model) rawModel = model;
    }

    const extracted = extractCodexUsageLine(sourceIdentity, line, nowMs, rawModel);
    if (!extracted || extracted.entry.provider !== 'codex') return;
    if (!rawModel) rawModel = extracted.rawModel;
    const entry = extracted.entry as CompactRecentEntry & { provider: 'codex' };
    entries.push({ entry, aggregate: aggregateFromUsageEntry(entry) });
  }, startOffset);
  return { entries, byteOffset, rawModel };
}

function markNeedsRebuild(checkpoint: SourceCheckpoint, nowMs: number, reason: string): SourceCheckpoint {
  return {
    ...checkpoint,
    needsRebuild: true,
    rebuildReason: reason,
    lastImportedAt: nowMs,
  };
}

function unchangedCheckpoint(checkpoint: SourceCheckpoint | undefined, stat: fs.Stats): boolean {
  return !!checkpoint && checkpoint.size === stat.size && checkpoint.mtimeMs === stat.mtimeMs;
}

export async function importUsageJsonlIntoSnapshot(
  snapshot: UsageLedgerSnapshot,
  filePath: string,
  provider: ImportProvider,
  nowMs = Date.now(),
): Promise<UsageLedgerSnapshot> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return snapshot;
  }

  const sourceIdentity = sourceIdentityForPath(filePath, provider);
  const sourceHash = sourceHashForIdentity(sourceIdentity);
  const currentCheckpoint = snapshot.sourceCheckpoints[sourceHash];
  if (unchangedCheckpoint(currentCheckpoint, stat)) return snapshot;

  if (currentCheckpoint?.needsRebuild) return cloneUsageLedgerSnapshot(snapshot);
  const startOffset = currentCheckpoint?.byteOffset ?? 0;
  if (currentCheckpoint && stat.size < startOffset) {
    const next = cloneUsageLedgerSnapshot(snapshot);
    next.sourceCheckpoints[sourceHash] = markNeedsRebuild(currentCheckpoint, nowMs, 'source shrank before checkpoint offset');
    return next;
  }

  const { entries, byteOffset, rawModel } = await collectSourceEntries(
    filePath,
    provider,
    nowMs,
    startOffset,
    currentCheckpoint?.rawModel ?? '',
    sourceIdentity,
  );
  return importUsageEntriesIntoSnapshot(snapshot, {
    provider,
    sourceHash,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    byteOffset,
    ...(rawModel ? { rawModel } : {}),
  }, entries, nowMs);
}
