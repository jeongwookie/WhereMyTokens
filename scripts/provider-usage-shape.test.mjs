import test from 'node:test';
import assert from 'node:assert/strict';

import usageWindows from '../dist/main/usageWindows.js';
import ledgerUsage from '../dist/main/usageLedgerUsage.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { computeUsage } = usageWindows;
const { computeUsageFromLedger } = ledgerUsage;
const { emptyUsageAggregate, emptyUsageLedgerSnapshot, dayModelKey, hourProviderKey, minuteKey, monthModelKey } = aggregates;

function usageEntry(provider, model, tokens, timestampMs) {
  return {
    provider,
    requestId: `${provider}-${model}-${timestampMs}`,
    timestampMs,
    model,
    inputTokens: tokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0,
    cacheSavingsUSD: 0,
  };
}

function summary(provider, entries) {
  return {
    provider,
    sessionSnapshot: {},
    recentEntries: entries,
    historicalRollup: {
      aggregate: emptyUsageAggregate(),
      modelTotals: {},
      hourlyBuckets: {},
    },
    byteOffset: 0,
    mtimeMs: 0,
    size: 0,
    lastAccessedAt: 0,
  };
}

function agg(tokens) {
  return {
    requestCount: 1,
    inputTokens: tokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: tokens,
    costUSD: 0,
    cacheSavingsUSD: 0,
  };
}

test('summary usage exposes provider-keyed windows without legacy top-level provider windows', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const usage = computeUsage([
      summary('claude', [usageEntry('claude', 'Sonnet', 100, now - 60_000)]),
      summary('codex', [usageEntry('codex', 'GPT-5-CODEX', 200, now - 60_000)]),
      summary('antigravity', [usageEntry('antigravity', 'gemini-3-pro', 300, now - 60_000)]),
    ], { h5: 200_000, week: 1_000_000, sonnetWeek: 1_000_000 });

    assert.equal(usage.byProvider.claude.windows.h5.totalTokens, 100);
    assert.equal(usage.byProvider.claude.windows.week.totalTokens, 100);
    assert.equal(usage.byProvider.claude.windows.sonnetWeek.totalTokens, 100);
    assert.equal(usage.byProvider.claude.burnRate.h5OutputPerMin, 0);
    assert.equal(usage.byProvider.codex.windows.h5.totalTokens, 200);
    assert.equal(usage.byProvider.codex.windows.week.totalTokens, 200);
    assert.equal(usage.byProvider.antigravity.windows.h5.totalTokens, 300);
    assert.equal(usage.byProvider.antigravity.windows.week.totalTokens, 300);
    assert.equal('h5' in usage, false);
    assert.equal('week' in usage, false);
    assert.equal('h5Codex' in usage, false);
    assert.equal('weekCodex' in usage, false);
    assert.equal('sonnetWeekTokens' in usage, false);
    assert.equal('burnRate' in usage, false);
  } finally {
    Date.now = originalNow;
  }
});

test('ledger usage exposes provider-keyed windows without legacy top-level provider windows', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(now - 60_000, 'claude', 'Sonnet')] = agg(100);
  snapshot.minuteRecent[minuteKey(now - 60_000, 'codex', 'GPT-5-CODEX')] = agg(200);
  snapshot.minuteRecent[minuteKey(now - 60_000, 'antigravity', 'gemini-3-pro')] = agg(300);

  const usage = computeUsageFromLedger(snapshot, { h5: 200_000, week: 1_000_000, sonnetWeek: 1_000_000 }, {}, now);

  assert.equal(usage.byProvider.claude.windows.h5.totalTokens, 100);
  assert.equal(usage.byProvider.claude.windows.week.totalTokens, 100);
  assert.equal(usage.byProvider.claude.windows.sonnetWeek.totalTokens, 100);
  assert.equal(usage.byProvider.claude.burnRate.h5OutputPerMin, 0);
  assert.equal(usage.byProvider.codex.windows.h5.totalTokens, 200);
  assert.equal(usage.byProvider.codex.windows.week.totalTokens, 200);
  assert.equal(usage.byProvider.antigravity.windows.h5.totalTokens, 300);
  assert.equal(usage.byProvider.antigravity.windows.week.totalTokens, 300);
  assert.equal('h5' in usage, false);
  assert.equal('week' in usage, false);
  assert.equal('h5Codex' in usage, false);
  assert.equal('weekCodex' in usage, false);
  assert.equal('sonnetWeekTokens' in usage, false);
  assert.equal('burnRate' in usage, false);
});

test('ledger usage reads Antigravity aggregates written by generic ingest', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.dailyModel[dayModelKey('2026-05-25', 'antigravity', 'gemini-3-pro')] = agg(300);
  snapshot.monthlyModel[monthModelKey('2026-05-25', 'antigravity', 'gemini-3-pro')] = agg(300);
  snapshot.hourlyActivity[hourProviderKey(now - 60_000, 'antigravity')] = agg(300);
  snapshot.minuteRecent[minuteKey(now - 60_000, 'antigravity', 'gemini-3-pro')] = agg(300);

  const usage = computeUsageFromLedger(snapshot, { h5: 200_000, week: 1_000_000, sonnetWeek: 1_000_000 }, {}, now);
  const model = usage.models.find(row => row.provider === 'antigravity' && row.model === 'gemini-3-pro');

  assert.equal(usage.allTimeRequestCount, 1);
  assert.equal(usage.todayTokens, 300);
  assert.equal(model?.tokens, 300);
  assert.equal(usage.byProvider.antigravity.windows.h5.totalTokens, 300);
  assert.equal(usage.byProvider.antigravity.windows.week.totalTokens, 300);
  assert.equal(usage.heatmap30.some(bucket => bucket.tokens === 300), true);
});
