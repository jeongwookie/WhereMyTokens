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
  resolveCodexResetCreditsUrl,
  parseCodexResetCreditsPayload,
  resetCreditsFromUsagePayload,
  fetchCodexResetCredits,
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

test.afterEach(() => {
  restoreMocks();
});

test('reset-credits URL follows the wham path style', () => {
  assert.equal(resolveCodexResetCreditsUrl('https://chatgpt.com'), 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(resolveCodexResetCreditsUrl('https://chat.openai.com/'), 'https://chat.openai.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(resolveCodexResetCreditsUrl('https://example.test'), 'https://example.test/api/codex/rate-limit-reset-credits');
  // A user may set chatgpt_base_url to the FULL usage endpoint — PRESERVE its route family, never double-append:
  assert.equal(resolveCodexResetCreditsUrl('https://chatgpt.com/backend-api/wham/usage'), 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(resolveCodexResetCreditsUrl('https://example.test/api/codex/usage'), 'https://example.test/api/codex/rate-limit-reset-credits');
  // Custom proxy on the /wham/ family WITHOUT /backend-api must stay on /wham/ (not be re-derived to /api/codex/):
  assert.equal(resolveCodexResetCreditsUrl('https://myproxy.com/wham/usage'), 'https://myproxy.com/wham/rate-limit-reset-credits');
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
  assert.equal(data.credits[0].idSuffix, 'aaa');
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
  assert.equal(data.source, 'api');
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
  const stored = {
    schemaVersion: CODEX_RESET_CREDITS_CACHE_SCHEMA_VERSION,
    storedAt: now - 1000,
    authMtimeMs: 123,
    data: {
      credits: [{ idSuffix: 'aaa', status: 'available', expiresAtUtc: '2026-07-12T11:46:00Z' }],
      availableCount: 1, totalEarnedCount: 0, checkedAt: now - 1000, countOnly: false, source: 'api',
      status: { code: 'ok', connected: true, label: '', detail: '' },
    },
  };
  assert.equal(normalizeStoredCodexResetCredits(stored, 456), null);            // mtime mismatch
  assert.equal(normalizeStoredCodexResetCredits({ ...stored, schemaVersion: 99 }, 123), null); // schema mismatch
  const ok = normalizeStoredCodexResetCredits(stored, 123);
  assert.equal(ok?.data.availableCount, 1);
  assert.equal(ok?.data.credits[0].expiresAtUtc, '2026-07-12T11:46:00Z');
});

// --- Step 5b (Task 3): store-level apply path ---

import stateManagerModule from '../dist/main/stateManager.js';
const { StateManager } = stateManagerModule;

function fakeStore() {
  const map = new Map();
  return {
    map,
    get: (k, fb = null) => (map.has(k) ? map.get(k) : fb),
    set: (k, v) => { map.set(k, v); },
    delete: (k) => { map.delete(k); },
  };
}

function codexSnapshot({ usage = true, reset }) {
  return {
    provider: 'codex', source: 'api', capturedAt: Date.now(),
    groups: [], windowDisplay: {},
    windows: usage ? { h5: { pct: 5, resetMs: 3600000, source: 'api' } } : undefined,
    usage: usage ? { h5Available: true, weekAvailable: false, h5Pct: 5, weekPct: 0, h5ResetMs: 3600000, weekResetMs: null, h5LimitReached: false, weekLimitReached: false, plan: 'pro', credits: null, limitReached: false, rateLimitReachedType: null } : null,
    status: { code: 'ok', connected: true, label: '', detail: '' },
    authMtimeMs: 111,
    resetCredits: reset,
  };
}

function applyCodex(mgr, snapshot) {
  const seq = (mgr.codexUsageRequestSeq = (mgr.codexUsageRequestSeq ?? 0) + 1);
  mgr.providerQuotaRequestSeqs?.set?.('codex', seq);
  return mgr.applyProviderQuotaSnapshot(snapshot, seq, Date.now());
}

test('reset ok persists _cachedCodexResetCredits; usage cache written independently', () => {
  const store = fakeStore();
  const mgr = new StateManager(store, () => {});
  const reset = { credits: [{ idSuffix: 'a', status: 'available', expiresAtUtc: '2999-01-01T00:00:00Z' }], availableCount: 1, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api', status: { code: 'ok', connected: true, label: '', detail: '' } };
  applyCodex(mgr, codexSnapshot({ usage: true, reset }));
  assert.ok(store.map.get('_cachedCodexResetCredits'), 'reset cache written');
  assert.ok(store.map.get('_cachedCodexUsagePct'), 'usage cache written');
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
  assert.equal(firstPublic.resetCredits?.credits[0].idSuffix, 'aaa');
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
  assert.equal(mgr.codexResetCredits?.credits[0].idSuffix, 'bbb', 'in-memory reset cache remains after usage 401');
  const secondPublic = mgr.buildCodexProviderQuota(readAt);
  assert.equal(secondPublic.resetCredits?.credits.length, 1, 'public snapshot still carries reset credits after usage 401');
  assert.equal(secondPublic.resetCredits?.credits[0].idSuffix, 'bbb');
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
  assert.equal(publicSnap.resetCredits.credits[0].idSuffix, 'y');
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
  assert.equal(out.credits[0].idSuffix, 'aaa');
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
