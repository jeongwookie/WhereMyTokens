import test from 'node:test';
import assert from 'node:assert/strict';

import aggregates from '../dist/main/usageLedgerAggregates.js';
import usageLedgerUsage from '../dist/main/usageLedgerUsage.js';
import types from '../dist/main/usageLedgerTypes.js';

const {
  addUsageAggregate,
  subtractUsageAggregate,
  emptyUsageAggregate,
  emptyDailyBreakdownRow,
  emptyUsageLedgerSnapshot,
  minuteKey,
  hourProviderKey,
  dayModelKey,
  monthModelKey,
  compactUsageLedgerSnapshot,
} = aggregates;
const { computeUsageFromLedger } = usageLedgerUsage;
const { USAGE_LEDGER_SCHEMA_VERSION } = types;

function breakdownDelta(overrides = {}) {
  return {
    thinking: 1,
    response: 2,
    toolOutputRead: 0,
    toolOutputEditWrite: 0,
    toolOutputSearch: 0,
    toolOutputGit: 0,
    toolOutputBuildTest: 0,
    toolOutputTerminal: 0,
    toolOutputSubagents: 0,
    toolOutputWeb: 0,
    read: 3,
    editWrite: 4,
    search: 5,
    git: 6,
    buildTest: 7,
    terminal: 8,
    subagents: 9,
    web: 10,
    ...overrides,
  };
}

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

test('empty daily breakdown row and snapshot use v5 tool output shape', () => {
  const row = emptyDailyBreakdownRow('2026-06-16');
  assert.equal(row.toolOutputRead, 0);
  assert.equal(row.toolOutputEditWrite, 0);
  assert.equal(row.toolOutputTerminal, 0);
  assert.equal(emptyUsageLedgerSnapshot().schemaVersion, 5);
});

test('usage ledger key builders are stable strings', () => {
  assert.equal(minuteKey(1710000061000, 'claude', 'claude-sonnet-4'), '1710000060000|claude|claude-sonnet-4');
  assert.equal(hourProviderKey(1710003661000, 'codex'), '1710003600000|codex');
  assert.equal(dayModelKey('2026-05-25', 'codex', 'GPT-5-CODEX'), '2026-05-25|codex|GPT-5-CODEX');
  assert.equal(monthModelKey('2026-05-25', 'claude', 'claude-sonnet-4'), '2026-05|claude|claude-sonnet-4');
});

test('pace model quota targets populate duration bucket model windows', () => {
  const now = Date.parse('2026-06-01T04:00:00Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(now - 60_000, 'antigravity', 'Gemini 3 Pro')] = {
    requestCount: 1,
    inputTokens: 1000,
    outputTokens: 2000,
    cacheCreationTokens: 3000,
    cacheReadTokens: 4000,
    totalTokens: 10_000,
    costUSD: 0.1,
    cacheSavingsUSD: 0.2,
  };

  const usage = computeUsageFromLedger(
    snapshot,
    {},
    now,
    new Set(['antigravity']),
    {
      antigravity: {
        provider: 'antigravity',
        source: 'localRpc',
        capturedAt: now,
        status: { connected: true, code: 'connected' },
        models: [{
          model: 'MODEL_GEMINI_3_PRO',
          label: 'Gemini 3 Pro',
          usageModel: 'Gemini 3 Pro',
          remainingPct: 42,
          defaultMode: 'rich',
          visualKind: 'pace',
          durationMs: 5 * 60 * 60 * 1000,
          resetMs: 4 * 60 * 60 * 1000,
          statsWindowKey: 'model.MODEL_GEMINI_3_PRO',
        }],
      },
    },
  );

  assert.equal(usage.modelWindows.antigravity.windows.h5['Gemini 3 Pro'].totalTokens, 10_000);
});

test('compaction removes expired minute, request index, hourly, daily, breakdown, and source repair rows', () => {
  const now = Date.parse('2026-05-25T12:00:00Z');
  const delta = breakdownDelta();
  const snapshot = {
    schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
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
    dailyBreakdown: {
      '2025-05-24|claude': emptyDailyBreakdownRow('2025-05-24'),
      '2026-05-25|claude': emptyDailyBreakdownRow('2026-05-25'),
    },
    recentBreakdownIndex: {
      'source|old': { dailyBreakdownKey: '2025-05-24|claude', delta },
      'source|new': { dailyBreakdownKey: '2026-05-25|claude', delta },
    },
    breakdownStartedDate: '2026-05-20',
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
  assert.deepEqual(Object.keys(compacted.dailyBreakdown), ['2026-05-25|claude']);
  assert.deepEqual(Object.keys(compacted.recentBreakdownIndex), ['source|new']);
  assert.equal(compacted.breakdownStartedDate, '2026-05-20');
  assert.equal(Object.keys(compacted.sourceRepairRollup).length, 1);
  assert.equal(compacted.lastCompactedAt, now);
});

test('compaction keeps breakdown index for retained daily breakdown rows', () => {
  const now = Date.parse('2026-05-25T12:00:00Z');
  const delta = breakdownDelta();
  const snapshot = {
    ...emptyUsageLedgerSnapshot(),
    recentRequestIndex: {
      'source|old-request': {
        minuteKey: minuteKey(now - 9 * 24 * 60 * 60 * 1000, 'claude', 'old'),
        aggregate: emptyUsageAggregate(),
        lastSeenMs: now - 9 * 24 * 60 * 60 * 1000,
      },
    },
    dailyBreakdown: {
      '2026-05-10|claude': emptyDailyBreakdownRow('2026-05-10'),
    },
    recentBreakdownIndex: {
      'source|old-request': { dailyBreakdownKey: '2026-05-10|claude', delta },
    },
  };

  const compacted = compactUsageLedgerSnapshot(snapshot, now);

  assert.deepEqual(Object.keys(compacted.recentRequestIndex), []);
  assert.deepEqual(Object.keys(compacted.dailyBreakdown), ['2026-05-10|claude']);
  assert.deepEqual(Object.keys(compacted.recentBreakdownIndex), ['source|old-request']);
});
