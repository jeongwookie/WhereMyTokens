import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import rateLimitFetcher from '../dist/main/rateLimitFetcher.js';
import oauthRefresh from '../dist/main/oauthRefresh.js';

const { __setOAuthRefreshPostForTest, __clearOAuthRefreshForTest } = oauthRefresh;
const {
  API_USAGE_CACHE_SCHEMA_VERSION,
  CLAUDE_API_MAX_BACKOFF_MS,
  fetchApiUsagePct,
  normalizeStoredApiUsagePct,
} = rateLimitFetcher;

const originalReadFileSync = fs.readFileSync;
const originalRequest = https.request;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
let lastRequestOptions = null;
let tempDirs = [];

function makeTempConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-rate-limit-fetcher-'));
  tempDirs.push(dir);
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
}

function writeRealCredentials(dir, claudeAiOauth = {}) {
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 7 * 60 * 60 * 1000,
      rateLimitTier: 'max_5x',
      subscriptionType: 'max',
      ...claudeAiOauth,
    },
  }, null, 2));
}

function withMockCredentials(expectedPath, claudeAiOauth = {}) {
  fs.readFileSync = function patchedReadFileSync(target, ...args) {
    const filePath = String(target);
    if (filePath.endsWith('.credentials.json')) {
      if (expectedPath) assert.equal(path.normalize(filePath), path.normalize(expectedPath));
      return JSON.stringify({
        claudeAiOauth: {
          accessToken: 'test-access-token',
          refreshToken: 'test-refresh-token',
          expiresAt: Date.now() + 7 * 60 * 60 * 1000,
          rateLimitTier: 'max_5x',
          subscriptionType: 'max',
          ...claudeAiOauth,
        },
      });
    }
    return originalReadFileSync.call(this, target, ...args);
  };
}

function withMissingCredentials() {
  fs.readFileSync = function patchedReadFileSync(target, ...args) {
    const filePath = String(target);
    if (filePath.endsWith('.credentials.json')) {
      throw new Error('missing credentials');
    }
    return originalReadFileSync.call(this, target, ...args);
  };
}

function withHttpResponse(statusCode, payload, headers = {}) {
  withHttpResponses([{ statusCode, payload, headers }]);
}

function withHttpResponses(responses) {
  let index = 0;
  https.request = function patchedRequest(options, callback) {
    lastRequestOptions = options;
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => {
      if (error) process.nextTick(() => req.emit('error', error));
    };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = response.statusCode;
      res.headers = response.headers ?? {};
      callback(res);
      process.nextTick(() => {
        const body = typeof response.payload === 'string' ? response.payload : JSON.stringify(response.payload);
        if (body) res.emit('data', body);
        res.emit('end');
      });
    };
    return req;
  };
}

function restoreMocks() {
  fs.readFileSync = originalReadFileSync;
  https.request = originalRequest;
  lastRequestOptions = null;
  __clearOAuthRefreshForTest();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
}

test.afterEach(() => {
  restoreMocks();
});

test('Claude API marks core null resets as reset-unavailable without zeroing the window', async () => {
  withMockCredentials();
  withHttpResponse(200, {
    five_hour: { utilization: 0.03, resets_at: null },
    seven_day: { utilization: 0.4, resets_at: '2026-04-28T00:00:00.000Z' },
    seven_day_sonnet: { utilization: 0, resets_at: null },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 11500,
      used_credits: 11504,
      utilization: 100,
      currency: 'USD',
    },
  });

  const result = await fetchApiUsagePct();

  assert.ok(result.usage);
  assert.equal(result.status.code, 'reset-unavailable');
  assert.equal(result.status.connected, true);
  assert.match(result.status.detail, /five_hour/);
  assert.doesNotMatch(result.status.detail, /seven_day_sonnet/);
  assert.equal(result.usage.soResetMs, null);
  assert.equal(result.usage.extraUsage?.currency, 'USD');
  assert.equal(result.usage.plan, 'Max 5x');
});

test('Claude API keeps a visible reset warning when core reset timing is unavailable', async () => {
  withMockCredentials();
  withHttpResponse(200, {
    five_hour: { utilization: 0.03, resets_at: null },
    seven_day: { utilization: 0.4, resets_at: '2026-04-28T00:00:00.000Z' },
    seven_day_sonnet: null,
  });

  const result = await fetchApiUsagePct();

  assert.ok(result.usage);
  assert.equal(result.status.code, 'reset-unavailable');
  assert.equal(result.status.connected, true);
  assert.equal(result.status.label, 'reset partial');
  assert.equal(result.usage.h5ResetMs, null);
});

test('Claude API classifies 429 responses as rate limited', async () => {
  withMockCredentials();
  withHttpResponse(429, { error: { message: 'too many requests. Please try again later.' } }, { 'retry-after': '180' });

  const result = await fetchApiUsagePct();

  assert.equal(result.usage, null);
  assert.equal(result.status.code, 'rate-limited');
  assert.equal(result.status.connected, false);
  assert.equal(result.status.httpStatus, 429);
  assert.equal(result.status.retryAfterMs, 180_000);
  assert.match(result.status.detail, /too many requests\./);
  assert.doesNotMatch(result.status.detail, /Please try again later/i);
});

test('Claude API classifies 401 without burning a non-expired refresh token', async () => {
  withMockCredentials();
  withHttpResponse(401, { error: { message: 'invalid bearer token. Please try again later.' } });
  let refreshCalls = 0;
  __setOAuthRefreshPostForTest(async () => {
    refreshCalls += 1;
    return { status: 200, body: '{}' };
  });

  const result = await fetchApiUsagePct();

  assert.equal(result.usage, null);
  assert.equal(result.status.code, 'unauthorized');
  assert.equal(result.status.label, 'login required');
  assert.equal(result.status.httpStatus, 401);
  assert.match(result.status.detail, /Run `claude \/login` to re-authenticate/);
  assert.match(result.status.detail, /invalid bearer token\./);
  assert.doesNotMatch(result.status.detail, /Please try again later/i);
  assert.equal(refreshCalls, 0);
});

test('Claude API does not preflight refresh expired tokens when usage still succeeds', async () => {
  const configDir = makeTempConfigDir();
  writeRealCredentials(configDir, { expiresAt: Date.now() - 1000 });
  withHttpResponse(200, {
    five_hour: { utilization: 5, resets_at: '2026-04-24T05:00:00.000Z' },
    seven_day: { utilization: 17, resets_at: '2026-04-28T00:00:00.000Z' },
    seven_day_sonnet: null,
  });
  let refreshCalls = 0;
  __setOAuthRefreshPostForTest(async () => {
    refreshCalls += 1;
    return { status: 200, body: '{}' };
  });

  const result = await fetchApiUsagePct();

  assert.ok(result.usage);
  assert.equal(result.status.code, 'ok');
  assert.equal(refreshCalls, 0);
});

test('Claude API refreshes only after 401 when the stored access token is expired', async () => {
  const configDir = makeTempConfigDir();
  writeRealCredentials(configDir, { expiresAt: Date.now() - 1000 });
  withHttpResponses([
    { statusCode: 401, payload: { error: { message: 'expired access token. Please try again later.' } } },
    {
      statusCode: 200,
      payload: {
        five_hour: { utilization: 9, resets_at: '2026-04-24T05:00:00.000Z' },
        seven_day: { utilization: 19, resets_at: '2026-04-28T00:00:00.000Z' },
        seven_day_sonnet: null,
      },
    },
  ]);
  let refreshCalls = 0;
  let refreshUserAgent = '';
  __setOAuthRefreshPostForTest(async (_url, _params, userAgent) => {
    refreshCalls += 1;
    refreshUserAgent = userAgent;
    return {
      status: 200,
      body: JSON.stringify({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 28800,
      }),
    };
  });

  const result = await fetchApiUsagePct();
  const updated = JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf-8'));

  assert.ok(result.usage);
  assert.equal(result.status.code, 'ok');
  assert.equal(result.usage.h5Pct, 9);
  assert.equal(refreshCalls, 1);
  assert.equal(refreshUserAgent, 'claude-code/1.0');
  assert.equal(updated.claudeAiOauth.accessToken, 'new-access-token');
  assert.equal(lastRequestOptions?.headers?.Authorization, 'Bearer new-access-token');
});

test('Claude API uses percentage units returned by the usage endpoint', async () => {
  withMockCredentials();
  withHttpResponse(200, {
    five_hour: { utilization: 5, resets_at: '2026-04-24T05:00:00.000Z' },
    seven_day: { utilization: 17, resets_at: '2026-04-28T00:00:00.000Z' },
    seven_day_sonnet: { utilization: 0, resets_at: null },
  });

  const result = await fetchApiUsagePct();

  assert.ok(result.usage);
  assert.equal(result.status.code, 'reset-unavailable');
  assert.equal(result.status.label, '');
  assert.equal(result.usage.h5Pct, 5);
  assert.equal(result.usage.weekPct, 17);
  assert.match(String(lastRequestOptions?.headers?.['User-Agent']), /^claude-code\//);
});

test('Claude API credentials honor CLAUDE_CONFIG_DIR', async () => {
  const configDir = path.join(process.cwd(), 'tmp-claude-config');
  process.env.CLAUDE_CONFIG_DIR = configDir;
  withMockCredentials(path.join(configDir, '.credentials.json'));
  withHttpResponse(200, {
    five_hour: { utilization: 5, resets_at: '2026-04-24T05:00:00.000Z' },
    seven_day: { utilization: 17, resets_at: '2026-04-28T00:00:00.000Z' },
    seven_day_sonnet: { utilization: 0, resets_at: null },
  });

  const result = await fetchApiUsagePct();

  assert.ok(result.usage);
  assert.equal(result.usage.plan, 'Max 5x');
});

test('Claude API reports schema changes when core windows are missing', async () => {
  withMockCredentials();
  withHttpResponse(200, {
    seven_day_oauth_apps: { utilization: 0.1, resets_at: '2026-04-30T00:00:00.000Z' },
  });

  const result = await fetchApiUsagePct();

  assert.equal(result.usage, null);
  assert.equal(result.status.code, 'schema-changed');
  assert.equal(result.status.connected, false);
  assert.ok(result.status.responseKeys?.includes('seven_day_oauth_apps'));
});

test('Claude API reports schema changes when core window fields have invalid types', async () => {
  withMockCredentials();
  withHttpResponse(200, {
    five_hour: { utilization: 'bad', resets_at: '2026-04-24T05:00:00.000Z' },
    seven_day: { utilization: 0.4, resets_at: 1234 },
    seven_day_sonnet: { utilization: 'bad', resets_at: 1234 },
  });

  const result = await fetchApiUsagePct();

  assert.equal(result.usage, null);
  assert.equal(result.status.code, 'schema-changed');
  assert.equal(result.status.connected, false);
  assert.match(result.status.detail, /invalid core usage fields/i);
});

test('Claude API treats utilization as percentage units when only Sonnet window is malformed', async () => {
  withMockCredentials();
  withHttpResponse(200, {
    five_hour: { utilization: 0.03, resets_at: '2026-04-24T05:00:00.000Z' },
    seven_day: { utilization: 0.4, resets_at: '2026-04-28T00:00:00.000Z' },
    seven_day_sonnet: { utilization: 'bad', resets_at: 1234 },
  });

  const result = await fetchApiUsagePct();

  assert.ok(result.usage);
  assert.equal(result.status.code, 'reset-unavailable');
  assert.equal(result.status.label, '');
  assert.equal(result.usage.h5Pct, 0.03);
  assert.equal(result.usage.weekPct, 0.4);
  assert.equal(result.usage.soPct, 0);
  assert.equal(result.usage.soResetMs, null);
});

test('Claude API does not inflate sub-one-percent usage to near full', async () => {
  withMockCredentials();
  withHttpResponse(200, {
    five_hour: { utilization: 0.98, resets_at: '2026-04-24T05:00:00.000Z' },
    seven_day: { utilization: 1.4, resets_at: '2026-04-28T00:00:00.000Z' },
    seven_day_sonnet: { utilization: 0.2, resets_at: '2026-04-28T00:00:00.000Z' },
  });

  const result = await fetchApiUsagePct();

  assert.ok(result.usage);
  assert.equal(result.status.code, 'ok');
  assert.equal(result.usage.h5Pct, 0.98);
  assert.equal(result.usage.weekPct, 1.4);
  assert.equal(result.usage.soPct, 0.2);
});

test('Claude API reports missing credentials without throwing', async () => {
  withMissingCredentials();

  const result = await fetchApiUsagePct();

  assert.equal(result.usage, null);
  assert.equal(result.status.code, 'no-credentials');
  assert.equal(result.status.label, 'local only');
});

test('persisted Claude API cache is normalized before reuse', () => {
  const normalized = normalizeStoredApiUsagePct({
    schemaVersion: API_USAGE_CACHE_SCHEMA_VERSION,
    h5Pct: 0.63,
    weekPct: 41,
    soPct: 7,
    h5ResetMs: 'bad',
    weekResetMs: 1200,
    soResetMs: null,
    plan: 'Max 5x',
    extraUsage: {
      isEnabled: true,
      monthlyLimit: 11500,
      usedCredits: 11504,
      utilization: 1,
      currency: 'USD',
    },
    storedAt: 1_000,
  });

  assert.ok(normalized);
  assert.equal(normalized.h5Pct, 0.63);
  assert.equal(normalized.h5ResetMs, null);
  assert.equal(normalized.weekResetMs, 1200);
  assert.equal(normalized.extraUsage?.utilization, 1);
  assert.equal(normalized.storedAt, undefined);
});

test('persisted extra usage clamps negative values', () => {
  const normalized = normalizeStoredApiUsagePct({
    schemaVersion: API_USAGE_CACHE_SCHEMA_VERSION,
    h5Pct: 10,
    weekPct: 20,
    soPct: 30,
    h5ResetMs: 1000,
    weekResetMs: 2000,
    soResetMs: 3000,
    plan: 'Max 5x',
    extraUsage: {
      isEnabled: true,
      monthlyLimit: -100,
      usedCredits: -50,
      utilization: -10,
    },
    storedAt: 1_000,
  });

  assert.ok(normalized?.extraUsage);
  assert.equal(normalized.extraUsage.monthlyLimit, 0);
  assert.equal(normalized.extraUsage.usedCredits, 0);
  assert.equal(normalized.extraUsage.utilization, 0);
});
