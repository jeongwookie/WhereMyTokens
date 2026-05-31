import test from 'node:test';
import assert from 'node:assert/strict';

import ingestModule from '../dist/main/usageLedgerIngest.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { importUsageEntriesIntoSnapshot } = ingestModule;
const { emptyUsageLedgerSnapshot, dayModelKey, monthModelKey } = aggregates;

function entry({
  id,
  timestamp = '2026-05-25T10:15:00.000Z',
  input = 10,
  output = 20,
  model = 'gemini-3-pro',
} = {}) {
  return {
    provider: 'antigravity',
    requestId: id,
    timestampMs: Date.parse(timestamp),
    model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: 2,
    cacheReadTokens: 3,
    costUSD: 0,
    cacheSavingsUSD: 0,
  };
}

function aggregateFor(usageEntry) {
  return {
    requestCount: 1,
    inputTokens: usageEntry.inputTokens,
    outputTokens: usageEntry.outputTokens,
    cacheCreationTokens: usageEntry.cacheCreationTokens,
    cacheReadTokens: usageEntry.cacheReadTokens,
    totalTokens: usageEntry.inputTokens + usageEntry.outputTokens + usageEntry.cacheCreationTokens + usageEntry.cacheReadTokens,
    costUSD: usageEntry.costUSD,
    cacheSavingsUSD: usageEntry.cacheSavingsUSD,
  };
}

test('generic usage ingest writes provider-keyed aggregates and source checkpoints', async () => {
  const nowMs = Date.parse('2026-05-25T12:00:00.000Z');
  const usageEntry = entry({ id: 'ag-request-1' });
  const next = await importUsageEntriesIntoSnapshot(emptyUsageLedgerSnapshot(), {
    provider: 'antigravity',
    sourceHash: 'ag-source-hash',
    sourceKey: 'antigravity:cascade:cascade-1',
  }, [{ entry: usageEntry, aggregate: aggregateFor(usageEntry) }], nowMs);

  assert.equal(next.dailyModel[dayModelKey('2026-05-25', 'antigravity', 'gemini-3-pro')].requestCount, 1);
  assert.equal(next.monthlyModel[monthModelKey('2026-05-25', 'antigravity', 'gemini-3-pro')].totalTokens, 35);
  assert.equal(next.sourceCheckpoints['ag-source-hash'].provider, 'antigravity');
  assert.equal(next.sourceCheckpoints['ag-source-hash'].sourceKey, 'antigravity:cascade:cascade-1');
  assert.equal('byteOffset' in next.sourceCheckpoints['ag-source-hash'], false);
});

test('generic usage ingest replaces duplicate recent requests with the larger output aggregate', async () => {
  const nowMs = Date.parse('2026-05-25T12:00:00.000Z');
  const first = entry({ id: 'ag-dup', output: 10 });
  const second = entry({ id: 'ag-dup', timestamp: '2026-05-25T10:16:00.000Z', output: 25 });
  const next = await importUsageEntriesIntoSnapshot(emptyUsageLedgerSnapshot(), {
    provider: 'antigravity',
    sourceHash: 'ag-source-hash',
    sourceKey: 'antigravity:cascade:cascade-1',
  }, [
    { entry: first, aggregate: aggregateFor(first) },
    { entry: second, aggregate: aggregateFor(second) },
  ], nowMs);

  const row = next.dailyModel[dayModelKey('2026-05-25', 'antigravity', 'gemini-3-pro')];
  assert.equal(row.requestCount, 1);
  assert.equal(row.outputTokens, 25);
});

test('generic usage ingest rejects entries from a different provider than the source', async () => {
  const nowMs = Date.parse('2026-05-25T12:00:00.000Z');
  const usageEntry = { ...entry({ id: 'wrong-provider' }), provider: 'claude' };

  await assert.rejects(
    importUsageEntriesIntoSnapshot(emptyUsageLedgerSnapshot(), {
      provider: 'antigravity',
      sourceHash: 'ag-source-hash',
      sourceKey: 'antigravity:cascade:cascade-1',
    }, [{ entry: usageEntry, aggregate: aggregateFor(usageEntry) }], nowMs),
    /Provider mismatch/,
  );
});
