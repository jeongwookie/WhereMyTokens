import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import stateManagerModule from '../dist/main/stateManager.js';
import rateLimitFetcherModule from '../dist/main/rateLimitFetcher.js';
import codexUsageFetcherModule from '../dist/main/codexUsageFetcher.js';
import oauthRefreshModule from '../dist/main/oauthRefresh.js';

const { StateManager } = stateManagerModule;
const { API_USAGE_CACHE_SCHEMA_VERSION, CLAUDE_API_MAX_BACKOFF_MS } = rateLimitFetcherModule;
const { CODEX_USAGE_CACHE_SCHEMA_VERSION, getCodexAuthIdentityHash } = codexUsageFetcherModule;
const originalFetchApiUsagePct = rateLimitFetcherModule.fetchApiUsagePct;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalCodexHome = process.env.CODEX_HOME;
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

function refreshClaudeQuota(manager, force = true) {
  return manager.refreshProviderQuotas({ ...manager.getState().settings, enabledProviders: ['claude'] }, force);
}

function buildQuotaWindows(manager) {
  const providerQuotas = manager.buildProviderQuotas();
  const empty = { pct: 0, resetMs: null };
  return {
    h5: providerQuotas.claude?.windows?.h5 ?? empty,
    week: providerQuotas.claude?.windows?.week ?? empty,
    so: providerQuotas.claude?.windows?.sonnetWeek ?? empty,
    codexH5: providerQuotas.codex?.windows?.h5 ?? empty,
    codexWeek: providerQuotas.codex?.windows?.week ?? empty,
  };
}

function withTempClaudeCredentials(oauthOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-claude-test-'));
  tempClaudeDirs.push(dir);
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'test-access-token',
      rateLimitTier: 'max_5x',
      subscriptionType: 'max',
      ...oauthOverrides,
    },
  }));
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
}

function withCurrentClaudeCredentialMarker(sample) {
  return {
    ...sample,
    credentialMarker: oauthRefreshModule.getOAuthCredentialMarker(),
  };
}

function withTempCodexAuth() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-codex-state-test-'));
  tempClaudeDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    tokens: {
      access_token: 'test-access-token',
    },
  }));
  process.env.CODEX_HOME = dir;
  return {
    authMtimeMs: fs.statSync(path.join(dir, 'auth.json')).mtimeMs,
    authIdentityHash: getCodexAuthIdentityHash(),
  };
}

test.afterEach(() => {
  rateLimitFetcherModule.fetchApiUsagePct = originalFetchApiUsagePct;
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const dir of tempClaudeDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cached Claude percentages with null resets expire instead of surviving forever', () => {
  withTempClaudeCredentials();
  const manager = new StateManager(makeStore({
    _cachedApiPct: withCurrentClaudeCredentialMarker({
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
    }),
  }), () => {});

  const limits = buildQuotaWindows(manager);

  assert.equal(limits.h5.pct, 0);
  assert.equal(limits.week.pct, 0);
  assert.equal(limits.so.pct, 0);
});

test('cached Claude API samples are aged once after startup', () => {
  withTempClaudeCredentials();
  const storedAt = Date.now() - (35 * 60 * 1000);
  const manager = new StateManager(makeStore({
    _cachedApiPct: withCurrentClaudeCredentialMarker({
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
    }),
  }), () => {});

  const limits = buildQuotaWindows(manager);

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

test('Claude API cache is discarded after credential marker changes', () => {
  const dir = withTempClaudeCredentials({
    accessToken: 'first-access',
    refreshToken: 'first-refresh',
    expiresAt: Date.now() + 3600_000,
  });
  const cachedSample = withCurrentClaudeCredentialMarker({
    schemaVersion: API_USAGE_CACHE_SCHEMA_VERSION,
    h5Pct: 63,
    weekPct: 41,
    soPct: 7,
    h5ResetMs: 60 * 60 * 1000,
    weekResetMs: 6 * 24 * 60 * 60 * 1000,
    soResetMs: null,
    plan: 'Max 5x',
    extraUsage: null,
    storedAt: Date.now(),
  });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'second-access',
      refreshToken: 'second-refresh',
      expiresAt: Date.now() + 3600_000,
      rateLimitTier: 'max_5x',
      subscriptionType: 'max',
    },
  }));
  const store = makeStore({ _cachedApiPct: cachedSample });
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

  const limits = buildQuotaWindows(manager);

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

  const limits = buildQuotaWindows(manager);

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
    providerQuotas: {
      ...manager.getState().providerQuotas,
      claude: {
        provider: 'claude',
        source: 'statusLine',
        capturedAt: Date.now(),
        windows: {
          h5: { pct: 42, resetMs: 60_000, source: 'statusLine' },
          week: { pct: 18, resetMs: 120_000, source: 'statusLine' },
          sonnetWeek: { pct: 0, resetMs: null, source: 'statusLine' },
        },
      },
    },
  };
  manager.liveSession = {
    _ts: Date.now() - 301_000,
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: Date.now() + 60_000 },
      seven_day: { used_percentage: 18, resets_at: Date.now() + 120_000 },
    },
  };

  const limits = buildQuotaWindows(manager);

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
    providerQuotas: {
      ...manager.getState().providerQuotas,
      codex: {
        provider: 'codex',
        source: 'localLog',
        capturedAt: Date.now(),
        windows: {
          h5: { pct: 66, resetMs: 60_000, source: 'localLog' },
          week: { pct: 27, resetMs: 120_000, source: 'localLog' },
        },
      },
    },
  };

  const limits = buildQuotaWindows(manager);

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

  const limits = buildQuotaWindows(manager);

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

  const limits = buildQuotaWindows(manager);

  assert.equal(limits.codexH5.pct, 100);
  assert.equal(limits.codexH5.source, 'localLog');
  assert.equal(limits.codexWeek.pct, 0);
  assert.equal(limits.codexWeek.source, undefined);
});

test('Codex live usage overrides stale local-log rate limits', () => {
  const { authMtimeMs, authIdentityHash } = withTempCodexAuth();
  const manager = new StateManager(makeStore(), () => {});
  const now = Date.now();
  manager.codexUsageConnected = true;
  manager.codexUsagePctStoredAt = now;
  manager.codexUsageAuthMtimeMs = authMtimeMs;
  manager.codexUsageAuthIdentityHash = authIdentityHash;
  manager.codexUsagePct = {
    h5Available: true,
    weekAvailable: true,
    h5Pct: 100,
    weekPct: 53,
    h5ResetMs: 30 * 60 * 1000,
    weekResetMs: 3 * 24 * 60 * 60 * 1000,
    h5LimitReached: true,
    weekLimitReached: false,
    plan: 'pro',
    credits: null,
    limitReached: true,
    rateLimitReachedType: 'rate_limit_reached',
  };
  manager.codexRateLimits = {
    h5: {
      pct: 9,
      resetsAt: Math.floor((now + 4 * 60 * 60 * 1000) / 1000),
      observedAt: now - 1000,
    },
    week: {
      pct: 17,
      resetsAt: Math.floor((now + 6 * 24 * 60 * 60 * 1000) / 1000),
      observedAt: now - 1000,
    },
  };

  const limits = buildQuotaWindows(manager);

  assert.equal(limits.codexH5.pct, 100);
  assert.equal(limits.codexH5.source, 'api');
  assert.equal(limits.codexWeek.pct, 53);
  assert.equal(limits.codexWeek.source, 'api');
});

test('cached Codex live usage is used before local logs and ages after startup', () => {
  const { authMtimeMs, authIdentityHash } = withTempCodexAuth();
  const manager = new StateManager(makeStore({
    _cachedCodexUsagePct: {
      schemaVersion: CODEX_USAGE_CACHE_SCHEMA_VERSION,
      storedAt: Date.now() - 10_000,
      authMtimeMs,
      authIdentityHash,
      h5Available: true,
      weekAvailable: true,
      h5Pct: 5,
      weekPct: 17,
      h5ResetMs: 70_000,
      weekResetMs: 130_000,
      h5LimitReached: false,
      weekLimitReached: false,
      plan: 'pro',
      credits: null,
      limitReached: false,
      rateLimitReachedType: null,
    },
  }), () => {});

  const limits = buildQuotaWindows(manager);

  assert.equal(limits.codexH5.pct, 5);
  assert.equal(limits.codexH5.source, 'cache');
  assert.ok((limits.codexH5.resetMs ?? 0) <= 70_000);
  assert.equal(limits.codexWeek.pct, 17);
  assert.equal(limits.codexWeek.source, 'cache');
});

test('legacy Codex live usage cache schema is discarded on startup', () => {
  const { authMtimeMs, authIdentityHash } = withTempCodexAuth();
  const store = makeStore({
    _cachedCodexUsagePct: {
      schemaVersion: CODEX_USAGE_CACHE_SCHEMA_VERSION - 1,
      storedAt: Date.now() - 10_000,
      authMtimeMs,
      authIdentityHash,
      h5Available: true,
      weekAvailable: true,
      h5Pct: 100,
      weekPct: 100,
      h5ResetMs: 70_000,
      weekResetMs: 130_000,
      h5LimitReached: true,
      weekLimitReached: true,
      plan: 'pro',
      credits: null,
      limitReached: true,
      rateLimitReachedType: 'rate_limit_reached',
    },
  });
  const manager = new StateManager(store, () => {});

  assert.equal(manager.codexUsagePct, null);
  assert.equal(store.values._cachedCodexUsagePct, undefined);
});

test('expired Codex live cache falls back to fresh local-log windows', () => {
  const manager = new StateManager(makeStore(), () => {});
  const now = Date.now();
  manager.codexUsageConnected = false;
  manager.codexUsagePctStoredAt = now - 31 * 60 * 1000;
  manager.codexUsagePct = {
    h5Available: true,
    weekAvailable: true,
    h5Pct: 5,
    weekPct: 17,
    h5ResetMs: null,
    weekResetMs: null,
    h5LimitReached: false,
    weekLimitReached: false,
    plan: 'pro',
    credits: null,
    limitReached: false,
    rateLimitReachedType: null,
  };
  manager.codexRateLimits = {
    h5: {
      pct: 23,
      resetsAt: Math.floor((now + 2 * 60 * 60 * 1000) / 1000),
      observedAt: now - 1000,
    },
  };

  const limits = buildQuotaWindows(manager);

  assert.equal(limits.codexH5.pct, 23);
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
      mtimeMs: now,
      size: 1,
    },
  ]]);

  const derived = manager.computeDerivedUsage(manager.getState().settings);

  assert.equal(derived.providerQuotas.claude.windows.h5.source, 'statusLine');
  assert.equal(derived.usage.byProvider.claude.windows.h5.requestCount, 0);
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

  const limits = buildQuotaWindows(manager);

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

  const limits = buildQuotaWindows(manager);

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

  await refreshClaudeQuota(manager, true);

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

  await refreshClaudeQuota(manager, true);

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

  await refreshClaudeQuota(manager, true);

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

  const firstRefresh = await refreshClaudeQuota(manager, true);
  const secondRefresh = await refreshClaudeQuota(manager, true);

  assert.equal(firstRefresh, true);
  assert.equal(secondRefresh, false);
  assert.equal(calls, 1);
  assert.equal(manager.apiBackoffMs, 240_000);
});

test('updated Claude credentials bypass refresh-limited API backoff', async () => {
  const dir = withTempClaudeCredentials({
    refreshToken: 'old-refresh',
    expiresAt: Date.now() - 1000,
  });
  const manager = new StateManager(makeStore(), () => {});
  manager.consumeOAuthCredentialChange();
  manager.apiBackoffMs = CLAUDE_API_MAX_BACKOFF_MS;
  manager.lastApiCallMs = Date.now();
  let calls = 0;
  rateLimitFetcherModule.fetchApiUsagePct = async () => {
    calls += 1;
    return {
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

  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
      rateLimitTier: 'max_5x',
      subscriptionType: 'max',
    },
  }));
  const refreshed = await refreshClaudeQuota(manager, false);

  assert.equal(refreshed, true);
  assert.equal(calls, 1);
  assert.equal(manager.apiBackoffMs, 0);
  assert.equal(manager.apiUsagePct.h5Pct, 5);
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

  const failedRefresh = await refreshClaudeQuota(manager, true);
  const recoveredRefresh = await refreshClaudeQuota(manager, true);

  assert.equal(failedRefresh, true);
  assert.equal(recoveredRefresh, true);
  assert.equal(calls, 2);
  assert.equal(manager.apiBackoffMs, 0);
  assert.equal(manager.apiUsagePct.h5Pct, 5);
});

test('unauthorized Claude refresh keeps the last trusted API sample as cache', async () => {
  const cachedSample = withCurrentClaudeCredentialMarker({
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
  });
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

  await refreshClaudeQuota(manager, true);
  const limits = buildQuotaWindows(manager);

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

  const firstRefresh = refreshClaudeQuota(manager, true);
  const secondRefresh = refreshClaudeQuota(manager, true);

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

test('UsageIndex keeps atomic replacement, schema, compaction, and corruption recovery guards in source', () => {
  const indexSource = fs.readFileSync(path.resolve('src', 'main', 'usageIndex', 'usageIndex.ts'), 'utf8');
  const sqliteSource = fs.readFileSync(path.resolve('src', 'main', 'usageIndex', 'sqliteUsageIndexStorage.ts'), 'utf8');
  const resilientSource = fs.readFileSync(path.resolve('src', 'main', 'usageIndex', 'resilientUsageIndex.ts'), 'utf8');

  assert.match(sqliteSource, /USAGE_INDEX_SCHEMA_VERSION = 4/);
  assert.match(sqliteSource, /this\.transaction\(\(\) => \{/);
  assert.match(sqliteSource, /async compact\(nowMs: number\)/);
  assert.match(indexSource, /await this\.storage\.commitSource\(\{ mode, source: committedSource, batch \}\)/);
  assert.match(resilientSource, /PRAGMA integrity_check/);
  assert.match(resilientSource, /Recovered UsageIndex failed integrity check/);
});

test('startup recovery and canonical UsageIndex guards remain in source', () => {
  const appSource = fs.readFileSync(path.resolve('src', 'renderer', 'App.tsx'), 'utf8');
  const stateSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const startupSnapshotSource = fs.readFileSync(path.resolve('src', 'main', 'startupStateSnapshot.ts'), 'utf8');

  assert.match(appSource, /BOOT_FALLBACK_DELAY_MS/);
  assert.match(appSource, /Startup Recovery/);
  assert.match(stateSource, /private readonly usageIndex: UsageIndex/);
  assert.match(stateSource, /loadUsageIndexProjection/);
  assert.doesNotMatch(stateSource, /usageLedgerStore|jsonlCache/);
  assert.match(stateSource, /private startupFreshComplete = false/);
  assert.match(stateSource, /const initialRefreshDone = this\.startupFreshComplete/);
  assert.match(startupSnapshotSource, /stateFreshness: 'restored'/);
  assert.match(stateSource, /stateFreshness: 'fresh'/);
});

test('session discovery keeps recent-active scope and tracked session hints in source', () => {
  const typesSource = fs.readFileSync(path.resolve('src', 'main', 'providers', 'types.ts'), 'utf8');
  const codexPathsSource = fs.readFileSync(path.resolve('src', 'main', 'providers', 'codex', 'paths.ts'), 'utf8');
  const codexDiscoverySource = fs.readFileSync(path.resolve('src', 'main', 'providers', 'codex', 'discovery.ts'), 'utf8');
  const claudeDiscoverySource = fs.readFileSync(path.resolve('src', 'main', 'providers', 'claude', 'discovery.ts'), 'utf8');
  const stateSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');

  assert.match(typesSource, /SessionDiscoveryScope = 'recent-active' \| 'all'/);
  assert.match(typesSource, /trackedJsonlPaths\?: string\[\]/);
  assert.doesNotMatch(codexDiscoverySource, /TrackingProvider|provider: TrackingProvider/);
  assert.doesNotMatch(claudeDiscoverySource, /TrackingProvider|provider: TrackingProvider/);
  assert.match(codexDiscoverySource, /scope === 'all'/);
  assert.match(claudeDiscoverySource, /'recent-active'/);
  assert.match(codexPathsSource, /CODEX_ARCHIVED_SESSIONS_DIR/);
  assert.match(codexPathsSource, /CODEX_SESSION_CLEANUP_ARCHIVE_DIR/);
  assert.match(codexPathsSource, /CODEX_USAGE_DIRS/);
  assert.match(stateSource, /private collectTrackedSessionFiles\(/);
  assert.match(stateSource, /for \(const provider of providers\)/);
  assert.match(stateSource, /this\.collectTrackedSessionFiles\(provider\.id, this\.startupLimitForProvider\(provider\.id\)\)/);
  assert.match(stateSource, /provider\.discoverSessions\(discoveryCtx\)/);
});

test('usage scans include Claude agent logs without expanding visible startup sessions', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const codexSource = fs.readFileSync(path.resolve('src', 'main', 'providers', 'codex', 'sources.ts'), 'utf8');
  const claudeSource = fs.readFileSync(path.resolve('src', 'main', 'providers', 'claude', 'sources.ts'), 'utf8');
  const loadStart = source.indexOf('private async loadProviderSummaries');
  const loadEnd = source.indexOf('private async refreshChangedSummaries', loadStart);
  const loadBody = source.slice(loadStart, loadEnd);
  const claudeAllStart = claudeSource.indexOf('export function listAllClaudeSources');
  const claudeAllEnd = claudeSource.indexOf('export function buildClaudeUsageIndexSource', claudeAllStart);
  const claudeAllBody = claudeSource.slice(claudeAllStart, claudeAllEnd);
  const scopedStart = source.indexOf('private async buildScopedSessionInfosDetailed');
  const scopedEnd = source.indexOf('private collectTrackedSessionFiles', scopedStart);
  const scopedBody = source.slice(scopedStart, scopedEnd);

  assert.match(codexSource, /CODEX_USAGE_DIRS/);
  assert.match(source, /private sourceBackedProviders\(settings: AppSettings\)/);
  assert.match(source, /provider\.listAllSources\(ctx\)/);
  assert.match(source, /provider\.listRecentSources\(ctx, this\.startupLimitForProvider\(provider\.id\)\)/);
  assert.match(source, /provider\.usageIndexSource\(ctx, source\)/);
  assert.match(source, /this\.usageIndex\.refreshSource\(indexedSource\.descriptor, indexedSource\.scanner\)/);
  assert.match(codexSource, /function codexSessionDedupeKey/);
  assert.match(codexSource, /function codexUsageRootRank/);
  assert.match(codexSource, /CODEX_USAGE_DIRS/);
  assert.match(claudeSource, /listAllClaudeSources/);
  assert.match(claudeSource, /filter\(isClaudeJsonlName\)/);
  assert.match(claudeSource, /if \(isClaudeAgentJsonlPath\(source\.filePath\)\) return null/);
  assert.doesNotMatch(loadBody, /settings\.provider === 'claude'/);
  assert.doesNotMatch(loadBody, /settings\.provider === 'codex'/);
  assert.doesNotMatch(claudeAllBody, /!\w+\.startsWith\('agent-'\)/);
  assert.match(scopedBody, /provider\.listRecentSources\(ctx, limit\)/);
  assert.doesNotMatch(scopedBody, /listCodexUsageJsonlFiles/);
});

test('all-time session count comes from indexed source summaries instead of current UI rows', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const manager = new StateManager(makeStore(), () => {});
  const now = Date.now();
  const summary = ({ provider = 'claude' } = {}) => ({
    provider,
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
      activityBreakdownKind: provider === 'codex' ? 'events' : 'tokens',
    },
    mtimeMs: now,
    size: 1,
  });

  manager.summaries = new Map([
    ['visible-claude.jsonl', summary()],
    ['visible-codex.jsonl', summary({ provider: 'codex' })],
    ['empty.jsonl', summary()],
  ]);
  manager.state = {
    ...manager.getState(),
    sessions: [{}, {}, {}],
  };

  assert.equal(manager.countAllTimeUsageSessions(manager.getState().settings), 3);
  assert.match(source, /private countAllTimeUsageSessions\(settings: AppSettings\): number/);
  assert.match(source, /allTimeSessions = this\.countAllTimeUsageSessions\(settings\)/);
  assert.doesNotMatch(source, /allTimeSessions: sessions\.length/);
});

test('all-time session count follows enabled providers for summary fallback', () => {
  const manager = new StateManager(makeStore(), () => {});
  const settings = {
    ...manager.getState().settings,
    enabledProviders: ['claude'],
    quotaTargetModes: {
      'claude.group.account': 'none',
      'claude.group.sonnet': 'none',
      'codex.group.account': 'rich',
    },
  };
  const now = Date.now();
  const summary = ({ provider = 'claude', model = 'claude-3-5-sonnet' } = {}) => ({
    provider,
    sessionSnapshot: {
      modelName: model,
      rawModel: model,
      latestInputTokens: 0,
      latestCacheCreationTokens: 0,
      latestCacheReadTokens: 0,
      toolCounts: {},
      activityBreakdown: {
        read: 0, editWrite: 0, search: 0, git: 0, buildTest: 0,
        terminal: 0, thinking: 0, response: 0, subagents: 0, web: 0,
      },
      activityBreakdownKind: provider === 'codex' ? 'events' : 'tokens',
    },
    mtimeMs: now,
    size: 1,
  });

  manager.summaries = new Map([
    ['visible-sonnet.jsonl', summary()],
    ['hidden-opus.jsonl', summary({ model: 'claude-3-opus' })],
    ['hidden-codex.jsonl', summary({ provider: 'codex', model: 'gpt-5-codex' })],
    ['visible-second.jsonl', summary()],
  ]);

  assert.equal(manager.countAllTimeUsageSessions(settings), 3);
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

test('popup show starts with recent watcher and promotes wide watcher later', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const visibleStart = source.indexOf('  setUiVisible(visible: boolean): void');
  const visibleEnd = source.indexOf('  private clearForegroundTimers', visibleStart);
  const visibleBody = source.slice(visibleStart, visibleEnd);
  const watcherStart = source.indexOf('  private startWatcher');
  const watcherEnd = source.indexOf('  private async fastRefresh', watcherStart);
  const watcherBody = source.slice(watcherStart, watcherEnd);
  const promotionStart = source.indexOf('  private scheduleWideWatcherPromotion');
  const promotionEnd = source.indexOf('  private isPerfDebugEnabled', promotionStart);
  const promotionBody = source.slice(promotionStart, promotionEnd);

  assert.match(visibleBody, /this\.startWatcher\('popup:show:recent', 'recent'\)/);
  assert.match(visibleBody, /this\.scheduleWideWatcherPromotion\(\)/);
  assert.match(watcherBody, /mode: WatcherMode = 'auto'/);
  assert.match(watcherBody, /const useWideWatcher = mode === 'wide' \|\| \(mode === 'auto' && this\.uiVisible\)/);
  assert.match(source, /this\.startWatcher\('popup:show:wide', 'wide'\)/);
  assert.match(promotionBody, /this\.scheduleForegroundRefresh\(\)/);
});

test('foreground and manual refresh use budgeted UsageIndex-backed history scans', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const scheduleStart = source.indexOf('  private scheduleForegroundRefresh');
  const scheduleEnd = source.indexOf('  private scheduleWideWatcherPromotion', scheduleStart);
  const scheduleBody = source.slice(scheduleStart, scheduleEnd);
  const forceStart = source.indexOf('  async forceRefresh');
  const forceEnd = source.indexOf('  async resetUsageIndex', forceStart);
  const forceBody = source.slice(forceStart, forceEnd);
  const heavyStart = source.indexOf('  private async heavyRefresh');
  const heavyEnd = source.indexOf('  private buildStartupPriorityFiles', heavyStart);
  const heavyBody = source.slice(heavyStart, heavyEnd);
  const warmupStart = source.indexOf('  private scheduleHistoryWarmup');
  const warmupEnd = source.indexOf('  private clearHistoryWarmup', warmupStart);
  const warmupBody = source.slice(warmupStart, warmupEnd);

  assert.match(source, /new RefreshScheduler\(\{/);
  assert.match(source, /execute: \(work\) => this\.executeRefresh\(work\)/);
  assert.match(scheduleBody, /this\.requestRefresh\(\{/);
  assert.match(scheduleBody, /mode: 'heavy'/);
  assert.match(scheduleBody, /reason: 'foreground'/);
  assert.match(scheduleBody, /scanBudgetMs = StateManager\.FOREGROUND_SCAN_BUDGET_MS/);
  assert.match(scheduleBody, /scanBudgetMs,/);
  assert.match(source, /FOREGROUND_WARMUP_DELAY_MS = 3_000/);
  assert.match(heavyBody, /scanBudgetMs: number \| null = null/);
  assert.match(heavyBody, /allowHiddenFullScan = false/);
  assert.match(heavyBody, /!allowHiddenFullScan && initialRefreshDone && !this\.uiVisible/);
  assert.match(heavyBody, /const effectiveScanBudgetMs = scanBudgetMs \?\? /);
  assert.doesNotMatch(heavyBody, /refreshUsageLedger|ledgerRefresh|hasExcludedProjects/);
  assert.match(heavyBody, /this\.loadProviderSummaries\([\s\S]*force,[\s\S]*effectiveScanBudgetMs,[\s\S]*priorityFiles,[\s\S]*includeFullHistory,[\s\S]*includeFullHistory/);
  assert.match(heavyBody, /const summaryPartial = loaded\.scanPartial \|\| loaded\.sourceListPartial/);
  assert.match(heavyBody, /const partialHistoryScan = summaryPartial/);
  assert.match(heavyBody, /const nextSummaries = partialHistoryScan && initialRefreshDone/);
  assert.match(heavyBody, /new Map\(\[\.\.\.this\.summaries, \.\.\.loaded\.summaries\]\)/);
  assert.match(heavyBody, /this\.mergeCodexRateLimits\(this\.codexRateLimits, loaded\.codexRateLimits \?\? undefined\)/);
  assert.match(heavyBody, /const showHistoryWarmupBanner = allowStartupBudget && !initialRefreshDone && partialHistoryScan/);
  assert.match(heavyBody, /this\.scheduleHistoryWarmup\(/);
  assert.match(heavyBody, /showHistoryWarmupBanner \? StateManager\.STARTUP_WARMUP_DELAY_MS : StateManager\.FOREGROUND_WARMUP_DELAY_MS/);
  assert.match(heavyBody, /true,\s*\)/);
  assert.match(warmupBody, /reason: 'history-warmup'/);
  assert.match(warmupBody, /includeFullHistory: true/);
  assert.match(warmupBody, /scanBudgetMs: StateManager\.FOREGROUND_SCAN_BUDGET_MS/);
  assert.match(heavyBody, /const keepHistoryWarmupBanner = partialHistoryScan/);
  assert.match(heavyBody, /showHistoryWarmupBanner \|\| this\.state\.historyWarmupPending/);
  assert.match(heavyBody, /historyWarmupPending: keepHistoryWarmupBanner/);
  assert.match(heavyBody, /historyWarmupStartsAt: keepHistoryWarmupBanner \? historyWarmupStartsAt : null/);
  assert.doesNotMatch(heavyBody, /historyWarmupPending: partialHistoryScan/);
  assert.match(forceBody, /reason: 'manual'/);
  assert.match(forceBody, /includeFullHistory: true/);
  assert.match(forceBody, /scanBudgetMs: StateManager\.FOREGROUND_SCAN_BUDGET_MS/);
  assert.doesNotMatch(forceBody, /force: true/);
});
