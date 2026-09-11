import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  BREAKDOWN_KEYS,
  emptyBreakdownDelta,
  type BreakdownDelta,
} from '../../shared/breakdownTypes';
import type { ProviderId } from '../../shared/quotaTypes';
import { PROVIDER_IDS } from '../providers/settings';
import {
  emptyUsageMetrics,
  type StoredUsageSource,
  type UsageBreakdownData,
  type UsageBreakdownQuery,
  type UsageCompactionResult,
  type UsageEntry,
  type UsageEntryProjection,
  type UsageEntryQuery,
  type UsageFilter,
  type UsageIndexStorage,
  type UsageMetrics,
  type UsageModelTotal,
  type UsageQueryData,
  type UsageQuery,
  type UsageSessionProjection,
  type UsageSourceCommit,
  type UsageSourceDescriptor,
  type UsageSourceKind,
  type UsageSourceVersion,
  type UsageTimeBucketTotal,
} from './types';
import { UsageEntryProjectionBuilder } from './entryProjection';
import { usageRetentionCutoffs } from './retention';
import { canonicalSessionProjection, executionFingerprint, identityAccepts, reviseClaudePayload, sameExecutionOrigin, validUsageRevision, type ExecutionIdentity } from './executionIdentity';
import {
  addUsageBreakdown,
  addUsageMetrics,
  collectUsageBucketDeltas,
  usageBucketStart,
  type UsageBucketDelta,
  type UsageBucketKind,
} from './usageBucketAggregation';

const USAGE_INDEX_SCHEMA_VERSION = 6;
const EXECUTION_TABLES_SQL = `
  CREATE TABLE usage_identity (
    provider TEXT NOT NULL, identity_key TEXT NOT NULL, source_id TEXT NOT NULL,
    request_id TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, origin_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    PRIMARY KEY(provider, identity_key)
  ) STRICT;
  CREATE INDEX usage_identity_owner ON usage_identity(provider, source_id, request_id);
`;
const USAGE_BUCKET_TABLE_SQL = `
  CREATE TABLE usage_bucket (
    source_id TEXT NOT NULL REFERENCES usage_source(source_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('hour', 'day', 'month')),
    bucket_start_ms INTEGER NOT NULL,
    request_count INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    cache_savings_usd REAL NOT NULL,
    breakdown_json TEXT NOT NULL,
    PRIMARY KEY (source_id, provider, model, bucket_kind, bucket_start_ms)
  ) STRICT;

  CREATE INDEX usage_bucket_time_provider_model
    ON usage_bucket(bucket_kind, bucket_start_ms, provider, model);
`;

interface SourceRow {
  source_id: string;
  provider: string;
  source_kind: string;
  parser_version: number;
  version_token: string;
  source_size: number | null;
  mtime_ms: number | null;
  checkpoint_json: string;
  provider_metadata_json: string | null;
  sealed_before_ms: number | null;
}

interface ProjectRow {
  project_key: string;
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
  breakdown_json: string | null;
}

interface EntryProjectionRow {
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

interface CountRow {
  row_count: number;
}

interface SessionRow {
  source_id: string;
  provider: string;
  updated_at: number;
  byte_size: number;
  payload_json: string;
}

interface BucketRow {
  source_id: string;
  provider: string;
  model: string;
  bucket_kind: string;
  bucket_start_ms: number;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
  cache_savings_usd: number;
  breakdown_json: string;
}

function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId);
}

function isSourceKind(value: string): value is UsageSourceKind {
  return value === 'file' || value === 'remote';
}

function isBucketKind(value: string): value is UsageBucketKind {
  return value === 'hour' || value === 'day' || value === 'month';
}

function parseObjectJson(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Invalid ${label} JSON in UsageIndex${detail}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label} shape in UsageIndex`);
  }
  return parsed as Record<string, unknown>;
}

function parseBreakdown(value: string | null): BreakdownDelta | undefined {
  if (!value) return undefined;
  const parsed = parseObjectJson(value, 'breakdown');
  const breakdown = emptyBreakdownDelta();
  for (const key of BREAKDOWN_KEYS) {
    const field = parsed[key];
    if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) {
      throw new Error(`Invalid breakdown.${key} in UsageIndex`);
    }
    breakdown[key] = field;
  }
  return breakdown;
}

function cloneDescriptor(source: UsageSourceDescriptor): UsageSourceDescriptor {
  return {
    ...source,
    version: { ...source.version },
    projectKeys: [...(source.projectKeys ?? [])],
  };
}

function entryFromRow(row: EntryRow): UsageEntry {
  if (!isProviderId(row.provider)) throw new Error(`Invalid provider ${row.provider} in UsageIndex entry`);
  return {
    requestId: row.request_id,
    timestampMs: row.timestamp_ms,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    cacheReadTokens: row.cache_read_tokens,
    costUSD: row.cost_usd,
    cacheSavingsUSD: row.cache_savings_usd,
    ...(row.breakdown_json ? { breakdown: parseBreakdown(row.breakdown_json) } : {}),
  };
}

function metricsFromBucketRow(row: BucketRow): UsageMetrics {
  return {
    requestCount: row.request_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    cacheReadTokens: row.cache_read_tokens,
    totalTokens: row.total_tokens,
    costUSD: row.cost_usd,
    cacheSavingsUSD: row.cache_savings_usd,
  };
}

function entryQuerySql(query: UsageFilter, selectSql = 'e.*', orderSql = ''): { sql: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (query.fromMs !== undefined) {
    clauses.push('e.timestamp_ms >= ?');
    params.push(query.fromMs);
  }
  if (query.toMs !== undefined) {
    clauses.push('e.timestamp_ms < ?');
    params.push(query.toMs);
  }
  if (query.providers?.size) {
    clauses.push(`e.provider IN (${[...query.providers].map(() => '?').join(', ')})`);
    params.push(...query.providers);
  }
  if (query.excludedProjectKeys?.length) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM usage_source_project excluded
      WHERE excluded.source_id = e.source_id
        AND excluded.project_key COLLATE NOCASE IN (${query.excludedProjectKeys.map(() => '?').join(', ')})
    )`);
    params.push(...query.excludedProjectKeys);
  }
  return {
    sql: `SELECT ${selectSql} FROM usage_entry e${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}${orderSql}`,
    params,
  };
}

function bucketQuerySql(query: UsageQuery): { sql: string; params: SQLInputValue[] } {
  const clauses = ['b.bucket_kind = ?'];
  const params: SQLInputValue[] = [query.grain];
  if (query.fromMs !== undefined) {
    clauses.push('b.bucket_start_ms >= ?');
    params.push(query.fromMs);
  }
  if (query.toMs !== undefined) {
    clauses.push('b.bucket_start_ms < ?');
    params.push(query.toMs);
  }
  if (query.providers?.size) {
    clauses.push(`b.provider IN (${[...query.providers].map(() => '?').join(', ')})`);
    params.push(...query.providers);
  }
  if (query.excludedProjectKeys?.length) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM usage_source_project excluded
      WHERE excluded.source_id = b.source_id
        AND excluded.project_key COLLATE NOCASE IN (${query.excludedProjectKeys.map(() => '?').join(', ')})
    )`);
    params.push(...query.excludedProjectKeys);
  }
  return {
    sql: `SELECT b.* FROM usage_bucket b WHERE ${clauses.join(' AND ')}`,
    params,
  };
}

export class SqliteUsageIndexStorage implements UsageIndexStorage {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      this.database.exec('PRAGMA foreign_keys = ON');
      this.database.exec('PRAGMA busy_timeout = 5000');
      if (databasePath !== ':memory:') {
        this.database.exec('PRAGMA journal_mode = WAL');
        this.database.exec('PRAGMA synchronous = NORMAL');
      }
      this.initializeSchema();
    } catch (error) {
      try { this.database.close(); } catch { /* preserve the original initialization error */ }
      this.closed = true;
      throw error;
    }
  }

  identitySource(provider: ProviderId, key: string): string | undefined {
    this.assertOpen();
    return (this.database.prepare('SELECT source_id FROM usage_identity WHERE provider=? AND identity_key=?').get(provider, key) as { source_id: string } | undefined)?.source_id;
  }

  async getSource(sourceId: string): Promise<StoredUsageSource | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM usage_source WHERE source_id = ?').get(sourceId) as SourceRow | undefined;
    if (!row) return null;
    if (!isProviderId(row.provider) || !isSourceKind(row.source_kind)) {
      throw new Error(`Invalid source identity stored for ${sourceId}`);
    }
    const projects = this.database
      .prepare('SELECT project_key FROM usage_source_project WHERE source_id = ? ORDER BY project_key')
      .all(sourceId) as unknown as ProjectRow[];
    const version: UsageSourceVersion = {
      token: row.version_token,
      ...(row.source_size === null ? {} : { size: row.source_size }),
      ...(row.mtime_ms === null ? {} : { mtimeMs: row.mtime_ms }),
    };
    const sessionRow = this.database
      .prepare('SELECT * FROM usage_session_hot WHERE source_id = ?')
      .get(sourceId) as SessionRow | undefined;
    const sessionProjection = sessionRow
      ? this.sessionProjectionFromRow(sessionRow)
      : undefined;
    return {
      descriptor: {
        sourceId: row.source_id,
        provider: row.provider,
        kind: row.source_kind,
        parserVersion: row.parser_version,
        version,
        projectKeys: projects.map(project => project.project_key),
      },
      checkpoint: parseObjectJson(row.checkpoint_json, 'checkpoint'),
      ...(row.sealed_before_ms === null ? {} : { sealedBeforeMs: row.sealed_before_ms }),
      ...(row.provider_metadata_json
        ? { providerMetadata: parseObjectJson(row.provider_metadata_json, 'provider metadata') }
        : {}),
      ...(sessionProjection ? { sessionProjection } : {}),
    };
  }

  async updateSourceDescriptor(source: UsageSourceDescriptor): Promise<void> {
    this.assertOpen();
    this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE usage_source
        SET parser_version = ?, version_token = ?, source_size = ?, mtime_ms = ?
        WHERE source_id = ? AND provider = ? AND source_kind = ?
      `).run(
        source.parserVersion,
        source.version.token,
        source.version.size ?? null,
        source.version.mtimeMs ?? null,
        source.sourceId,
        source.provider,
        source.kind,
      );
      if (result.changes !== 1) throw new Error(`Cannot update missing usage source ${source.sourceId}`);
      this.replaceProjects(source);
    });
  }

  async commitSource(commit: UsageSourceCommit): Promise<void> {
    this.assertOpen();
    this.transaction(() => {
      const storedSource = this.database.prepare('SELECT * FROM usage_source WHERE source_id = ?')
        .get(commit.source.sourceId) as SourceRow | undefined;
      const lookup = this.database.prepare('SELECT source_id AS sourceId, request_id AS requestId, timestamp_ms AS timestampMs, origin_id AS originId, fingerprint FROM usage_identity WHERE provider = ? AND identity_key = ?');
      const owner = (key: string) => lookup.get(commit.source.provider, key) as ExecutionIdentity | undefined;
      const register = this.database.prepare('INSERT OR IGNORE INTO usage_identity VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const seed of commit.batch.identitySeeds ?? []) {
        let row = this.database.prepare('SELECT * FROM usage_entry WHERE source_id=? AND request_id=?').get(commit.source.sourceId, seed.requestId) as EntryRow | undefined;
        // 구버전 응답 ID는 새 카운터 ID와 다르므로 원본 응답과 시각이 일치할 때만 연결한다.
        if (!row && commit.source.provider === 'codex' && seed.key.startsWith('codex:response:')) {
          row = this.database.prepare('SELECT * FROM usage_entry WHERE source_id=? AND request_id=? AND timestamp_ms=?')
            .get(commit.source.sourceId, seed.key, seed.timestampMs) as EntryRow | undefined;
        }
        const retained = row ? entryFromRow(row) : undefined;
        const known = owner(seed.key);
        if (retained && known?.sourceId === commit.source.sourceId && known.requestId === `protected:${seed.requestId}`) {
          this.database.prepare('UPDATE usage_identity SET request_id=?, timestamp_ms=?, origin_id=?, fingerprint=? WHERE provider=? AND source_id=? AND request_id=?')
            .run(retained.requestId, retained.timestampMs, retained.identityOrigin ?? '', executionFingerprint(retained), commit.source.provider, known.sourceId, known.requestId);
        }
        register.run(commit.source.provider, seed.key, commit.source.sourceId, retained?.requestId ?? `protected:${seed.requestId}`,
          retained?.timestampMs ?? seed.timestampMs, retained?.identityOrigin ?? '', retained ? executionFingerprint(retained) : '');
      }
      const identityIssues = new Set<string>();
      const crossUpdates: Array<{ known: ExecutionIdentity; previous: UsageEntry; entry: UsageEntry }> = [];
      const cascadeSuffix = commit.source.sourceId.slice(commit.source.sourceId.indexOf(':cascade:'));
      const uncertainCascade = !storedSource && commit.source.provider === 'antigravity'
        && commit.source.sourceId.includes(':cascade:') && this.database.prepare(
          "SELECT source_id, provider_metadata_json FROM usage_source WHERE provider='antigravity' AND source_id<>? AND substr(source_id, -length(?))=? AND ((parser_version < 2 OR source_id LIKE 'antigravity:unknown:%') AND json_extract(provider_metadata_json, '$.resolvedUsageScope') IS NULL OR ? LIKE 'antigravity:unknown:%') LIMIT 1",
        ).get(commit.source.sourceId, cascadeSuffix, cascadeSuffix, commit.source.sourceId) as { source_id: string; provider_metadata_json: string | null } | undefined;
      if (uncertainCascade && !commit.source.sourceId.startsWith('antigravity:unknown:')) {
        const metadata = uncertainCascade.provider_metadata_json ? JSON.parse(uncertainCascade.provider_metadata_json) : {};
        metadata.resolvedUsageScope = commit.source.sourceId;
        this.database.prepare('UPDATE usage_source SET provider_metadata_json=? WHERE source_id=?').run(JSON.stringify(metadata), uncertainCascade.source_id);
      }
      const entriesToCommit = commit.batch.entries.map(entry => ({ ...entry })).filter(entry => {
        const keys = [entry.identityKey, ...(entry.identityAliases ?? [])].filter((k): k is string => !!k);
        if (uncertainCascade) {
          for (const key of keys) register.run(entry.provider, key, commit.source.sourceId, 'protected:' + entry.requestId, entry.timestampMs, '', '');
          return false;
        }
        const scopeWitness = entry.provider === 'antigravity' && entry.identityOrigin ? owner(entry.identityOrigin) : undefined;
        let witnessedScope: string | undefined;
        if (scopeWitness?.sourceId.startsWith('antigravity:unknown:')) {
          const row = this.database.prepare('SELECT provider_metadata_json FROM usage_source WHERE source_id=?').get(scopeWitness.sourceId) as { provider_metadata_json: string | null } | undefined;
          witnessedScope = row?.provider_metadata_json ? JSON.parse(row.provider_metadata_json).resolvedUsageScope : undefined;
        }
        if (scopeWitness && scopeWitness.sourceId !== commit.source.sourceId
          && (commit.source.sourceId.startsWith('antigravity:unknown:')
            || scopeWitness.sourceId.startsWith('antigravity:unknown:') && (!witnessedScope || witnessedScope === commit.source.sourceId))) {
          for (const key of keys) register.run(entry.provider, key, commit.source.sourceId, 'protected:' + entry.requestId, entry.timestampMs, '', '');
          return false;
        }
        const knownValues = keys.map(owner).filter((v): v is ExecutionIdentity => !!v);
        const known = knownValues[0];
        if (knownValues.some(v => v.sourceId !== known?.sourceId || v.requestId !== known?.requestId)) { identityIssues.add('identity-conflict'); return false; }
        if (known && known.sourceId !== commit.source.sourceId) {
          if (sameExecutionOrigin(entry, known) && executionFingerprint(entry) === known.fingerprint) return false;
          const row = this.database.prepare('SELECT * FROM usage_entry WHERE source_id=? AND request_id=?').get(known.sourceId, known.requestId) as EntryRow | undefined;
          const originalState = this.database.prepare('SELECT checkpoint_json FROM usage_source WHERE source_id=?').get(known.sourceId) as { checkpoint_json: string } | undefined;
          const resumeState = originalState ? JSON.parse(originalState.checkpoint_json).resumeState : undefined;
          const oldPayload = resumeState ? JSON.parse(resumeState).payload : {};
          if (row && validUsageRevision(entry, entryFromRow(row), known, oldPayload, commit.batch.sessionProjection?.payload)) {
            crossUpdates.push({ known, previous: entryFromRow(row), entry: { ...entry, requestId: known.requestId } });
          } else identityIssues.add('cross-source-execution-conflict');
          return false;
        }
        if (known) {
          for (const key of keys) register.run(entry.provider, key, known.sourceId, known.requestId, known.timestampMs, known.originId, known.fingerprint);
          if (!known.requestId.startsWith('protected:')) entry.requestId = known.requestId;
          entry.timestampMs = known.timestampMs;
        }
        if (!identityAccepts(entry, commit.source.sourceId, known)) return false;
        if (known) {
          const previousRow = this.database.prepare('SELECT * FROM usage_entry WHERE source_id=? AND request_id=?').get(known.sourceId, known.requestId) as EntryRow | undefined;
          if (!previousRow || known.fingerprint === executionFingerprint(entry)) return false;
          const oldCheckpoint = storedSource ? JSON.parse(storedSource.checkpoint_json) : {};
          const oldPayload = oldCheckpoint.resumeState ? JSON.parse(oldCheckpoint.resumeState).payload ?? {} : {};
          if (!validUsageRevision(entry, entryFromRow(previousRow), known, oldPayload, commit.batch.sessionProjection?.payload)) {
            identityIssues.add('identity-conflict'); return false;
          }
        }
        for (const key of keys) register.run(entry.provider, key, commit.source.sourceId, entry.requestId, entry.timestampMs, entry.identityOrigin ?? '', executionFingerprint(entry));
        if (entry.provider === 'antigravity' && entry.identityOrigin) {
          register.run(entry.provider, entry.identityOrigin, commit.source.sourceId, entry.requestId, entry.timestampMs, entry.identityOrigin, executionFingerprint(entry));
        }
        return true;
      });
      for (const link of commit.batch.identityLinks ?? []) {
        const target = owner(link.target), existing = owner(link.alias);
        if (!target) continue;
        if (existing && (existing.sourceId !== target.sourceId || existing.requestId !== target.requestId)) {
          identityIssues.add('identity-conflict'); continue;
        }
        register.run(commit.source.provider, link.alias, target.sourceId, target.requestId, target.timestampMs, target.originId, target.fingerprint);
      }
      const providerMetadata = { ...commit.batch.providerMetadata };
      const storedMetadata = storedSource?.provider_metadata_json ? JSON.parse(storedSource.provider_metadata_json) : {};
      if (storedMetadata.resolvedUsageScope) providerMetadata.resolvedUsageScope = storedMetadata.resolvedUsageScope;
      if (identityIssues.size) providerMetadata.accountingIssues = [...((providerMetadata.accountingIssues as string[] | undefined) ?? []), ...identityIssues];
      const replacedEntries = new Map<string, UsageEntry>();
      if (commit.mode === 'rebuild') {
        const coverage = commit.batch.rebuildCoverage;
        if (!coverage) throw new Error(`Usage source ${commit.source.sourceId} rebuild coverage is missing`);
        if (coverage.kind === 'full') {
          const rows = this.database.prepare('SELECT * FROM usage_entry WHERE source_id = ?')
            .all(commit.source.sourceId) as unknown as EntryRow[];
          for (const row of rows) replacedEntries.set(row.request_id, entryFromRow(row));
          this.database.prepare('DELETE FROM usage_entry WHERE source_id = ?').run(commit.source.sourceId);
        } else if (coverage.kind === 'range') {
          const rows = this.database.prepare(`
            SELECT * FROM usage_entry
            WHERE source_id = ? AND timestamp_ms >= ? AND timestamp_ms < ?
          `).all(commit.source.sourceId, coverage.fromMs, coverage.toMs) as unknown as EntryRow[];
          for (const row of rows) replacedEntries.set(row.request_id, entryFromRow(row));
          this.database.prepare(`
            DELETE FROM usage_entry
            WHERE source_id = ? AND timestamp_ms >= ? AND timestamp_ms < ?
          `).run(commit.source.sourceId, coverage.fromMs, coverage.toMs);
        }
      }

      this.database.prepare(`
        INSERT INTO usage_source (
          source_id, provider, source_kind, parser_version, version_token,
          source_size, mtime_ms, checkpoint_json, provider_metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          provider = excluded.provider,
          source_kind = excluded.source_kind,
          parser_version = excluded.parser_version,
          version_token = excluded.version_token,
          source_size = excluded.source_size,
          mtime_ms = excluded.mtime_ms,
          checkpoint_json = excluded.checkpoint_json,
          provider_metadata_json = excluded.provider_metadata_json
      `).run(
        commit.source.sourceId,
        commit.source.provider,
        commit.source.kind,
        commit.source.parserVersion,
        commit.source.version.token,
        commit.source.version.size ?? null,
        commit.source.version.mtimeMs ?? null,
        JSON.stringify(commit.batch.checkpoint),
        Object.keys(providerMetadata).length ? JSON.stringify(providerMetadata) : null,
      );
      this.replaceProjects(commit.source);

      const insertEntry = this.database.prepare(`
        INSERT INTO usage_entry (
          source_id, request_id, timestamp_ms, provider, model,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          cost_usd, cache_savings_usd, breakdown_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, request_id) DO UPDATE SET
          timestamp_ms = excluded.timestamp_ms,
          provider = excluded.provider,
          model = excluded.model,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cache_creation_tokens = excluded.cache_creation_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          cost_usd = excluded.cost_usd,
          cache_savings_usd = excluded.cache_savings_usd,
          breakdown_json = excluded.breakdown_json
      `);
      const selectEntry = this.database.prepare(`
        SELECT * FROM usage_entry WHERE source_id = ? AND request_id = ?
      `);
      for (const entry of entriesToCommit) {
        if (!replacedEntries.has(entry.requestId)) {
          const previous = selectEntry.get(commit.source.sourceId, entry.requestId) as EntryRow | undefined;
          if (previous) replacedEntries.set(previous.request_id, entryFromRow(previous));
        }
        insertEntry.run(
          commit.source.sourceId,
          entry.requestId,
          entry.timestampMs,
          entry.provider,
          entry.model,
          entry.inputTokens,
          entry.outputTokens,
          entry.cacheCreationTokens,
          entry.cacheReadTokens,
          entry.costUSD,
          entry.cacheSavingsUSD,
          entry.breakdown ? JSON.stringify(entry.breakdown) : null,
        );
      }

      const bucketDeltas = new Map<string, UsageBucketDelta>();
      collectUsageBucketDeltas(
        bucketDeltas,
        commit.source.sourceId,
        [...replacedEntries.values()],
        -1,
      );
      collectUsageBucketDeltas(bucketDeltas, commit.source.sourceId, entriesToCommit, 1);
      for (const update of crossUpdates) {
        const e = update.entry;
        insertEntry.run(update.known.sourceId, e.requestId, e.timestampMs, e.provider, e.model, e.inputTokens, e.outputTokens, e.cacheCreationTokens, e.cacheReadTokens, e.costUSD, e.cacheSavingsUSD, e.breakdown ? JSON.stringify(e.breakdown) : null);
        collectUsageBucketDeltas(bucketDeltas, update.known.sourceId, [update.previous], -1);
        collectUsageBucketDeltas(bucketDeltas, update.known.sourceId, [e], 1);
        this.database.prepare('UPDATE usage_identity SET fingerprint=? WHERE provider=? AND source_id=? AND request_id=?').run(executionFingerprint(e), e.provider, update.known.sourceId, e.requestId);
        const original = this.database.prepare('SELECT checkpoint_json FROM usage_source WHERE source_id=?').get(update.known.sourceId) as { checkpoint_json: string };
        const checkpoint = JSON.parse(original.checkpoint_json);
        if (checkpoint.resumeState) {
          const resume = JSON.parse(checkpoint.resumeState);
          const revised = reviseClaudePayload(resume.payload ?? {}, e.requestId, commit.batch.sessionProjection?.payload ?? {});
          if (revised) {
            resume.payload = revised; checkpoint.resumeState = JSON.stringify(resume);
            this.database.prepare('UPDATE usage_source SET checkpoint_json=? WHERE source_id=?').run(JSON.stringify(checkpoint), update.known.sourceId);
          }
        }
        const hot = this.database.prepare('SELECT payload_json FROM usage_session_hot WHERE source_id=?').get(update.known.sourceId) as { payload_json: string } | undefined;
        if (hot) {
          const revised = reviseClaudePayload(JSON.parse(hot.payload_json), e.requestId, commit.batch.sessionProjection?.payload ?? {});
          if (revised) this.database.prepare('UPDATE usage_session_hot SET payload_json=? WHERE source_id=?').run(JSON.stringify(revised), update.known.sourceId);
        }
      }
      for (const e of entriesToCommit) this.database.prepare('UPDATE usage_identity SET fingerprint=?, origin_id=? WHERE provider=? AND source_id=? AND request_id=?').run(executionFingerprint(e), e.identityOrigin ?? '', e.provider, commit.source.sourceId, e.requestId);
      this.applyBucketDeltas(bucketDeltas.values());

      if (commit.batch.sessionProjection === null
        || (commit.mode === 'rebuild' && commit.batch.sessionProjection === undefined)) {
        this.database.prepare('DELETE FROM usage_session_hot WHERE source_id = ?').run(commit.source.sourceId);
      } else if (commit.batch.sessionProjection) {
        const projection = canonicalSessionProjection(commit.batch.sessionProjection, owner);
        this.database.prepare(`
          INSERT INTO usage_session_hot (source_id, provider, updated_at, byte_size, payload_json)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(source_id) DO UPDATE SET
            provider = excluded.provider,
            updated_at = excluded.updated_at,
            byte_size = excluded.byte_size,
            payload_json = excluded.payload_json
        `).run(
          projection.sourceId,
          projection.provider,
          projection.updatedAt,
          projection.byteSize,
          JSON.stringify(projection.payload),
        );
      }
    });
  }

  async queryUsage(query: UsageQuery): Promise<UsageQueryData> {
    this.assertOpen();
    const aggregate = emptyUsageMetrics();
    const byProvider: Partial<Record<ProviderId, UsageMetrics>> = {};
    const modelMap = new Map<string, UsageModelTotal>();
    const bucketMap = new Map<number, UsageTimeBucketTotal>();

    const addContribution = (
      provider: ProviderId,
      modelName: string,
      bucketStartMs: number,
      metrics: UsageMetrics,
    ) => {
      addUsageMetrics(aggregate, metrics);
      byProvider[provider] ??= emptyUsageMetrics();
      addUsageMetrics(byProvider[provider]!, metrics);
      const modelKey = `${provider}\0${modelName}`;
      const model = modelMap.get(modelKey) ?? {
        provider,
        model: modelName,
        metrics: emptyUsageMetrics(),
      };
      addUsageMetrics(model.metrics, metrics);
      modelMap.set(modelKey, model);
      const bucket = bucketMap.get(bucketStartMs) ?? { bucketStartMs, metrics: emptyUsageMetrics() };
      addUsageMetrics(bucket.metrics, metrics);
      bucketMap.set(bucketStartMs, bucket);
    };

    const select = bucketQuerySql(query);
    const rows = this.database.prepare(select.sql).all(...select.params) as unknown as BucketRow[];
    for (const row of rows) {
      if (!isProviderId(row.provider) || !isBucketKind(row.bucket_kind)) {
        throw new Error('Invalid UsageIndex bucket identity');
      }
      addContribution(row.provider, row.model, row.bucket_start_ms, metricsFromBucketRow(row));
    }

    return {
      grain: query.grain,
      aggregate,
      byProvider,
      models: [...modelMap.values()].sort((a, b) => b.metrics.totalTokens - a.metrics.totalTokens),
      buckets: [...bucketMap.values()].sort((a, b) => a.bucketStartMs - b.bucketStartMs),
    };
  }

  async queryEntries(query: UsageEntryQuery): Promise<UsageEntry[]> {
    this.assertOpen();
    const { sql, params } = entryQuerySql(query);
    const rows = this.database.prepare(sql).all(...params) as unknown as EntryRow[];
    return rows.map(entryFromRow)
      .sort((a, b) => a.timestampMs - b.timestampMs || a.requestId.localeCompare(b.requestId));
  }

  async queryEntryProjection(query: UsageEntryQuery): Promise<UsageEntryProjection> {
    this.assertOpen();
    const count = entryQuerySql(query, 'COUNT(*) AS row_count');
    const countRow = this.database.prepare(count.sql).get(...count.params) as CountRow | undefined;
    const select = entryQuerySql(query, [
      'e.timestamp_ms',
      'e.provider',
      'e.model',
      'e.input_tokens',
      'e.output_tokens',
      'e.cache_creation_tokens',
      'e.cache_read_tokens',
      'e.cost_usd',
      'e.cache_savings_usd',
    ].join(', '));
    const statement = this.database.prepare(select.sql);
    const builder = new UsageEntryProjectionBuilder(countRow?.row_count ?? 0);
    const iterate = (statement as unknown as {
      iterate?: (...params: SQLInputValue[]) => Iterable<EntryProjectionRow>;
    }).iterate;

    if (typeof iterate === 'function') {
      for (const row of iterate.call(statement, ...select.params)) this.addEntryProjectionRow(builder, row);
    } else {
      for (const row of statement.all(...select.params) as unknown as EntryProjectionRow[]) {
        this.addEntryProjectionRow(builder, row);
      }
    }

    return builder.build();
  }

  async queryBreakdown(query: UsageBreakdownQuery): Promise<UsageBreakdownData> {
    this.assertOpen();
    const aggregate = emptyBreakdownDelta();
    const bucketMap = new Map<number, BreakdownDelta>();
    const addContribution = (bucketStartMs: number, breakdown: BreakdownDelta) => {
      addUsageBreakdown(aggregate, breakdown);
      const bucket = bucketMap.get(bucketStartMs) ?? emptyBreakdownDelta();
      addUsageBreakdown(bucket, breakdown);
      bucketMap.set(bucketStartMs, bucket);
    };

    const select = bucketQuerySql(query);
    const rows = this.database.prepare(select.sql).all(...select.params) as unknown as BucketRow[];
    for (const row of rows) {
      const breakdown = parseBreakdown(row.breakdown_json);
      if (breakdown) addContribution(row.bucket_start_ms, breakdown);
    }
    return {
      grain: query.grain,
      aggregate,
      buckets: [...bucketMap.entries()]
        .map(([bucketStartMs, breakdown]) => ({ bucketStartMs, breakdown }))
        .sort((a, b) => a.bucketStartMs - b.bucketStartMs),
    };
  }

  async readSessionProjections(sourceIds?: readonly string[]): Promise<UsageSessionProjection[]> {
    this.assertOpen();
    const params: SQLInputValue[] = [];
    let sql = 'SELECT * FROM usage_session_hot';
    if (sourceIds?.length) {
      sql += ` WHERE source_id IN (${sourceIds.map(() => '?').join(', ')})`;
      params.push(...sourceIds);
    } else if (sourceIds && sourceIds.length === 0) {
      return [];
    }
    sql += ' ORDER BY updated_at DESC';
    const rows = this.database.prepare(sql).all(...params) as unknown as SessionRow[];
    return rows.map(row => this.sessionProjectionFromRow(row));
  }

  async compact(nowMs: number): Promise<UsageCompactionResult> {
    this.assertOpen();
    const cutoffs = usageRetentionCutoffs(nowMs);
    let deletedRequestRows = 0;
    let deletedHourBuckets = 0;
    let deletedDayBuckets = 0;
    this.transaction(() => {
      deletedRequestRows = Number(this.database.prepare(
        'DELETE FROM usage_entry WHERE timestamp_ms < ?',
      ).run(cutoffs.requestMs).changes);
      deletedHourBuckets = Number(this.database.prepare(`
        DELETE FROM usage_bucket WHERE bucket_kind = 'hour' AND bucket_start_ms < ?
      `).run(cutoffs.hourMs).changes);
      deletedDayBuckets = Number(this.database.prepare(`
        DELETE FROM usage_bucket WHERE bucket_kind = 'day' AND bucket_start_ms < ?
      `).run(cutoffs.dayMs).changes);
      this.database.prepare(`
        UPDATE usage_source
        SET sealed_before_ms = ?
        WHERE sealed_before_ms IS NULL OR sealed_before_ms < ?
      `).run(cutoffs.requestMs, cutoffs.requestMs);
    });
    return { deletedRequestRows, deletedHourBuckets, deletedDayBuckets };
  }

  async reset(): Promise<void> {
    this.assertOpen();
    this.transaction(() => {
      this.database.prepare('DELETE FROM usage_source').run();
      this.database.exec('DELETE FROM usage_identity;');
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private initializeSchema(): void {
    const row = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
    let version = row.user_version;
    if (version === USAGE_INDEX_SCHEMA_VERSION) return;
    if (version === 4 || version === 5) {
      this.transaction(() => {
        if (version === 4) this.database.exec(EXECUTION_TABLES_SQL);
        else this.database.exec('CREATE INDEX IF NOT EXISTS usage_identity_owner ON usage_identity(provider, source_id, request_id)');
        // One-time checkpoint migration: retain the committed physical boundary, discard old parser state.
        const rows = this.database.prepare('SELECT source_id, checkpoint_json, provider_metadata_json FROM usage_source').all() as Array<{
          source_id: string; checkpoint_json: string; provider_metadata_json: string | null;
        }>;
        const update = this.database.prepare('UPDATE usage_source SET checkpoint_json=?, provider_metadata_json=? WHERE source_id=?');
        for (const row of rows) {
          const checkpoint = JSON.parse(row.checkpoint_json);
          if (typeof checkpoint.resumeState === 'string') {
            try {
              const previous = JSON.parse(checkpoint.resumeState);
              if (typeof previous.fingerprint === 'string') checkpoint.fingerprint = previous.fingerprint;
            } catch { /* A durable byte boundary is sufficient for a conservative bootstrap. */ }
          }
          delete checkpoint.resumeState;
          const metadata = row.provider_metadata_json ? JSON.parse(row.provider_metadata_json) : {};
          delete metadata.accountingIssues;
          delete metadata.inheritedKeys;
          update.run(JSON.stringify(checkpoint), JSON.stringify(metadata), row.source_id);
        }
        this.database.exec('DROP TABLE IF EXISTS usage_history_guard; DROP TABLE IF EXISTS usage_repair_receipt;');
        this.database.exec('PRAGMA user_version = 6');
      });
      return;
    }

    if (version === 2) {
      this.transaction(() => {
        this.database.exec('ALTER TABLE usage_source ADD COLUMN sealed_before_ms INTEGER');
        this.database.exec('PRAGMA user_version = 3');
      });
      version = 3;
    }

    if (version === 1) {
      this.transaction(() => {
        this.database.exec('ALTER TABLE usage_source ADD COLUMN sealed_before_ms INTEGER');
        this.database.exec(USAGE_BUCKET_TABLE_SQL);
        const entries = this.database.prepare('SELECT * FROM usage_entry').all() as unknown as EntryRow[];
        const bucketDeltas = new Map<string, UsageBucketDelta>();
        for (const entry of entries) {
          collectUsageBucketDeltas(bucketDeltas, entry.source_id, [entryFromRow(entry)], 1);
        }
        this.applyBucketDeltas(bucketDeltas.values());
        this.database.exec('PRAGMA user_version = 3');
      });
      version = 3;
    }

    if (version === 3) {
      this.migrateProviderConstraints();
      return;
    }

    if (version !== 0) {
      throw new Error(`Unsupported UsageIndex schema version ${version}`);
    }

    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE usage_source (
          source_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('file', 'remote')),
          parser_version INTEGER NOT NULL CHECK (parser_version >= 1),
          version_token TEXT NOT NULL,
          source_size INTEGER,
          mtime_ms REAL,
          checkpoint_json TEXT NOT NULL,
          provider_metadata_json TEXT,
          sealed_before_ms INTEGER
        ) STRICT;

        CREATE TABLE usage_source_project (
          source_id TEXT NOT NULL REFERENCES usage_source(source_id) ON DELETE CASCADE,
          project_key TEXT NOT NULL,
          PRIMARY KEY (source_id, project_key)
        ) STRICT;

        CREATE TABLE usage_entry (
          source_id TEXT NOT NULL REFERENCES usage_source(source_id) ON DELETE CASCADE,
          request_id TEXT NOT NULL,
          timestamp_ms INTEGER NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_creation_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL,
          cost_usd REAL NOT NULL,
          cache_savings_usd REAL NOT NULL,
          breakdown_json TEXT,
          PRIMARY KEY (source_id, request_id)
        ) STRICT;

        CREATE INDEX usage_entry_time_provider_model
          ON usage_entry(timestamp_ms, provider, model);

        ${USAGE_BUCKET_TABLE_SQL}

        CREATE TABLE usage_session_hot (
          source_id TEXT PRIMARY KEY REFERENCES usage_source(source_id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          byte_size INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        ) STRICT;

        ${EXECUTION_TABLES_SQL}
        PRAGMA user_version = ${USAGE_INDEX_SCHEMA_VERSION};
      `);
    });
  }

  private migrateProviderConstraints(): void {
    this.transaction(() => {
      this.database.exec(`
        DROP INDEX IF EXISTS usage_entry_time_provider_model;
        DROP INDEX IF EXISTS usage_bucket_time_provider_model;

        ALTER TABLE usage_source_project RENAME TO usage_source_project_v3;
        ALTER TABLE usage_entry RENAME TO usage_entry_v3;
        ALTER TABLE usage_bucket RENAME TO usage_bucket_v3;
        ALTER TABLE usage_session_hot RENAME TO usage_session_hot_v3;
        ALTER TABLE usage_source RENAME TO usage_source_v3;

        CREATE TABLE usage_source (
          source_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('file', 'remote')),
          parser_version INTEGER NOT NULL CHECK (parser_version >= 1),
          version_token TEXT NOT NULL,
          source_size INTEGER,
          mtime_ms REAL,
          checkpoint_json TEXT NOT NULL,
          provider_metadata_json TEXT,
          sealed_before_ms INTEGER
        ) STRICT;

        CREATE TABLE usage_source_project (
          source_id TEXT NOT NULL REFERENCES usage_source(source_id) ON DELETE CASCADE,
          project_key TEXT NOT NULL,
          PRIMARY KEY (source_id, project_key)
        ) STRICT;

        CREATE TABLE usage_entry (
          source_id TEXT NOT NULL REFERENCES usage_source(source_id) ON DELETE CASCADE,
          request_id TEXT NOT NULL,
          timestamp_ms INTEGER NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_creation_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL,
          cost_usd REAL NOT NULL,
          cache_savings_usd REAL NOT NULL,
          breakdown_json TEXT,
          PRIMARY KEY (source_id, request_id)
        ) STRICT;

        CREATE INDEX usage_entry_time_provider_model
          ON usage_entry(timestamp_ms, provider, model);

        ${USAGE_BUCKET_TABLE_SQL}

        CREATE TABLE usage_session_hot (
          source_id TEXT PRIMARY KEY REFERENCES usage_source(source_id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          byte_size INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        ) STRICT;

        INSERT INTO usage_source SELECT * FROM usage_source_v3;
        INSERT INTO usage_source_project SELECT * FROM usage_source_project_v3;
        INSERT INTO usage_entry SELECT * FROM usage_entry_v3;
        INSERT INTO usage_bucket SELECT * FROM usage_bucket_v3;
        INSERT INTO usage_session_hot SELECT * FROM usage_session_hot_v3;

        DROP TABLE usage_source_project_v3;
        DROP TABLE usage_entry_v3;
        DROP TABLE usage_bucket_v3;
        DROP TABLE usage_session_hot_v3;
        DROP TABLE usage_source_v3;

        ${EXECUTION_TABLES_SQL}
        PRAGMA user_version = ${USAGE_INDEX_SCHEMA_VERSION};
      `);
    });
  }

  private sessionProjectionFromRow(row: SessionRow): UsageSessionProjection {
    if (!isProviderId(row.provider)) throw new Error(`Invalid provider ${row.provider} in UsageIndex session`);
    return {
      sourceId: row.source_id,
      provider: row.provider,
      updatedAt: row.updated_at,
      byteSize: row.byte_size,
      payload: parseObjectJson(row.payload_json, 'session projection'),
    };
  }

  private applyBucketDeltas(deltas: Iterable<UsageBucketDelta>): void {
    applyUsageBucketDeltas(this.database, deltas);
  }

  private replaceProjects(source: UsageSourceDescriptor): void {
    this.database.prepare('DELETE FROM usage_source_project WHERE source_id = ?').run(source.sourceId);
    const insert = this.database.prepare(
      'INSERT INTO usage_source_project (source_id, project_key) VALUES (?, ?)',
    );
    for (const projectKey of source.projectKeys ?? []) insert.run(source.sourceId, projectKey);
  }

  private transaction(work: () => void): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SqliteUsageIndexStorage is closed');
  }

  private addEntryProjectionRow(builder: UsageEntryProjectionBuilder, row: EntryProjectionRow): void {
    if (!isProviderId(row.provider)) throw new Error(`Invalid provider ${row.provider} in UsageIndex entry`);
    builder.add({
      timestampMs: row.timestamp_ms,
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      cacheReadTokens: row.cache_read_tokens,
      costUSD: row.cost_usd,
      cacheSavingsUSD: row.cache_savings_usd,
    });
  }
}

export function usageIndexSchemaVersion(): number {
  return USAGE_INDEX_SCHEMA_VERSION;
}

/** Shared transactional bucket updater for ingestion and certified historical corrections. */
export function applyUsageBucketDeltas(database: DatabaseSync, deltas: Iterable<UsageBucketDelta>): void {
    const read = database.prepare(`
      SELECT * FROM usage_bucket
      WHERE source_id = ? AND provider = ? AND model = ?
        AND bucket_kind = ? AND bucket_start_ms = ?
    `);
    const remove = database.prepare(`
      DELETE FROM usage_bucket
      WHERE source_id = ? AND provider = ? AND model = ?
        AND bucket_kind = ? AND bucket_start_ms = ?
    `);
    const upsert = database.prepare(`
      INSERT INTO usage_bucket (
        source_id, provider, model, bucket_kind, bucket_start_ms,
        request_count, input_tokens, output_tokens, cache_creation_tokens,
        cache_read_tokens, total_tokens, cost_usd, cache_savings_usd, breakdown_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, provider, model, bucket_kind, bucket_start_ms) DO UPDATE SET
        request_count = excluded.request_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        total_tokens = excluded.total_tokens,
        cost_usd = excluded.cost_usd,
        cache_savings_usd = excluded.cache_savings_usd,
        breakdown_json = excluded.breakdown_json
    `);

    for (const delta of deltas) {
      const existing = read.get(
        delta.sourceId,
        delta.provider,
        delta.model,
        delta.kind,
        delta.bucketStartMs,
      ) as BucketRow | undefined;
      if (existing && (!isProviderId(existing.provider) || !isBucketKind(existing.bucket_kind))) {
        throw new Error(`Invalid UsageIndex bucket identity for ${delta.sourceId}`);
      }
      const metrics = existing ? metricsFromBucketRow(existing) : emptyUsageMetrics();
      const breakdown = existing ? parseBreakdown(existing.breakdown_json) ?? emptyBreakdownDelta() : emptyBreakdownDelta();
      addUsageMetrics(metrics, delta.metrics);
      addUsageBreakdown(breakdown, delta.breakdown);

      const metricValues = Object.values(metrics);
      const breakdownValues = Object.values(breakdown);
      if (!Number.isInteger(metrics.requestCount)
        || metricValues.some(value => !Number.isFinite(value) || value < -1e-9)
        || breakdownValues.some(value => !Number.isFinite(value) || value < -1e-9)) {
        throw new Error(`UsageIndex bucket delta underflow for ${delta.sourceId}`);
      }
      for (const key of Object.keys(metrics) as Array<keyof UsageMetrics>) {
        if (Math.abs(metrics[key]) < 1e-9) metrics[key] = 0;
      }
      for (const key of BREAKDOWN_KEYS) {
        if (Math.abs(breakdown[key]) < 1e-9) breakdown[key] = 0;
      }
      if (metrics.requestCount === 0) {
        remove.run(delta.sourceId, delta.provider, delta.model, delta.kind, delta.bucketStartMs);
        continue;
      }
      upsert.run(
        delta.sourceId,
        delta.provider,
        delta.model,
        delta.kind,
        delta.bucketStartMs,
        metrics.requestCount,
        metrics.inputTokens,
        metrics.outputTokens,
        metrics.cacheCreationTokens,
        metrics.cacheReadTokens,
        metrics.totalTokens,
        metrics.costUSD,
        metrics.cacheSavingsUSD,
        JSON.stringify(breakdown),
      );
    }
  }
