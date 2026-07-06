import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import codexUsageFetcher from '../dist/main/codexUsageFetcher.js';
import codexQuota from '../dist/main/providers/codex/quota.js';

const {
  CODEX_USAGE_CACHE_SCHEMA_VERSION,
  resolveCodexResetCreditsUrl,
  parseCodexResetCreditsPayload,
  resetCreditsFromUsagePayload,
  fetchCodexResetCredits,
  codexAuthPath,
  getCodexAuthIdentityHash,
} = codexUsageFetcher;
const { fetchCodexQuota } = codexQuota;

const originalRequest = https.request;
const originalCodexHome = process.env.CODEX_HOME;
const tempDirs = [];
let lastRequestOptions = null;

function makeTempCodexHome(authPayload = null, configText = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-codex-reset-test-'));
  tempDirs.push(dir);
  process.env.CODEX_HOME = dir;
  if (authPayload) {
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(authPayload));
  }
  if (configText != null) {
    fs.writeFileSync(path.join(dir, 'config.toml'), configText);
  }
  return dir;
}

function emitResponse(callback, statusCode, payload, headers) {
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = (error) => {
    if (error) process.nextTick(() => req.emit('error', error));
  };
  req.end = () => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers = headers ?? {};
    callback(res);
    process.nextTick(() => {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      if (body) res.emit('data', body);
      res.emit('end');
    });
  };
  return req;
}

function withHttpResponse(statusCode, payload, headers = {}) {
  https.request = function patchedRequest(options, callback) {
    lastRequestOptions = options;
    return emitResponse(callback, statusCode, payload, headers);
  };
}

// Route by request path so usage and reset endpoints can succeed/fail independently.
function routeHttp({ usage, reset }) {
  const hits = { usage: 0, reset: 0 };
  https.request = function patchedRequest(options, callback) {
    lastRequestOptions = options;
    const p = String(options.path || '');
    const isReset = p.endsWith('/rate-limit-reset-credits');
    const spec = isReset ? reset : usage;
    if (isReset) hits.reset += 1;
    else hits.usage += 1;
    return emitResponse(callback, spec.status, spec.body, spec.headers ?? {});
  };
  return hits;
}

function restoreMocks() {
  https.request = originalRequest;
  lastRequestOptions = null;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ensureTempCodexAuth() {
  if (!process.env.CODEX_HOME || !fs.existsSync(path.join(process.env.CODEX_HOME, 'auth.json'))) {
    makeTempCodexHome({ tokens: { access_token: 'test-access-token', account_id: 'acct_test' } });
  }
  return {
    authMtimeMs: fs.statSync(codexAuthPath()).mtimeMs,
    authIdentityHash: getCodexAuthIdentityHash(),
  };
}

test.afterEach(() => {
  restoreMocks();
});

test('reset-credits URL follows the wham path style', () => {
  assert.equal(resolveCodexResetCreditsUrl('https://chatgpt.com'), 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(resolveCodexResetCreditsUrl('https://chat.openai.com/'), 'https://chat.openai.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(resolveCodexResetCreditsUrl('https://example.test'), 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(resolveCodexResetCreditsUrl('https://chatgpt.com/backend-api/wham/usage'), 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(resolveCodexResetCreditsUrl('https://chatgpt.com/api/codex'), 'https://chatgpt.com/api/codex/rate-limit-reset-credits');
  assert.equal(resolveCodexResetCreditsUrl('https://chatgpt.com/api/codex/usage'), 'https://chatgpt.com/api/codex/rate-limit-reset-credits');
  assert.equal(resolveCodexResetCreditsUrl('https://myproxy.com/wham/usage'), 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
});

test('parses available credits sorted soonest-first, drops non-available', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  const data = parseCodexResetCreditsPayload({
    available_count: 2,
    total_earned_count: 5,
    credits: [
      { id: 'RateLimitReset_bbb', status: 'available', expires_at: '2026-07-18T08:36:00.000000Z', granted_at: '2026-06-18T08:36:00Z' },
      { id: 'RateLimitReset_aaa', status: 'available', expires_at: '2026-07-12T11:46:00.000000Z' },
      { id: 'RateLimitReset_ccc', status: 'redeemed', expires_at: '2026-07-01T00:00:00Z', redeemed_at: '2026-06-30T00:00:00Z' },
    ],
  }, now);
  assert.equal(data.credits.length, 2);
  assert.equal(data.credits[0].expiresAtUtc, '2026-07-12T11:46:00.000000Z');
  assert.equal(data.credits[1].expiresAtUtc, '2026-07-18T08:36:00.000000Z');
  assert.equal(data.credits[0].status, 'available');
  assert.equal(data.credits[0].idSuffix, null);
  assert.equal(data.availableCount, 2);
  assert.equal(data.totalEarnedCount, 5);
  assert.equal(data.countOnly, false);
  assert.equal(data.source, 'api');
});

test('expires_at variants: trailing Z, explicit offset, and null all parse', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  const data = parseCodexResetCreditsPayload({
    available_count: 3,
    credits: [
      { id: 'z', status: 'available', expires_at: '2026-07-12T11:46:00Z' },
      { id: 'o', status: 'available', expires_at: '2026-07-10T00:00:00+02:00' },
      { id: 'n', status: 'available', expires_at: null },
    ],
  }, now);
  // null-expiry credit is retained (available) but sorts last
  assert.equal(data.credits.length, 3);
  assert.equal(data.credits[data.credits.length - 1].expiresAtUtc, null);
  assert.equal(data.credits[0].expiresAtUtc, '2026-07-10T00:00:00+02:00');
});

test('invalid expires_at marks the reset-credit payload as schema-changed', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  assert.equal(parseCodexResetCreditsPayload({
    available_count: 1,
    credits: [{ id: 'bad', status: 'available', expires_at: 'not-a-date' }],
  }, now), null);
});

test('missing expires_at marks the reset-credit payload as schema-changed', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  assert.equal(parseCodexResetCreditsPayload({
    available_count: 1,
    credits: [{ id: 'missing', status: 'available' }],
  }, now), null);
});

test('available_count absent is derived from the available list', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  const data = parseCodexResetCreditsPayload({
    credits: [
      { id: 'a', status: 'available', expires_at: '2026-07-12T00:00:00Z' },
      { id: 'b', status: 'available', expires_at: '2026-07-13T00:00:00Z' },
    ],
  }, now);
  assert.equal(data.availableCount, 2);
});

test('usage-embedded fallback carries the REAL reset status, not a synthetic ok (R2-1)', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  // The count-only fallback must stamp the FAILING reset status so backoff/eviction still fire downstream.
  const failing = { code: 'rate-limited', connected: false, label: 'rate limited', detail: 'slow', retryAfterMs: 90_000 };
  const data = resetCreditsFromUsagePayload({ rate_limit_reset_credits: { available_count: 4 } }, now, failing);
  assert.equal(data.countOnly, true);
  assert.equal(data.availableCount, 4);
  assert.equal(data.credits.length, 0);
  assert.equal(data.status.code, 'rate-limited');       // NOT laundered to ok
  assert.equal(data.status.retryAfterMs, 90_000);
  assert.equal(data.source, 'usage');
});

test('usage payload without reset-credit field yields no fallback', () => {
  const failing = { code: 'network', connected: false, label: 'api disconnected', detail: 'x' };
  assert.equal(resetCreditsFromUsagePayload({ rate_limit: {} }, Date.now(), failing), null);
});

test('empty-but-well-formed 200 is a valid zero result, not schema-changed', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  // A present credits array OR a numeric available_count makes it a legit zero.
  const withArray = parseCodexResetCreditsPayload({ credits: [], available_count: 0 }, now);
  assert.notEqual(withArray, null);
  assert.equal(withArray.availableCount, 0);
  assert.equal(withArray.credits.length, 0);
  const countOnlyShape = parseCodexResetCreditsPayload({ available_count: 0 }, now);
  assert.notEqual(countOnlyShape, null);
  assert.equal(countOnlyShape.availableCount, 0);
});

test('unexpected-shape 200 (neither credits array nor numeric available_count) returns null', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  assert.equal(parseCodexResetCreditsPayload({}, now), null);
  assert.equal(parseCodexResetCreditsPayload({ unrelated: true }, now), null);
  assert.equal(parseCodexResetCreditsPayload('not-json-object', now), null);
});

// --- Step 1: network fn ---

test('fetchCodexResetCredits reads auth.json, sends the usage header set, parses list', async () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token', account_id: 'acct_test' } });
  withHttpResponse(200, {
    available_count: 1, total_earned_count: 0,
    credits: [{ id: 'RateLimitReset_xyz', status: 'available', expires_at: '2026-07-12T11:46:00.000000Z' }],
  });
  const result = await fetchCodexResetCredits();
  assert.equal(result.status.code, 'ok');
  assert.equal(result.data?.credits.length, 1);
  assert.equal(result.data?.countOnly, false);
  assert.equal(lastRequestOptions.path, '/backend-api/wham/rate-limit-reset-credits');
  assert.equal(lastRequestOptions.headers.Authorization, 'Bearer test-access-token');
  assert.equal(lastRequestOptions.headers['ChatGPT-Account-Id'], 'acct_test');
  // No checker-specific headers
  assert.equal(lastRequestOptions.headers.originator, undefined);
  assert.equal(lastRequestOptions.headers['OAI-Product-Sku'], undefined);
  assert.equal(JSON.stringify(result.status).includes('test-access-token'), false);
});

test('fetchCodexResetCredits without account id still parses', async () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token' } });
  withHttpResponse(200, { available_count: 0, credits: [] });
  const result = await fetchCodexResetCredits();
  assert.equal(result.status.code, 'ok');
  assert.equal(lastRequestOptions.headers['ChatGPT-Account-Id'], undefined);
  assert.equal(result.data?.availableCount, 0);
});

test('fetchCodexResetCredits with no credentials makes no network call', async () => {
  makeTempCodexHome();
  withHttpResponse(200, {});
  const result = await fetchCodexResetCredits();
  assert.equal(result.status.code, 'no-credentials');
  assert.equal(result.data, null);
  assert.equal(lastRequestOptions, null);
});

test('fetchCodexResetCredits rejects non-OpenAI custom base URLs before sending auth headers', async () => {
  makeTempCodexHome(
    { tokens: { access_token: 'test-access-token', account_id: 'acct_test' } },
    'chatgpt_base_url = "https://example.test"',
  );
  withHttpResponse(200, {
    should_not: 'be requested',
  });

  const result = await fetchCodexResetCredits();

  assert.equal(result.status.code, 'schema-changed');
  assert.equal(result.status.label, 'unsupported endpoint');
  assert.equal(result.data, null);
  assert.equal(lastRequestOptions, null);
  assert.equal(JSON.stringify(result.status).includes('test-access-token'), false);
});

test('fetchCodexResetCredits 401 classifies unauthorized without leaking token', async () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token' } });
  withHttpResponse(401, { error: 'nope' });
  const result = await fetchCodexResetCredits();
  assert.equal(result.status.code, 'unauthorized');
  assert.equal(result.data, null);
  assert.equal(JSON.stringify(result.status).includes('test-access-token'), false);
});

test('fetchCodexResetCredits 429 surfaces Retry-After', async () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token' } });
  withHttpResponse(429, { error: 'slow down' }, { 'retry-after': '90' });
  const result = await fetchCodexResetCredits();
  assert.equal(result.status.code, 'rate-limited');
  assert.equal(result.status.retryAfterMs, 90_000);
});

test('fetchCodexResetCredits maps unexpected-shape 200 to schema-changed with responseKeys', async () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token' } });
  withHttpResponse(200, { totally: 'unexpected', shape: 1 });
  const result = await fetchCodexResetCredits();
  assert.equal(result.status.code, 'schema-changed');
  assert.equal(result.data, null);
  assert.deepEqual(result.status.responseKeys, ['shape', 'totally']);
  assert.equal(JSON.stringify(result.status).includes('test-access-token'), false);
});

test('fetchCodexResetCredits maps invalid JSON 200 to schema-changed', async () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token' } });
  withHttpResponse(200, 'not json');
  const result = await fetchCodexResetCredits();
  assert.equal(result.status.code, 'schema-changed');
  assert.equal(result.data, null);
});

test('fetchCodexResetCredits maps a 404 (endpoint removed/moved) to schema-changed, not http-error (R4-1)', async () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token' } });
  withHttpResponse(404, { error: 'not found' });
  const result = await fetchCodexResetCredits();
  assert.equal(result.status.code, 'schema-changed');   // NOT 'http-error'
  assert.equal(result.status.httpStatus, 404);
  assert.equal(result.data, null);
});

// --- Step 5c: fetchCodexQuota-level independence + no-launder (R2-1 / R2-2) ---

const nowMs = Date.parse('2026-07-04T00:00:00Z');
const ctx = { nowMs, settings: {}, jsonlCache: {}, scanBudgetMs: null, prioritySourceIds: new Set(), includeFullHistory: false, force: false };

test('usage-ok + reset-429: count may show but status stays rate-limited (backoff will fire)', async () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token' } });
  routeHttp({
    usage: { status: 200, body: { rate_limit: { primary_window: { used_percent: 5, reset_at: Math.floor(nowMs/1000)+3600, limit_window_seconds: 18000 } }, rate_limit_reset_credits: { available_count: 3 } } },
    reset: { status: 429, body: { error: 'slow' }, headers: { 'retry-after': '90' } },
  });
  const snap = await fetchCodexQuota(ctx);
  assert.equal(snap.resetCredits.status.code, 'rate-limited');   // NOT ok
  assert.equal(snap.resetCredits.status.retryAfterMs, 90_000);
  assert.equal(snap.resetCredits.availableCount, 3);             // count-only fallback still shows the count
  assert.equal(snap.resetCredits.countOnly, true);
  assert.ok(snap.usage, 'usage unaffected');
});

test('usage-ok + reset-401: error state, no stale count laundered as ok', async () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token' } });
  routeHttp({
    usage: { status: 200, body: { rate_limit: { primary_window: { used_percent: 5, reset_at: Math.floor(nowMs/1000)+3600, limit_window_seconds: 18000 } }, rate_limit_reset_credits: { available_count: 3 } } },
    reset: { status: 401, body: { error: 'nope' } },
  });
  const snap = await fetchCodexQuota(ctx);
  assert.equal(snap.resetCredits.status.code, 'unauthorized');   // preserved -> Task 3 evicts
  assert.equal(snap.resetCredits.availableCount, 0);             // do NOT show a stale count for a rejected credential
  assert.equal(snap.resetCredits.countOnly, false);
  assert.ok(snap.usage, 'usage unaffected');
});

test('usage-ok + reset-schema-changed: failing status preserved, empty list', async () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token' } });
  routeHttp({
    usage: { status: 200, body: { rate_limit: { primary_window: { used_percent: 5, reset_at: Math.floor(nowMs/1000)+3600, limit_window_seconds: 18000 } } } },
    reset: { status: 200, body: { totally: 'unexpected' } },     // -> schema-changed
  });
  const snap = await fetchCodexQuota(ctx);
  assert.equal(snap.resetCredits.status.code, 'schema-changed');
  assert.equal(snap.resetCredits.credits.length, 0);
});

test('reset-ok + usage-fail: reset data still returned (independent failure)', async () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token' } });
  routeHttp({
    usage: { status: 500, body: { error: 'boom' } },
    reset: { status: 200, body: { available_count: 2, credits: [ { id: 'a', status: 'available', expires_at: '2999-01-01T00:00:00Z' }, { id: 'b', status: 'available', expires_at: '2999-02-01T00:00:00Z' } ] } },
  });
  const snap = await fetchCodexQuota(ctx);
  assert.equal(snap.resetCredits.status.code, 'ok');
  assert.equal(snap.resetCredits.credits.length, 2);
});

test('ctx.skipCodexResetCredits: dedicated reset GET is skipped, usage GET still fires (R2-2)', async () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token' } });
  const hits = routeHttp({
    usage: { status: 200, body: { rate_limit: { primary_window: { used_percent: 5, reset_at: Math.floor(nowMs/1000)+3600, limit_window_seconds: 18000 } } } },
    reset: { status: 200, body: { available_count: 9, credits: [] } },
  });
  const snap = await fetchCodexQuota({ ...ctx, skipCodexResetCredits: true });
  assert.equal(hits.usage, 1, 'usage GET fired');
  assert.equal(hits.reset, 0, 'reset GET skipped during cooldown');
  assert.equal(snap.resetCredits, null, 'no overwrite -> StateManager keeps stored data');
});

// --- Step 1 (Task 3): cache normalizer ---

const { normalizeStoredCodexResetCredits, CODEX_RESET_CREDITS_CACHE_SCHEMA_VERSION } = codexUsageFetcher;

test('stored reset-credit cache rejected on auth mtime change or schema mismatch', () => {
  const now = Date.now();
  const authIdentityHash = 'auth-hash-a';
  const stored = {
    schemaVersion: CODEX_RESET_CREDITS_CACHE_SCHEMA_VERSION,
    storedAt: now - 1000,
    authMtimeMs: 123,
    authIdentityHash,
    data: {
      credits: [{ idSuffix: 'aaa', status: 'available', expiresAtUtc: '2026-07-12T11:46:00Z' }],
      availableCount: 1, totalEarnedCount: 0, checkedAt: now - 1000, countOnly: false, source: 'api',
      status: { code: 'ok', connected: true, label: '', detail: '' },
    },
  };
  assert.equal(normalizeStoredCodexResetCredits(stored, 456, authIdentityHash), null);            // mtime mismatch
  assert.equal(normalizeStoredCodexResetCredits(stored, 123, 'auth-hash-b'), null);               // auth marker mismatch
  assert.equal(normalizeStoredCodexResetCredits({ ...stored, schemaVersion: 99 }, 123, authIdentityHash), null); // schema mismatch
  const ok = normalizeStoredCodexResetCredits(stored, 123, authIdentityHash);
  assert.equal(ok?.data.availableCount, 1);
  assert.equal(ok?.data.credits[0].idSuffix, null);
  assert.equal(ok?.data.credits[0].expiresAtUtc, '2026-07-12T11:46:00Z');
});

test('stored reset-credit cache rejects count-only data and clamps counts', () => {
  const now = Date.now();
  const authIdentityHash = 'auth-hash-a';
  const stored = {
    schemaVersion: CODEX_RESET_CREDITS_CACHE_SCHEMA_VERSION,
    storedAt: now - 1000,
    authMtimeMs: 123,
    authIdentityHash,
    data: {
      credits: [{ idSuffix: 'aaa', status: 'available', expiresAtUtc: '2026-07-12T11:46:00Z' }],
      availableCount: -1.4, totalEarnedCount: 2.6, checkedAt: now - 1000, countOnly: false, source: 'api',
      status: { code: 'ok', connected: true, label: '', detail: '' },
    },
  };
  const normalized = normalizeStoredCodexResetCredits(stored, 123, authIdentityHash);
  assert.equal(normalized?.data.availableCount, 0);
  assert.equal(normalized?.data.totalEarnedCount, 3);
  assert.equal(normalizeStoredCodexResetCredits({ ...stored, data: { ...stored.data, countOnly: true } }, 123, authIdentityHash), null);
});

// --- Step 5b (Task 3): store-level apply path ---

import stateManagerModule from '../dist/main/stateManager.js';
const { StateManager } = stateManagerModule;

function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    store: initial,
    get: (k, fb = null) => (map.has(k) ? map.get(k) : fb),
    set(k, v) {
      map.set(k, v);
      this.store[k] = v;
    },
    delete(k) {
      map.delete(k);
      delete this.store[k];
    },
  };
}

function codexSnapshot({ usage = true, reset }) {
  const { authMtimeMs, authIdentityHash } = ensureTempCodexAuth();
  return {
    provider: 'codex', source: 'api', capturedAt: Date.now(),
    groups: [], windowDisplay: {},
    windows: usage ? { h5: { pct: 5, resetMs: 3600000, source: 'api' } } : undefined,
    usage: usage ? { h5Available: true, weekAvailable: false, h5Pct: 5, weekPct: 0, h5ResetMs: 3600000, weekResetMs: null, h5LimitReached: false, weekLimitReached: false, plan: 'pro', credits: null, limitReached: false, rateLimitReachedType: null } : null,
    status: { code: 'ok', connected: true, label: '', detail: '' },
    authMtimeMs,
    authIdentityHash,
    resetAuthMtimeMs: authMtimeMs,
    resetAuthIdentityHash: authIdentityHash,
    resetCredits: reset,
  };
}

function noCredentialCodexSnapshot() {
  return {
    provider: 'codex', source: 'localLog', capturedAt: Date.now(),
    groups: [], windowDisplay: {},
    windows: undefined,
    usage: null,
    status: { code: 'no-credentials', connected: false, label: 'local log', detail: 'Codex auth.json with ChatGPT tokens was not found.' },
    authMtimeMs: null,
    authIdentityHash: null,
    resetAuthMtimeMs: null,
    resetAuthIdentityHash: null,
    resetCredits: null,
  };
}

function seedResetAuth(mgr) {
  const { authMtimeMs, authIdentityHash } = ensureTempCodexAuth();
  mgr.codexResetAuthMtimeMs = authMtimeMs;
  mgr.codexResetAuthIdentityHash = authIdentityHash;
  mgr.codexResetAttemptAuthMtimeMs = authMtimeMs;
  mgr.codexResetAttemptAuthIdentityHash = authIdentityHash;
  return { authMtimeMs, authIdentityHash };
}

function applyCodex(mgr, snapshot) {
  const seq = (mgr.codexUsageRequestSeq = (mgr.codexUsageRequestSeq ?? 0) + 1);
  mgr.providerQuotaRequestSeqs?.set?.('codex', seq);
  return mgr.applyProviderQuotaSnapshot(snapshot, seq, Date.now());
}

function suppressSettingsSideEffects(mgr) {
  mgr.publishState = () => {};
  mgr.startWatcher = () => {};
  mgr.clearHistoryWarmup = () => {};
  mgr.clearGitWarmup = () => {};
  mgr.requestRefresh = async () => {};
}

test('reset ok persists _cachedCodexResetCredits; usage cache written independently', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const reset = { credits: [{ idSuffix: 'a', status: 'available', expiresAtUtc: '2999-01-01T00:00:00Z' }], availableCount: 1, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset }));
  assert.ok(store.map.get('_cachedCodexResetCredits'), 'reset cache written');
  assert.ok(store.map.get('_cachedCodexUsagePct'), 'usage cache written');
});

test('Codex-disabled startup does not expose or validate persisted Codex quota caches', () => {
  const store = fakeStore({
    enabledProviders: ['claude'],
    _cachedCodexUsagePct: { schemaVersion: 999 },
    _cachedCodexResetCredits: { schemaVersion: 999 },
  });
  const mgr = new StateManager(store, () => {});
  const quotas = mgr.buildProviderQuotas(Date.now());
  assert.equal(quotas.codex, undefined);
  assert.equal(store.map.has('_cachedCodexUsagePct'), true);
  assert.equal(store.map.has('_cachedCodexResetCredits'), true);
});

test('startup restored Codex provider quota is stripped until auth-bound cache validates', () => {
  const resetCredits = {
    credits: [{ idSuffix: null, status: 'available', expiresAtUtc: '2999-01-01T00:00:00Z' }],
    availableCount: 1,
    totalEarnedCount: 0,
    checkedAt: Date.now(),
    countOnly: false,
    source: 'cache',
    status: { code: 'ok', connected: false },
  };
  const store = fakeStore({
    enabledProviders: ['codex'],
    _startupStateSnapshot: {
      schemaVersion: 5,
      savedAt: Date.now(),
      state: {
        providerQuotas: {
          codex: {
            provider: 'codex',
            source: 'cache',
            capturedAt: Date.now(),
            windows: {},
            resetCredits,
          },
        },
        sessions: [],
        repoGitStats: {},
        initialRefreshComplete: true,
        historyWarmupPending: false,
        historyWarmupStartsAt: null,
        codeOutputLoading: false,
        lastUpdated: Date.now(),
      },
    },
  });
  const mgr = new StateManager(store, () => {});
  assert.equal(mgr.getState().providerQuotas.codex, undefined);
});

test('startup valid auth-bound Codex caches are exposed in initial providerQuotas', () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token', account_id: 'acct_test' } });
  const { authMtimeMs, authIdentityHash } = ensureTempCodexAuth();
  const now = Date.now();
  const store = fakeStore({
    enabledProviders: ['codex'],
    _cachedCodexUsagePct: {
      schemaVersion: CODEX_USAGE_CACHE_SCHEMA_VERSION,
      storedAt: now - 1000,
      authMtimeMs,
      authIdentityHash,
      h5Available: true,
      weekAvailable: false,
      h5Pct: 12,
      weekPct: 0,
      h5ResetMs: 3_600_000,
      weekResetMs: null,
      h5LimitReached: false,
      weekLimitReached: false,
      plan: 'pro',
      credits: null,
      limitReached: false,
      rateLimitReachedType: null,
    },
    _cachedCodexResetCredits: {
      schemaVersion: CODEX_RESET_CREDITS_CACHE_SCHEMA_VERSION,
      storedAt: now - 1000,
      authMtimeMs,
      authIdentityHash,
      data: {
        credits: [{ idSuffix: 'local', status: 'available', expiresAtUtc: '2999-01-01T00:00:00Z' }],
        availableCount: 1,
        totalEarnedCount: 0,
        checkedAt: now - 1000,
        countOnly: false,
        source: 'api',
        status: { code: 'ok', connected: true, label: '', detail: '' },
      },
    },
  });

  const mgr = new StateManager(store, () => {});
  const quota = mgr.getState().providerQuotas.codex;

  assert.ok(quota, 'Codex quota is visible before the first refresh');
  assert.equal(quota.windows.h5.pct, 12);
  assert.equal(quota.resetCredits.availableCount, 1);
  assert.equal(quota.resetCredits.source, 'cache');
  assert.equal(quota.resetCredits.credits[0].idSuffix, null);
});

test('Codex provider toggle clears usage and reset cooldown timers', () => {
  const store = fakeStore({ enabledProviders: ['codex'] });
  const mgr = new StateManager(store, () => {});
  suppressSettingsSideEffects(mgr);
  mgr.lastCodexUsageCallMs = Date.now();
  mgr.lastCodexResetCallMs = Date.now();
  mgr.codexUsageBackoffMs = 90_000;
  mgr.codexResetBackoffMs = 90_000;

  store.set('enabledProviders', ['claude']);
  mgr.applySettingsChange();

  assert.equal(mgr.lastCodexUsageCallMs, 0);
  assert.equal(mgr.lastCodexResetCallMs, 0);
  assert.equal(mgr.codexUsageBackoffMs, 0);
  assert.equal(mgr.codexResetBackoffMs, 0);

  mgr.lastCodexUsageCallMs = Date.now();
  mgr.lastCodexResetCallMs = Date.now();
  mgr.codexUsageBackoffMs = 90_000;
  mgr.codexResetBackoffMs = 90_000;

  store.set('enabledProviders', ['claude', 'codex']);
  mgr.applySettingsChange();

  assert.equal(mgr.lastCodexUsageCallMs, 0);
  assert.equal(mgr.lastCodexResetCallMs, 0);
  assert.equal(mgr.codexUsageBackoffMs, 0);
  assert.equal(mgr.codexResetBackoffMs, 0);
});

test('Codex provider toggle preserves auth-bound caches and rehydrates them when re-enabled', () => {
  makeTempCodexHome({ tokens: { access_token: 'test-access-token', account_id: 'acct_test' } });
  const { authMtimeMs, authIdentityHash } = ensureTempCodexAuth();
  const now = Date.now();
  const store = fakeStore({
    enabledProviders: ['codex'],
    _cachedCodexUsagePct: {
      schemaVersion: CODEX_USAGE_CACHE_SCHEMA_VERSION,
      storedAt: now - 1000,
      authMtimeMs,
      authIdentityHash,
      h5Available: true,
      weekAvailable: false,
      h5Pct: 22,
      weekPct: 0,
      h5ResetMs: 3_600_000,
      weekResetMs: null,
      h5LimitReached: false,
      weekLimitReached: false,
      plan: 'pro',
      credits: null,
      limitReached: false,
      rateLimitReachedType: null,
    },
    _cachedCodexResetCredits: {
      schemaVersion: CODEX_RESET_CREDITS_CACHE_SCHEMA_VERSION,
      storedAt: now - 1000,
      authMtimeMs,
      authIdentityHash,
      data: {
        credits: [{ idSuffix: null, status: 'available', expiresAtUtc: '2999-01-01T00:00:00Z' }],
        availableCount: 1,
        totalEarnedCount: 0,
        checkedAt: now - 1000,
        countOnly: false,
        source: 'api',
        status: { code: 'ok', connected: true, label: '', detail: '' },
      },
    },
  });
  const mgr = new StateManager(store, () => {});
  suppressSettingsSideEffects(mgr);

  store.set('enabledProviders', ['claude']);
  mgr.applySettingsChange();
  assert.ok(store.map.get('_cachedCodexUsagePct'), 'disabled provider does not delete auth-bound usage cache');
  assert.ok(store.map.get('_cachedCodexResetCredits'), 'disabled provider does not delete auth-bound reset cache');
  assert.equal(mgr.getState().providerQuotas.codex, undefined);

  store.set('enabledProviders', ['claude', 'codex']);
  mgr.applySettingsChange();
  const quota = mgr.getState().providerQuotas.codex;
  assert.ok(quota, 're-enabled Codex rehydrates trusted cache immediately');
  assert.equal(quota.windows.h5.pct, 22);
  assert.equal(quota.resetCredits.availableCount, 1);
});

test('reset 401 evicts ONLY the reset cache; usage cache intact', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const good = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: good }));
  assert.ok(store.map.get('_cachedCodexResetCredits'));
  const reset401 = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'unauthorized', connected: false, label: 'auth failed', detail: 'rejected' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: reset401 }));
  assert.equal(store.map.has('_cachedCodexResetCredits'), false, 'reset cache evicted on 401');
  assert.ok(store.map.get('_cachedCodexUsagePct'), 'usage cache untouched by reset 401');
});

test('reset schema-changed (e.g. a remapped 404) evicts ONLY the reset cache (R4-1)', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const good = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: good }));
  assert.ok(store.map.get('_cachedCodexResetCredits'));
  const resetSchema = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'schema-changed', connected: false, label: 'schema changed', detail: 'endpoint 404', httpStatus: 404 } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: resetSchema }));
  assert.equal(store.map.has('_cachedCodexResetCredits'), false, 'reset cache evicted on schema-changed');
  assert.ok(store.map.get('_cachedCodexUsagePct'), 'usage cache untouched');
});

test('no-credentials clears BOTH caches and zeroes reset backoff', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const good = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: good }));
  const noCred = { ...codexSnapshot({ usage: false, reset: null }), status: { code: 'no-credentials', connected: false, label: 'local log', detail: '' } };
  applyCodex(mgr, noCred);
  assert.equal(store.map.has('_cachedCodexResetCredits'), false);
  assert.equal(store.map.has('_cachedCodexUsagePct'), false);
  assert.equal(mgr.codexResetBackoffMs, 0);
  assert.equal(mgr.lastCodexUsageCallMs, 0);
});

test('Codex auth change clears failed-attempt usage and reset backoffs even without a cached sample', () => {
  const store = fakeStore();
  makeTempCodexHome({ tokens: { access_token: 'test-access-token-a', account_id: 'acct_a' } });
  const mgr = new StateManager(store, () => {});
  const now = Date.now();
  const first = mgr.beginCodexQuotaRequest(false, now);
  assert.ok(first);
  mgr.providerQuotaRequestSeqs.set('codex', first.requestSeq);
  const unauthorized = { code: 'unauthorized', connected: false, label: 'auth failed', detail: 'rejected' };
  const reset401 = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: now, countOnly: false, source: 'api', status: unauthorized };
  mgr.applyProviderQuotaSnapshot({
    ...codexSnapshot({ usage: false, reset: reset401 }),
    status: unauthorized,
    usage: null,
    windows: undefined,
  }, first.requestSeq, now);

  assert.equal(mgr.codexUsagePct, null);
  assert.ok(mgr.codexUsageBackoffMs > 0);
  assert.ok(mgr.codexResetBackoffMs > 0);

  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-access-token-b', account_id: 'acct_b' } }));
  const second = mgr.beginCodexQuotaRequest(false, now + 1000);

  assert.ok(second, 'new auth identity should bypass failed-attempt backoff and min interval');
  assert.equal(second.skipCodexUsage, false);
  assert.equal(second.skipCodexResetCredits, false);
  assert.equal(mgr.codexUsageBackoffMs, 0);
  assert.equal(mgr.codexResetBackoffMs, 0);
});

test('Codex auth appearing after no-credentials bypasses the usage min interval', () => {
  const store = fakeStore();
  const dir = makeTempCodexHome(null);
  const mgr = new StateManager(store, () => {});
  const now = Date.now();
  const first = mgr.beginCodexQuotaRequest(false, now);
  assert.ok(first);
  mgr.providerQuotaRequestSeqs.set('codex', first.requestSeq);
  mgr.applyProviderQuotaSnapshot(noCredentialCodexSnapshot(), first.requestSeq, now);

  assert.equal(mgr.codexAuthMissingObserved, true);
  assert.equal(mgr.lastCodexUsageCallMs, 0);

  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-access-token', account_id: 'acct_test' } }));
  const second = mgr.beginCodexQuotaRequest(false, now + 1000);

  assert.ok(second, 'newly present auth should be admitted immediately');
  assert.equal(second.skipCodexUsage, false);
  assert.equal(second.skipCodexResetCredits, false);
});

test('reset 429 sets reset-specific backoff without touching usage backoff (F1)', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  mgr.codexUsageBackoffMs = 0;
  const reset429 = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'rate-limited', connected: false, label: 'rate limited', detail: 'slow', retryAfterMs: 90_000 } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: reset429 }));
  assert.equal(mgr.codexResetBackoffMs, 90_000, 'reset backoff honors Retry-After');
  assert.equal(mgr.codexUsageBackoffMs, 0, 'usage backoff untouched by reset 429');
  assert.ok(store.map.get('_cachedCodexUsagePct'));
});

test('reset cooldown throttles ONLY the reset GET; usage scheduling is independent (R2-2)', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const now = Date.now();
  // Reset is in cooldown (backoff active, just called) but usage is NOT.
  mgr.codexResetBackoffMs = 90_000;
  mgr.lastCodexResetCallMs = now;
  mgr.codexUsageBackoffMs = 0;
  assert.equal(mgr.shouldSkipCodexResetCredits(now + 1000), true, 'reset skipped during its own cooldown');
  // Usage interval gate must NOT be blocked by the reset backoff: seed lastCodexUsageCallMs older than the interval.
  mgr.lastCodexUsageCallMs = now - (StateManager.CODEX_USAGE_MIN_INTERVAL_MS + 1000);
  assert.notEqual(mgr.beginCodexQuotaRequest(false, now + 1000), null, 'usage request still admitted while reset is cooled down');
});

test('reset request is admitted even when usage is inside its min interval', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const now = Date.now();
  mgr.lastCodexUsageCallMs = now;
  mgr.codexUsageBackoffMs = 0;
  mgr.codexResetBackoffMs = 0;
  mgr.lastCodexResetCallMs = 0;
  const admission = mgr.beginCodexQuotaRequest(false, now + 1000);
  assert.ok(admission, 'reset-only request admitted');
  assert.equal(admission.skipCodexUsage, true);
  assert.equal(admission.skipCodexResetCredits, false);
});

test('successful reset refreshes are throttled during the reset min interval', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const now = Date.now();
  const first = mgr.beginCodexQuotaRequest(false, now);
  assert.ok(first);
  const second = mgr.beginCodexQuotaRequest(false, now + 1000);
  assert.equal(second, null, 'usage and reset are both throttled after a fresh reset request');
});

test('cooldown-skip apply (resetCredits null) leaves stored data + timers untouched (R2-2)', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const good = { credits: [{ idSuffix: 'a', status: 'available', expiresAtUtc: '2999-01-01T00:00:00Z' }], availableCount: 1, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: good }));
  const storedBefore = store.map.get('_cachedCodexResetCredits');
  const backoffBefore = mgr.codexResetBackoffMs;
  // Next tick skips the reset GET -> snapshot carries resetCredits: null.
  applyCodex(mgr, codexSnapshot({ usage: true, reset: null }));
  assert.equal(store.map.get('_cachedCodexResetCredits'), storedBefore, 'reset cache not overwritten on skip');
  assert.equal(mgr.codexResetBackoffMs, backoffBefore, 'reset backoff not re-timed on skip');
  assert.equal(mgr.codexResetCredits.credits.length, 1, 'stored credits still available for the next public rebuild');
});

test('reset failure does not evict usage cache and vice-versa (independence)', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const checkedAt = Date.parse('2026-07-04T00:00:00Z');
  const readAt = Date.parse('2026-07-05T00:00:00Z');
  const goodReset = {
    credits: [{ idSuffix: 'aaa', status: 'available', expiresAtUtc: '2999-01-01T00:00:00Z' }],
    availableCount: 1,
    totalEarnedCount: 2,
    checkedAt,
    countOnly: false,
    source: 'api',
    status: { code: 'ok', connected: true, label: '', detail: '' },
  };

  applyCodex(mgr, codexSnapshot({ usage: true, reset: goodReset }));

  const firstPublic = mgr.buildCodexProviderQuota(readAt);
  assert.equal(firstPublic.resetCredits?.credits.length, 1, 'public snapshot carries active reset credits');
  assert.equal(firstPublic.resetCredits?.credits[0].idSuffix, null);
  assert.ok(store.map.get('_cachedCodexUsagePct'), 'usage cache written by the initial good usage apply');
  assert.ok(store.map.get('_cachedCodexResetCredits'), 'reset cache written by the initial good reset apply');

  const reset401 = {
    credits: [],
    availableCount: 0,
    totalEarnedCount: 0,
    checkedAt: checkedAt + 1,
    countOnly: false,
    source: 'api',
    status: { code: 'unauthorized', connected: false, label: 'auth failed', detail: 'rejected' },
  };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: reset401 }));

  assert.ok(store.map.get('_cachedCodexUsagePct'), 'usage cache survives reset 401');
  assert.equal(mgr.codexUsagePct?.h5Pct, 5, 'in-memory usage remains intact after reset 401');
  assert.equal(store.map.has('_cachedCodexResetCredits'), false, 'reset cache evicted on reset 401');
  assert.equal(mgr.codexResetCredits, null, 'in-memory reset cache evicted on reset 401');

  const nextReset = {
    credits: [{ idSuffix: 'bbb', status: 'available', expiresAtUtc: '2999-02-01T00:00:00Z' }],
    availableCount: 1,
    totalEarnedCount: 3,
    checkedAt: checkedAt + 2,
    countOnly: false,
    source: 'api',
    status: { code: 'ok', connected: true, label: '', detail: '' },
  };
  const usage401 = {
    ...codexSnapshot({ usage: false, reset: nextReset }),
    status: { code: 'unauthorized', connected: false, label: 'auth failed', detail: 'usage rejected' },
  };
  applyCodex(mgr, usage401);

  assert.ok(store.map.get('_cachedCodexResetCredits'), 'reset cache survives usage 401');
  assert.equal(mgr.codexResetCredits?.credits[0].idSuffix, null, 'in-memory reset cache remains after usage 401');
  const secondPublic = mgr.buildCodexProviderQuota(readAt);
  assert.equal(secondPublic.resetCredits?.credits.length, 1, 'public snapshot still carries reset credits after usage 401');
  assert.equal(secondPublic.resetCredits?.credits[0].idSuffix, null);
});

// --- Task 4: per-tick re-inject + expiry filter + status overlay + sanitizeResetCredits ---

const { activeCodexResetCredits, sanitizeResetCredits } = stateManagerModule;

test('activeCodexResetCredits drops expired credits and recomputes count', () => {
  const now = Date.parse('2026-07-15T00:00:00Z');
  const data = {
    credits: [
      { idSuffix: 'a', status: 'available', expiresAtUtc: '2026-07-12T00:00:00Z' }, // expired
      { idSuffix: 'b', status: 'available', expiresAtUtc: '2026-07-20T00:00:00Z' }, // active
      { idSuffix: 'c', status: 'available', expiresAtUtc: null },                    // no-expiry -> kept
    ],
    availableCount: 3, totalEarnedCount: 0, checkedAt: now, countOnly: false, source: 'api',
    status: { code: 'ok', connected: true, label: '', detail: '' },
  };
  const active = activeCodexResetCredits(data, now, /*connected*/ false);
  assert.equal(active.credits.length, 2);
  assert.equal(active.availableCount, 2);      // list-derived when not countOnly
  assert.equal(active.source, 'cache');        // disconnected -> cache
});

test('activeCodexResetCredits keeps availableCount for countOnly fallback', () => {
  const now = Date.now();
  const data = { credits: [], availableCount: 4, totalEarnedCount: 0, checkedAt: now, countOnly: true, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  const active = activeCodexResetCredits(data, now, true);
  assert.equal(active.availableCount, 4);
  assert.equal(active.credits.length, 0);
});

test('buildCodexProviderQuota re-injects active reset credits onto the PUBLIC snapshot each tick (F7)', () => {
  // §5.6 is pipeline behavior, not just a helper. Seed instance-stored reset data and rebuild.
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const now = Date.parse('2026-07-15T00:00:00Z');
  mgr.codexUsageConnected = true;
  seedResetAuth(mgr);
  mgr.codexResetCreditsStoredAt = now - 1000;
  mgr.codexResetCredits = {
    credits: [
      { idSuffix: 'x', status: 'available', expiresAtUtc: '2026-07-12T00:00:00Z' }, // expired vs now
      { idSuffix: 'y', status: 'available', expiresAtUtc: '2026-07-20T00:00:00Z' }, // active
    ],
    availableCount: 2, totalEarnedCount: 3, checkedAt: now - 1000, countOnly: false, source: 'api',
    status: { code: 'ok', connected: true, label: '', detail: '' },
  };
  const publicSnap = mgr.buildCodexProviderQuota(now);
  assert.ok(publicSnap.resetCredits, 'resetCredits attached to the rebuilt public snapshot');
  assert.equal(publicSnap.resetCredits.credits.length, 1, 'expired credit filtered at rebuild');
  assert.equal(publicSnap.resetCredits.credits[0].idSuffix, null);
  assert.equal(publicSnap.resetCredits.availableCount, 1);
  // NOTE (R3-4): do NOT assert the `resets` group here — that group is added in Task 6, later in the
  // task-by-task sequence, so asserting it in Task 4 would fail. Task 4 owns only the `resetCredits`
  // FIELD, which buildCodexProviderQuota attaches independently of the groups array. Task 6 asserts the group.
});

test('cached-good list + current-tick reset error overlays stale/error status onto the rebuild (R3-1)', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const now = Date.parse('2026-07-15T00:00:00Z');
  mgr.codexUsageConnected = true;
  seedResetAuth(mgr);
  // Last-good cached list (its own status is the OLD ok).
  mgr.codexResetCredits = {
    credits: [{ idSuffix: 'y', status: 'available', expiresAtUtc: '2026-07-20T00:00:00Z' }],
    availableCount: 1, totalEarnedCount: 0, checkedAt: now - 60_000, countOnly: false, source: 'api',
    status: { code: 'ok', connected: true, label: '', detail: '' },
  };
  mgr.codexResetCreditsStoredAt = now - 60_000;
  // This tick's reset attempt 429'd (Task 3 kept the cache but captured the failing status).
  mgr.codexResetStatus = { code: 'rate-limited', connected: false, label: 'rate limited', detail: 'slow', retryAfterMs: 90_000 };

  const publicSnap = mgr.buildCodexProviderQuota(now);
  assert.equal(publicSnap.resetCredits.credits.length, 1, 'cached list is kept');
  assert.equal(publicSnap.resetCredits.status.code, 'rate-limited', 'current-tick error overlaid, not the old ok');
  assert.equal(publicSnap.resetCredits.source, 'cache', 'marked cache/stale');
  assert.equal(publicSnap.resetCredits.checkedAt, now - 60_000, 'last successful update preserved for the tooltip');
});

test('rebuilt public snapshot emits the PUBLIC resetCredits shape, not the internal one (R4-3)', () => {
  // buildProviderQuotas assigns buildCodexProviderQuota() directly without re-sanitizing, so the
  // rebuild itself must emit the public shape. Seed a stored list whose status carries INTERNAL fields.
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const now = Date.parse('2026-07-15T00:00:00Z');
  mgr.codexUsageConnected = true;
  seedResetAuth(mgr);
  mgr.codexResetCredits = {
    credits: [{ idSuffix: 'y', status: 'available', expiresAtUtc: '2026-07-20T00:00:00Z', profileUserId: 'leaky', title: 'leaky' }],
    availableCount: 1, totalEarnedCount: 0, checkedAt: now - 1000, countOnly: false, source: 'api',
    // internal CodexUsageStatus carries httpStatus / responseKeys that must NOT reach the renderer:
    status: { code: 'ok', connected: true, label: '', detail: '', httpStatus: 200, responseKeys: ['credits'] },
  };
  mgr.codexResetCreditsStoredAt = now - 1000;
  mgr.codexResetStatus = mgr.codexResetCredits.status;

  const rc = mgr.buildCodexProviderQuota(now).resetCredits;
  // status is the PUBLIC ProviderQuotaStatus: internal-only fields are gone.
  assert.equal('httpStatus' in rc.status, false, 'internal httpStatus stripped');
  assert.equal('responseKeys' in rc.status, false, 'internal responseKeys stripped');
  // Every emitted status key must be a member of the public ProviderQuotaStatus shape (no internal leak).
  const publicStatusKeys = ['code', 'connected', 'detail', 'label', 'severity'];
  assert.ok(Object.keys(rc.status).every(k => publicStatusKeys.includes(k)), 'only public status keys emitted');
  // credits carry ONLY the public source facts.
  assert.deepEqual(Object.keys(rc.credits[0]).sort(), ['expiresAtUtc', 'idSuffix', 'status']);
  assert.equal('profileUserId' in rc.credits[0], false);
  assert.equal('title' in rc.credits[0], false);
});

test('sanitizeResetCredits validates shape and drops unknown fields', () => {
  const out = sanitizeResetCredits({
    credits: [
      { idSuffix: 'aaa', status: 'available', expiresAtUtc: '2026-07-12T00:00:00Z', secret: 'x' },
      { idSuffix: 5, status: 'available', expiresAtUtc: null }, // idSuffix non-string -> null
      'garbage',
    ],
    availableCount: 2, totalEarnedCount: 1, checkedAt: 123, countOnly: false, source: 'api',
    status: { code: 'ok', connected: true, label: '', detail: '', httpStatus: 200 },
    injected: 'nope',
  });
  assert.equal(out.credits.length, 2);
  assert.equal(out.credits[0].idSuffix, null);
  assert.equal('secret' in out.credits[0], false);
  assert.equal(out.credits[1].idSuffix, null);
  assert.equal(out.availableCount, 2);
  assert.equal('injected' in out, false);
  assert.equal(out.status.code, 'ok');
  assert.equal('httpStatus' in out.status, false);   // public status shape only
});

test('sanitizeResetCredits rejects non-objects', () => {
  assert.equal(sanitizeResetCredits(null), null);
  assert.equal(sanitizeResetCredits('x'), null);
});

test('reset-only no-credentials clears stale usage cache immediately', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const good = { credits: [{ idSuffix: 'a', status: 'available', expiresAtUtc: '2999-01-01T00:00:00Z' }], availableCount: 1, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: good }));
  assert.ok(store.map.get('_cachedCodexUsagePct'));

  const resetNoCred = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'no-credentials', connected: false, label: 'local log', detail: 'Codex auth.json with ChatGPT tokens was not found.' } };
  applyCodex(mgr, { ...codexSnapshot({ usage: false, reset: resetNoCred }), usageSkipped: true, source: 'cache' });

  assert.equal(store.map.has('_cachedCodexUsagePct'), false);
  assert.equal(mgr.codexUsagePct, null);
  assert.equal(mgr.codexUsageConnected, false);
});

test('reset-only schema-changed clears stale usage cache immediately', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const good = { credits: [{ idSuffix: 'a', status: 'available', expiresAtUtc: '2999-01-01T00:00:00Z' }], availableCount: 1, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: good }));
  assert.ok(store.map.get('_cachedCodexUsagePct'));

  const resetSchema = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'schema-changed', connected: false, label: 'unsupported endpoint', detail: 'Custom endpoint unsupported.' } };
  applyCodex(mgr, { ...codexSnapshot({ usage: false, reset: resetSchema }), usageSkipped: true, source: 'cache' });

  assert.equal(store.map.has('_cachedCodexUsagePct'), false);
  assert.equal(mgr.codexUsagePct, null);
  assert.equal(mgr.codexUsageConnected, false);
});

test('in-memory Codex usage is discarded when auth identity changes', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const good = { credits: [{ idSuffix: 'a', status: 'available', expiresAtUtc: '2999-01-01T00:00:00Z' }], availableCount: 1, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: good }));
  assert.ok(mgr.getAgedCodexUsagePct(Date.now()), 'usage sample is initially visible');

  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-access-token-b', account_id: 'acct_b' } }));

  assert.equal(mgr.getAgedCodexUsagePct(Date.now()), null);
  assert.equal(mgr.codexUsagePct, null);
  assert.equal(store.map.has('_cachedCodexUsagePct'), false);
});

test('fresh count-only fallback wins over older reset list and survives reset-skipped usage ticks', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const goodList = { credits: [{ idSuffix: 'old', status: 'available', expiresAtUtc: '2999-01-01T00:00:00Z' }], availableCount: 1, totalEarnedCount: 0, checkedAt: Date.now() - 120_000, countOnly: false, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: goodList }));

  const countOnly = { credits: [], availableCount: 3, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: true, source: 'cache', status: { code: 'rate-limited', connected: false, label: 'rate limited', detail: 'slow down' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: countOnly }));
  let pub = mgr.buildCodexProviderQuota(Date.now());
  assert.equal(pub.resetCredits?.availableCount, 3);
  assert.equal(pub.resetCredits?.countOnly, true);
  assert.equal(pub.resetCredits?.status.code, 'rate-limited');

  applyCodex(mgr, codexSnapshot({ usage: true, reset: null }));
  pub = mgr.buildCodexProviderQuota(Date.now());
  assert.equal(pub.resetCredits?.availableCount, 3);
  assert.equal(pub.resetCredits?.countOnly, true);
});

test('successful count-only reset survives later reset-skipped usage ticks', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const countOnly = { credits: [], availableCount: 3, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: true, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: countOnly }));
  let pub = mgr.buildCodexProviderQuota(Date.now());
  assert.equal(pub.resetCredits?.availableCount, 3);
  assert.equal(pub.resetCredits?.countOnly, true);
  assert.equal(store.map.has('_cachedCodexResetCredits'), false, 'count-only success is not persisted as a detailed list');

  applyCodex(mgr, codexSnapshot({ usage: true, reset: null }));
  pub = mgr.buildCodexProviderQuota(Date.now());
  assert.equal(pub.resetCredits?.availableCount, 3);
  assert.equal(pub.resetCredits?.countOnly, true);
  assert.equal(pub.resetCredits?.status.code, 'ok');
});

test('fresh count-only fallback keeps count but overlays later reset failure status', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const countOnly = { credits: [], availableCount: 3, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: true, source: 'usage', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: countOnly }));

  const reset429 = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: Date.now() + 1, countOnly: false, source: 'api', status: { code: 'rate-limited', connected: false, label: 'rate limited', detail: 'slow', retryAfterMs: 90_000 } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: reset429 }));

  const pub = mgr.buildCodexProviderQuota(Date.now());
  assert.equal(pub.resetCredits?.availableCount, 3);
  assert.equal(pub.resetCredits?.countOnly, true);
  assert.equal(pub.resetCredits?.status.code, 'rate-limited');
  assert.equal(pub.resetCredits?.source, 'usage');
});

test('sanitizeResetCredits clamps persisted or IPC count values', () => {
  const out = sanitizeResetCredits({
    credits: [],
    availableCount: -3.2,
    totalEarnedCount: 4.6,
    checkedAt: 123,
    countOnly: true,
    source: 'cache',
    status: { code: 'ok', connected: true },
  });
  assert.equal(out.availableCount, 0);
  assert.equal(out.totalEarnedCount, 5);
});

// --- Task 5: fresh-apply sanitizer whitelists a validated resetCredits ---

const { sanitizeProviderQuotaSnapshot } = stateManagerModule;

test('sanitizeProviderQuotaSnapshot whitelists a validated resetCredits (public shape)', () => {
  const out = sanitizeProviderQuotaSnapshot('codex', {
    provider: 'codex', source: 'api', capturedAt: 1,
    resetCredits: {
      credits: [{ idSuffix: 'aaa', status: 'available', expiresAtUtc: '2026-07-12T00:00:00Z', title: 'leak' }],
      availableCount: 1, totalEarnedCount: 0, checkedAt: 123, countOnly: false, source: 'api',
      status: { code: 'ok', connected: true, label: '', detail: '', httpStatus: 200, responseKeys: ['credits'] },
    },
  });
  assert.ok(out.resetCredits, 'resetCredits survives the whitelist');
  assert.equal(out.resetCredits.credits.length, 1);
  assert.deepEqual(Object.keys(out.resetCredits.credits[0]).sort(), ['expiresAtUtc', 'idSuffix', 'status']);
  assert.equal('httpStatus' in out.resetCredits.status, false);   // internal fields stripped
  assert.equal('responseKeys' in out.resetCredits.status, false);
});

test('sanitizeProviderQuotaSnapshot yields null resetCredits when absent', () => {
  const out = sanitizeProviderQuotaSnapshot('codex', { provider: 'codex', source: 'api', capturedAt: 1 });
  assert.equal(out.resetCredits, null);
});

// --- Closing-gate G1 (spec §8): errored/no-credentials must render an in-card "unavailable",
// not vanish. The per-tick rebuild emits an errored resetCredits (empty list, error status) when
// there is no cached list but the latest reset attempt failed. Renderer's mode gate still hides
// it when the resets group is set to 'none'.

test('no-credentials rebuild emits an errored resetCredits (card shows unavailable, not hidden)', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const good = { credits: [{ idSuffix: 'a', status: 'available', expiresAtUtc: '2999-01-01T00:00:00Z' }], availableCount: 1, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: good }));
  const noCred = { ...codexSnapshot({ usage: false, reset: null }), status: { code: 'no-credentials', connected: false, label: 'local log', detail: '' } };
  applyCodex(mgr, noCred);
  const pub = mgr.buildCodexProviderQuota(Date.now());
  assert.ok(pub.resetCredits, 'resetCredits is present (not null) so the card renders');
  assert.equal(pub.resetCredits.status.code, 'no-credentials');
  assert.equal(pub.resetCredits.status.connected, false);
  assert.equal(pub.resetCredits.credits.length, 0);
  assert.equal(pub.resetCredits.availableCount, 0);
});

test('reset 401 with no cached list rebuilds an errored resetCredits (unavailable)', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const reset401 = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'unauthorized', connected: false, label: 'auth failed', detail: 'rejected' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: reset401 }));
  const pub = mgr.buildCodexProviderQuota(Date.now());
  assert.ok(pub.resetCredits, 'errored resetCredits present');
  assert.equal(pub.resetCredits.status.code, 'unauthorized');
  assert.equal(pub.resetCredits.credits.length, 0);
});

test('never-fetched reset (no status) yields no card (null resetCredits)', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const pub = mgr.buildCodexProviderQuota(Date.now());
  assert.equal(pub.resetCredits, null, 'no reset status yet -> no card');
});

// --- Closing-gate r2 (both vendors): the count-only 429 fallback's N must reach the public
// rebuild THIS tick via the apply-time snapshot (plan §5.5) — not be shadowed to 0 by the
// errored-emit, and not marked stale by usage connectivity (reset independence).

test('count-only 429 fallback (no prior list) still shows N available in the public rebuild', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const countOnly = { credits: [], availableCount: 3, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: true, source: 'cache', status: { code: 'rate-limited', connected: false, label: 'rate limited', detail: 'slow', retryAfterMs: 90_000 } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: countOnly }));
  const pub = mgr.buildCodexProviderQuota(Date.now());
  assert.ok(pub.resetCredits, 'resetCredits present');
  assert.equal(pub.resetCredits.availableCount, 3, 'fallback count N preserved (not shadowed to 0)');
  assert.equal(pub.resetCredits.countOnly, true);
  assert.equal(pub.resetCredits.status.code, 'rate-limited', 'real status surfaced');
});

test('reset fresh + usage disconnected: reset stays source api, not marked stale by usage (independence)', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const good = { credits: [{ idSuffix: 'a', status: 'available', expiresAtUtc: '2999-01-01T00:00:00Z' }], availableCount: 1, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset: good }));
  mgr.codexUsageConnected = false;   // usage goes down; reset last succeeded (ok)
  const pub = mgr.buildCodexProviderQuota(Date.now());
  assert.equal(pub.resetCredits.source, 'api', 'reset freshness independent of usage connectivity');
  assert.equal(pub.resetCredits.credits.length, 1);
});

// --- Closing-gate r3 (GPT): a dedicated 200 with available_count but NO credits array is
// count-only, so the source count is shown (not recomputed to 0 from the empty list). §8.

test('parse: dedicated 200 with only available_count is countOnly and keeps the source count', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  const data = parseCodexResetCreditsPayload({ available_count: 3 }, now);
  assert.notEqual(data, null);
  assert.equal(data.availableCount, 3);
  assert.equal(data.countOnly, true, 'no credits array -> countOnly so renderer uses availableCount, not 0');
  assert.equal(data.credits.length, 0);
});

test('parse: 200 WITH a credits array stays countOnly:false (list-derived)', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  const data = parseCodexResetCreditsPayload({ credits: [{ id: 'a', status: 'available', expires_at: '2026-07-12T00:00:00Z' }] }, now);
  assert.equal(data.countOnly, false);
  assert.equal(data.availableCount, 1);
});

test('parse: mismatched credits list and available_count uses the source count as countOnly', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  const data = parseCodexResetCreditsPayload({
    available_count: 9,
    credits: [{ id: 'a', status: 'available', expires_at: '2026-07-12T00:00:00Z' }],
  }, now);
  assert.equal(data.countOnly, true);
  assert.equal(data.availableCount, 9);
  assert.equal(data.credits.length, 0);
});

test('privacy docs disclose Codex config read and unsupported custom endpoints', () => {
  const docs = fs.readFileSync(path.resolve('docs', 'privacy-security.md'), 'utf8');
  assert.match(docs, /~\/\.codex\/config\.toml/);
  assert.match(docs, /chatgpt_base_url/);
  assert.match(docs, /does not send Codex auth tokens to non-OpenAI hosts/);
});
