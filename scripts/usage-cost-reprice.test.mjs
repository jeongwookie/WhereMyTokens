import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import usageIndexModule from '../dist/main/usageIndex/index.js';
import modelPricingModule from '../dist/main/modelPricing.js';
import claudeScannerModule from '../dist/main/providers/claude/usageIndexScanner.js';
import codexScannerModule from '../dist/main/providers/codex/usageIndexScanner.js';

const { SqliteUsageIndexStorage, repriceUsageIndexCosts } = usageIndexModule;
const { estimateUsageCost } = modelPricingModule;
const { createClaudeUsageIndexScanner } = claudeScannerModule;
const { createCodexUsageIndexScanner } = codexScannerModule;

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

test('bounded source replay reads only through the persisted checkpoint', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-reprice-bounded-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const timestamp = '2026-08-04T00:00:00.000Z';

  const claudePath = path.join(tempDir, 'claude.jsonl');
  const claudeLine = (id, outputTokens) => JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      id,
      model: 'claude-fable-5',
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  });
  const firstClaude = `${claudeLine('claude-first', 5)}\n`;
  fs.writeFileSync(claudePath, `${firstClaude}${claudeLine('claude-later', 9)}\n`);
  const claudeBatch = await createClaudeUsageIndexScanner(claudePath, {
    endOffsetExclusive: Buffer.byteLength(firstClaude),
  }).scan({
    mode: 'rebuild',
    source: descriptor('claude:bounded', 'claude'),
    checkpoint: null,
    previousSessionProjection: null,
  });
  assert.deepEqual(claudeBatch.entries.map(item => item.requestId), ['claude-first']);
  assert.equal(claudeBatch.checkpoint.byteOffset, Buffer.byteLength(firstClaude));

  const codexPath = path.join(tempDir, 'codex.jsonl');
  const sessionLine = `${JSON.stringify({
    type: 'session_meta',
    timestamp,
    payload: { model: 'gpt-5.6-sol' },
  })}\n`;
  const codexUsageLine = outputTokens => `${JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        model_context_window: 1_050_000,
        last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: outputTokens },
      },
    },
  })}\n`;
  const firstCodex = `${sessionLine}${codexUsageLine(5)}`;
  fs.writeFileSync(codexPath, `${firstCodex}${codexUsageLine(9)}`);
  const codexBatch = await createCodexUsageIndexScanner(codexPath, {
    endOffsetExclusive: Buffer.byteLength(firstCodex),
  }).scan({
    mode: 'rebuild',
    source: descriptor('codex:bounded', 'codex'),
    checkpoint: null,
    previousSessionProjection: null,
  });
  assert.equal(codexBatch.entries.length, 1);
  assert.equal(codexBatch.entries[0].outputTokens, 5);
  assert.equal(codexBatch.checkpoint.byteOffset, Buffer.byteLength(firstCodex));
});

test('a database change after backup creation aborts before repricing', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-reprice-race-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'usage-index.sqlite');
  const backupPath = path.join(tempDir, 'usage-index.backup.sqlite');
  const source = descriptor('claude:race-fixture', 'claude');
  const timestamp = Date.parse('2026-08-04T00:00:00Z');
  const old = entry('opus-race', timestamp, 'claude', 'Opus', 91.5);
  const storage = new SqliteUsageIndexStorage(dbPath);
  await commit(storage, source, [old]);
  await storage.close();

  const estimate = estimateUsageCost({
    model: 'claude-opus-5',
    timestampMs: timestamp,
    inputTokens: old.inputTokens,
    outputTokens: old.outputTokens,
    cacheCreationTokens: old.cacheCreationTokens,
    cacheReadTokens: old.cacheReadTokens,
  });
  await assert.rejects(
    repriceUsageIndexCosts({
      databasePath: dbPath,
      backupPath,
      replaySource: async () => {
        const concurrent = new DatabaseSync(dbPath);
        concurrent.prepare('UPDATE usage_source SET version_token = ? WHERE source_id = ?')
          .run('fixture-v2', source.sourceId);
        concurrent.close();
        return [{ ...old, costUSD: estimate.costUSD, cacheSavingsUSD: estimate.cacheSavingsUSD }];
      },
    }),
    /changed after backup creation/,
  );

  const live = new DatabaseSync(dbPath);
  const liveRow = live.prepare(`
    SELECT s.version_token, b.cost_usd
    FROM usage_source s JOIN usage_bucket b ON b.source_id = s.source_id
    WHERE b.bucket_kind = 'month'
  `).get();
  live.close();
  const backup = new DatabaseSync(backupPath);
  const backupSource = backup.prepare('SELECT version_token FROM usage_source').get();
  backup.close();
  assert.equal(liveRow.version_token, 'fixture-v2');
  assert.equal(liveRow.cost_usd, 91.5);
  assert.equal(backupSource.version_token, 'fixture-v1');
});
