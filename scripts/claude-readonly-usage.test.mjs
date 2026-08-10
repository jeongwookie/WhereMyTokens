import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import compatibilityModule from '../dist/main/providers/claude/readOnlyUsage.js';

const {
  CLAUDE_COMPATIBILITY_MIN_INTERVAL_MS,
  __resetClaudeCompatibilityStateForTest,
  __setClaudeCompatibilityHttpForTest,
  claudeCompatibilityUsageUrlForTest,
  fetchClaudeCompatibilityUsage,
  invalidateClaudeCompatibilityUsageCache,
  parseClaudeCompatibilityUsage,
} = compatibilityModule;

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/quota/claude-limits.json', import.meta.url), 'utf8'));
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const tempDirs = [];

function useCredentials(accessToken = 'access-a', expiresAt = undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-claude-readonly-'));
  tempDirs.push(dir);
  process.env.CLAUDE_CONFIG_DIR = dir;
  const filePath = path.join(dir, '.credentials.json');
  fs.writeFileSync(filePath, JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: 'unused',
      rateLimitTier: 'default_claude_max_5x',
      subscriptionType: 'max',
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
  }, null, 2));
  return filePath;
}

test.afterEach(() => {
  __setClaudeCompatibilityHttpForTest(null);
  __resetClaudeCompatibilityStateForTest();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('compatibility parser keeps exact account windows and valid scoped limits', () => {
  const usage = parseClaudeCompatibilityUsage({
    ...fixture,
    extra_usage: {
      is_enabled: true,
      monthly_limit: 2000,
      used_credits: 750,
      utilization: 37.5,
    },
  }, 'Max 5x');
  assert.ok(usage);
  assert.deepEqual(usage.fiveHour, {
    usedPct: 99,
    resetsAtMs: Date.parse('2099-01-01T00:00:00Z'),
  });
  assert.deepEqual(usage.sevenDay, {
    usedPct: 98,
    resetsAtMs: Date.parse('2099-01-02T00:00:00Z'),
  });
  assert.deepEqual(usage.modelScoped, [{
    label: 'Fable',
    usedPct: 56,
    resetsAtMs: Date.parse('2026-07-24T10:00:00Z'),
  }]);
  assert.equal(usage.planName, 'Max 5x');
  assert.equal(usage.extraUsage.usedCredits, 750);
});

test('compatibility fetch is read-only and throttles successful requests for 15 minutes', async () => {
  const filePath = useCredentials();
  const before = fs.readFileSync(filePath, 'utf8');
  const beforeMtime = fs.statSync(filePath).mtimeMs;
  let calls = 0;
  __setClaudeCompatibilityHttpForTest(async headers => {
    calls += 1;
    assert.equal(headers.Authorization, 'Bearer access-a');
    assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
    return { status: 200, body: JSON.stringify(fixture), headers: {} };
  });

  const now = Date.now();
  const first = await fetchClaudeCompatibilityUsage({ nowMs: now });
  const cached = await fetchClaudeCompatibilityUsage({ nowMs: now + CLAUDE_COMPATIBILITY_MIN_INTERVAL_MS - 1 });

  assert.equal(first.status.code, 'compatibility-api');
  assert.equal(cached.capturedAt, first.capturedAt);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(fs.statSync(filePath).mtimeMs, beforeMtime);
  assert.equal(claudeCompatibilityUsageUrlForTest(), 'https://api.anthropic.com/api/oauth/usage');
});

test('expired credential metadata requires official login without network access or file writes', async () => {
  const now = Date.now();
  const filePath = useCredentials('expired-metadata', now - 1);
  const before = fs.readFileSync(filePath, 'utf8');
  const beforeMtime = fs.statSync(filePath).mtimeMs;
  let calls = 0;
  __setClaudeCompatibilityHttpForTest(async () => {
    calls += 1;
    return { status: 200, body: JSON.stringify(fixture), headers: {} };
  });

  const expired = await fetchClaudeCompatibilityUsage({ nowMs: now });
  const stillExpired = await fetchClaudeCompatibilityUsage({ nowMs: now + 60_000 });

  assert.equal(expired.status.code, 'credentials-expired');
  assert.equal(stillExpired.status.code, 'credentials-expired');
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(fs.statSync(filePath).mtimeMs, beforeMtime);
});

test('credential-file invalidation retries when login renews metadata without rotating the access token', async () => {
  const now = Date.now();
  const filePath = useCredentials('same-access-token', now - 1);
  let calls = 0;
  __setClaudeCompatibilityHttpForTest(async () => {
    calls += 1;
    return { status: 200, body: JSON.stringify(fixture), headers: {} };
  });

  const expired = await fetchClaudeCompatibilityUsage({ nowMs: now });
  const credentials = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  credentials.claudeAiOauth.expiresAt = now + 60 * 60_000;
  fs.writeFileSync(filePath, JSON.stringify(credentials, null, 2));
  invalidateClaudeCompatibilityUsageCache();
  const recovered = await fetchClaudeCompatibilityUsage({ nowMs: now + 1 });

  assert.equal(expired.status.code, 'credentials-expired');
  assert.equal(recovered.status.code, 'compatibility-api');
  assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).claudeAiOauth.refreshToken, 'unused');
});

test('auth failure backs off, while a changed access token retries without reading refresh state', async () => {
  const filePath = useCredentials('expired');
  let calls = 0;
  __setClaudeCompatibilityHttpForTest(async headers => {
    calls += 1;
    if (headers.Authorization === 'Bearer expired') {
      return { status: 401, body: '{}', headers: {} };
    }
    return { status: 200, body: JSON.stringify(fixture), headers: {} };
  });

  const now = Date.now();
  const rejected = await fetchClaudeCompatibilityUsage({ nowMs: now });
  const backedOff = await fetchClaudeCompatibilityUsage({ nowMs: now + 5 * 60_000 });
  const stillBlocked = await fetchClaudeCompatibilityUsage({ nowMs: now + 2 * 60 * 60_000 });
  assert.equal(rejected.status.code, 'unauthorized');
  assert.equal(backedOff.status.code, 'unauthorized');
  assert.equal(stillBlocked.status.code, 'unauthorized');
  assert.equal(calls, 1);

  const credentials = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  credentials.claudeAiOauth.accessToken = 'renewed';
  fs.writeFileSync(filePath, JSON.stringify(credentials, null, 2));
  const recovered = await fetchClaudeCompatibilityUsage({ nowMs: now + 5 * 60_000 + 1 });
  assert.equal(recovered.status.code, 'compatibility-api');
  assert.equal(calls, 2);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).claudeAiOauth.refreshToken, 'unused');
});

test('rate-limit response honors a longer server retry window', async () => {
  useCredentials();
  let calls = 0;
  __setClaudeCompatibilityHttpForTest(async () => {
    calls += 1;
    return { status: 429, body: '{}', headers: { 'retry-after': '1800' } };
  });
  const now = Date.now();
  const limited = await fetchClaudeCompatibilityUsage({ nowMs: now });
  const cached = await fetchClaudeCompatibilityUsage({ nowMs: now + 20 * 60_000 });
  assert.equal(limited.status.retryAfterMs, 30 * 60_000);
  assert.equal(cached.status.code, 'rate-limited');
  assert.equal(calls, 1);
});
