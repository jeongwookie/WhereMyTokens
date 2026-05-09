import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import codexUsageFetcher from '../dist/main/codexUsageFetcher.js';

const {
  CODEX_USAGE_CACHE_SCHEMA_VERSION,
  fetchCodexUsagePct,
  normalizeStoredCodexUsagePct,
  resolveCodexUsageUrl,
} = codexUsageFetcher;

const originalRequest = https.request;
const originalCodexHome = process.env.CODEX_HOME;
const tempDirs = [];
let lastRequestOptions = null;

function makeTempCodexHome(authPayload = null, configText = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-codex-test-'));
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

function withHttpResponse(statusCode, payload, headers = {}) {
  https.request = function patchedRequest(options, callback) {
    lastRequestOptions = options;
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => {
      if (error) process.nextTick(() => req.emit('error', error));
    };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.headers = headers;
      callback(res);
      process.nextTick(() => {
        const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
        if (body) res.emit('data', body);
        res.emit('end');
      });
    };
    return req;
  };
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

test('Codex usage URL follows official path style', () => {
  assert.equal(resolveCodexUsageUrl('https://chatgpt.com'), 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(resolveCodexUsageUrl('https://chat.openai.com/'), 'https://chat.openai.com/backend-api/wham/usage');
  assert.equal(resolveCodexUsageUrl('https://example.test'), 'https://example.test/api/codex/usage');
  assert.equal(resolveCodexUsageUrl('https://example.test/api/codex/usage'), 'https://example.test/api/codex/usage');
});

test('Codex live usage reads auth.json, sends safe headers, and parses windows', async () => {
  makeTempCodexHome({
    tokens: {
      access_token: 'test-access-token',
      account_id: 'acct_test',
    },
  });
  const nowSec = Math.floor(Date.now() / 1000);
  withHttpResponse(200, {
    plan_type: 'pro',
    rate_limit: {
      primary_window: { used_percent: 7, reset_at: nowSec + 3600, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 53, reset_at: nowSec + 86_400, limit_window_seconds: 604_800 },
      limit_reached: false,
    },
    credits: { has_credits: true, unlimited: false, balance: '12.34' },
  });

  const result = await fetchCodexUsagePct();

  assert.equal(result.status.code, 'ok');
  assert.equal(result.usage?.h5Available, true);
  assert.equal(result.usage?.weekAvailable, true);
  assert.equal(result.usage?.h5Pct, 7);
  assert.equal(result.usage?.weekPct, 53);
  assert.equal(result.usage?.h5LimitReached, false);
  assert.equal(result.usage?.weekLimitReached, false);
  assert.equal(result.usage?.plan, 'pro');
  assert.equal(result.usage?.credits?.balance, '12.34');
  assert.equal(lastRequestOptions.hostname, 'chatgpt.com');
  assert.equal(lastRequestOptions.path, '/backend-api/wham/usage');
  assert.equal(lastRequestOptions.headers.Authorization, 'Bearer test-access-token');
  assert.equal(lastRequestOptions.headers['ChatGPT-Account-Id'], 'acct_test');
  assert.equal(lastRequestOptions.headers.Accept, 'application/json');
  assert.equal(JSON.stringify(result.status).includes('test-access-token'), false);
});

test('Codex global limit_reached does not override unrelated weekly window', async () => {
  makeTempCodexHome({
    tokens: {
      access_token: 'test-access-token',
    },
  });
  const nowSec = Math.floor(Date.now() / 1000);
  withHttpResponse(200, {
    rate_limit: {
      primary_window: { used_percent: 9, remaining_percent: 0, reset_at: nowSec + 3600, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 100, remaining_percent: 22, reset_at: nowSec + 604_800, limit_window_seconds: 604_800 },
      limit_reached: true,
    },
  });

  const result = await fetchCodexUsagePct();

  assert.equal(result.status.code, 'ok');
  assert.equal(result.usage?.limitReached, true);
  assert.equal(result.usage?.h5Pct, 100);
  assert.equal(result.usage?.weekPct, 78);
  assert.equal(result.usage?.h5LimitReached, true);
  assert.equal(result.usage?.weekLimitReached, false);
});

test('Codex clear reached type only marks the matching 5h window', async () => {
  makeTempCodexHome({
    tokens: {
      access_token: 'test-access-token',
    },
  });
  const nowSec = Math.floor(Date.now() / 1000);
  withHttpResponse(200, {
    rate_limit: {
      primary_window: { used_percent: 9, reset_at: nowSec + 3600, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 17, reset_at: nowSec + 604_800, limit_window_seconds: 604_800 },
      rate_limit_reached_type: 'primary_window',
    },
  });

  const result = await fetchCodexUsagePct();

  assert.equal(result.status.code, 'ok');
  assert.equal(result.usage?.limitReached, true);
  assert.equal(result.usage?.h5Pct, 100);
  assert.equal(result.usage?.weekPct, 17);
  assert.equal(result.usage?.h5LimitReached, true);
  assert.equal(result.usage?.weekLimitReached, false);
});

test('Codex ambiguous reached type is metadata only', async () => {
  makeTempCodexHome({
    tokens: {
      access_token: 'test-access-token',
    },
  });
  const nowSec = Math.floor(Date.now() / 1000);
  withHttpResponse(200, {
    rate_limit_reached_type: 'rate_limit_reached',
    rate_limit: {
      primary_window: { used_percent: 9, reset_at: nowSec + 3600, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 17, reset_at: nowSec + 604_800, limit_window_seconds: 604_800 },
    },
  });

  const result = await fetchCodexUsagePct();

  assert.equal(result.status.code, 'ok');
  assert.equal(result.usage?.limitReached, true);
  assert.equal(result.usage?.h5Pct, 9);
  assert.equal(result.usage?.weekPct, 17);
  assert.equal(result.usage?.h5LimitReached, false);
  assert.equal(result.usage?.weekLimitReached, false);
});

test('Codex remaining percentage takes precedence over used percentage aliases', async () => {
  makeTempCodexHome({
    tokens: {
      access_token: 'test-access-token',
    },
  });
  const nowSec = Math.floor(Date.now() / 1000);
  withHttpResponse(200, {
    rate_limit: {
      primary_window: { used_percentage: 3, remaining_percentage: 25, reset_at: nowSec + 3600, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 91, remaining_percent: 60, reset_at: nowSec + 604_800, limit_window_seconds: 604_800 },
    },
  });

  const result = await fetchCodexUsagePct();

  assert.equal(result.status.code, 'ok');
  assert.equal(result.usage?.h5Pct, 75);
  assert.equal(result.usage?.weekPct, 40);
});

test('Codex usage fetcher returns local-log status when auth is missing', async () => {
  makeTempCodexHome();
  withHttpResponse(200, {});

  const result = await fetchCodexUsagePct();

  assert.equal(result.status.code, 'no-credentials');
  assert.equal(result.usage, null);
  assert.equal(lastRequestOptions, null);
});

test('Codex usage fetcher respects Retry-After on 429 without storing response body', async () => {
  makeTempCodexHome({
    tokens: {
      access_token: 'test-access-token',
    },
  });
  withHttpResponse(429, { error: 'rate limited' }, { 'retry-after': '120' });

  const result = await fetchCodexUsagePct();

  assert.equal(result.status.code, 'rate-limited');
  assert.equal(result.status.retryAfterMs, 120_000);
  assert.equal(JSON.stringify(result.status).includes('rate limited'), true);
  assert.equal(JSON.stringify(result.status).includes('test-access-token'), false);
});

test('stored Codex usage cache is rejected after auth file changes', () => {
  const now = Date.now();
  const cached = {
    schemaVersion: CODEX_USAGE_CACHE_SCHEMA_VERSION,
    storedAt: now - 1000,
    authMtimeMs: 123,
    h5Available: true,
    weekAvailable: true,
    h5Pct: 5,
    weekPct: 17,
    h5ResetMs: 60_000,
    weekResetMs: 120_000,
    h5LimitReached: false,
    weekLimitReached: false,
    plan: 'pro',
    credits: null,
    limitReached: false,
    rateLimitReachedType: null,
  };

  assert.equal(normalizeStoredCodexUsagePct(cached, 456), null);
  const normalized = normalizeStoredCodexUsagePct(cached, 123);
  assert.equal(normalized?.h5Pct, 5);
  assert.equal(normalized?.weekPct, 17);
  assert.equal(normalized?.h5LimitReached, false);
  assert.equal(normalized?.weekLimitReached, false);
});
