import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import rateLimitFetcher from '../dist/main/rateLimitFetcher.js';
import claudeQuota from '../dist/main/providers/claude/quota.js';
import oauthRefresh from '../dist/main/oauthRefresh.js';

const { parseClaudeUsagePayload, fetchClaudeUsage, __setClaudeUsageHttpForTest } = rateLimitFetcher;
const { parseClaudeQuotaEntries } = claudeQuota;
const { __setOAuthRefreshPostForTest, __clearOAuthRefreshForTest } = oauthRefresh;
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/quota/claude-limits.json', import.meta.url), 'utf8'));

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const tempDirs = [];

function useTempClaudeCredentials(oauth = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-rate-limit-fetcher-'));
  tempDirs.push(dir);
  process.env.CLAUDE_CONFIG_DIR = dir;
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'stored-access',
      refreshToken: 'stored-refresh',
      expiresAt: Date.now() + 3600_000,
      rateLimitTier: 'max_5x',
      subscriptionType: 'max',
      ...oauth,
    },
  }, null, 2));
  return dir;
}

test.afterEach(() => {
  __setClaudeUsageHttpForTest(null);
  __clearOAuthRefreshForTest();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude usage normalizes top-level account windows and retains scoped limits', () => {
  const usage = parseClaudeUsagePayload(fixture, 'max');
  assert.equal(usage.plan, 'max');
  assert.equal(usage.limits.length, 3);
  assert.deepEqual(usage.accountWindows, {
    fiveHour: { usedPct: 99, resetsAt: Date.parse('2099-01-01T00:00:00Z') },
    sevenDay: { usedPct: 98, resetsAt: Date.parse('2099-01-02T00:00:00Z') },
  });
  assert.equal(usage.accountWindowCandidates, 2);
  assert.equal(usage.invalidAccountWindows, 0);
});

test('Claude maps account windows and active scoped limits from their single transport authorities', () => {
  const usage = parseClaudeUsagePayload(fixture, 'max');
  const parsed = parseClaudeQuotaEntries(usage);
  assert.deepEqual(parsed.entries.map(entry => entry.key), [
    'claude.account.5h',
    'claude.account.7d',
    'claude.fable.7d',
  ]);
  assert.deepEqual(parsed.entries.map(entry => entry.usedPct), [99, 98, 56]);
  assert.equal(parsed.entries[2].target.id, 'claude.group.fable');
  assert.equal(parsed.entries[2].usageBinding, undefined);
  assert.equal(parsed.invalid, 0);
});

test('Claude parser ignores is_active and diagnoses malformed or unknown rows', () => {
  const usage = parseClaudeUsagePayload({ limits: [
    { kind: 'session', group: 'session', percent: 10, resets_at: '2026-07-18T10:00:00Z', is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 30, resets_at: '2026-07-24T10:00:00Z', is_active: false, scope: { model: { id: null, display_name: 'Fable' } } },
    { kind: 'unknown', group: 'weekly', percent: 20, resets_at: '2026-07-24T10:00:00Z', is_active: false },
  ] });
  const parsed = parseClaudeQuotaEntries(usage);
  assert.deepEqual(parsed.entries.map(entry => entry.key), ['claude.fable.7d']);
  assert.equal(parsed.entries[0].usedPct, 30);
  assert.equal(parsed.activeCandidates, 2);
  assert.equal(parsed.invalid, 1);
});

test('Claude empty arrays are authoritative empty; malformed scoped rows are invalid candidates', () => {
  const empty = parseClaudeUsagePayload({ limits: [] });
  const malformed = parseClaudeUsagePayload({ limits: [{ kind: 'weekly_scoped', group: 'weekly', is_active: false }] });
  assert.deepEqual(parseClaudeQuotaEntries(empty), { entries: [], activeCandidates: 0, invalid: 0 });
  assert.deepEqual(parseClaudeQuotaEntries(malformed), { entries: [], activeCandidates: 1, invalid: 1 });
});

test('Claude accepts an account-only response without inventing scoped entries', () => {
  const usage = parseClaudeUsagePayload({ five_hour: fixture.five_hour, seven_day: fixture.seven_day });
  assert.ok(usage);
  assert.deepEqual(usage.limits, []);
  const parsed = parseClaudeQuotaEntries(usage);
  assert.deepEqual(parsed.entries.map(entry => entry.key), ['claude.account.5h', 'claude.account.7d']);
  assert.deepEqual(parsed.entries.map(entry => entry.usedPct), [99, 98]);
});

test('Claude reports malformed top-level account windows as invalid candidates', () => {
  const usage = parseClaudeUsagePayload({
    five_hour: { utilization: 'bad', resets_at: '2099-01-01T00:00:00Z' },
    limits: [],
  });
  assert.ok(usage);
  assert.equal(usage.accountWindowCandidates, 1);
  assert.equal(usage.invalidAccountWindows, 1);
  assert.deepEqual(parseClaudeQuotaEntries(usage), { entries: [], activeCandidates: 1, invalid: 1 });
});

test('expired local token refreshes before the usage fetch even when the server would answer 429', async () => {
  useTempClaudeCredentials({ expiresAt: Date.now() - 60_000 });
  __setOAuthRefreshPostForTest(async () => ({
    status: 200,
    body: JSON.stringify({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }),
  }));
  const seenAuthHeaders = [];
  __setClaudeUsageHttpForTest(async (_url, headers) => {
    seenAuthHeaders.push(headers.Authorization);
    return { status: 200, body: JSON.stringify({ five_hour: fixture.five_hour, seven_day: fixture.seven_day, limits: [] }), headers: {} };
  });

  const result = await fetchClaudeUsage();

  assert.equal(result.status.code, 'ok');
  assert.equal(result.status.connected, true);
  assert.deepEqual(seenAuthHeaders, ['Bearer fresh-access']);
  assert.equal(result.usage.accountWindows.fiveHour.usedPct, 99);
});

test('expired local token with a server-rejected refresh reports login required without a usage request', async () => {
  useTempClaudeCredentials({ expiresAt: Date.now() - 60_000 });
  __setOAuthRefreshPostForTest(async () => ({
    status: 400,
    body: JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token not found or invalid' }),
  }));
  let usageCalls = 0;
  __setClaudeUsageHttpForTest(async () => {
    usageCalls += 1;
    return { status: 429, body: JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited.' } }), headers: {} };
  });

  const result = await fetchClaudeUsage();

  assert.equal(result.status.code, 'unauthorized');
  assert.equal(result.status.label, 'login required');
  assert.equal(result.usage, null);
  assert.equal(usageCalls, 0);
});

test('token entering the expiry leeway is renewed proactively before it expires', async () => {
  useTempClaudeCredentials({ expiresAt: Date.now() + 2 * 60_000 });
  __setOAuthRefreshPostForTest(async () => ({
    status: 200,
    body: JSON.stringify({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }),
  }));
  const seenAuthHeaders = [];
  __setClaudeUsageHttpForTest(async (_url, headers) => {
    seenAuthHeaders.push(headers.Authorization);
    return { status: 200, body: JSON.stringify({ limits: [] }), headers: {} };
  });

  const result = await fetchClaudeUsage();

  assert.equal(result.status.code, 'ok');
  assert.deepEqual(seenAuthHeaders, ['Bearer fresh-access']);
});

test('valid local token fetches usage directly without touching the OAuth refresh endpoint', async () => {
  useTempClaudeCredentials({ expiresAt: Date.now() + 3600_000 });
  let refreshCalls = 0;
  __setOAuthRefreshPostForTest(async () => {
    refreshCalls += 1;
    return { status: 200, body: JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 }) };
  });
  const seenAuthHeaders = [];
  __setClaudeUsageHttpForTest(async (_url, headers) => {
    seenAuthHeaders.push(headers.Authorization);
    return { status: 200, body: JSON.stringify({ limits: [] }), headers: {} };
  });

  const result = await fetchClaudeUsage();

  assert.equal(result.status.code, 'ok');
  assert.equal(refreshCalls, 0);
  assert.deepEqual(seenAuthHeaders, ['Bearer stored-access']);
});

test('expired local token with a rate-limited refresh still attempts the fetch with the stored token', async () => {
  useTempClaudeCredentials({ expiresAt: Date.now() - 60_000 });
  __setOAuthRefreshPostForTest(async () => ({
    status: 429,
    body: JSON.stringify({ error: { message: 'Rate limited. Please try again later.' } }),
  }));
  const seenAuthHeaders = [];
  __setClaudeUsageHttpForTest(async (_url, headers) => {
    seenAuthHeaders.push(headers.Authorization);
    return { status: 429, body: JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited.' } }), headers: {} };
  });

  const result = await fetchClaudeUsage();

  assert.equal(result.status.code, 'rate-limited');
  assert.deepEqual(seenAuthHeaders, ['Bearer stored-access']);
});
