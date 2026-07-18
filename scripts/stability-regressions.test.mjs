import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import stateManagerModule from '../dist/main/stateManager.js';
import rateLimitFetcherModule from '../dist/main/rateLimitFetcher.js';
import codexUsageFetcherModule from '../dist/main/codexUsageFetcher.js';
import oauthRefreshModule from '../dist/main/oauthRefresh.js';
import quotaDomainModule from '../dist/shared/quotaDomain.js';

const { StateManager } = stateManagerModule;
const { CLAUDE_API_MAX_BACKOFF_MS } = rateLimitFetcherModule;
const { getCodexAuthIdentityHash } = codexUsageFetcherModule;
const { ageProviderQuotaSnapshot, validateProviderQuotaSnapshot } = quotaDomainModule;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalCodexHome = process.env.CODEX_HOME;
const tempDirs = [];

function makeStore(overrides = {}) {
  const values = { ...overrides };
  return {
    store: values,
    values,
    get(key, fallback = null) {
      return key in values ? values[key] : fallback;
    },
    set(key, value) {
      values[key] = value;
      this.store[key] = value;
    },
    delete(key) {
      delete values[key];
      delete this.store[key];
    },
  };
}

function target(provider, overrides = {}) {
  return {
    id: `${provider}.group.account`,
    label: provider === 'claude' ? 'Claude' : 'Codex',
    defaultMode: 'rich',
    defaultOrder: 0,
    taskbarAbbreviation: provider === 'claude' ? 'C' : 'X',
    ...overrides,
  };
}

function entry(provider, period, usedPct, now, overrides = {}) {
  const durationMs = period === '5h' ? 18_000_000 : 604_800_000;
  return {
    key: `${provider}.account.${period}`,
    target: target(provider),
    scope: { kind: 'account' },
    state: 'limited',
    usedPct,
    resetsAt: now + durationMs,
    durationMs,
    durationInferred: false,
    period,
    usageBinding: { kind: 'all-provider-models' },
    ...overrides,
  };
}

function claudeSnapshot(now, entries, overrides = {}) {
  return {
    provider: 'claude',
    source: 'api',
    capturedAt: now,
    entries,
    status: { connected: true, code: 'ok', label: '', detail: '' },
    credentialMarker: oauthRefreshModule.getOAuthCredentialMarker(),
    ...overrides,
  };
}

function codexSnapshot(now, entries, auth, overrides = {}) {
  return {
    provider: 'codex',
    source: 'api',
    capturedAt: now,
    entries,
    status: { connected: true, code: 'ok', label: '', detail: '' },
    authMtimeMs: auth.authMtimeMs,
    authIdentityHash: auth.authIdentityHash,
    resetAuthMtimeMs: auth.authMtimeMs,
    resetAuthIdentityHash: auth.authIdentityHash,
    resetCredits: null,
    ...overrides,
  };
}

function withTempClaudeCredentials(token = 'claude-token') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-claude-stability-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: token, rateLimitTier: 'max_5x', subscriptionType: 'max' },
  }));
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
}

function withTempCodexAuth(token = 'codex-token') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-codex-stability-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    tokens: { access_token: token, account_id: 'acct_test' },
  }));
  process.env.CODEX_HOME = dir;
  return {
    authMtimeMs: fs.statSync(path.join(dir, 'auth.json')).mtimeMs,
    authIdentityHash: getCodexAuthIdentityHash(),
  };
}

function applyClaude(manager, snapshot, startedAt = snapshot.capturedAt) {
  const seq = (manager.apiRequestSeq ?? 0) + 1;
  manager.apiRequestSeq = seq;
  manager.providerQuotaRequestSeqs.set('claude', seq);
  return manager.applyProviderQuotaSnapshot(snapshot, seq, startedAt);
}

function applyCodex(manager, snapshot, startedAt = snapshot.capturedAt) {
  const seq = (manager.codexUsageRequestSeq ?? 0) + 1;
  manager.codexUsageRequestSeq = seq;
  manager.providerQuotaRequestSeqs.set('codex', seq);
  return manager.applyProviderQuotaSnapshot(snapshot, seq, startedAt);
}

test.afterEach(() => {
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('canonical aging expires entries independently without source mixing', () => {
  const now = Date.now();
  const snapshot = claudeSnapshot(now - 1_000, [
    entry('claude', '5h', 31, now, { resetsAt: now - 1 }),
    entry('claude', '7d', 62, now, { resetsAt: now + 60_000 }),
  ]);
  const aged = ageProviderQuotaSnapshot(snapshot, now);
  assert.deepEqual(aged.entries.map(item => item.key), ['claude.account.7d']);
  assert.equal(aged.source, 'api');
});

test('canonical validator rejects old window shape and strips private fields', () => {
  assert.equal(validateProviderQuotaSnapshot({
    provider: 'claude', source: 'api', capturedAt: 1,
    windows: { h5: { pct: 10 } },
  }), null);
  const valid = validateProviderQuotaSnapshot({
    ...claudeSnapshot(1, [entry('claude', '5h', 10, 1)]),
    secret: 'drop-me',
  });
  assert.ok(valid);
  assert.equal('secret' in valid, false);
  assert.equal('credentialMarker' in valid, false);
});

test('Claude canonical cache hydrates once and ages individual entries', () => {
  withTempClaudeCredentials();
  const now = Date.now();
  const marker = oauthRefreshModule.getOAuthCredentialMarker();
  const store = makeStore({
    enabledProviders: ['claude'],
    _cachedClaudeQuota: {
      schemaVersion: 1,
      credentialMarker: marker,
      snapshot: claudeSnapshot(now - 1_000, [
        entry('claude', '5h', 14, now, { resetsAt: now - 1 }),
        entry('claude', '7d', 28, now, { resetsAt: now + 60_000 }),
      ]),
    },
  });
  const manager = new StateManager(store, () => {});
  const quota = manager.buildProviderQuotas(now).claude;
  assert.deepEqual(quota.entries.map(item => item.key), ['claude.account.7d']);
  assert.equal(quota.entries[0].usedPct, 28);
  assert.equal(quota.source, 'cache');
});

test('Claude legacy cache is retired and credential mismatch discards canonical cache', () => {
  withTempClaudeCredentials();
  const now = Date.now();
  const store = makeStore({
    enabledProviders: ['claude'],
    _cachedApiPct: { schemaVersion: 2, h5Pct: 77 },
    _cachedClaudeQuota: {
      schemaVersion: 1,
      credentialMarker: 'different-credential',
      snapshot: claudeSnapshot(now, [entry('claude', '5h', 77, now)]),
    },
  });
  const manager = new StateManager(store, () => {});
  assert.equal('_cachedApiPct' in store.values, false);
  assert.equal('_cachedClaudeQuota' in store.values, false);
  assert.equal(manager.buildProviderQuotas(now).claude.entries.length, 0);
});

test('Claude failed refresh keeps the last whole trusted snapshot without rewriting it', () => {
  withTempClaudeCredentials();
  const now = Date.now();
  const store = makeStore({ enabledProviders: ['claude'] });
  const manager = new StateManager(store, () => {});
  applyClaude(manager, claudeSnapshot(now, [
    entry('claude', '5h', 33, now),
    entry('claude', '7d', 44, now),
  ]));
  const persisted = store.values._cachedClaudeQuota;
  applyClaude(manager, claudeSnapshot(now + 1, [], {
    status: { connected: false, code: 'rate-limited', label: 'rate limited', detail: 'slow', retryAfterMs: 90_000 },
  }), now + 1);
  assert.equal(store.values._cachedClaudeQuota, persisted);
  assert.deepEqual(manager.buildProviderQuotas(now + 1).claude.entries.map(item => item.usedPct), [33, 44]);
  assert.equal(manager.apiBackoffMs, 90_000);
});

test('Claude Retry-After is capped and a newer request generation wins', () => {
  withTempClaudeCredentials();
  const now = Date.now();
  const manager = new StateManager(makeStore({ enabledProviders: ['claude'] }), () => {});
  const oldSeq = (manager.apiRequestSeq ?? 0) + 1;
  manager.apiRequestSeq = oldSeq;
  manager.providerQuotaRequestSeqs.set('claude', oldSeq);
  const newSnapshot = claudeSnapshot(now + 2, [entry('claude', '5h', 82, now + 2)]);
  applyClaude(manager, newSnapshot, now + 2);
  assert.equal(manager.applyProviderQuotaSnapshot(
    claudeSnapshot(now, [entry('claude', '5h', 12, now)]),
    oldSeq,
    now,
  ), false);
  assert.equal(manager.buildProviderQuotas(now + 3).claude.entries[0].usedPct, 82);

  applyClaude(manager, claudeSnapshot(now + 4, [], {
    status: { connected: false, code: 'rate-limited', label: 'rate limited', detail: 'slow', retryAfterMs: CLAUDE_API_MAX_BACKOFF_MS * 2 },
  }), now + 4);
  assert.equal(manager.apiBackoffMs, CLAUDE_API_MAX_BACKOFF_MS);
});

test('Codex canonical cache hydrates only for the current auth identity', () => {
  const auth = withTempCodexAuth();
  const now = Date.now();
  const store = makeStore({
    enabledProviders: ['codex'],
    _cachedCodexQuota: {
      schemaVersion: 1,
      authMtimeMs: auth.authMtimeMs,
      authIdentityHash: auth.authIdentityHash,
      snapshot: codexSnapshot(now - 1_000, [entry('codex', '5h', 26, now)], auth),
    },
  });
  const manager = new StateManager(store, () => {});
  const quota = manager.buildProviderQuotas(now).codex;
  assert.equal(quota.entries[0].usedPct, 26);
  assert.equal(quota.source, 'cache');
});

test('Codex legacy cache is retired and a mismatched canonical cache is rejected', () => {
  const auth = withTempCodexAuth();
  const now = Date.now();
  const store = makeStore({
    enabledProviders: ['codex'],
    _cachedCodexUsagePct: { schemaVersion: 4, h5Pct: 55 },
    _cachedCodexQuota: {
      schemaVersion: 1,
      authMtimeMs: auth.authMtimeMs,
      authIdentityHash: 'wrong-auth',
      snapshot: codexSnapshot(now, [entry('codex', '5h', 55, now)], auth),
    },
  });
  const manager = new StateManager(store, () => {});
  assert.equal('_cachedCodexUsagePct' in store.values, false);
  assert.equal('_cachedCodexQuota' in store.values, false);
  assert.equal(manager.buildProviderQuotas(now).codex.entries.length, 0);
});

test('Codex selects a connected API snapshot as a whole before local-log and cache candidates', () => {
  const auth = withTempCodexAuth();
  const now = Date.now();
  const manager = new StateManager(makeStore({ enabledProviders: ['codex'] }), () => {});
  manager.codexRateLimits = {
    capturedAt: now + 10,
    position: 10,
    sourceId: 'local-newer',
    entries: [entry('codex', '5h', 91, now)],
  };
  applyCodex(manager, codexSnapshot(now, [
    entry('codex', '5h', 19, now),
    entry('codex', '7d', 29, now),
  ], auth));
  const quota = manager.buildProviderQuotas(now + 20).codex;
  assert.deepEqual(quota.entries.map(item => item.usedPct), [19, 29]);
  assert.equal(quota.source, 'api');
});

test('Codex reset-only refresh cannot replace the last full usage snapshot', () => {
  const auth = withTempCodexAuth();
  const now = Date.now();
  const store = makeStore({ enabledProviders: ['codex'] });
  const manager = new StateManager(store, () => {});
  applyCodex(manager, codexSnapshot(now, [
    entry('codex', '5h', 37, now),
    entry('codex', '7d', 48, now),
  ], auth));
  const persisted = store.values._cachedCodexQuota;

  applyCodex(manager, codexSnapshot(now + 1, [], auth, {
    source: 'cache',
    usageSkipped: true,
    resetCredits: {
      credits: [],
      availableCount: 0,
      totalEarnedCount: 0,
      checkedAt: now + 1,
      countOnly: false,
      source: 'api',
      status: { connected: true, code: 'ok', label: '', detail: '' },
    },
  }));

  assert.equal(store.values._cachedCodexQuota, persisted);
  const quota = manager.buildProviderQuotas(now + 2).codex;
  assert.deepEqual(quota.entries.map(item => item.usedPct), [37, 48]);
  assert.equal(quota.source, 'api');
});

test('Codex local-log expiry removes the whole stale candidate without placeholders', () => {
  const auth = withTempCodexAuth();
  const now = Date.now();
  const manager = new StateManager(makeStore({ enabledProviders: ['codex'] }), () => {});
  manager.codexRateLimits = {
    capturedAt: now - 10_000,
    position: 1,
    sourceId: 'expired',
    entries: [entry('codex', '5h', 90, now, { resetsAt: now - 1 })],
  };
  const quota = manager.buildProviderQuotas(now).codex;
  assert.deepEqual(quota.entries, []);
  assert.equal(quota.entries.some(item => item.state === 'unlimited'), false);
  assert.ok(auth.authIdentityHash);
});
