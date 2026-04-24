import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import stateManagerModule from '../dist/main/stateManager.js';
import * as jsonlCacheModule from '../dist/main/jsonlCache.js';

const { StateManager } = stateManagerModule;
const { JsonlCache } = jsonlCacheModule;

function makeStore(overrides = {}) {
  const values = { ...overrides };
  return {
    store: {},
    get(key, fallback = null) {
      return key in values ? values[key] : fallback;
    },
    set(key, value) {
      values[key] = value;
    },
  };
}

test('cached Claude percentages with null resets expire instead of surviving forever', () => {
  const manager = new StateManager(makeStore({
    _cachedApiPct: {
      h5Pct: 63,
      weekPct: 41,
      soPct: 7,
      h5ResetMs: null,
      weekResetMs: null,
      soResetMs: null,
      plan: 'Max 5x',
      extraUsage: null,
      storedAt: Date.now() - (31 * 60 * 1000),
    },
  }), () => {});

  const limits = manager.buildLimits();

  assert.equal(limits.h5.pct, 0);
  assert.equal(limits.week.pct, 0);
  assert.equal(limits.so.pct, 0);
});

test('offline Claude windows fall back to live status-line resets when API reset is unavailable', () => {
  const manager = new StateManager(makeStore(), () => {});
  manager.apiConnected = false;
  manager.apiUsagePct = {
    h5Pct: 58,
    weekPct: 21,
    soPct: 4,
    h5ResetMs: null,
    weekResetMs: null,
    soResetMs: null,
    plan: 'Max 5x',
    extraUsage: null,
  };
  manager.liveSession = {
    _ts: Date.now(),
    rate_limits: {
      five_hour: { used_percentage: 17, resets_at: Date.now() + 15 * 60 * 1000 },
      seven_day: { used_percentage: 33, resets_at: Date.now() + 6 * 60 * 60 * 1000 },
    },
  };

  const limits = manager.buildLimits();

  assert.equal(limits.h5.source, 'statusLine');
  assert.equal(limits.week.source, 'statusLine');
  assert.equal(limits.h5.pct, 17);
  assert.equal(limits.week.pct, 33);
  assert.ok((limits.h5.resetMs ?? 0) > 0);
  assert.ok((limits.week.resetMs ?? 0) > 0);
  assert.equal(limits.so.resetLabel, 'Claude Sonnet reset unavailable');
});

test('missing bridge rate-limit windows do not zero out cached Claude API data', () => {
  const manager = new StateManager(makeStore(), () => {});
  manager.apiConnected = false;
  manager.apiUsagePct = {
    h5Pct: 58,
    weekPct: 21,
    soPct: 4,
    h5ResetMs: 15 * 60 * 1000,
    weekResetMs: 6 * 60 * 60 * 1000,
    soResetMs: null,
    plan: 'Max 5x',
    extraUsage: null,
  };
  manager.liveSession = {
    _ts: Date.now(),
    rate_limits: {},
  };

  const limits = manager.buildLimits();

  assert.equal(limits.h5.pct, 58);
  assert.equal(limits.h5.source, 'cache');
  assert.equal(limits.week.pct, 21);
  assert.equal(limits.week.source, 'cache');
});

test('stale status-line fallback does not linger as cached Claude API data', () => {
  const manager = new StateManager(makeStore(), () => {});
  manager.apiConnected = false;
  manager.apiUsagePct = null;
  manager.state = {
    ...manager.getState(),
    limits: {
      ...manager.getState().limits,
      h5: { pct: 42, resetMs: 60_000, source: 'statusLine' },
      week: { pct: 18, resetMs: 120_000, source: 'statusLine' },
      so: { pct: 0, resetMs: null, source: 'statusLine' },
    },
  };
  manager.liveSession = {
    _ts: Date.now() - 301_000,
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: Date.now() + 60_000 },
      seven_day: { used_percentage: 18, resets_at: Date.now() + 120_000 },
    },
  };

  const limits = manager.buildLimits();

  assert.equal(limits.h5.pct, 0);
  assert.equal(limits.h5.source, undefined);
  assert.equal(limits.week.pct, 0);
  assert.equal(limits.week.source, undefined);
});

test('stale Codex local-log windows do not linger after rate limits disappear', () => {
  const manager = new StateManager(makeStore(), () => {});
  manager.codexRateLimits = null;
  manager.state = {
    ...manager.getState(),
    limits: {
      ...manager.getState().limits,
      codexH5: { pct: 66, resetMs: 60_000, source: 'localLog' },
      codexWeek: { pct: 27, resetMs: 120_000, source: 'localLog' },
    },
  };

  const limits = manager.buildLimits();

  assert.equal(limits.codexH5.pct, 0);
  assert.equal(limits.codexH5.source, undefined);
  assert.equal(limits.codexWeek.pct, 0);
  assert.equal(limits.codexWeek.source, undefined);
});

test('offline live fallback also drives Claude usage windows', () => {
  const manager = new StateManager(makeStore(), () => {});
  const now = Date.now();
  manager.apiConnected = false;
  manager.apiUsagePct = {
    h5Pct: 58,
    weekPct: 21,
    soPct: 4,
    h5ResetMs: 60 * 60 * 1000,
    weekResetMs: 6 * 60 * 60 * 1000,
    soResetMs: null,
    plan: 'Max 5x',
    extraUsage: null,
  };
  manager.liveSession = {
    _ts: now,
    rate_limits: {
      five_hour: { used_percentage: 17, resets_at: now + (4.5 * 60 * 60 * 1000) },
      seven_day: { used_percentage: 33, resets_at: now + (6 * 24 * 60 * 60 * 1000) },
    },
  };
  manager.summaries = new Map([[
    'test-claude',
    {
      provider: 'claude',
      sessionSnapshot: {
        modelName: '',
        rawModel: '',
        latestInputTokens: 0,
        latestCacheCreationTokens: 0,
        latestCacheReadTokens: 0,
        toolCounts: {},
        activityBreakdown: {
          read: 0, editWrite: 0, search: 0, git: 0, buildTest: 0,
          terminal: 0, thinking: 0, response: 0, subagents: 0, web: 0,
        },
        activityBreakdownKind: 'tokens',
      },
      recentEntries: [{
        requestId: 'req-1',
        timestampMs: now - (2 * 60 * 60 * 1000),
        model: 'claude-sonnet',
        provider: 'claude',
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUSD: 1,
        cacheSavingsUSD: 0,
      }],
      historicalRollup: {
        aggregate: {
          requestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          costUSD: 0,
          cacheSavingsUSD: 0,
        },
        modelTotals: {},
        hourlyBuckets: {},
      },
      byteOffset: 0,
      pendingBytes: 0,
      mtimeMs: now,
      size: 1,
      lastAccessedAt: now,
    },
  ]]);

  const derived = manager.computeDerivedUsage(manager.getState().settings);

  assert.equal(derived.limits.h5.source, 'statusLine');
  assert.equal(derived.usage.h5.requestCount, 0);
});

test('Sonnet stays on the last valid sample when the new API payload only loses the optional Sonnet block', () => {
  const manager = new StateManager(makeStore(), () => {});
  const now = Date.now();
  manager.apiUsagePct = {
    h5Pct: 58,
    weekPct: 21,
    soPct: 12,
    h5ResetMs: 15 * 60 * 1000,
    weekResetMs: 6 * 60 * 60 * 1000,
    soResetMs: 45 * 60 * 1000,
    plan: 'Max 5x',
    extraUsage: null,
  };
  manager.apiUsagePctStoredAt = now;

  const merged = manager.mergeApiUsageSample({
    h5Pct: 59,
    weekPct: 22,
    soPct: 0,
    h5ResetMs: 10 * 60 * 1000,
    weekResetMs: 5 * 60 * 60 * 1000,
    soResetMs: null,
    plan: 'Max 5x',
    extraUsage: null,
  }, {
    code: 'reset-unavailable',
    connected: true,
    label: 'reset partial',
    detail: 'seven_day_sonnet reset is unavailable.',
  }, now);

  assert.equal(merged.soPct, 12);
  assert.equal(merged.soResetMs, 45 * 60 * 1000);
});

test('Sonnet fallback does not indefinitely preserve samples without a reset time', () => {
  const manager = new StateManager(makeStore(), () => {});
  const now = Date.now();
  manager.apiUsagePct = {
    h5Pct: 58,
    weekPct: 21,
    soPct: 12,
    h5ResetMs: 15 * 60 * 1000,
    weekResetMs: 6 * 60 * 60 * 1000,
    soResetMs: null,
    plan: 'Max 5x',
    extraUsage: null,
  };
  manager.apiUsagePctStoredAt = now;

  const merged = manager.mergeApiUsageSample({
    h5Pct: 59,
    weekPct: 22,
    soPct: 0,
    h5ResetMs: 10 * 60 * 1000,
    weekResetMs: 5 * 60 * 60 * 1000,
    soResetMs: null,
    plan: 'Max 5x',
    extraUsage: null,
  }, {
    code: 'reset-unavailable',
    connected: true,
    label: 'reset partial',
    detail: 'seven_day_sonnet reset is unavailable.',
  }, now);

  assert.equal(merged.soPct, 0);
  assert.equal(merged.soResetMs, null);
});

test('in-memory null-reset samples also age out after later API loss', () => {
  const manager = new StateManager(makeStore(), () => {});
  manager.apiUsagePct = {
    h5Pct: 61,
    weekPct: 44,
    soPct: 9,
    h5ResetMs: null,
    weekResetMs: null,
    soResetMs: null,
    plan: 'Max 5x',
    extraUsage: null,
  };
  manager.apiUsagePctStoredAt = Date.now() - (31 * 60 * 1000);
  manager.apiConnected = false;

  const limits = manager.buildLimits();

  assert.equal(limits.h5.pct, 0);
  assert.equal(limits.week.pct, 0);
  assert.equal(limits.so.pct, 0);
});

test('persisted summary cache rejects malformed nested rollups', () => {
  const cache = new JsonlCache();
  const malformed = cache.hydratePersistedEntry({
    version: 2,
    summary: {
      provider: 'claude',
      sessionSnapshot: {
        modelName: '',
        rawModel: '',
        latestInputTokens: 0,
        latestCacheCreationTokens: 0,
        latestCacheReadTokens: 0,
        toolCounts: {},
        activityBreakdown: {
          read: 0, editWrite: 0, search: 0, git: 0, buildTest: 0,
          terminal: 0, thinking: 0, response: 0, subagents: 0, web: 0,
        },
        activityBreakdownKind: 'tokens',
      },
      recentEntries: [],
      historicalRollup: {
        aggregate: {
          requestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          costUSD: 0,
          cacheSavingsUSD: 0,
        },
        modelTotals: { broken: null },
        hourlyBuckets: {},
      },
      byteOffset: 0,
      pendingBytes: 0,
      mtimeMs: 1,
      size: 1,
      lastAccessedAt: Date.now(),
    },
  });

  cache.clearAll();
  assert.equal(malformed, null);
});

test('startup recovery and persisted summary cache guards remain in source', () => {
  const appSource = fs.readFileSync(path.resolve('src', 'renderer', 'App.tsx'), 'utf8');
  const cacheSource = fs.readFileSync(path.resolve('src', 'main', 'jsonlCache.ts'), 'utf8');
  const parserSource = fs.readFileSync(path.resolve('src', 'main', 'jsonlParser.ts'), 'utf8');

  assert.match(appSource, /BOOT_FALLBACK_DELAY_MS/);
  assert.match(appSource, /Startup Recovery/);
  assert.match(cacheSource, /PERSISTED_SCHEMA_VERSION = 2/);
  assert.match(cacheSource, /pendingText: undefined/);
  assert.match(cacheSource, /version: PERSISTED_SCHEMA_VERSION/);
  assert.match(parserSource, /pendingBytes/);
});

test('session discovery keeps recent-active scope and tracked session hints in source', () => {
  const discoverySource = fs.readFileSync(path.resolve('src', 'main', 'sessionDiscovery.ts'), 'utf8');

  assert.match(discoverySource, /SessionDiscoveryScope = 'recent-active' \| 'all'/);
  assert.match(discoverySource, /trackedJsonlPaths\?: string\[\]/);
  assert.match(discoverySource, /discoverSessions\(provider: TrackingProvider = 'both', options: DiscoverSessionsOptions = \{\}\)/);
  assert.match(discoverySource, /dedupeDiscoveredSessions/);
});

test('visible fast refresh stays on cached session scope and logs anomalies', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const fastStart = source.indexOf('private async fastRefresh');
  const fastEnd = source.indexOf('private async refreshGitStatsAfterStartup');
  const fastBody = source.slice(fastStart, fastEnd);

  assert.match(fastBody, /this\.refreshCachedSessionInfos\(\)\)\.sessions/);
  assert.doesNotMatch(fastBody, /this\.buildSessionInfos\(\)/);
  assert.match(source, /discoveryScope: StateManager\.SESSION_SCOPE/);
  assert.match(source, /sessionCountDelta/);
  assert.match(source, /session-count-spike/);
});
