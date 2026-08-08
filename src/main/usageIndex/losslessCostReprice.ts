import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { estimateUsageCost } from '../modelPricing';
import {
  collectUsageBucketDeltas,
  usageBucketStart,
  usageBucketIdentityKey,
  type UsageBucketDelta,
} from './usageBucketAggregation';
import { usageIndexSchemaVersion } from './sqliteUsageIndexStorage';
import type {
  UsageEntry,
  UsageSourceCheckpoint,
  UsageSourceDescriptor,
} from './types';

interface SourceRow {
  source_id: string;
  provider: string;
  source_kind: string;
  parser_version: number;
  version_token: string;
  source_size: number | null;
  mtime_ms: number | null;
  checkpoint_json: string;
}

interface EntryRow {
  source_id: string;
  request_id: string;
  timestamp_ms: number;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  cache_savings_usd: number;
}

interface BucketRow {
  source_id: string;
  provider: string;
  model: string;
  bucket_kind: 'hour' | 'day' | 'month';
  bucket_start_ms: number;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
  cache_savings_usd: number;
}

interface CostTotalRow {
  provider: string;
  model: string;
  request_count: number;
  cost_usd: number;
  cache_savings_usd: number;
}

export interface UsageCostReplaySource {
  descriptor: UsageSourceDescriptor;
  checkpoint: UsageSourceCheckpoint;
}

export interface LosslessCostRepriceProgress {
  completedSources: number;
  totalSources: number;
  sourceId: string;
  state: 'replayed' | 'preserved-unavailable';
}

export interface LosslessCostRepriceOptions {
  databasePath: string;
  backupPath?: string;
  dryRun?: boolean;
  replaySource(source: UsageCostReplaySource): Promise<readonly UsageEntry[] | null>;
  onProgress?(progress: LosslessCostRepriceProgress): void;
}

export interface LosslessCostRepriceReport {
  applied: boolean;
  backupPath?: string;
  beforeCostUSD: number;
  afterCostUSD: number;
  beforeCacheSavingsUSD: number;
  afterCacheSavingsUSD: number;
  replayedSources: number;
  preservedUnavailableSources: number;
  updatedEntryRows: number;
  updatedBucketRows: number;
  affectedModelsBefore: CostTotalRow[];
  affectedModelsAfter: CostTotalRow[];
  nonCostStateHash: string;
}

const NON_COST_HASH_QUERIES = [
  `SELECT source_id, provider, source_kind, parser_version, version_token, source_size,
      mtime_ms, checkpoint_json, provider_metadata_json, sealed_before_ms
    FROM usage_source ORDER BY source_id`,
  `SELECT source_id, project_key FROM usage_source_project ORDER BY source_id, project_key`,
  `SELECT source_id, request_id, timestamp_ms, provider, model, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, breakdown_json
    FROM usage_entry ORDER BY source_id, request_id`,
  `SELECT source_id, provider, model, bucket_kind, bucket_start_ms, request_count,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens,
      breakdown_json
    FROM usage_bucket ORDER BY source_id, provider, model, bucket_kind, bucket_start_ms`,
  `SELECT source_id, provider, updated_at, byte_size, payload_json
    FROM usage_session_hot ORDER BY source_id`,
] as const;

const FULL_STATE_HASH_QUERIES = [
  `SELECT source_id, provider, source_kind, parser_version, version_token, source_size,
      mtime_ms, checkpoint_json, provider_metadata_json, sealed_before_ms
    FROM usage_source ORDER BY source_id`,
  `SELECT source_id, project_key FROM usage_source_project ORDER BY source_id, project_key`,
  `SELECT source_id, request_id, timestamp_ms, provider, model, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, cost_usd, cache_savings_usd, breakdown_json
    FROM usage_entry ORDER BY source_id, request_id`,
  `SELECT source_id, provider, model, bucket_kind, bucket_start_ms, request_count,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens,
      cost_usd, cache_savings_usd, breakdown_json
    FROM usage_bucket ORDER BY source_id, provider, model, bucket_kind, bucket_start_ms`,
  `SELECT source_id, provider, updated_at, byte_size, payload_json
    FROM usage_session_hot ORDER BY source_id`,
] as const;

function assertIntegrity(database: DatabaseSync, label: string): void {
  const rows = database.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
    throw new Error(`${label} failed SQLite integrity_check: ${JSON.stringify(rows)}`);
  }
}

function hashState(database: DatabaseSync, queries: readonly string[]): string {
  const hash = createHash('sha256');
  const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
  hash.update(`user_version\0${version.user_version}\0`);
  for (const sql of queries) {
    hash.update(sql);
    hash.update('\0');
    const rows = database.prepare(sql).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      hash.update(JSON.stringify(Object.values(row)));
      hash.update('\n');
    }
  }
  return hash.digest('hex');
}

function hashNonCostState(database: DatabaseSync): string {
  return hashState(database, NON_COST_HASH_QUERIES);
}

function hashFullState(database: DatabaseSync): string {
  return hashState(database, FULL_STATE_HASH_QUERIES);
}

function sourceLabel(sourceId: string): string {
  return `source-${createHash('sha256').update(sourceId).digest('hex').slice(0, 12)}`;
}

function canonicalTotals(database: DatabaseSync): { costUSD: number; cacheSavingsUSD: number } {
  const row = database.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd,
      COALESCE(SUM(cache_savings_usd), 0) AS cache_savings_usd
    FROM usage_bucket WHERE bucket_kind = 'month'
  `).get() as { cost_usd: number; cache_savings_usd: number };
  return { costUSD: row.cost_usd, cacheSavingsUSD: row.cache_savings_usd };
}

function affectedModelTotals(database: DatabaseSync): CostTotalRow[] {
  return database.prepare(`
    SELECT provider, model, SUM(request_count) AS request_count,
      SUM(cost_usd) AS cost_usd, SUM(cache_savings_usd) AS cache_savings_usd
    FROM usage_bucket
    WHERE bucket_kind = 'month' AND (
      (provider = 'claude' AND model IN ('Opus', 'Sonnet', 'claude-fable-5'))
      OR (provider = 'codex' AND model LIKE 'GPT-5.6%')
    )
    GROUP BY provider, model
    ORDER BY provider, model
  `).all() as unknown as CostTotalRow[];
}

function parseCheckpoint(source: SourceRow): UsageSourceCheckpoint {
  let value: unknown;
  try {
    value = JSON.parse(source.checkpoint_json);
  } catch {
    throw new Error(`Usage ${sourceLabel(source.source_id)} has invalid checkpoint JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Usage ${sourceLabel(source.source_id)} has a non-object checkpoint`);
  }
  return value as UsageSourceCheckpoint;
}

function replayDescriptor(source: SourceRow): UsageSourceDescriptor {
  if (source.provider !== 'claude' && source.provider !== 'codex') {
    throw new Error(`Cannot replay unsupported provider ${source.provider}`);
  }
  if (source.source_kind !== 'file') {
    throw new Error(`Cannot replay non-file ${sourceLabel(source.source_id)}`);
  }
  return {
    sourceId: source.source_id,
    provider: source.provider,
    kind: 'file',
    parserVersion: source.parser_version,
    version: {
      token: source.version_token,
      ...(source.source_size === null ? {} : { size: source.source_size }),
      ...(source.mtime_ms === null ? {} : { mtimeMs: source.mtime_ms }),
    },
  };
}

function needsRawReplay(provider: string, model: string): boolean {
  return (provider === 'claude' && (model === 'Opus' || model === 'Sonnet'))
    || (provider === 'codex' && model.startsWith('GPT-5.6'));
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function assertEntryIdentity(row: EntryRow, entry: UsageEntry): void {
  const sameTimestampBucket = usageBucketStart(row.timestamp_ms, 'hour')
    === usageBucketStart(entry.timestampMs, 'hour');
  const same = sameTimestampBucket
    && row.provider === entry.provider
    && row.model === entry.model
    && row.input_tokens === entry.inputTokens
    && row.output_tokens === entry.outputTokens
    && row.cache_creation_tokens === entry.cacheCreationTokens
    && row.cache_read_tokens === entry.cacheReadTokens;
  if (!same) {
    throw new Error(`Replay identity mismatch for ${row.source_id}:${row.request_id}: ${JSON.stringify({
      stored: {
        timestampMs: row.timestamp_ms,
        provider: row.provider,
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheCreationTokens: row.cache_creation_tokens,
        cacheReadTokens: row.cache_read_tokens,
      },
      replayed: {
        timestampMs: entry.timestampMs,
        provider: entry.provider,
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheCreationTokens: entry.cacheCreationTokens,
        cacheReadTokens: entry.cacheReadTokens,
      },
    })}`);
  }
}

function repriceReplayedSource(
  database: DatabaseSync,
  sourceId: string,
  entries: readonly UsageEntry[],
): { updatedEntryRows: number; updatedBucketRows: number } {
  const relevantEntries = entries.filter(entry => needsRawReplay(entry.provider, entry.model));
  const entryById = new Map(relevantEntries.map(entry => [entry.requestId, entry]));
  const bucketDeltas = new Map<string, UsageBucketDelta>();
  collectUsageBucketDeltas(bucketDeltas, sourceId, relevantEntries, 1);

  const storedEntries = (database.prepare('SELECT * FROM usage_entry WHERE source_id = ?')
    .all(sourceId) as unknown as EntryRow[])
    .filter(row => needsRawReplay(row.provider, row.model));
  const updateEntry = database.prepare(`
    UPDATE usage_entry SET cost_usd = ?, cache_savings_usd = ?
    WHERE source_id = ? AND request_id = ?
  `);
  let updatedEntryRows = 0;
  for (const row of storedEntries) {
    const entry = entryById.get(row.request_id);
    if (!entry) throw new Error(`Replay omitted indexed request ${sourceId}:${row.request_id}`);
    assertEntryIdentity(row, entry);
    if (sameNumber(row.cost_usd, entry.costUSD)
      && sameNumber(row.cache_savings_usd, entry.cacheSavingsUSD)) continue;
    const result = updateEntry.run(entry.costUSD, entry.cacheSavingsUSD, sourceId, row.request_id);
    if (result.changes !== 1) throw new Error(`Failed to reprice request ${sourceId}:${row.request_id}`);
    updatedEntryRows += 1;
  }

  const storedBuckets = (database.prepare('SELECT * FROM usage_bucket WHERE source_id = ?')
    .all(sourceId) as unknown as BucketRow[])
    .filter(row => needsRawReplay(row.provider, row.model));
  const updateBucket = database.prepare(`
    UPDATE usage_bucket SET cost_usd = ?, cache_savings_usd = ?
    WHERE source_id = ? AND provider = ? AND model = ?
      AND bucket_kind = ? AND bucket_start_ms = ?
  `);
  let updatedBucketRows = 0;
  for (const row of storedBuckets) {
    const key = usageBucketIdentityKey(
      sourceId,
      row.provider as UsageEntry['provider'],
      row.model,
      row.bucket_kind,
      row.bucket_start_ms,
    );
    const replayed = bucketDeltas.get(key);
    if (!replayed) throw new Error(`Replay omitted indexed bucket ${key}`);
    const metrics = replayed.metrics;
    const sameIdentity = row.request_count === metrics.requestCount
      && row.input_tokens === metrics.inputTokens
      && row.output_tokens === metrics.outputTokens
      && row.cache_creation_tokens === metrics.cacheCreationTokens
      && row.cache_read_tokens === metrics.cacheReadTokens
      && row.total_tokens === metrics.totalTokens;
    if (!sameIdentity) throw new Error(`Replay token mismatch for bucket ${key}`);
    if (sameNumber(row.cost_usd, metrics.costUSD)
      && sameNumber(row.cache_savings_usd, metrics.cacheSavingsUSD)) continue;
    const result = updateBucket.run(
      metrics.costUSD,
      metrics.cacheSavingsUSD,
      sourceId,
      row.provider,
      row.model,
      row.bucket_kind,
      row.bucket_start_ms,
    );
    if (result.changes !== 1) throw new Error(`Failed to reprice bucket ${key}`);
    updatedBucketRows += 1;
  }
  return { updatedEntryRows, updatedBucketRows };
}

function repriceUnambiguousFableRows(
  database: DatabaseSync,
): { updatedEntryRows: number; updatedBucketRows: number } {
  const entries = database.prepare(`
    SELECT * FROM usage_entry WHERE provider = 'claude' AND model = 'claude-fable-5'
  `).all() as unknown as EntryRow[];
  const updateEntry = database.prepare(`
    UPDATE usage_entry SET cost_usd = ?, cache_savings_usd = ?
    WHERE source_id = ? AND request_id = ?
  `);
  let updatedEntryRows = 0;
  for (const row of entries) {
    const estimate = estimateUsageCost({
      model: row.model,
      timestampMs: row.timestamp_ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      cacheReadTokens: row.cache_read_tokens,
    });
    if (sameNumber(row.cost_usd, estimate.costUSD)
      && sameNumber(row.cache_savings_usd, estimate.cacheSavingsUSD)) continue;
    updateEntry.run(estimate.costUSD, estimate.cacheSavingsUSD, row.source_id, row.request_id);
    updatedEntryRows += 1;
  }

  const buckets = database.prepare(`
    SELECT * FROM usage_bucket WHERE provider = 'claude' AND model = 'claude-fable-5'
  `).all() as unknown as BucketRow[];
  const updateBucket = database.prepare(`
    UPDATE usage_bucket SET cost_usd = ?, cache_savings_usd = ?
    WHERE source_id = ? AND provider = ? AND model = ?
      AND bucket_kind = ? AND bucket_start_ms = ?
  `);
  let updatedBucketRows = 0;
  for (const row of buckets) {
    const estimate = estimateUsageCost({
      model: row.model,
      timestampMs: row.bucket_start_ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      cacheReadTokens: row.cache_read_tokens,
    });
    if (sameNumber(row.cost_usd, estimate.costUSD)
      && sameNumber(row.cache_savings_usd, estimate.cacheSavingsUSD)) continue;
    updateBucket.run(
      estimate.costUSD,
      estimate.cacheSavingsUSD,
      row.source_id,
      row.provider,
      row.model,
      row.bucket_kind,
      row.bucket_start_ms,
    );
    updatedBucketRows += 1;
  }
  return { updatedEntryRows, updatedBucketRows };
}

function createBackup(database: DatabaseSync, databasePath: string, backupPath: string): string {
  const resolvedDatabase = path.resolve(databasePath);
  const resolvedBackup = path.resolve(backupPath);
  if (resolvedBackup === resolvedDatabase) throw new Error('Backup path must differ from the live UsageIndex path');
  if (fs.existsSync(resolvedBackup)) throw new Error(`Backup already exists: ${resolvedBackup}`);
  fs.mkdirSync(path.dirname(resolvedBackup), { recursive: true });
  const escaped = resolvedBackup.replace(/'/g, "''");
  database.exec(`VACUUM INTO '${escaped}'`);
  const backup = new DatabaseSync(resolvedBackup, { timeout: 5_000 });
  try {
    assertIntegrity(backup, 'UsageIndex backup');
    return hashFullState(backup);
  } finally {
    backup.close();
  }
}

export async function repriceUsageIndexCosts(
  options: LosslessCostRepriceOptions,
): Promise<LosslessCostRepriceReport> {
  const dryRun = options.dryRun === true;
  if (!dryRun && !options.backupPath) {
    throw new Error('A backupPath is required for an applied UsageIndex repricing');
  }

  const database = new DatabaseSync(options.databasePath, { timeout: 5_000 });
  let transactionOpen = false;
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA busy_timeout = 5000');
    assertIntegrity(database, 'UsageIndex');
    const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version !== usageIndexSchemaVersion()) {
      throw new Error(`Expected UsageIndex schema ${usageIndexSchemaVersion()}, found ${version.user_version}`);
    }
    const expectedStateHash = dryRun
      ? hashFullState(database)
      : createBackup(database, options.databasePath, options.backupPath!);
    const sources = database.prepare(`
      SELECT DISTINCT s.source_id, s.provider, s.source_kind, s.parser_version,
        s.version_token, s.source_size, s.mtime_ms, s.checkpoint_json
      FROM usage_source s
      JOIN usage_bucket b ON b.source_id = s.source_id
      WHERE (s.provider = 'claude' AND b.model IN ('Opus', 'Sonnet'))
        OR (s.provider = 'codex' AND b.model LIKE 'GPT-5.6%')
      ORDER BY s.provider, s.source_id
    `).all() as unknown as SourceRow[];

    let replayedSources = 0;
    let preservedUnavailableSources = 0;
    const replayedEntries = new Map<string, readonly UsageEntry[] | null>();
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      const replayed = await options.replaySource({
        descriptor: replayDescriptor(source),
        checkpoint: parseCheckpoint(source),
      });
      if (replayed === null) {
        if (source.provider === 'codex') {
          throw new Error(`Cannot exactly reprice unavailable Codex ${sourceLabel(source.source_id)}`);
        }
        replayedEntries.set(source.source_id, null);
        preservedUnavailableSources += 1;
        options.onProgress?.({
          completedSources: index + 1,
          totalSources: sources.length,
          sourceId: source.source_id,
          state: 'preserved-unavailable',
        });
        continue;
      }
      replayedEntries.set(source.source_id, replayed);
      replayedSources += 1;
      options.onProgress?.({
        completedSources: index + 1,
        totalSources: sources.length,
        sourceId: source.source_id,
        state: 'replayed',
      });
    }

    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    if (hashFullState(database) !== expectedStateHash) {
      throw new Error('UsageIndex changed after backup creation; close WhereMyTokens and retry with a new backup path');
    }
    const beforeHash = hashNonCostState(database);
    const beforeTotals = canonicalTotals(database);
    const affectedModelsBefore = affectedModelTotals(database);
    let updatedEntryRows = 0;
    let updatedBucketRows = 0;
    for (const source of sources) {
      const replayed = replayedEntries.get(source.source_id);
      if (!replayed) continue;
      const changed = repriceReplayedSource(database, source.source_id, replayed);
      updatedEntryRows += changed.updatedEntryRows;
      updatedBucketRows += changed.updatedBucketRows;
    }

    const fable = repriceUnambiguousFableRows(database);
    updatedEntryRows += fable.updatedEntryRows;
    updatedBucketRows += fable.updatedBucketRows;

    const afterHash = hashNonCostState(database);
    if (afterHash !== beforeHash) {
      throw new Error(`Non-cost UsageIndex state changed during repricing (${beforeHash} -> ${afterHash})`);
    }
    const afterTotals = canonicalTotals(database);
    const affectedModelsAfter = affectedModelTotals(database);
    assertIntegrity(database, 'Repriced UsageIndex');

    if (dryRun) database.exec('ROLLBACK');
    else database.exec('COMMIT');
    transactionOpen = false;
    return {
      applied: !dryRun,
      ...(options.backupPath && !dryRun ? { backupPath: path.resolve(options.backupPath) } : {}),
      beforeCostUSD: beforeTotals.costUSD,
      afterCostUSD: afterTotals.costUSD,
      beforeCacheSavingsUSD: beforeTotals.cacheSavingsUSD,
      afterCacheSavingsUSD: afterTotals.cacheSavingsUSD,
      replayedSources,
      preservedUnavailableSources,
      updatedEntryRows,
      updatedBucketRows,
      affectedModelsBefore,
      affectedModelsAfter,
      nonCostStateHash: beforeHash,
    };
  } catch (error) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    }
    throw error;
  } finally {
    database.close();
  }
}
