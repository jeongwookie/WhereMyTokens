import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import rateLimitFetcher from '../dist/main/rateLimitFetcher.js';

const { fetchApiUsagePct, normalizeStoredApiUsagePct } = rateLimitFetcher;

const originalReadFileSync = fs.readFileSync;
const originalRequest = https.request;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
let lastRequestOptions = null;

function withMockCredentials(expectedPath) {
  fs.readFileSync = function patchedReadFileSync(target, ...args) {
    const filePath = String(target);
    if (filePath.endsWith('.credentials.json')) {
      if (expectedPath) assert.equal(path.normalize(filePath), path.normalize(expectedPath));
      return JSON.stringify({
        claudeAiOauth: {
          accessToken: 'test-access-token',
          rateLimitTier: 'max_5x',
          subscriptionType: 'max',
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
  fs.readFileSync = originalReadFileSync;
  https.request = originalRequest;
  lastRequestOptions = null;
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
}

test.afterEach(() => {
  restoreMocks();
});

test('Claude API marks null resets as reset-unavailable without zeroing the window', async () => {
  withMockCredentials();
  withHttpResponse(200, {
    five_hour: { utilization: 0.03, resets_at: '2026-04-24T05:00:00.000Z' },
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
  assert.equal(result.usage.soResetMs, null);
  assert.equal(result.usage.extraUsage?.currency, 'USD');
  assert.equal(result.usage.plan, 'Max 5x');
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

test('Claude API classifies 401 as an expired stored CLI token', async () => {
  withMockCredentials();
  withHttpResponse(401, { error: { message: 'invalid bearer token. Please try again later.' } });

  const result = await fetchApiUsagePct();

  assert.equal(result.usage, null);
  assert.equal(result.status.code, 'unauthorized');
  assert.equal(result.status.label, 'auth failed');
  assert.equal(result.status.httpStatus, 401);
  assert.match(result.status.detail, /Claude CLI token was rejected or expired/);
  assert.match(result.status.detail, /invalid bearer token\./);
  assert.doesNotMatch(result.status.detail, /Please try again later/i);
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
    storedAt: 'bad',
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
  });

  assert.ok(normalized?.extraUsage);
  assert.equal(normalized.extraUsage.monthlyLimit, 0);
  assert.equal(normalized.extraUsage.usedCredits, 0);
  assert.equal(normalized.extraUsage.utilization, 0);
});
