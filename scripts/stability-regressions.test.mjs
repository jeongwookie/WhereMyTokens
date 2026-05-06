import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import stateManagerModule from '../dist/main/stateManager.js';
import * as jsonlCacheModule from '../dist/main/jsonlCache.js';
import rateLimitFetcherModule from '../dist/main/rateLimitFetcher.js';

const { StateManager } = stateManagerModule;
const { JsonlCache } = jsonlCacheModule;
const { API_USAGE_CACHE_SCHEMA_VERSION, CLAUDE_API_MAX_BACKOFF_MS } = rateLimitFetcherModule;
const originalFetchApiUsagePct = rateLimitFetcherModule.fetchApiUsagePct;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const tempClaudeDirs = [];

function makeStore(overrides = {}) {
  const values = { ...overrides };
  const store = {
    store: {},
    values,
    get(key, fallback = null) {
      return key in values ? values[key] : fallback;
    },
    set(key, value) {
      values[key] = value;
    },
    delete(key) {
      delete values[key];
    },
  };
  return store;
}

function withTempClaudeCredentials() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-claude-test-'));
  tempClaudeDirs.push(dir);
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'test-access-token',
      rateLimitTier: 'max_5x',
      subscriptionType: 'max',
    },
  }));
  process.env.CLAUDE_CONFIG_DIR = dir;
}

test.afterEach(() => {
  rateLimitFetcherModule.fetchApiUsagePct = originalFetchApiUsagePct;
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  for (const dir of tempClaudeDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cached Claude percentages with null resets expire instead of surviving forever', () => {
  withTempClaudeCredentials();
  const manager = new StateManager(makeStore({
    _cachedApiPct: {
      schemaVersion: API_USAGE_CACHE_SCHEMA_VERSION,
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

test('cached Claude API samples are aged once after startup', () => {
  withTempClaudeCredentials();
  const storedAt = Date.now() - (35 * 60 * 1000);
  const manager = new StateManager(makeStore({
    _cachedApiPct: {
      schemaVersion: API_USAGE_CACHE_SCHEMA_VERSION,
      h5Pct: 5,
      weekPct: 17,
      soPct: 3,
      h5ResetMs: 60 * 60 * 1000,
      weekResetMs: 6 * 24 * 60 * 60 * 1000,
      soResetMs: 90 * 60 * 1000,
      plan: 'Pro',
      extraUsage: null,
      storedAt,
    },
  }), () => {});

  const limits = manager.buildLimits();

  assert.equal(limits.h5.pct, 5);
  assert.ok((limits.h5.resetMs ?? 0) > 20 * 60 * 1000);
  assert.ok((limits.h5.resetMs ?? 0) < 30 * 60 * 1000);
  assert.equal(limits.so.pct, 3);
  assert.ok((limits.so.resetMs ?? 0) > 50 * 60 * 1000);
});

test('legacy unversioned Claude API cache is discarded on startup', () => {
  const store = makeStore({
    _cachedApiPct: {
      h5Pct: 63,
      weekPct: 41,
      soPct: 7,
      h5ResetMs: null,
      weekResetMs: null,
      soResetMs: null,
      plan: 'Max 5x',
      extraUsage: null,
      storedAt: Date.now(),
    },
  });
  const manager = new StateManager(store, () => {});

  assert.equal(manager.apiUsagePct, null);
  assert.equal(store.values._cachedApiPct, undefined);
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

test('expired Codex local-log rate limits do not linger as active windows', () => {
  const manager = new StateManager(makeStore(), () => {});
  const now = Date.now();
  manager.codexRateLimits = {
    h5: {
      pct: 8,
      resetsAt: Math.floor((now + 4 * 60 * 60 * 1000) / 1000),
      observedAt: Math.floor(now / 1000),
    },
    week: {
      pct: 94,
      resetsAt: Math.floor((now - 60_000) / 1000),
      observedAt: Math.floor(now / 1000) - 60,
    },
  };

  const limits = manager.buildLimits();

  assert.equal(limits.codexH5.pct, 8);
  assert.equal(limits.codexH5.source, 'localLog');
  assert.equal(limits.codexWeek.pct, 0);
  assert.equal(limits.codexWeek.source, undefined);
});

test('malformed Codex local-log rate limits are clamped or dropped', () => {
  const manager = new StateManager(makeStore(), () => {});
  const now = Date.now();
  manager.codexRateLimits = {
    h5: {
      pct: 150,
      resetsAt: Math.floor((now + 4 * 60 * 60 * 1000) / 1000),
      observedAt: Math.floor(now / 1000),
    },
    week: {
      pct: 50,
      resetsAt: Math.floor((now + 8 * 24 * 60 * 60 * 1000) / 1000),
      observedAt: Math.floor(now / 1000),
    },
  };

  const limits = manager.buildLimits();

  assert.equal(limits.codexH5.pct, 100);
  assert.equal(limits.codexH5.source, 'localLog');
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

test('expired Claude core usage windows age independently', () => {
  const manager = new StateManager(makeStore(), () => {});
  manager.apiUsagePct = {
    h5Pct: 5,
    weekPct: 17,
    soPct: 0,
    h5ResetMs: 5_000,
    weekResetMs: 6 * 24 * 60 * 60 * 1000,
    soResetMs: null,
    plan: 'Pro',
    extraUsage: null,
  };
  manager.apiUsagePctStoredAt = Date.now() - 10_000;
  manager.apiConnected = false;

  const limits = manager.buildLimits();

  assert.equal(limits.h5.pct, 0);
  assert.equal(limits.h5.source, 'cache');
  assert.equal(limits.week.pct, 17);
  assert.equal(limits.week.source, 'cache');
  assert.ok((limits.week.resetMs ?? 0) > 0);
});

test('rate-limited Claude refresh keeps the last trusted API sample without rewriting cache', async () => {
  const store = makeStore();
  const manager = new StateManager(store, () => {});
  manager.apiUsagePct = {
    h5Pct: 5,
    weekPct: 17,
    soPct: 0,
    h5ResetMs: 5 * 60 * 60 * 1000,
    weekResetMs: 6 * 24 * 60 * 60 * 1000,
    soResetMs: null,
    plan: 'Pro',
    extraUsage: null,
  };
  manager.apiUsagePctStoredAt = Date.now() - 5_000;
  rateLimitFetcherModule.fetchApiUsagePct = async () => ({
    usage: null,
    status: {
      code: 'rate-limited',
      connected: false,
      label: 'rate limited',
      detail: 'Claude API returned HTTP 429.',
      httpStatus: 429,
    },
  });

  await manager.refreshApiUsagePct(true);

  assert.equal(manager.apiUsagePct.h5Pct, 5);
  assert.equal(manager.apiUsagePct.weekPct, 17);
  assert.equal(store.values._cachedApiPct, undefined);
  assert.equal(manager.apiStatusLabel, 'rate limited');
  assert.equal(manager.apiBackoffMs, 120_000);
});

test('rate-limited Claude refresh honors Retry-After before exponential backoff', async () => {
  const manager = new StateManager(makeStore(), () => {});
  rateLimitFetcherModule.fetchApiUsagePct = async () => ({
    usage: null,
    status: {
      code: 'rate-limited',
      connected: false,
      label: 'rate limited',
      detail: 'Claude API returned HTTP 429.',
      httpStatus: 429,
      retryAfterMs: 240_000,
    },
  });

  await manager.refreshApiUsagePct(true);

  assert.equal(manager.apiBackoffMs, 240_000);
  assert.match(manager.apiError, /Retry in 4m/);
});

test('rate-limited Claude refresh caps excessive Retry-After backoff', async () => {
  const manager = new StateManager(makeStore(), () => {});
  rateLimitFetcherModule.fetchApiUsagePct = async () => ({
    usage: null,
    status: {
      code: 'rate-limited',
      connected: false,
      label: 'rate limited',
      detail: 'Claude API returned HTTP 429.',
      httpStatus: 429,
      retryAfterMs: 999_999_000,
    },
  });

  await manager.refreshApiUsagePct(true);

  assert.equal(manager.apiBackoffMs, CLAUDE_API_MAX_BACKOFF_MS);
  assert.match(manager.apiError, /Retry in 10m/);
});

test('forced Claude refresh does not bypass active Retry-After backoff', async () => {
  const manager = new StateManager(makeStore(), () => {});
  let calls = 0;
  rateLimitFetcherModule.fetchApiUsagePct = async () => {
    calls += 1;
    return {
      usage: null,
      status: {
        code: 'rate-limited',
        connected: false,
        label: 'rate limited',
        detail: 'Claude API returned HTTP 429.',
        httpStatus: 429,
        retryAfterMs: 240_000,
      },
    };
  };

  const firstRefresh = await manager.refreshApiUsagePct(true);
  const secondRefresh = await manager.refreshApiUsagePct(true);

  assert.equal(firstRefresh, true);
  assert.equal(secondRefresh, false);
  assert.equal(calls, 1);
  assert.equal(manager.apiBackoffMs, 240_000);
});

test('non-rate-limited Claude failure clears stale Retry-After backoff', async () => {
  const manager = new StateManager(makeStore(), () => {});
  manager.lastApiCallMs = Date.now() - 241_000;
  manager.apiBackoffMs = 240_000;
  let calls = 0;
  rateLimitFetcherModule.fetchApiUsagePct = async () => {
    calls += 1;
    return calls === 1
      ? {
          usage: null,
          status: {
            code: 'unauthorized',
            connected: false,
            label: 'auth failed',
            detail: 'Claude CLI token was rejected or expired.',
            httpStatus: 401,
          },
        }
      : {
          usage: {
            h5Pct: 5,
            weekPct: 17,
            soPct: 0,
            h5ResetMs: 5 * 60 * 60 * 1000,
            weekResetMs: 6 * 24 * 60 * 60 * 1000,
            soResetMs: null,
            plan: 'Pro',
            extraUsage: null,
          },
          status: { code: 'ok', connected: true, label: '', detail: '' },
        };
  };

  const failedRefresh = await manager.refreshApiUsagePct(true);
  const recoveredRefresh = await manager.refreshApiUsagePct(true);

  assert.equal(failedRefresh, true);
  assert.equal(recoveredRefresh, true);
  assert.equal(calls, 2);
  assert.equal(manager.apiBackoffMs, 0);
  assert.equal(manager.apiUsagePct.h5Pct, 5);
});

test('unauthorized Claude refresh keeps the last trusted API sample as cache', async () => {
  const cachedSample = {
    schemaVersion: API_USAGE_CACHE_SCHEMA_VERSION,
    h5Pct: 5,
    weekPct: 17,
    soPct: 0,
    h5ResetMs: 5 * 60 * 60 * 1000,
    weekResetMs: 6 * 24 * 60 * 60 * 1000,
    soResetMs: null,
    plan: 'Pro',
    extraUsage: null,
    storedAt: Date.now() - 5_000,
  };
  const store = makeStore({ _cachedApiPct: cachedSample });
  const manager = new StateManager(store, () => {});
  manager.apiUsagePct = { ...cachedSample };
  manager.apiUsagePctStoredAt = cachedSample.storedAt;
  rateLimitFetcherModule.fetchApiUsagePct = async () => ({
    usage: null,
    status: {
      code: 'unauthorized',
      connected: false,
      label: 'auth failed',
      detail: 'Claude CLI token was rejected or expired.',
      httpStatus: 401,
    },
  });

  await manager.refreshApiUsagePct(true);
  const limits = manager.buildLimits();

  assert.equal(manager.apiStatusLabel, 'auth failed');
  assert.equal(manager.apiUsagePct.h5Pct, 5);
  assert.equal(manager.apiUsagePct.weekPct, 17);
  assert.equal(store.values._cachedApiPct, cachedSample);
  assert.equal(limits.h5.source, 'cache');
  assert.equal(limits.h5.pct, 5);
  assert.equal(limits.week.source, 'cache');
  assert.equal(limits.week.pct, 17);
});

test('late Claude API refresh results do not overwrite a newer generation', async () => {
  const store = makeStore();
  const manager = new StateManager(store, () => {});
  let resolveFirst;
  let resolveSecond;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const second = new Promise(resolve => { resolveSecond = resolve; });
  let calls = 0;
  rateLimitFetcherModule.fetchApiUsagePct = () => {
    calls += 1;
    return calls === 1 ? first : second;
  };

  const firstRefresh = manager.refreshApiUsagePct(true);
  const secondRefresh = manager.refreshApiUsagePct(true);

  resolveSecond({
    usage: {
      h5Pct: 5,
      weekPct: 17,
      soPct: 0,
      h5ResetMs: 5 * 60 * 60 * 1000,
      weekResetMs: 6 * 24 * 60 * 60 * 1000,
      soResetMs: null,
      plan: 'Pro',
      extraUsage: null,
    },
    status: { code: 'ok', connected: true, label: '', detail: '' },
  });
  await secondRefresh;

  resolveFirst({
    usage: {
      h5Pct: 0,
      weekPct: 16,
      soPct: 0,
      h5ResetMs: null,
      weekResetMs: 6 * 24 * 60 * 60 * 1000,
      soResetMs: null,
      plan: 'Pro',
      extraUsage: null,
    },
    status: { code: 'ok', connected: true, label: '', detail: '' },
  });
  await firstRefresh;

  assert.equal(manager.apiUsagePct.h5Pct, 5);
  assert.equal(manager.apiUsagePct.weekPct, 17);
  assert.equal(store.values._cachedApiPct.h5Pct, 5);
  assert.equal(store.values._cachedApiPct.weekPct, 17);
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
  const stateSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');

  assert.match(discoverySource, /SessionDiscoveryScope = 'recent-active' \| 'all'/);
  assert.match(discoverySource, /trackedJsonlPaths\?: string\[\]/);
  assert.match(discoverySource, /discoverSessions\(provider: TrackingProvider = 'both', options: DiscoverSessionsOptions = \{\}\)/);
  assert.match(discoverySource, /dedupeDiscoveredSessions/);
  assert.match(stateSource, /private collectTrackedSessionFiles\(/);
  assert.match(stateSource, /collectTrackedSessionFiles\('codex', StateManager\.STARTUP_CODEX_FILE_LIMIT\)/);
  assert.match(stateSource, /collectTrackedSessionFiles\('claude', StateManager\.STARTUP_CLAUDE_FILE_LIMIT\)/);
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

test('Claude API refresh is not committed from startup or fast-refresh follow-up paths', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const startStart = source.indexOf('  start()');
  const startEnd = source.indexOf('  stop()');
  const startBody = source.slice(startStart, startEnd);
  const fastStart = source.indexOf('private async fastRefresh');
  const fastEnd = source.indexOf('private async refreshGitStatsAfterStartup');
  const fastBody = source.slice(fastStart, fastEnd);

  assert.doesNotMatch(startBody, /refreshApiUsagePct/);
  assert.doesNotMatch(startBody, /Promise\.all\(\[this\.refreshAutoLimits\(\), this\.refreshApiUsagePct\(\)\]\)/);
  assert.doesNotMatch(fastBody, /apiFollowup/);
  assert.doesNotMatch(fastBody, /refreshApiUsagePct/);
});

test('changed session refresh merges unmatched files without falling back to scoped rebuild', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const updateStart = source.indexOf('private updateChangedSessionInfos');
  const updateEnd = source.indexOf('private refreshCachedSessionInfos');
  const updateBody = source.slice(updateStart, updateEnd);

  assert.match(source, /private buildSessionInfoForJsonlPath/);
  assert.match(updateBody, /const matchedPaths = new Set<string>\(\)/);
  assert.match(updateBody, /this\.buildSessionInfoForJsonlPath\(filePath, previousByKey, this\.summaries\)/);
  assert.doesNotMatch(updateBody, /buildScopedSessionInfosDetailed/);
  assert.match(updateBody, /this\.retainScopedSessionInfos\(/);
});

test('cached session refresh prunes retained sessions back to the recent-active scope', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const refreshStart = source.indexOf('private refreshCachedSessionInfos');
  const refreshEnd = source.indexOf('private buildSessionInfos');
  const refreshBody = source.slice(refreshStart, refreshEnd);

  assert.match(source, /private retainScopedSessionInfos\(/);
  assert.match(refreshBody, /this\.retainScopedSessionInfos\(next\)/);
  assert.match(refreshBody, /this\.retainScopedSessionInfos\(this\.state\.sessions\)/);
});
