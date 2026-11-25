import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAgyUsageJson, createAntigravityCliQuotaReader } from '../dist/main/providers/antigravity/cliQuota.js';
import { parseAntigravityQuotaSummary } from '../dist/main/providers/antigravity/quota.js';
import quotaDomain from '../dist/shared/quotaDomain.js';

const { validateProviderQuotaSnapshot } = quotaDomain;

test('agy /usage JSON maps group quotas to existing 5h/7d provider entries', () => {
  const normalized = parseAgyUsageJson({
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            id: 'gemini',
            name: 'Gemini Models',
            buckets: [
              {
                id: 'gemini-session',
                name: 'Session Limit Remaining',
                window: '5h',
                remaining_fraction: 0.75,
                reset_time: '2026-11-25T08:00:00Z',
              },
              {
                id: 'gemini-weekly',
                name: 'Weekly Limit Remaining',
                window: 'weekly',
                remaining_fraction: 0,
                reset_time: '2026-11-28T08:00:00Z',
              },
            ],
          },
          {
            name: 'Claude/GPT models',
            buckets: [{ id: '3p-weekly', name: 'Weekly Remaining', window: 'weekly', remaining_fraction: 0.3 }],
          },
        ],
      },
    },
    // Extra metadata must be ignored, including account and session fields.
    session_id: 'should-not-leak',
    account: { email: 'private@example.com' },
  });

  assert.ok(normalized);
  assert.equal(JSON.stringify(normalized).includes('private@example.com'), false);
  assert.equal(JSON.stringify(normalized).includes('should-not-leak'), false);
  const entries = parseAntigravityQuotaSummary(normalized);
  assert.deepEqual(entries.map(entry => [entry.target.label, entry.period, entry.usedPct]), [
    ['Gemini Models', '5h', 25],
    ['Gemini Models', '7d', 100],
    ['Claude/GPT models', '7d', 70],
  ]);
  assert.ok(validateProviderQuotaSnapshot({
    provider: 'antigravity',
    source: 'localCli',
    capturedAt: Date.now(),
    entries,
    status: { connected: true, code: 'connected', severity: 'ok' },
  }));
});

test('agy /usage skips omitted or malformed fractions; never invents 100% usage', () => {
  const result = parseAgyUsageJson({
    command: { data: { groups: [{
      name: 'Gemini Models',
      buckets: [
        { id: 'unknown', window: 'weekly' },
        { id: 'bad', remaining_fraction: '0' },
        { id: 'nan', remaining_fraction: null },
        { id: 'known', window: 'weekly', remaining_fraction: 0.5 },
      ],
    }] } },
  });
  assert.deepEqual(parseAntigravityQuotaSummary(result).map(entry => entry.usedPct), [50]);
});

test('agy /usage rejects unrelated commands and malformed result envelopes', () => {
  assert.equal(parseAgyUsageJson({ command: { name: 'prompt', data: { groups: [] } } }), null);
  assert.equal(parseAgyUsageJson({ response: { groups: [] } }), null);
  assert.equal(parseAgyUsageJson({ command: { name: 'usage', data: { groups: {} } } }), null);
  assert.equal(parseAgyUsageJson(null), null);
  assert.equal(parseAgyUsageJson({ status: 'ERROR', command: { name: 'usage', data: { groups: [] } } }), null);
});

test('agy 1.5.17 maps explicit windows and omits the epoch reset sentinel', () => {
  const normalized = parseAgyUsageJson({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [
      { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.2, reset_time: '2030-12-01T01:00:00Z' },
      { id: 'gemini-5h', window: '5h', remaining_fraction: 0.35, reset_time: '2030-11-25T11:00:00Z' },
    ] },
    { name: 'Claude and GPT models', buckets: [
      { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
      { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
      { id: 'invalid', window: '5h', remaining_fraction: 1.5 },
    ] },
  ] } } });
  const entries = parseAntigravityQuotaSummary(normalized);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map(e => e.period), ['7d', '5h', '7d', '5h']);
  assert.deepEqual(entries.map(e => Math.round(e.usedPct * 10) / 10), [80, 65, 0, 0]);
  assert.deepEqual(entries.map(e => e.resetsAt), [Date.parse('2030-12-01T01:00:00Z'), Date.parse('2030-11-25T11:00:00Z'), null, null]);
});

test('agy /usage accepts snake_case aliases and clamps oversized bucket collections', () => {
  const value = parseAgyUsageJson({
    command: { data: { groups: [{
      display_name: 'Argon',
      buckets: Array.from({ length: 40 }, (_, i) => ({
        bucket_id: 'argon-' + i,
        display_name: 'Weekly',
        remaining_fraction: 1,
        reset_time: null,
      })),
    }] } },
  });
  const entries = parseAntigravityQuotaSummary(value);
  assert.equal(entries.length, 32);
  assert.ok(entries.every(entry => entry.target.label === 'Argon' && entry.usedPct === 0));
});

test('CLI reader bypasses TTL on manual refresh but respects the retry guard and original capture time', async () => {
  let now = 0;
  let calls = 0;
  const snapshot = parseAgyUsageJson({
    status: 'SUCCESS', command: { name: 'usage', data: { groups: [
      { name: 'Gemini Models', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.5 }] },
    ] } },
  });
  const read = createAntigravityCliQuotaReader(async () => {
    calls++;
    return calls === 3 ? null : snapshot;
  }, () => now);
  const first = await read();
  assert.equal(first.fromCache, false);
  now += 1_000;
  assert.equal((await read(true)).capturedAt, first.capturedAt);
  assert.equal(calls, 1);
  now += 15_000;
  assert.equal((await read()).fromCache, true);
  const refreshed = await read(true);
  assert.equal(refreshed.fromCache, false);
  assert.equal(refreshed.capturedAt, now);
  assert.equal(calls, 2);
  now += 15_000;
  const failed = await read(true);
  assert.equal(failed.fromCache, true);
  assert.equal(failed.refreshFailed, true);
  assert.equal(failed.capturedAt, refreshed.capturedAt);
  now += 60_000;
  assert.equal((await read()).fromCache, false);
  assert.equal(calls, 4);
});

test('overlapping CLI quota requests share one invocation', async () => {
  let calls = 0;
  let release;
  const read = createAntigravityCliQuotaReader(() => {
    calls++;
    return new Promise(resolve => { release = resolve; });
  }, () => 0);
  const first = read();
  const second = read(true);
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ groups: [{ displayName: 'Gemini Models', buckets: [{ remainingFraction: 1 }] }] });
  assert.deepEqual(await first, await second);
});
