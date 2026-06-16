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
  type UsageLedgerIngestUsageEntry,
} from './usageLedgerIngest';
import { CompactRecentEntry } from './jsonlTypes';
import { localDateKey } from './usageLedgerAggregates';
import { claudeLedgerBreakdown, codexFunctionCallCategory } from './activityClassifier';
import { extractClaudeUsageLine, extractCodexUsageLine } from './jsonlUsageExtractor';
import { compositionToDelta, splitOutput } from './outputSplitter';
import { readCodexSessionHeader } from './sessionMetadata';
import {
  emptyToolActivity,
  emptyToolOutput,
  TOOL_ACTIVITY_KEYS,
  type ToolActivity,
  type ToolCategory,
} from '../shared/breakdownTypes';

type ImportProvider = 'claude' | 'codex';

interface SourceEntry {
  entry: UsageLedgerIngestUsageEntry & { provider: ImportProvider };
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

async function scanJsonlLines(filePath: string, onLine: (line: string, offsetAfterLine: number) => void, startOffset = 0): Promise<number> {
  const stream = fs.createReadStream(filePath, { start: startOffset });
  let buffer = Buffer.alloc(0);
  let consumedBytes = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      try {
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
          if (line.trim()) onLine(line, startOffset + consumedBytes);
        }
      } catch (error) {
        fail(error);
      }
    });
    stream.on('error', fail);
    stream.on('end', () => {
      if (settled) return;
      let trailingBuffer = buffer;
      if (trailingBuffer.length > 0 && trailingBuffer[trailingBuffer.length - 1] === 0x0d) {
        trailingBuffer = trailingBuffer.subarray(0, trailingBuffer.length - 1);
      }
      const trailing = trailingBuffer.toString('utf8');
      if (trailing.trim()) {
        try {
          JSON.parse(trailing);
        } catch {
          // Keep partial trailing JSONL out of the ledger until the next append completes it.
          done();
          return;
        }
        try {
          onLine(trailing, startOffset + consumedBytes + buffer.length);
          consumedBytes += buffer.length;
        } catch (error) {
          fail(error);
          return;
        }
      }
      done();
    });
  });
  return startOffset + consumedBytes;
}

export async function collectSourceEntries(
  filePath: string,
  provider: ImportProvider,
  nowMs: number,
  startOffset = 0,
  fallbackRawModel = '',
  sourceIdentity = normalizedSourcePath(filePath),
  breakdownBoundary = localDateKey(nowMs),
): Promise<SourceScanResult> {
  const onOrAfterBoundary = (timestampMs: number): boolean => localDateKey(timestampMs) >= breakdownBoundary;

  if (provider === 'claude') {
    const byRequest = new Map<string, SourceEntry>();
    const byteOffset = await scanJsonlLines(filePath, (line) => {
      const extracted = extractClaudeUsageLine(line, nowMs);
      if (!extracted || extracted.entry.provider !== 'claude') return;
      const entry = extracted.entry as CompactRecentEntry & { provider: 'claude' };
      let breakdown: UsageLedgerIngestUsageEntry['breakdown'];
      if (onOrAfterBoundary(entry.timestampMs)) {
        let obj: Record<string, unknown> | null = null;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          obj = null;
        }
        const message = obj?.message as Record<string, unknown> | undefined;
        const content = message?.content as unknown[] | undefined;
        breakdown = claudeLedgerBreakdown(content ?? [], entry.outputTokens);
      }
      const withBreakdown = { ...entry, breakdown };
      const current = byRequest.get(entry.requestId);
      if (current && current.entry.outputTokens >= entry.outputTokens) return;
      byRequest.set(entry.requestId, {
        entry: withBreakdown,
        aggregate: aggregateFromUsageEntry(withBreakdown),
      });
    }, startOffset);
    return { entries: [...byRequest.values()], byteOffset };
  }

  const entries: SourceEntry[] = [];
  let rawModel = fallbackRawModel;
  let pendingTurn: {
    responseChars: number;
    toolChars: Record<ToolCategory, number>;
    toolCounts: ToolActivity;
  } = {
    responseChars: 0,
    toolChars: emptyToolOutput(),
    toolCounts: emptyToolActivity(),
  };
  let lastCompleteTurnOffset = startOffset;
  const resetPendingTurn = (): void => {
    pendingTurn = {
      responseChars: 0,
      toolChars: emptyToolOutput(),
      toolCounts: emptyToolActivity(),
    };
  };
  await scanJsonlLines(filePath, (line, offsetAfterLine) => {
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

    if (payload?.type === 'function_call' && typeof payload.name === 'string') {
      const timestamp = obj.timestamp as string | undefined;
      const timestampMs = timestamp ? new Date(timestamp).getTime() : NaN;
      if (Number.isFinite(timestampMs) && onOrAfterBoundary(timestampMs)) {
        const args = String(payload.arguments ?? '');
        const category = codexFunctionCallCategory(payload.name, args);
        pendingTurn.toolChars[category] += args.length + payload.name.length;
        pendingTurn.toolCounts[category] += 1;
      }
      return;
    }

    if (payload?.type === 'message' && payload.role === 'assistant') {
      const timestamp = obj.timestamp as string | undefined;
      const timestampMs = timestamp ? new Date(timestamp).getTime() : NaN;
      if (Number.isFinite(timestampMs) && onOrAfterBoundary(timestampMs)) {
        const content = payload.content as unknown;
        if (Array.isArray(content)) {
          for (const block of content) {
            const item = block as Record<string, unknown>;
            if ((item.type === 'output_text' || item.type === 'text') && typeof item.text === 'string') {
              pendingTurn.responseChars += item.text.length;
            }
          }
        }
      }
      return;
    }

    const extracted = extractCodexUsageLine(sourceIdentity, line, nowMs, rawModel);
    if (!extracted || extracted.entry.provider !== 'codex') return;
    if (!rawModel) rawModel = extracted.rawModel;
    const entry = extracted.entry as CompactRecentEntry & { provider: 'codex' };
    let breakdown: UsageLedgerIngestUsageEntry['breakdown'];
    if (onOrAfterBoundary(entry.timestampMs)) {
      const composition = splitOutput(
        {
          thinkingChars: 0,
          responseChars: pendingTurn.responseChars,
          toolChars: pendingTurn.toolChars,
        },
        entry.outputTokens,
        extracted.reasoningOutputTokens,
      );
      breakdown = compositionToDelta(composition);
      for (const key of TOOL_ACTIVITY_KEYS) breakdown[key] = pendingTurn.toolCounts[key];
    }
    const withBreakdown = { ...entry, breakdown, countsAsUsage: true };
    entries.push({ entry: withBreakdown, aggregate: aggregateFromUsageEntry(withBreakdown) });
    resetPendingTurn();
    lastCompleteTurnOffset = offsetAfterLine;
  }, startOffset);
  return { entries, byteOffset: lastCompleteTurnOffset, rawModel };
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
  return !!checkpoint
    && typeof checkpoint.byteOffset === 'number'
    && Number.isFinite(checkpoint.byteOffset)
    && checkpoint.size === stat.size
    && checkpoint.mtimeMs === stat.mtimeMs;
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
  if (currentCheckpoint && (typeof currentCheckpoint.byteOffset !== 'number' || !Number.isFinite(currentCheckpoint.byteOffset))) {
    if (currentCheckpoint.needsRebuild) return snapshot;
    const next = cloneUsageLedgerSnapshot(snapshot);
    next.sourceCheckpoints[sourceHash] = markNeedsRebuild(currentCheckpoint, nowMs, 'jsonl checkpoint missing byte offset');
    return next;
  }
  if (unchangedCheckpoint(currentCheckpoint, stat)) return snapshot;

  if (currentCheckpoint?.needsRebuild) return snapshot;
  const startOffset = currentCheckpoint?.byteOffset ?? 0;
  if (currentCheckpoint && stat.size < startOffset) {
    if (currentCheckpoint.needsRebuild) return snapshot;
    const next = cloneUsageLedgerSnapshot(snapshot);
    next.sourceCheckpoints[sourceHash] = markNeedsRebuild(currentCheckpoint, nowMs, 'source shrank before checkpoint offset');
    return next;
  }

  const breakdownBoundary = snapshot.breakdownStartedDate ?? localDateKey(nowMs);
  const { entries, byteOffset, rawModel } = await collectSourceEntries(
    filePath,
    provider,
    nowMs,
    startOffset,
    currentCheckpoint?.rawModel ?? '',
    sourceIdentity,
    breakdownBoundary,
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
