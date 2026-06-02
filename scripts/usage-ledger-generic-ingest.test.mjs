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

test('generic usage ingest replaces duplicate recent requests when model or pricing changes', async () => {
  const nowMs = Date.parse('2026-05-25T12:00:00.000Z');
  const oldEntry = entry({ id: 'ag-repriced', model: 'Gemini Pro', output: 25 });
  const newEntry = {
    ...entry({ id: 'ag-repriced', model: 'Gemini 3.1 Pro (High)', output: 25 }),
    costUSD: 0.041626,
    cacheSavingsUSD: 0.019042,
  };
  const oldSnapshot = await importUsageEntriesIntoSnapshot(emptyUsageLedgerSnapshot(), {
    provider: 'antigravity',
    sourceHash: 'ag-source-hash',
    sourceKey: 'antigravity:cascade:cascade-1',
  }, [{ entry: oldEntry, aggregate: aggregateFor(oldEntry) }], nowMs);

  const next = await importUsageEntriesIntoSnapshot(oldSnapshot, {
    provider: 'antigravity',
    sourceHash: 'ag-source-hash',
    sourceKey: 'antigravity:cascade:cascade-1',
  }, [{ entry: newEntry, aggregate: aggregateFor(newEntry) }], nowMs);

  assert.equal(next.dailyModel[dayModelKey('2026-05-25', 'antigravity', 'Gemini Pro')], undefined);
  assert.equal(next.monthlyModel[monthModelKey('2026-05-25', 'antigravity', 'Gemini Pro')], undefined);
  const daily = next.dailyModel[dayModelKey('2026-05-25', 'antigravity', 'Gemini 3.1 Pro (High)')];
  const monthly = next.monthlyModel[monthModelKey('2026-05-25', 'antigravity', 'Gemini 3.1 Pro (High)')];
  assert.equal(daily.requestCount, 1);
  assert.equal(daily.outputTokens, 25);
  assert.equal(daily.costUSD, 0.041626);
  assert.equal(monthly.costUSD, 0.041626);
});

test('generic usage ingest skips entries already imported through a source cursor outside recent retention', async () => {
  const nowMs = Date.parse('2026-05-25T12:00:00.000Z');
  const oldEntry = entry({
    id: 'ag-old-cursor',
    timestamp: '2026-05-16T10:15:00.000Z',
    input: 100,
    output: 200,
  });
  const first = await importUsageEntriesIntoSnapshot(emptyUsageLedgerSnapshot(), {
    provider: 'antigravity',
    sourceHash: 'ag-source-hash',
    sourceKey: 'antigravity:cascade:cascade-1',
    cursor: oldEntry.requestId,
  }, [{ entry: oldEntry, aggregate: aggregateFor(oldEntry) }], nowMs);

  const second = await importUsageEntriesIntoSnapshot(first, {
    provider: 'antigravity',
    sourceHash: 'ag-source-hash',
    sourceKey: 'antigravity:cascade:cascade-1',
    cursor: oldEntry.requestId,
  }, [{ entry: oldEntry, aggregate: aggregateFor(oldEntry) }], nowMs);

  const daily = second.dailyModel[dayModelKey('2026-05-16', 'antigravity', 'gemini-3-pro')];
  const monthly = second.monthlyModel[monthModelKey('2026-05-16', 'antigravity', 'gemini-3-pro')];
  assert.equal(daily.requestCount, 1);
  assert.equal(monthly.requestCount, 1);
  assert.equal(monthly.totalTokens, 305);
});

test('generic usage ingest imports only entries after a saved source cursor', async () => {
  const nowMs = Date.parse('2026-05-25T12:00:00.000Z');
  const oldEntry = entry({ id: 'ag-cursor-old', timestamp: '2026-05-16T10:15:00.000Z', input: 10, output: 20 });
  const newEntry = entry({ id: 'ag-cursor-new', timestamp: '2026-05-16T10:16:00.000Z', input: 30, output: 40 });
  const first = await importUsageEntriesIntoSnapshot(emptyUsageLedgerSnapshot(), {
    provider: 'antigravity',
    sourceHash: 'ag-source-hash',
    sourceKey: 'antigravity:cascade:cascade-1',
    cursor: oldEntry.requestId,
  }, [{ entry: oldEntry, aggregate: aggregateFor(oldEntry) }], nowMs);

  const second = await importUsageEntriesIntoSnapshot(first, {
    provider: 'antigravity',
    sourceHash: 'ag-source-hash',
    sourceKey: 'antigravity:cascade:cascade-1',
    cursor: newEntry.requestId,
  }, [
    { entry: oldEntry, aggregate: aggregateFor(oldEntry) },
    { entry: newEntry, aggregate: aggregateFor(newEntry) },
  ], nowMs);

  const daily = second.dailyModel[dayModelKey('2026-05-16', 'antigravity', 'gemini-3-pro')];
  assert.equal(daily.requestCount, 2);
  assert.equal(daily.inputTokens, 40);
  assert.equal(daily.outputTokens, 60);
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

test('provider slice replacement is idempotent for Antigravity aggregates', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const usageEntry = entry({
    id: 'ag-slice-1',
    timestamp: '2026-06-01T10:15:00.000Z',
    input: 100,
    output: 200,
    model: 'Gemini 3 Pro',
  });
  const aggregate = aggregateFor(usageEntry);
  const slice = {
    provider: 'antigravity',
    minuteRecent: { [`${usageEntry.timestampMs - (usageEntry.timestampMs % 60000)}|antigravity|Gemini 3 Pro`]: aggregate },
    recentRequestIndex: {},
    hourlyActivity: { [`${usageEntry.timestampMs - (usageEntry.timestampMs % 3600000)}|antigravity`]: aggregate },
    dailyModel: { [dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')]: aggregate },
    monthlyModel: { [monthModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')]: aggregate },
    sourceCheckpoints: {
      'ag-cache-source': {
        provider: 'antigravity',
        sourceHash: 'ag-cache-source',
        sourceKey: 'antigravity:usage-cache',
        lastImportedAt: nowMs,
        hasUsage: true,
      },
    },
    sourceRepairRollup: {},
  };

  const first = ingestModule.replaceProviderUsageSliceInSnapshot(emptyUsageLedgerSnapshot(), slice, nowMs);
  const second = ingestModule.replaceProviderUsageSliceInSnapshot(first, slice, nowMs);

  assert.equal(second.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].requestCount, 1);
  assert.equal(second.monthlyModel[monthModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].totalTokens, 305);
});

test('provider slice replacement preserves other providers', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const claudeEntry = { ...entry({ id: 'claude-1', model: 'Claude Sonnet' }), provider: 'claude' };
  const base = await importUsageEntriesIntoSnapshot(emptyUsageLedgerSnapshot(), {
    provider: 'claude',
    sourceHash: 'claude-source',
    sourceKey: 'claude:file',
  }, [{ entry: claudeEntry, aggregate: aggregateFor(claudeEntry) }], nowMs);
  const slice = {
    provider: 'antigravity',
    minuteRecent: {},
    recentRequestIndex: {},
    hourlyActivity: {},
    dailyModel: {
      [dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')]: {
        requestCount: 1,
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
        totalTokens: 10,
        costUSD: 0.01,
        cacheSavingsUSD: 0.001,
      },
    },
    monthlyModel: {},
    sourceCheckpoints: {},
    sourceRepairRollup: {},
  };

  const next = ingestModule.replaceProviderUsageSliceInSnapshot(base, slice, nowMs);

  assert.equal(next.dailyModel[dayModelKey('2026-05-25', 'claude', 'Claude Sonnet')].requestCount, 1);
  assert.equal(next.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].totalTokens, 10);
});
