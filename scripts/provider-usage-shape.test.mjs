import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import usageWindows from '../dist/main/usageWindows.js';
import ledgerUsage from '../dist/main/usageLedgerUsage.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { computeUsage } = usageWindows;
const { computeUsageFromLedger } = ledgerUsage;
const { emptyUsageAggregate, emptyUsageLedgerSnapshot, dayModelKey, hourProviderKey, minuteKey, monthModelKey } = aggregates;

function usageEntry(provider, model, tokens, timestampMs, costUSD = 0, overrides = {}) {
  return {
    provider,
    requestId: `${provider}-${model}-${timestampMs}`,
    timestampMs,
    model,
    inputTokens: overrides.inputTokens ?? tokens,
    outputTokens: overrides.outputTokens ?? 0,
    cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    costUSD,
    cacheSavingsUSD: overrides.cacheSavingsUSD ?? 0,
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

function agg(tokens, costUSD = 0, requestCount = 1, overrides = {}) {
  return {
    requestCount,
    inputTokens: overrides.inputTokens ?? tokens,
    outputTokens: overrides.outputTokens ?? 0,
    cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    totalTokens: overrides.totalTokens ?? tokens,
    costUSD,
    cacheSavingsUSD: overrides.cacheSavingsUSD ?? 0,
  };
}

function quotaMetadata(now = Date.now()) {
  return {
    claude: {
      provider: 'claude',
      source: 'api',
      capturedAt: now,
      groups: [
        { key: 'account', label: 'Claude', defaultMode: 'rich', windowKeys: ['h5', 'week'] },
        { key: 'sonnet', label: 'Sonnet', defaultMode: 'simple', windowKeys: ['sonnetWeek'] },
      ],
      windowDisplay: {
        h5: { label: '5h', durationMs: 5 * 60 * 60 * 1000 },
        week: { label: '1w', durationMs: 7 * 24 * 60 * 60 * 1000 },
        sonnetWeek: { label: '1w', durationMs: 7 * 24 * 60 * 60 * 1000, modelIncludes: ['sonnet'] },
      },
    },
    codex: {
      provider: 'codex',
      source: 'api',
      capturedAt: now,
      groups: [
        { key: 'account', label: 'Codex', defaultMode: 'rich', windowKeys: ['h5', 'week'] },
      ],
      windowDisplay: {
        h5: { label: '5h', durationMs: 5 * 60 * 60 * 1000 },
        week: { label: '1w', durationMs: 7 * 24 * 60 * 60 * 1000 },
      },
    },
  };
}

function antigravityQuotaMetadata(now = Date.now()) {
  return {
    antigravity: {
      provider: 'antigravity',
      source: 'api',
      capturedAt: now,
      groups: [
        {
          key: 'gemini',
          label: 'Gemini',
          defaultMode: 'simple',
          windowKeys: ['geminiWeek'],
        },
      ],
      windowDisplay: {
        geminiWeek: { label: '1w', durationMs: 7 * 24 * 60 * 60 * 1000 },
      },
    },
  };
}

function antigravityQuotaMetadataWithWindowReset(now = Date.now()) {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  return {
    antigravity: {
      ...antigravityQuotaMetadata(now).antigravity,
      windows: {
        geminiWeek: { pct: 10, resetMs: weekMs - 60 * 60 * 1000, source: 'api' },
      },
    },
  };
}

function localDateKey(timestampMs) {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

test('provider quota metadata carries display groups without usage scopes', () => {
  const mainTypes = fs.readFileSync('src/main/providers/types.ts', 'utf8');
  const rendererTypes = fs.readFileSync('src/renderer/types.ts', 'utf8');
  const appSource = fs.readFileSync('src/renderer/App.tsx', 'utf8');
  const claudeQuota = fs.readFileSync('src/main/providers/claude/quota.ts', 'utf8');
  const codexQuota = fs.readFileSync('src/main/providers/codex/quota.ts', 'utf8');

  assert.doesNotMatch(mainTypes, /ProviderQuotaUsageScope|usageScope/);
  assert.doesNotMatch(rendererTypes, /ProviderQuotaUsageScope|usageScope/);
  assert.doesNotMatch(appSource, /normalizeQuotaUsageScope|usageScope/);
  assert.doesNotMatch(claudeQuota, /usageScope/);
  assert.doesNotMatch(codexQuota, /usageScope/);
});

test('usage window stats are driven by quota groups instead of Claude or Sonnet literals', () => {
  const summarySource = fs.readFileSync('src/main/usageWindows.ts', 'utf8');
  const ledgerSource = fs.readFileSync('src/main/usageLedgerUsage.ts', 'utf8');

  assert.match(summarySource, /buildProviderWindowTargets/);
  assert.match(ledgerSource, /buildProviderWindowTargets/);
  assert.doesNotMatch(summarySource, /entry\.provider === 'claude'/);
  assert.doesNotMatch(ledgerSource, /row\.provider === 'claude'/);
});

test('summary usage exposes provider-keyed windows without legacy top-level provider windows', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const usage = computeUsage([
      summary('claude', [usageEntry('claude', 'Sonnet', 100, now - 60_000)]),
      summary('codex', [usageEntry('codex', 'GPT-5-CODEX', 200, now - 60_000)]),
      summary('antigravity', [usageEntry('antigravity', 'gemini-3-pro', 300, now - 60_000)]),
    ], {}, undefined, quotaMetadata(now));

    assert.equal(usage.byProvider.claude.windows.h5.totalTokens, 100);
    assert.equal(usage.byProvider.claude.windows.week.totalTokens, 100);
    assert.equal(usage.byProvider.claude.windows.sonnetWeek.totalTokens, 100);
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

test('summary usage applies generic model filters for model-scoped quota windows', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const usage = computeUsage([
      summary('claude', [
        usageEntry('claude', 'claude-3-5-sonnet', 100, now - 60_000),
        usageEntry('claude', 'claude-3-opus', 200, now - 60_000),
      ]),
    ], {}, undefined, quotaMetadata(now));

    assert.equal(usage.byProvider.claude.windows.week.totalTokens, 300);
    assert.equal(usage.byProvider.claude.windows.sonnetWeek.totalTokens, 100);
  } finally {
    Date.now = originalNow;
  }
});

test('summary usage computes custom windows as provider-wide stats from provider quota metadata', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const usage = computeUsage([
      summary('antigravity', [
        usageEntry('antigravity', 'gemini-3-pro', 300, now - 60_000),
        usageEntry('antigravity', 'other-model', 500, now - 60_000),
      ]),
    ], {}, undefined, antigravityQuotaMetadata(now));

    assert.equal(usage.byProvider.antigravity.windows.geminiWeek.totalTokens, 800);
  } finally {
    Date.now = originalNow;
  }
});

test('summary usage visibility follows enabled providers instead of quota display modes', () => {
  const now = Date.now();
  const claude = summary('claude', [
    usageEntry('claude', 'claude-3-5-sonnet', 100, now - 60_000, 1),
    usageEntry('claude', 'claude-3-opus', 200, now - 60_000, 2),
  ]);
  claude.historicalRollup.aggregate = agg(300, 3, 2);
  claude.historicalRollup.modelTotals = {
    sonnet: { provider: 'claude', model: 'claude-3-5-sonnet', tokens: 50, costUSD: 0.5 },
    opus: { provider: 'claude', model: 'claude-3-opus', tokens: 250, costUSD: 2.5 },
  };
  claude.historicalRollup.hourlyBuckets = {
    hour: { ...agg(300, 3, 2), timestampMs: now - 24 * 60 * 60 * 1000 },
  };

  const codex = summary('codex', [
    usageEntry('codex', 'gpt-5-codex', 400, now - 60_000, 4),
  ]);
  codex.historicalRollup.aggregate = agg(400, 4, 1);
  codex.historicalRollup.modelTotals = {
    codex: { provider: 'codex', model: 'gpt-5-codex', tokens: 400, costUSD: 4 },
  };
  codex.historicalRollup.hourlyBuckets = {
    hour: { ...agg(400, 4, 1), timestampMs: now - 24 * 60 * 60 * 1000 },
  };

  const usage = computeUsage([claude, codex], {}, {
    providerScopes: new Set(['claude', 'codex']),
  });

  assert.equal(usage.todayTokens, 700);
  assert.equal(usage.todayCost, 7);
  assert.equal(usage.allTimeCost, 14);
  assert.deepEqual(usage.models.map(row => row.model), ['gpt-5-codex', 'claude-3-opus', 'claude-3-5-sonnet']);
  assert.equal(usage.byProvider.claude.windows.h5.totalTokens, 300);
  assert.equal(usage.byProvider.codex.windows.h5.totalTokens, 400);
  assert.equal(usage.heatmap30.reduce((sum, bucket) => sum + bucket.tokens, 0), 1400);
  assert.equal(usage.todBuckets.reduce((sum, bucket) => sum + bucket.tokens, 0), 1400);
  assert.equal(usage.weeklyTimeline.reduce((sum, week) => sum + week.tokens, 0), 1400);

  const claudeOnlyUsage = computeUsage([claude, codex], {}, {
    providerScopes: new Set(['claude']),
  });

  assert.equal(claudeOnlyUsage.todayTokens, 300);
  assert.equal(claudeOnlyUsage.byProvider.claude.windows.h5.totalTokens, 300);
  assert.equal(claudeOnlyUsage.byProvider.codex.windows.h5.totalTokens, 0);
});

test('ledger usage exposes provider-keyed windows without legacy top-level provider windows', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(now - 60_000, 'claude', 'Sonnet')] = agg(100);
  snapshot.minuteRecent[minuteKey(now - 60_000, 'codex', 'GPT-5-CODEX')] = agg(200);
  snapshot.minuteRecent[minuteKey(now - 60_000, 'antigravity', 'gemini-3-pro')] = agg(300);

  const usage = computeUsageFromLedger(snapshot, {}, now, undefined, quotaMetadata(now));

  assert.equal(usage.byProvider.claude.windows.h5.totalTokens, 100);
  assert.equal(usage.byProvider.claude.windows.week.totalTokens, 100);
  assert.equal(usage.byProvider.claude.windows.sonnetWeek.totalTokens, 100);
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

test('ledger usage applies generic model filters for model-scoped quota windows', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(now - 60_000, 'claude', 'claude-3-5-sonnet')] = agg(100);
  snapshot.minuteRecent[minuteKey(now - 60_000, 'claude', 'claude-3-opus')] = agg(200);

  const usage = computeUsageFromLedger(snapshot, {}, now, undefined, quotaMetadata(now));

  assert.equal(usage.byProvider.claude.windows.week.totalTokens, 300);
  assert.equal(usage.byProvider.claude.windows.sonnetWeek.totalTokens, 100);
});

test('ledger usage computes custom windows as provider-wide stats from provider quota metadata', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(now - 60_000, 'antigravity', 'gemini-3-pro')] = agg(300);
  snapshot.minuteRecent[minuteKey(now - 60_000, 'antigravity', 'other-model')] = agg(500);

  const usage = computeUsageFromLedger(snapshot, {}, now, undefined, antigravityQuotaMetadata(now));

  assert.equal(usage.byProvider.antigravity.windows.geminiWeek.totalTokens, 800);
});

test('custom provider windows use their own reset time for summary and ledger stats', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const summaryUsage = computeUsage([
      summary('antigravity', [
        usageEntry('antigravity', 'gemini-3-pro', 300, now - 30 * 60 * 1000),
        usageEntry('antigravity', 'other-model', 500, now - 2 * 60 * 60 * 1000),
      ]),
    ], {}, undefined, antigravityQuotaMetadataWithWindowReset(now));

    assert.equal(summaryUsage.byProvider.antigravity.windows.geminiWeek.totalTokens, 300);
  } finally {
    Date.now = originalNow;
  }

  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(now - 30 * 60 * 1000, 'antigravity', 'gemini-3-pro')] = agg(300);
  snapshot.minuteRecent[minuteKey(now - 2 * 60 * 60 * 1000, 'antigravity', 'other-model')] = agg(500);
  const ledgerUsage = computeUsageFromLedger(snapshot, {}, now, undefined, antigravityQuotaMetadataWithWindowReset(now));

  assert.equal(ledgerUsage.byProvider.antigravity.windows.geminiWeek.totalTokens, 300);
});

test('provider reset hints apply to generic provider windows', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const resetHints = { antigravity: { h5ResetMs: 4 * 60 * 60 * 1000, weekResetMs: null } };
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const summaryUsage = computeUsage([
      summary('antigravity', [usageEntry('antigravity', 'gemini-3-pro', 300, now - 2 * 60 * 60 * 1000)]),
    ], resetHints);

    assert.equal(summaryUsage.byProvider.antigravity.windows.h5.totalTokens, 0);
    assert.equal(summaryUsage.byProvider.antigravity.windows.week.totalTokens, 300);
  } finally {
    Date.now = originalNow;
  }

  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(now - 2 * 60 * 60 * 1000, 'antigravity', 'gemini-3-pro')] = agg(300);
  const ledger = computeUsageFromLedger(snapshot, resetHints, now);

  assert.equal(ledger.byProvider.antigravity.windows.h5.totalTokens, 0);
  assert.equal(ledger.byProvider.antigravity.windows.week.totalTokens, 300);
});

test('timed model quota windows count overlapping model names once', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const quotas = {
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: now,
      models: [
        {
          model: 'MODEL_GEMINI_3_PRO',
          label: 'Gemini 3 Pro',
          usageModel: 'Gemini 3 Pro',
          remainingPct: 80,
          resetMs: 4 * 60 * 60 * 1000,
          durationMs: 5 * 60 * 60 * 1000,
        },
        {
          model: 'MODEL_GEMINI_3_PRO_PREVIEW',
          label: 'Gemini 3 Pro Preview',
          usageModel: 'Gemini 3 Pro Preview',
          remainingPct: 70,
          resetMs: 4 * 60 * 60 * 1000,
          durationMs: 5 * 60 * 60 * 1000,
        },
      ],
    },
  };
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const summaryUsage = computeUsage([
      summary('antigravity', [
        usageEntry('antigravity', 'Gemini 3 Pro Preview', 300, now - 60_000),
      ]),
    ], {}, undefined, quotas);

    assert.equal(summaryUsage.byProvider.antigravity.windows.h5.totalTokens, 300);
  } finally {
    Date.now = originalNow;
  }

  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(now - 60_000, 'antigravity', 'Gemini 3 Pro Preview')] = agg(300);
  const ledger = computeUsageFromLedger(snapshot, {}, now, undefined, quotas);

  assert.equal(ledger.byProvider.antigravity.windows.h5.totalTokens, 300);
});

test('Antigravity cache efficiency includes uncached prompt tokens instead of reporting all cache reads as 100%', () => {
  const now = Date.now();
  const promptStats = {
    inputTokens: 8_500,
    outputTokens: 5_900,
    cacheCreationTokens: 0,
    cacheReadTokens: 167_200,
    totalTokens: 181_600,
  };
  const expectedEfficiency = (promptStats.cacheReadTokens / (promptStats.inputTokens + promptStats.cacheCreationTokens + promptStats.cacheReadTokens)) * 100;
  const summaryUsage = computeUsage([
    summary('antigravity', [
      usageEntry('antigravity', 'Gemini 3.1 Pro', promptStats.totalTokens, now - 60_000, 0.1211, promptStats),
    ]),
  ], {}, undefined, antigravityQuotaMetadata(now));

  assert.equal(Math.round(summaryUsage.todayCacheEfficiency), Math.round(expectedEfficiency));
  assert.equal(Math.round(summaryUsage.byProvider.antigravity.windows.geminiWeek.cacheEfficiency), Math.round(expectedEfficiency));

  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.dailyModel[dayModelKey(localDateKey(now), 'antigravity', 'Gemini 3.1 Pro')] = agg(promptStats.totalTokens, 0.1211, 1, promptStats);
  snapshot.minuteRecent[minuteKey(now - 60_000, 'antigravity', 'Gemini 3.1 Pro')] = agg(promptStats.totalTokens, 0.1211, 1, promptStats);

  const ledger = computeUsageFromLedger(snapshot, {}, now, undefined, antigravityQuotaMetadata(now));

  assert.equal(Math.round(ledger.todayCacheEfficiency), Math.round(expectedEfficiency));
  assert.equal(Math.round(ledger.byProvider.antigravity.windows.geminiWeek.cacheEfficiency), Math.round(expectedEfficiency));
});

test('ledger usage reads Antigravity aggregates written by generic ingest', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.dailyModel[dayModelKey('2026-05-25', 'antigravity', 'gemini-3-pro')] = agg(300);
  snapshot.monthlyModel[monthModelKey('2026-05-25', 'antigravity', 'gemini-3-pro')] = agg(300);
  snapshot.hourlyActivity[hourProviderKey(now - 60_000, 'antigravity')] = agg(300);
  snapshot.minuteRecent[minuteKey(now - 60_000, 'antigravity', 'gemini-3-pro')] = agg(300);

  const usage = computeUsageFromLedger(snapshot, {}, now);
  const model = usage.models.find(row => row.provider === 'antigravity' && row.model === 'gemini-3-pro');

  assert.equal(usage.allTimeRequestCount, 1);
  assert.equal(usage.todayTokens, 300);
  assert.equal(model?.tokens, 300);
  assert.equal(usage.byProvider.antigravity.windows.h5.totalTokens, 300);
  assert.equal(usage.byProvider.antigravity.windows.week.totalTokens, 300);
  assert.equal(usage.heatmap30.some(bucket => bucket.tokens === 300), true);
});
