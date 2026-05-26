import test from 'node:test';
import assert from 'node:assert/strict';

import queryModule from '../dist/main/usageLedgerUsage.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { computeUsageFromLedger, buildTrendDataFromLedger } = queryModule;
const { emptyUsageLedgerSnapshot, dayModelKey, hourProviderKey, minuteKey } = aggregates;

function agg(tokens, cost, calls = 1) {
  return {
    requestCount: calls,
    inputTokens: tokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: tokens,
    costUSD: cost,
    cacheSavingsUSD: 0,
  };
}

test('ledger usage query preserves current today, all-time, model, and hourly dimensions', () => {
  const now = Date.parse('2026-05-25T12:30:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(now - 60_000, 'claude', 'Sonnet')] = agg(100, 1.5);
  snapshot.hourlyActivity[hourProviderKey(now - 60_000, 'claude')] = agg(100, 1.5);
  snapshot.dailyModel[dayModelKey('2026-05-25', 'claude', 'Sonnet')] = agg(100, 1.5);
  snapshot.monthlyModel['2026-04|codex|GPT-5-CODEX'] = agg(200, 2.5);

  const usage = computeUsageFromLedger(snapshot, { h5: 200_000, week: 1_000_000, sonnetWeek: 1_000_000 }, {}, now);
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
