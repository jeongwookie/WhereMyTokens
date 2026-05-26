import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  DAILY_MODEL_RETENTION_MS,
  HOURLY_ACTIVITY_RETENTION_MS,
  MINUTE_RECENT_RETENTION_MS,
  SOURCE_REPAIR_RETENTION_MS,
  SourceCheckpoint,
  UsageAggregate,
  UsageLedgerSnapshot,
} from './usageLedgerTypes';
import {
  addUsageAggregate,
  aggregateFromParts,
  dayModelKey,
  emptyUsageAggregate,
  hourProviderKey,
  hourSourceModelKey,
  localDateKey,
  minuteKey,
  monthModelKey,
  subtractUsageAggregate,
} from './usageLedgerAggregates';
import { CompactRecentEntry } from './jsonlTypes';
import { extractClaudeUsageLine, extractCodexUsageLine } from './jsonlUsageExtractor';

type ImportProvider = 'claude' | 'codex';

const LEDGER_IMPORT_YIELD_EVERY = 250;

interface SourceEntry {
  entry: CompactRecentEntry;
  aggregate: UsageAggregate;
}

interface SourceScanResult {
  entries: SourceEntry[];
  byteOffset: number;
}

function cooperativeYield(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export function normalizedSourcePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function sourceHashForPath(filePath: string): string {
  return crypto.createHash('sha256').update(normalizedSourcePath(filePath)).digest('base64url');
}

function cloneAggregate(aggregate: UsageAggregate): UsageAggregate {
  return { ...aggregate };
}

function cloneSnapshot(snapshot: UsageLedgerSnapshot): UsageLedgerSnapshot {
  return {
    ...snapshot,
    minuteRecent: Object.fromEntries(Object.entries(snapshot.minuteRecent).map(([key, value]) => [key, cloneAggregate(value)])),
    recentRequestIndex: Object.fromEntries(Object.entries(snapshot.recentRequestIndex).map(([key, value]) => [key, { ...value, aggregate: cloneAggregate(value.aggregate) }])),
    hourlyActivity: Object.fromEntries(Object.entries(snapshot.hourlyActivity).map(([key, value]) => [key, cloneAggregate(value)])),
    dailyModel: Object.fromEntries(Object.entries(snapshot.dailyModel).map(([key, value]) => [key, cloneAggregate(value)])),
    monthlyModel: Object.fromEntries(Object.entries(snapshot.monthlyModel).map(([key, value]) => [key, cloneAggregate(value)])),
    sourceCheckpoints: Object.fromEntries(Object.entries(snapshot.sourceCheckpoints).map(([key, value]) => [key, { ...value }])),
    sourceRepairRollup: Object.fromEntries(Object.entries(snapshot.sourceRepairRollup).map(([key, value]) => [key, cloneAggregate(value)])),
  };
}

function asAggregate(entry: CompactRecentEntry): UsageAggregate {
  return aggregateFromParts({
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheCreationTokens: entry.cacheCreationTokens,
    cacheReadTokens: entry.cacheReadTokens,
    costUSD: entry.costUSD,
    cacheSavingsUSD: entry.cacheSavingsUSD,
  });
}

function addToRecord(record: Record<string, UsageAggregate>, key: string, aggregate: UsageAggregate): void {
  const current = record[key] ?? emptyUsageAggregate();
  addUsageAggregate(current, aggregate);
  record[key] = current;
}

function subtractFromRecord(record: Record<string, UsageAggregate>, key: string, aggregate: UsageAggregate): void {
  const current = record[key];
  if (!current) return;
  subtractUsageAggregate(current, aggregate);
  if (current.requestCount <= 0 || current.totalTokens <= 0) delete record[key];
  else record[key] = current;
}

function parseMinuteLedgerKey(key: string): { timestampMs: number; provider: ImportProvider; model: string } | null {
  const [timestampRaw, provider, ...modelParts] = key.split('|');
  const timestampMs = Number(timestampRaw);
  const model = modelParts.join('|');
  if (!Number.isFinite(timestampMs) || (provider !== 'claude' && provider !== 'codex') || !model) return null;
  return { timestampMs, provider, model };
}

function subtractExistingRecentRequest(
  snapshot: UsageLedgerSnapshot,
  sourceHash: string,
  requestIndexKey: string,
  existing: UsageLedgerSnapshot['recentRequestIndex'][string],
): void {
  const row = parseMinuteLedgerKey(existing.minuteKey);
  if (!row) {
    delete snapshot.recentRequestIndex[requestIndexKey];
    return;
  }
  subtractFromRecord(snapshot.minuteRecent, existing.minuteKey, existing.aggregate);
  subtractFromRecord(snapshot.hourlyActivity, hourProviderKey(row.timestampMs, row.provider), existing.aggregate);
  subtractFromRecord(snapshot.dailyModel, dayModelKey(row.timestampMs, row.provider, row.model), existing.aggregate);
  subtractFromRecord(snapshot.monthlyModel, monthModelKey(row.timestampMs, row.provider, row.model), existing.aggregate);
  subtractFromRecord(snapshot.sourceRepairRollup, hourSourceModelKey(sourceHash, row.timestampMs, row.provider, row.model), existing.aggregate);
  delete snapshot.recentRequestIndex[requestIndexKey];
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

async function collectSourceEntries(filePath: string, provider: ImportProvider, nowMs: number, startOffset = 0): Promise<SourceScanResult> {
  if (provider === 'claude') {
    const byRequest = new Map<string, SourceEntry>();
    const byteOffset = await scanJsonlLines(filePath, (line) => {
      const extracted = extractClaudeUsageLine(line, nowMs);
      if (!extracted || extracted.entry.provider !== 'claude') return;
      const current = byRequest.get(extracted.entry.requestId);
      if (current && current.entry.outputTokens >= extracted.entry.outputTokens) return;
      byRequest.set(extracted.entry.requestId, {
        entry: extracted.entry,
        aggregate: asAggregate(extracted.entry),
      });
    }, startOffset);
    return { entries: [...byRequest.values()], byteOffset };
  }

  const entries: SourceEntry[] = [];
  let rawModel = '';
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

    const extracted = extractCodexUsageLine(filePath, line, nowMs, rawModel);
    if (!extracted || extracted.entry.provider !== 'codex') return;
    if (!rawModel) rawModel = extracted.rawModel;
    entries.push({ entry: extracted.entry, aggregate: asAggregate(extracted.entry) });
  }, startOffset);
  return { entries, byteOffset };
}

function markNeedsRebuild(checkpoint: SourceCheckpoint, nowMs: number, reason: string): SourceCheckpoint {
  return {
    ...checkpoint,
    needsRebuild: true,
    rebuildReason: reason,
    lastImportedAt: nowMs,
  };
}

function subtractPreviousSource(next: UsageLedgerSnapshot, sourceHash: string, provider: ImportProvider, nowMs: number): boolean {
  const repairRows = Object.entries(next.sourceRepairRollup)
    .filter(([key]) => key.startsWith(`${sourceHash}|`));
  if (repairRows.length === 0) return false;

  const repairCutoff = nowMs - SOURCE_REPAIR_RETENTION_MS;
  if (repairRows.some(([key]) => Number(key.split('|')[1]) < repairCutoff)) return false;

  for (const [key, aggregate] of repairRows) {
    const [, hourStartRaw, rowProvider, model] = key.split('|');
    const hourStartMs = Number(hourStartRaw);
    if (!Number.isFinite(hourStartMs) || (rowProvider !== 'claude' && rowProvider !== 'codex')) continue;
    subtractFromRecord(next.hourlyActivity, hourProviderKey(hourStartMs, rowProvider), aggregate);
    subtractFromRecord(next.dailyModel, dayModelKey(hourStartMs, rowProvider, model), aggregate);
    subtractFromRecord(next.monthlyModel, monthModelKey(hourStartMs, rowProvider, model), aggregate);
    delete next.sourceRepairRollup[key];
  }

  for (const [key, value] of Object.entries(next.recentRequestIndex)) {
    if (!key.startsWith(`${sourceHash}|`)) continue;
    subtractFromRecord(next.minuteRecent, value.minuteKey, value.aggregate);
    delete next.recentRequestIndex[key];
  }

  return true;
}

function addEntryToSnapshot(next: UsageLedgerSnapshot, sourceHash: string, sourceEntry: SourceEntry, nowMs: number): void {
  const { entry, aggregate } = sourceEntry;
  if (entry.provider !== 'claude' && entry.provider !== 'codex') return;

  const provider = entry.provider;
  const requestIndexKey = `${sourceHash}|${entry.requestId}`;
  const existing = next.recentRequestIndex[requestIndexKey];
  if (existing) {
    if (existing.aggregate.outputTokens >= aggregate.outputTokens) return;
    subtractExistingRecentRequest(next, sourceHash, requestIndexKey, existing);
  }

  if (entry.timestampMs >= nowMs - MINUTE_RECENT_RETENTION_MS) {
    const key = minuteKey(entry.timestampMs, provider, entry.model);
    addToRecord(next.minuteRecent, key, aggregate);
    next.recentRequestIndex[requestIndexKey] = {
      minuteKey: key,
      aggregate: cloneAggregate(aggregate),
      lastSeenMs: nowMs,
    };
  }

  if (entry.timestampMs >= nowMs - HOURLY_ACTIVITY_RETENTION_MS) {
    addToRecord(next.hourlyActivity, hourProviderKey(entry.timestampMs, provider), aggregate);
  }

  if (entry.timestampMs >= nowMs - DAILY_MODEL_RETENTION_MS) {
    addToRecord(next.dailyModel, dayModelKey(localDateKey(entry.timestampMs), provider, entry.model), aggregate);
  }

  addToRecord(next.monthlyModel, monthModelKey(localDateKey(entry.timestampMs), provider, entry.model), aggregate);

  if (entry.timestampMs >= nowMs - SOURCE_REPAIR_RETENTION_MS) {
    addToRecord(next.sourceRepairRollup, hourSourceModelKey(sourceHash, entry.timestampMs, provider, entry.model), aggregate);
  }
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

  const sourceHash = sourceHashForPath(filePath);
  const currentCheckpoint = snapshot.sourceCheckpoints[sourceHash];
  if (unchangedCheckpoint(currentCheckpoint, stat)) return snapshot;

  const next = cloneSnapshot(snapshot);
  const startOffset = currentCheckpoint ? currentCheckpoint.byteOffset : 0;
  if (currentCheckpoint?.needsRebuild) return next;
  if (currentCheckpoint && stat.size < startOffset) {
    next.sourceCheckpoints[sourceHash] = markNeedsRebuild(currentCheckpoint, nowMs, 'source shrank before checkpoint offset');
    return next;
  }

  const { entries, byteOffset } = await collectSourceEntries(filePath, provider, nowMs, startOffset);
  let processedEntries = 0;
  for (const entry of entries) {
    addEntryToSnapshot(next, sourceHash, entry, nowMs);
    processedEntries += 1;
    if (processedEntries % LEDGER_IMPORT_YIELD_EVERY === 0) await cooperativeYield();
  }

  next.sourceCheckpoints[sourceHash] = {
    provider,
    sourceHash,
    normalizedPath: normalizedSourcePath(filePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    byteOffset,
    lastImportedAt: nowMs,
    hasUsage: (currentCheckpoint?.hasUsage ?? false) || entries.length > 0,
  };

  return next;
}
