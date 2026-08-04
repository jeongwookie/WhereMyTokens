import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import usageIndexModule from '../dist/main/usageIndex/index.js';
import modelPricingModule from '../dist/main/modelPricing.js';

const { SqliteUsageIndexStorage, repriceUsageIndexCosts } = usageIndexModule;
const { estimateUsageCost } = modelPricingModule;

function descriptor(sourceId, provider) {
  return {
    sourceId,
    provider,
    kind: 'file',
    parserVersion: 1,
    version: { token: 'fixture-v1', size: 100, mtimeMs: 100 },
  };
}

function entry(requestId, timestampMs, provider, model, costUSD) {
  return {
    requestId,
    timestampMs,
    provider,
    model,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 1_000_000,
    costUSD,
    cacheSavingsUSD: 0,
  };
}

async function commit(storage, source, entries) {
  await storage.commitSource({
    mode: 'rebuild',
    source,
    batch: {
      checkpoint: { byteOffset: 100 },
      entries,
      rebuildCoverage: { kind: 'full' },
    },
  });
}

function nonCostRows(database) {
  return {
    sources: database.prepare('SELECT * FROM usage_source ORDER BY source_id').all(),
    entries: database.prepare(`
      SELECT source_id, request_id, timestamp_ms, provider, model, input_tokens,
        output_tokens, cache_creation_tokens, cache_read_tokens, breakdown_json
      FROM usage_entry ORDER BY source_id, request_id
    `).all(),
    buckets: database.prepare(`
      SELECT source_id, provider, model, bucket_kind, bucket_start_ms, request_count,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        total_tokens, breakdown_json
      FROM usage_bucket ORDER BY source_id, provider, model, bucket_kind, bucket_start_ms
    `).all(),
  };
}

test('lossless repricing backs up first and changes only derived cost columns', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-reprice-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'usage-index.sqlite');
  const backupPath = path.join(tempDir, 'usage-index.backup.sqlite');
  const opusSource = descriptor('claude:opus-fixture', 'claude');
  const fableSource = descriptor('claude:fable-fixture', 'claude');
  const timestamp = Date.parse('2026-08-04T00:00:00Z');
  const oldOpus = entry('opus-r1', timestamp, 'claude', 'Opus', 91.5);
  const oldFable = entry('fable-r1', timestamp, 'claude', 'claude-fable-5', 18.3);
  const storage = new SqliteUsageIndexStorage(dbPath);
  await commit(storage, opusSource, [oldOpus]);
  await commit(storage, fableSource, [oldFable]);
  await storage.close();

  const before = new DatabaseSync(dbPath);
  const beforeNonCost = nonCostRows(before);
  before.close();
  const opusEstimate = estimateUsageCost({
    model: 'claude-opus-5',
    timestampMs: timestamp,
    inputTokens: oldOpus.inputTokens,
    outputTokens: oldOpus.outputTokens,
    cacheCreationTokens: oldOpus.cacheCreationTokens,
    cacheReadTokens: oldOpus.cacheReadTokens,
  });
  const replayedOpus = {
    ...oldOpus,
    costUSD: opusEstimate.costUSD,
    cacheSavingsUSD: opusEstimate.cacheSavingsUSD,
  };

  const report = await repriceUsageIndexCosts({
    databasePath: dbPath,
    backupPath,
    replaySource: async source => source.descriptor.sourceId === opusSource.sourceId
      ? [replayedOpus]
      : null,
  });
  assert.equal(report.applied, true);
  assert.equal(report.replayedSources, 1);
  assert.equal(report.preservedUnavailableSources, 0);
  assert.ok(report.updatedEntryRows > 0);
  assert.ok(report.updatedBucketRows > 0);

  const live = new DatabaseSync(dbPath);
  assert.deepEqual(nonCostRows(live), beforeNonCost);
  const liveCosts = live.prepare(`
    SELECT model, cost_usd FROM usage_bucket WHERE bucket_kind = 'month' ORDER BY model
  `).all();
  live.close();
  const backup = new DatabaseSync(backupPath);
  const backupCosts = backup.prepare(`
    SELECT model, cost_usd FROM usage_bucket WHERE bucket_kind = 'month' ORDER BY model
  `).all();
  backup.close();

  const expectedFable = estimateUsageCost({
    model: 'claude-fable-5',
    timestampMs: timestamp,
    inputTokens: oldFable.inputTokens,
    outputTokens: oldFable.outputTokens,
    cacheCreationTokens: oldFable.cacheCreationTokens,
    cacheReadTokens: oldFable.cacheReadTokens,
  });
  assert.deepEqual(liveCosts.map(row => row.model), ['Opus', 'claude-fable-5']);
  assert.ok(Math.abs(liveCosts[0].cost_usd - opusEstimate.costUSD) < 1e-10);
  assert.ok(Math.abs(liveCosts[1].cost_usd - expectedFable.costUSD) < 1e-10);
  assert.deepEqual(backupCosts.map(row => row.cost_usd), [91.5, 18.3]);
});

test('a replay token mismatch rolls back every proposed cost change', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-reprice-rollback-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'usage-index.sqlite');
  const backupPath = path.join(tempDir, 'usage-index.backup.sqlite');
  const source = descriptor('codex:gpt56-fixture', 'codex');
  const timestamp = Date.parse('2026-08-04T00:00:00Z');
  const old = entry('gpt-r1', timestamp, 'codex', 'GPT-5.6-SOL', 18.3);
  const storage = new SqliteUsageIndexStorage(dbPath);
  await commit(storage, source, [old]);
  await storage.close();

  await assert.rejects(
    repriceUsageIndexCosts({
      databasePath: dbPath,
      backupPath,
      replaySource: async () => [{ ...old, inputTokens: old.inputTokens + 1, costUSD: 1 }],
    }),
    /identity mismatch|token mismatch/,
  );
  const database = new DatabaseSync(dbPath);
  const row = database.prepare(`
    SELECT cost_usd FROM usage_bucket WHERE bucket_kind = 'month'
  `).get();
  database.close();
  assert.equal(row.cost_usd, 18.3);
  assert.equal(fs.existsSync(backupPath), true);
});
