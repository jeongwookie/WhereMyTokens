import test from 'node:test';
import assert from 'node:assert/strict';

import queryModule from '../dist/main/usageLedgerUsage.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';
import ingestModule from '../dist/main/usageLedgerIngest.js';

const { computeUsageFromLedger, buildTrendDataFromLedger } = queryModule;
const { replaceProviderUsageSliceInSnapshot } = ingestModule;
const { emptyUsageLedgerSnapshot, dayModelKey, hourProviderKey, minuteKey, monthModelKey } = aggregates;

function agg(tokens, cost, calls = 1, overrides = {}) {
  return {
    requestCount: calls,
    inputTokens: overrides.inputTokens ?? tokens,
    outputTokens: overrides.outputTokens ?? 0,
    cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    totalTokens: overrides.totalTokens ?? tokens,
    costUSD: cost,
    cacheSavingsUSD: overrides.cacheSavingsUSD ?? 0,
  };
}

function weekLabel(dateKey) {
  const [, month, day] = dateKey.split('-').map(Number);
  return `${month}/${day}`;
}

test('ledger usage query preserves current today, all-time, model, and hourly dimensions', () => {
  const now = Date.parse('2026-05-25T12:30:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(now - 60_000, 'claude', 'Sonnet')] = agg(100, 1.5);
  snapshot.hourlyActivity[hourProviderKey(now - 60_000, 'claude')] = agg(100, 1.5);
  snapshot.dailyModel[dayModelKey('2026-05-25', 'claude', 'Sonnet')] = agg(100, 1.5);
  snapshot.monthlyModel['2026-04|codex|GPT-5-CODEX'] = agg(200, 2.5);

  const usage = computeUsageFromLedger(snapshot, {}, now);
  assert.equal(usage.todayTokens, 100);
  assert.equal(usage.todayCost, 1.5);
  assert.equal(usage.allTimeCost, 4.0);
  assert.equal(usage.models.length, 2);
  assert.equal(usage.heatmap.length, 1);
});

test('ledger trend query returns daily weekly and monthly rows', () => {
  const now = Date.parse('2026-05-25T12:30:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.dailyModel[dayModelKey('2026-05-25', 'claude', 'Sonnet')] = agg(100, 1.5);
  snapshot.dailyModel[dayModelKey('2026-05-24', 'codex', 'GPT-5-CODEX')] = agg(200, 2.5);
  snapshot.monthlyModel['2026-04|codex|GPT-5-CODEX'] = agg(300, 3.5);

  const trend = buildTrendDataFromLedger(snapshot, now);
  assert.ok(trend.daily.some(row => row.date === '2026-05-25' && row.tokens === 100));
  assert.ok(trend.weekly.length > 0);
  assert.ok(trend.monthly.some(row => row.month === '2026-04' && row.costUSD === 3.5));
});

test('ledger all-time totals keep full monthly aggregates at daily retention boundaries', () => {
  const now = Date.parse('2026-05-25T12:30:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.dailyModel[dayModelKey('2025-05-25', 'claude', 'Sonnet')] = agg(40, 0.4);
  snapshot.monthlyModel['2025-05|claude|Sonnet'] = agg(400, 4.0, 10);

  const usage = computeUsageFromLedger(snapshot, {}, now);

  assert.equal(usage.allTimeCost, 4.0);
  assert.equal(usage.allTimeRequestCount, 10);
  assert.equal(usage.models[0].tokens, 400);
});

test('ledger usage query filters aggregates by enabled provider set', () => {
  const now = Date.parse('2026-05-25T12:30:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(now - 60_000, 'claude', 'Sonnet')] = agg(100, 1.0);
  snapshot.minuteRecent[minuteKey(now - 60_000, 'codex', 'GPT-5-CODEX')] = agg(200, 2.0);
  snapshot.hourlyActivity[hourProviderKey(now - 60_000, 'claude')] = agg(100, 1.0);
  snapshot.hourlyActivity[hourProviderKey(now - 60_000, 'codex')] = agg(200, 2.0);
  snapshot.dailyModel[dayModelKey('2026-05-25', 'claude', 'Sonnet')] = agg(100, 1.0);
  snapshot.dailyModel[dayModelKey('2026-05-25', 'codex', 'GPT-5-CODEX')] = agg(200, 2.0);

  const usage = computeUsageFromLedger(snapshot, {}, now, new Set(['claude']));

  assert.equal(usage.todayTokens, 100);
  assert.equal(usage.todayCost, 1.0);
  assert.equal(usage.byProvider.claude.windows.h5.totalTokens, 100);
  assert.equal(usage.byProvider.codex.windows.h5.totalTokens, 0);
  assert.deepEqual(usage.models.map(model => model.provider), ['claude']);
  assert.equal(usage.heatmap.reduce((sum, bucket) => sum + bucket.tokens, 0), 100);
});

test('ledger usage visibility filter counts full enabled-provider usage', () => {
  const now = Date.parse('2026-05-25T12:30:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(now - 60_000, 'claude', 'claude-3-5-sonnet')] = agg(100, 1.0);
  snapshot.minuteRecent[minuteKey(now - 60_000, 'claude', 'claude-3-opus')] = agg(200, 2.0);
  snapshot.minuteRecent[minuteKey(now - 60_000, 'codex', 'gpt-5-codex')] = agg(300, 3.0);
  snapshot.hourlyActivity[hourProviderKey(now - 60_000, 'claude')] = agg(300, 3.0);
  snapshot.hourlyActivity[hourProviderKey(now - 60_000, 'codex')] = agg(300, 3.0);
  snapshot.dailyModel[dayModelKey('2026-05-25', 'claude', 'claude-3-5-sonnet')] = agg(100, 1.0);
  snapshot.dailyModel[dayModelKey('2026-05-25', 'claude', 'claude-3-opus')] = agg(200, 2.0);
  snapshot.dailyModel[dayModelKey('2026-05-25', 'codex', 'gpt-5-codex')] = agg(300, 3.0);

  const usage = computeUsageFromLedger(snapshot, {}, now, {
    providerScopes: new Set(['claude']),
  });

  assert.equal(usage.todayTokens, 300);
  assert.equal(usage.todayCost, 3.0);
  assert.equal(usage.byProvider.claude.windows.h5.totalTokens, 300);
  assert.equal(usage.byProvider.codex.windows.h5.totalTokens, 0);
  assert.deepEqual(usage.models.map(model => model.model), ['claude-3-opus', 'claude-3-5-sonnet']);
  assert.equal(usage.heatmap.reduce((sum, bucket) => sum + bucket.tokens, 0), 300);
  assert.equal(usage.todBuckets.reduce((sum, bucket) => sum + bucket.tokens, 0), 300);
});

test('ledger usage query exposes today cache efficiency and savings from daily aggregates', () => {
  const now = Date.parse('2026-05-25T12:30:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.dailyModel[dayModelKey('2026-05-25', 'claude', 'Sonnet')] = agg(500, 1.0, 2, {
    inputTokens: 100,
    cacheCreationTokens: 100,
    cacheReadTokens: 300,
    cacheSavingsUSD: 1.25,
  });
  snapshot.dailyModel[dayModelKey('2026-05-25', 'codex', 'GPT-5-CODEX')] = agg(400, 2.0, 3, {
    inputTokens: 100,
    cacheReadTokens: 300,
    cacheSavingsUSD: 2.25,
  });

  const usage = computeUsageFromLedger(snapshot, {}, now);

  assert.equal(usage.todayCacheTokens, 700);
  assert.equal(usage.todayCacheSavingsUSD, 3.5);
  assert.equal(usage.todayCacheEfficiency, 75);
});

test('ledger trend query filters rows by enabled provider set', () => {
  const now = Date.parse('2026-05-25T12:30:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.dailyModel[dayModelKey('2026-05-25', 'claude', 'Sonnet')] = agg(100, 1.0);
  snapshot.dailyModel[dayModelKey('2026-05-25', 'codex', 'GPT-5-CODEX')] = agg(200, 2.0);
  snapshot.monthlyModel['2026-05|claude|Sonnet'] = agg(100, 1.0);
  snapshot.monthlyModel['2026-05|codex|GPT-5-CODEX'] = agg(200, 2.0);

  const trend = buildTrendDataFromLedger(snapshot, now, new Set(['codex']));

  assert.deepEqual(trend.daily.map(row => row.tokens), [200]);
  assert.deepEqual(trend.monthly.map(row => row.costUSD), [2.0]);
});

test('ledger trend query filters rows by enabled provider scopes', () => {
  const now = Date.parse('2026-05-25T12:30:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.dailyModel[dayModelKey('2026-05-25', 'claude', 'claude-3-5-sonnet')] = agg(100, 1.0);
  snapshot.dailyModel[dayModelKey('2026-05-25', 'claude', 'claude-3-opus')] = agg(200, 2.0);
  snapshot.dailyModel[dayModelKey('2026-05-25', 'codex', 'gpt-5-codex')] = agg(300, 3.0);
  snapshot.monthlyModel['2026-05|claude|claude-3-5-sonnet'] = agg(100, 1.0);
  snapshot.monthlyModel['2026-05|claude|claude-3-opus'] = agg(200, 2.0);
  snapshot.monthlyModel['2026-05|codex|gpt-5-codex'] = agg(300, 3.0);

  const trend = buildTrendDataFromLedger(snapshot, now, {
    providerScopes: new Set(['codex']),
  });

  assert.deepEqual(trend.daily.map(row => row.tokens), [300]);
  assert.deepEqual(trend.monthly.map(row => row.costUSD), [3.0]);
});

test('ledger usage query exposes cached Antigravity model window stats', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const callTs = now - 60_000;
  const snapshot = emptyUsageLedgerSnapshot();
  const aggregate = agg(170, 0.12, 1, {
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 50,
    totalTokens: 170,
    cacheSavingsUSD: 0.05,
  });
  snapshot.minuteRecent[minuteKey(callTs, 'antigravity', 'Gemini 3 Pro')] = aggregate;
  snapshot.hourlyActivity[hourProviderKey(callTs, 'antigravity')] = aggregate;
  snapshot.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')] = aggregate;
  snapshot.monthlyModel[monthModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')] = aggregate;

  const providerQuotas = {
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: now,
      models: [
        {
          model: 'gemini-3-pro-high',
          label: 'Gemini 3 Pro (High)',
          usageModel: 'Gemini 3 Pro',
          statsWindowKey: 'model.gemini-3-pro-high',
          remainingPct: 80,
          resetMs: 4 * 60 * 60 * 1000,
          durationMs: 5 * 60 * 60 * 1000,
        },
      ],
    },
  };

  const usage = computeUsageFromLedger(snapshot, {}, now, undefined, providerQuotas);
  const modelWindow = usage.modelWindows.antigravity.windows.h5['Gemini 3 Pro'];

  assert.equal(modelWindow.inputTokens, 100);
  assert.equal(modelWindow.outputTokens, 20);
  assert.equal(modelWindow.cacheReadTokens, 50);
  assert.equal(modelWindow.totalTokens, 170);
  assert.equal(modelWindow.costUSD, 0.12);
});

test('ledger trend query remains idempotent after replacing the Antigravity provider slice twice', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const aggregate = agg(170, 0.12, 1, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    totalTokens: 170,
  });
  const slice = {
    provider: 'antigravity',
    minuteRecent: {},
    recentRequestIndex: {},
    hourlyActivity: {},
    dailyModel: {
      [dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')]: aggregate,
    },
    monthlyModel: {
      [monthModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')]: aggregate,
    },
    sourceCheckpoints: {
      'ag-cache-source': {
        provider: 'antigravity',
        sourceHash: 'ag-cache-source',
        sourceKey: 'antigravity:usage-cache',
        lastImportedAt: now,
        hasUsage: true,
      },
    },
    sourceRepairRollup: {},
  };

  const afterFirst = replaceProviderUsageSliceInSnapshot(emptyUsageLedgerSnapshot(), slice, now);
  const afterSecond = replaceProviderUsageSliceInSnapshot(afterFirst, slice, now);
  const trend = buildTrendDataFromLedger(afterSecond, now);

  assert.equal(trend.daily.at(-1).tokens, 170);
  assert.equal(trend.daily.at(-1).requestCount, 1);
});

test('ledger activity weekly timeline uses the same calendar-week buckets as trend weekly data', () => {
  const now = Date.parse('2026-05-26T12:30:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.dailyModel[dayModelKey('2026-05-17', 'claude', 'Sonnet')] = agg(1_000, 1.0);
  snapshot.dailyModel[dayModelKey('2026-05-18', 'claude', 'Sonnet')] = agg(100, 0.1);
  snapshot.dailyModel[dayModelKey('2026-05-24', 'claude', 'Sonnet')] = agg(200, 0.2);
  snapshot.dailyModel[dayModelKey('2026-05-25', 'claude', 'Sonnet')] = agg(300, 0.3);

  const usage = computeUsageFromLedger(snapshot, {}, now);
  const trend = buildTrendDataFromLedger(snapshot, now);
  const weeklyByLabel = new Map(usage.weeklyTimeline.map(row => [row.weekLabel, row.tokens]));
  const trendByLabel = new Map(trend.weekly.map(row => [weekLabel(row.weekStart), row.tokens]));

  assert.equal(weeklyByLabel.get('5/18'), trendByLabel.get('5/18'));
  assert.equal(weeklyByLabel.get('5/25'), trendByLabel.get('5/25'));
});
