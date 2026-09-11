import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { USAGE_PRICE_REVISIONS, estimatePriceRevisionCost, type UsagePriceRevision } from '../modelPricing';
import { assertIntegrity, createBackup, hashFullState, hashNonCostState, sameNumber, syncExecutionPriceFingerprint } from './losslessCostReprice';
import { usageIndexSchemaVersion } from './sqliteUsageIndexStorage';
import { collectUsageBucketDeltas, usageBucketStart, type UsageBucketDelta } from './usageBucketAggregation';
import type { UsageEntry } from './types';

export interface PricingRevisionReport {
  revisionId: string;
  signature: string;
  completedAt: string;
  backupPath: string;
  matchedSources: number;
  preservedSources: number;
  preserved: Array<{ source: string; reason: 'no-retained-detail' | 'incomplete-buckets' }>;
  updatedEntries: number;
  updatedBuckets: number;
  updatedIdentityRows: number;
  beforeCostUSD: number;
  afterCostUSD: number;
  nonCostStateHash: string;
}

export interface PricingRevisionOptions {
  databasePath: string;
  backupDirectory: string;
  revisions?: readonly UsagePriceRevision[];
  dryRun?: boolean;
}

function signature(rule: UsagePriceRevision): string {
  return createHash('sha256').update(JSON.stringify(rule)).digest('hex');
}

function validateRules(rules: readonly UsagePriceRevision[]): void {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (!rule.id || ids.has(rule.id) || !rule.model || !rule.provider
      || !Number.isSafeInteger(rule.effectiveFromMs) || rule.effectiveFromMs < 0
      || (rule.effectiveUntilMs !== undefined && (!Number.isSafeInteger(rule.effectiveUntilMs)
        || rule.effectiveUntilMs <= rule.effectiveFromMs))
      || [rule.rates.input, rule.rates.output, rule.rates.cacheWrite, rule.rates.cacheRead]
        .some(rate => !Number.isFinite(rate) || rate < 0)) throw new Error('Invalid pricing revision');
    ids.add(rule.id);
  }
}

const ENTRY_QUERY = `SELECT request_id AS requestId, timestamp_ms AS timestampMs, provider, model,
  input_tokens AS inputTokens, output_tokens AS outputTokens, cache_creation_tokens AS cacheCreationTokens,
  cache_read_tokens AS cacheReadTokens, cost_usd AS costUSD, cache_savings_usd AS cacheSavingsUSD, breakdown_json AS breakdownJson
  FROM usage_entry WHERE source_id = ? AND provider = ? AND model = ? ORDER BY timestamp_ms, request_id`;

/** Applies declared price corrections from retained facts, never from reparsing raw logs. */
export function applyUsagePricingRevisions(options: PricingRevisionOptions): PricingRevisionReport[] {
  const rules = options.revisions ?? USAGE_PRICE_REVISIONS;
  validateRules(rules);
  const db = new DatabaseSync(options.databasePath, { timeout: 5000 });
  let inTransaction = false;
  try {
    db.exec('PRAGMA foreign_keys=ON');
    if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version !== usageIndexSchemaVersion()) {
      throw new Error('Open and migrate UsageIndex before applying pricing revisions');
    }
    const hasReceipts = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_pricing_revision'").get();
    const reports: PricingRevisionReport[] = [];
    const pending: UsagePriceRevision[] = [];
    for (const rule of rules) {
      const receipt = hasReceipts ? db.prepare('SELECT signature, report_json FROM usage_pricing_revision WHERE revision_id=?').get(rule.id) : undefined;
      if (!receipt) pending.push(rule);
      else {
        if (receipt.signature !== signature(rule)) throw new Error(`Completed pricing revision changed: ${rule.id}`);
        reports.push(JSON.parse(String(receipt.report_json)) as PricingRevisionReport);
      }
    }
    if (!pending.length) return reports;
    assertIntegrity(db, 'UsageIndex');
    const backupPath = path.join(options.backupDirectory, `usage-index-${Date.now()}-${process.pid}.sqlite`);
    const fullBefore = options.dryRun ? hashFullState(db) : createBackup(db, options.databasePath, backupPath);
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    if (hashFullState(db) !== fullBefore) throw new Error('UsageIndex changed while creating the pricing backup; retry before collection starts');
    const nonCostBefore = hashNonCostState(db);
    db.exec(`CREATE TABLE IF NOT EXISTS usage_pricing_revision (
      revision_id TEXT PRIMARY KEY, signature TEXT NOT NULL, report_json TEXT NOT NULL
    ) STRICT`);
    const updateEntry = db.prepare('UPDATE usage_entry SET cost_usd=?, cache_savings_usd=? WHERE source_id=? AND request_id=?');
    const updateBucket = db.prepare(`UPDATE usage_bucket SET cost_usd=?, cache_savings_usd=?
      WHERE source_id=? AND provider=? AND model=? AND bucket_kind=? AND bucket_start_ms=?`);
    const getBucket = db.prepare(`SELECT * FROM usage_bucket
      WHERE source_id=? AND provider=? AND model=? AND bucket_kind=? AND bucket_start_ms=?`);
    for (const rule of pending) {
      const report: PricingRevisionReport = {
        revisionId: rule.id, signature: signature(rule), completedAt: new Date().toISOString(),
        backupPath: options.dryRun ? '' : backupPath, matchedSources: 0, preservedSources: 0, preserved: [],
        updatedEntries: 0, updatedBuckets: 0, updatedIdentityRows: 0, beforeCostUSD: 0, afterCostUSD: 0, nonCostStateHash: nonCostBefore,
      };
      const upperMonth = rule.effectiveUntilMs === undefined ? Number.MAX_SAFE_INTEGER
        : usageBucketStart(rule.effectiveUntilMs - 1, 'month');
      const sources = db.prepare(`SELECT DISTINCT source_id FROM usage_bucket
        WHERE provider=? AND model=? AND bucket_kind='month' AND bucket_start_ms>=? AND bucket_start_ms<=?
        ORDER BY source_id`).all(rule.provider, rule.model, usageBucketStart(rule.effectiveFromMs, 'month'), upperMonth);
      report.matchedSources = sources.length;
      for (const source of sources) {
        const sourceId = String(source.source_id);
        const rows = db.prepare(ENTRY_QUERY).all(sourceId, rule.provider, rule.model) as unknown as Array<UsageEntry & { breakdownJson: string | null }>;
        const entries: UsageEntry[] = rows.map(({ breakdownJson, ...entry }) => ({ ...entry,
          ...(breakdownJson ? { breakdown: JSON.parse(breakdownJson) } : {}),
        }));
        const targeted = entries.filter(e => e.timestampMs >= rule.effectiveFromMs
          && (rule.effectiveUntilMs === undefined || e.timestampMs < rule.effectiveUntilMs));
        const sourceLabel = createHash('sha256').update(sourceId).digest('hex').slice(0, 16);
        if (!targeted.length) {
          report.preservedSources++;
          report.preserved.push({ source: sourceLabel, reason: 'no-retained-detail' });
          continue;
        }
        const oldBuckets = new Map<string, UsageBucketDelta>();
        const deltas = new Map<string, UsageBucketDelta>();
        collectUsageBucketDeltas(oldBuckets, sourceId, entries, 1);
        const priced = targeted.map(entry => ({ ...entry, ...estimatePriceRevisionCost(rule, entry) }));
        collectUsageBucketDeltas(deltas, sourceId, targeted, -1);
        collectUsageBucketDeltas(deltas, sourceId, priced, 1);
        const bucketUpdates: Array<{ delta: UsageBucketDelta; cost: number; savings: number }> = [];
        let complete = true;
        for (const [key, delta] of deltas) {
          const row = getBucket.get(sourceId, rule.provider, rule.model, delta.kind, delta.bucketStartMs);
          const expected = oldBuckets.get(key)?.metrics;
          if (!row || !expected || ![
            ['request_count', expected.requestCount], ['input_tokens', expected.inputTokens],
            ['output_tokens', expected.outputTokens], ['cache_creation_tokens', expected.cacheCreationTokens],
            ['cache_read_tokens', expected.cacheReadTokens], ['total_tokens', expected.totalTokens],
          ].every(([column, value]) => row[String(column)] === value)
            || !sameNumber(Number(row.cost_usd), expected.costUSD)
            || !sameNumber(Number(row.cache_savings_usd), expected.cacheSavingsUSD)) { complete = false; break; }
          const cost = Number(row.cost_usd) + delta.metrics.costUSD;
          const savings = Number(row.cache_savings_usd) + delta.metrics.cacheSavingsUSD;
          if (!Number.isFinite(cost) || !Number.isFinite(savings) || cost < -1e-9 || savings < -1e-9) {
            throw new Error('Invalid repriced bucket');
          }
          bucketUpdates.push({ delta, cost: Math.max(0, cost), savings: Math.max(0, savings) });
        }
        if (!complete) {
          report.preservedSources++;
          report.preserved.push({ source: sourceLabel, reason: 'incomplete-buckets' });
          continue;
        }
        for (let i = 0; i < targeted.length; i++) {
          const before = targeted[i]!, after = priced[i]!;
          report.beforeCostUSD += before.costUSD;
          report.afterCostUSD += after.costUSD;
          report.updatedIdentityRows += syncExecutionPriceFingerprint(db, sourceId, after);
          if (sameNumber(before.costUSD, after.costUSD) && sameNumber(before.cacheSavingsUSD, after.cacheSavingsUSD)) continue;
          updateEntry.run(after.costUSD, after.cacheSavingsUSD, sourceId, before.requestId);
          report.updatedEntries++;
        }
        for (const { delta, cost, savings } of bucketUpdates) {
          if (sameNumber(delta.metrics.costUSD, 0) && sameNumber(delta.metrics.cacheSavingsUSD, 0)) continue;
          updateBucket.run(cost, savings, sourceId, rule.provider, rule.model, delta.kind, delta.bucketStartMs);
          report.updatedBuckets++;
        }
      }
      db.prepare('INSERT INTO usage_pricing_revision VALUES (?,?,?)').run(rule.id, report.signature, JSON.stringify(report));
      reports.push(report);
    }
    if (hashNonCostState(db) !== nonCostBefore) throw new Error('Non-cost facts changed during pricing revision');
    assertIntegrity(db, 'Repriced UsageIndex');
    db.exec(options.dryRun ? 'ROLLBACK' : 'COMMIT');
    inTransaction = false;
    return reports;
  } finally {
    if (inTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
