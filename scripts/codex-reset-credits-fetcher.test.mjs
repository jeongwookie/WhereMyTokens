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
