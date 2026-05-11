import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import oauthRefresh from '../dist/main/oauthRefresh.js';

const {
  refreshNow,
  initOAuthRefresh,
  getOAuthCredentialState,
  __setOAuthRefreshPostForTest,
  __clearOAuthRefreshForTest,
} = oauthRefresh;

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalDisableRefresh = process.env.WMT_DISABLE_REFRESH;
const tempDirs = [];

function makeStore(values = {}) {
  return {
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
}

function useTempClaudeConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-oauth-refresh-'));
  tempDirs.push(dir);
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
}

function credentialsPath(dir) {
  return path.join(dir, '.credentials.json');
}

function writeCredentials(dir, oauth = {}) {
  fs.writeFileSync(credentialsPath(dir), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() - 1000,
      rateLimitTier: 'max_5x',
      subscriptionType: 'max',
      ...oauth,
    },
    preserved: true,
  }, null, 2));
}

function readCredentials(dir) {
  return JSON.parse(fs.readFileSync(credentialsPath(dir), 'utf8'));
}

test.afterEach(() => {
  __clearOAuthRefreshForTest();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalDisableRefresh === undefined) delete process.env.WMT_DISABLE_REFRESH;
  else process.env.WMT_DISABLE_REFRESH = originalDisableRefresh;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshNow writes rotating Claude credentials atomically', async () => {
  const dir = useTempClaudeConfig();
  writeCredentials(dir);
  initOAuthRefresh(makeStore());
  let seenUserAgent = '';
  __setOAuthRefreshPostForTest(async (_url, params, userAgent) => {
    seenUserAgent = userAgent;
    assert.equal(params.grant_type, 'refresh_token');
    assert.equal(params.refresh_token, 'old-refresh');
    return {
      status: 200,
      body: JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    };
  });

  const outcome = await refreshNow('claude-code/1.0', 'test');
  const updated = readCredentials(dir);

  assert.equal(outcome.kind, 'ok');
  assert.equal(seenUserAgent, 'claude-code/1.0');
  assert.equal(updated.claudeAiOauth.accessToken, 'new-access');
  assert.equal(updated.claudeAiOauth.refreshToken, 'new-refresh');
  assert.equal(updated.claudeAiOauth.rateLimitTier, 'max_5x');
  assert.equal(updated.preserved, true);
  assert.ok(fs.existsSync(`${credentialsPath(dir)}.bak`));
});

test('concurrent refreshNow calls share one OAuth request', async () => {
  const dir = useTempClaudeConfig();
  writeCredentials(dir);
  initOAuthRefresh(makeStore());
  let calls = 0;
  let resolvePost;
  const post = new Promise(resolve => {
    resolvePost = resolve;
  });
  __setOAuthRefreshPostForTest(async () => {
    calls += 1;
    return post;
  });

  const results = Promise.all([
    refreshNow('claude-code/1.0', 'test'),
    refreshNow('claude-code/1.0', 'test'),
    refreshNow('claude-code/1.0', 'test'),
  ]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  resolvePost({
    status: 200,
    body: JSON.stringify({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
    }),
  });

  const outcomes = await results;
  assert.deepEqual(outcomes.map(outcome => outcome.kind), ['ok', 'ok', 'ok']);
  assert.equal(calls, 1);
});

test('OAuth 429 cooldown is scoped to the current credential file', async () => {
  const dir = useTempClaudeConfig();
  writeCredentials(dir);
  const store = makeStore();
  initOAuthRefresh(store);
  let calls = 0;
  __setOAuthRefreshPostForTest(async () => {
    calls += 1;
    return {
      status: 429,
      body: JSON.stringify({ error: { message: 'Rate limited. Please try again later.' } }),
    };
  });

  const first = await refreshNow('claude-code/1.0', 'test');
  const second = await refreshNow('claude-code/1.0', 'test');

  assert.equal(first.kind, 'rate-limited');
  assert.equal(second.kind, 'rate-limited');
  assert.equal(calls, 1);
  assert.equal(store.values._oauthRefreshCooldown.reason, 'http-429');

  writeCredentials(dir, {
    accessToken: 'rotated-access',
    refreshToken: 'rotated-refresh',
    expiresAt: Date.now() - 1000,
  });
  __setOAuthRefreshPostForTest(async () => {
    calls += 1;
    return {
      status: 200,
      body: JSON.stringify({
        access_token: 'newer-access',
        refresh_token: 'newer-refresh',
        expires_in: 3600,
      }),
    };
  });

  const third = await refreshNow('claude-code/1.0', 'test');

  assert.equal(third.kind, 'ok');
  assert.equal(calls, 2);
  assert.equal(store.values._oauthRefreshCooldown, undefined);
});

test('refreshNow kill switch avoids OAuth network calls', async () => {
  const dir = useTempClaudeConfig();
  writeCredentials(dir);
  initOAuthRefresh(makeStore());
  process.env.WMT_DISABLE_REFRESH = '1';
  let calls = 0;
  __setOAuthRefreshPostForTest(async () => {
    calls += 1;
    return { status: 200, body: '{}' };
  });

  const outcome = await refreshNow('claude-code/1.0', 'test');

  assert.equal(outcome.kind, 'rate-limited');
  assert.equal(outcome.reason, 'kill-switch');
  assert.equal(calls, 0);
});

test('OAuth credential state reports expiry and refresh-token presence', () => {
  const dir = useTempClaudeConfig();
  writeCredentials(dir, { expiresAt: Date.now() - 1000 });

  const state = getOAuthCredentialState();

  assert.equal(state.hasCredentials, true);
  assert.equal(state.hasAccessToken, true);
  assert.equal(state.hasRefreshToken, true);
  assert.equal(state.isExpired, true);
  assert.equal(state.shouldRefresh, true);
});
