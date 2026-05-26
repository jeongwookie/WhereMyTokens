import test from 'node:test';
import assert from 'node:assert/strict';

import aggregates from '../dist/main/usageLedgerAggregates.js';

const {
  addUsageAggregate,
  subtractUsageAggregate,
  emptyUsageAggregate,
  minuteKey,
  hourProviderKey,
  dayModelKey,
  monthModelKey,
  compactUsageLedgerSnapshot,
} = aggregates;

test('usage aggregate add and subtract preserve all token fields', () => {
  const target = emptyUsageAggregate();
  addUsageAggregate(target, {
    requestCount: 2,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 30,
    cacheReadTokens: 40,
    totalTokens: 100,
    costUSD: 1.25,
    cacheSavingsUSD: 0.75,
  });
  subtractUsageAggregate(target, {
    requestCount: 1,
    inputTokens: 4,
    outputTokens: 5,
    cacheCreationTokens: 6,
    cacheReadTokens: 7,
    totalTokens: 22,
    costUSD: 0.25,
    cacheSavingsUSD: 0.10,
  });
  assert.deepEqual(target, {
    requestCount: 1,
    inputTokens: 6,
    outputTokens: 15,
    cacheCreationTokens: 24,
    cacheReadTokens: 33,
    totalTokens: 78,
    costUSD: 1.0,
    cacheSavingsUSD: 0.65,
  });
});

test('usage ledger key builders are stable strings', () => {
  assert.equal(minuteKey(1710000061000, 'claude', 'claude-sonnet-4'), '1710000060000|claude|claude-sonnet-4');
  assert.equal(hourProviderKey(1710003661000, 'codex'), '1710003600000|codex');
  assert.equal(dayModelKey('2026-05-25', 'codex', 'GPT-5-CODEX'), '2026-05-25|codex|GPT-5-CODEX');
  assert.equal(monthModelKey('2026-05-25', 'claude', 'claude-sonnet-4'), '2026-05|claude|claude-sonnet-4');
});

test('compaction removes expired minute, request index, hourly, daily, and source repair rows', () => {
  const now = Date.parse('2026-05-25T12:00:00Z');
  const snapshot = {
    schemaVersion: 1,
    minuteRecent: {
      [minuteKey(now - 9 * 24 * 60 * 60 * 1000, 'claude', 'old')]: emptyUsageAggregate(),
      [minuteKey(now - 60_000, 'claude', 'new')]: emptyUsageAggregate(),
    },
    recentRequestIndex: {
      'source|old': { minuteKey: minuteKey(now - 9 * 24 * 60 * 60 * 1000, 'claude', 'old'), aggregate: emptyUsageAggregate(), lastSeenMs: now - 9 * 24 * 60 * 60 * 1000 },
      'source|new': { minuteKey: minuteKey(now - 60_000, 'claude', 'new'), aggregate: emptyUsageAggregate(), lastSeenMs: now - 60_000 },
    },
    hourlyActivity: {
      [hourProviderKey(now - 181 * 24 * 60 * 60 * 1000, 'claude')]: emptyUsageAggregate(),
      [hourProviderKey(now - 60 * 60 * 1000, 'claude')]: emptyUsageAggregate(),
    },
    dailyModel: {
      '2025-05-24|claude|old': emptyUsageAggregate(),
      '2026-05-25|claude|new': emptyUsageAggregate(),
    },
    monthlyModel: {},
    sourceCheckpoints: {},
    sourceRepairRollup: {
      [`source|${hourProviderKey(now - 31 * 24 * 60 * 60 * 1000, 'claude')}|model`]: emptyUsageAggregate(),
      [`source|${hourProviderKey(now - 60 * 60 * 1000, 'claude')}|model`]: emptyUsageAggregate(),
    },
    lastCompactedAt: 0,
  };
  const compacted = compactUsageLedgerSnapshot(snapshot, now);
  assert.equal(Object.keys(compacted.minuteRecent).length, 1);
  assert.equal(Object.keys(compacted.recentRequestIndex).length, 1);
  assert.equal(Object.keys(compacted.hourlyActivity).length, 1);
  assert.equal(Object.keys(compacted.dailyModel).length, 1);
  assert.equal(Object.keys(compacted.sourceRepairRollup).length, 1);
  assert.equal(compacted.lastCompactedAt, now);
});
