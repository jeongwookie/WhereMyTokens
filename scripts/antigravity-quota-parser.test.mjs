import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  parseAntigravityModelQuotas,
  parseAntigravityQuotaSummary,
} from '../dist/main/providers/antigravity/quota.js';
import quotaDomain from '../dist/shared/quotaDomain.js';

const { validateProviderQuotaSnapshot } = quotaDomain;

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/quota/antigravity-models.json', import.meta.url), 'utf8'));
const FIVE_HOURS_MS = 18_000_000;
const WEEK_MS = 604_800_000;

test('pace off keeps absolute reset but does not invent duration, period, or usage binding', () => {
  const now = Date.parse('2026-07-18T04:00:00Z');
  const entries = parseAntigravityModelQuotas(fixture.models, now);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].usedPct, 30);
  assert.equal(entries[0].resetsAt, Date.parse('2026-07-18T06:00:00Z'));
  assert.equal(entries[0].durationMs, null);
  assert.equal(entries[0].period, null);
  assert.equal(entries[0].durationInferred, false);
  assert.equal(entries[0].usageBinding, undefined);
  assert.equal(entries[0].target.id, 'antigravity.group.model.gemini-pro');
});

test('pace on infers exact 5h/7d durations and adds exact model bindings', () => {
  const now = Date.parse('2026-07-18T04:00:00Z');
  const entries = parseAntigravityModelQuotas(fixture.models, now, { inferDurationFromReset: true });
  assert.deepEqual(entries.map(entry => entry.durationMs), [FIVE_HOURS_MS, WEEK_MS]);
  assert.deepEqual(entries.map(entry => entry.period), ['5h', '7d']);
  assert.ok(entries.every(entry => entry.durationInferred));
  assert.deepEqual(entries[0].usageBinding, {
    kind: 'models',
    matchers: [{ kind: 'exact', value: 'Gemini Pro' }],
  });
});

test('elapsed or invalid reset never fabricates inferred timing', () => {
  const entries = parseAntigravityModelQuotas([
    { label: 'Elapsed', modelOrAlias: { model: 'elapsed' }, quotaInfo: { remainingFraction: 1, resetTime: '2026-07-18T03:00:00Z' } },
    { label: 'Unknown', modelOrAlias: { model: 'unknown' }, quotaInfo: { remainingFraction: 0.5, resetTime: 'not-a-time' } },
  ], Date.parse('2026-07-18T04:00:00Z'), { inferDurationFromReset: true });
  assert.deepEqual(entries.map(entry => [entry.resetsAt, entry.durationMs, entry.period, entry.durationInferred]), [
    [Date.parse('2026-07-18T03:00:00Z'), null, null, false],
    [null, null, null, false],
  ]);
});

test('grouped quota summary creates one target per family and one entry per bucket', () => {
  const entries = parseAntigravityQuotaSummary({
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.75, resetTime: '2026-07-22T06:00:00Z' },
            { bucketId: 'gemini-session', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.4, resetTime: '2026-07-18T06:00:00Z' },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 1 },
          ],
        },
      ],
    },
  });

  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(entry => [entry.target.label, entry.period, entry.usedPct]), [
    ['Gemini Models', '7d', 25],
    ['Gemini Models', '5h', 60],
    ['Claude and GPT models', '7d', 0],
  ]);
  assert.equal(entries[0].target.id, entries[1].target.id);
  assert.notEqual(entries[0].target.id, entries[2].target.id);
  assert.ok(entries.every(entry => entry.durationInferred === false));
  assert.ok(entries.every(entry => entry.usageBinding === undefined));
});

test('grouped quota summary drops malformed buckets without inventing limits', () => {
  const entries = parseAntigravityQuotaSummary({
    groups: [{
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'missing-fraction', displayName: 'Weekly Limit Remaining' },
        { bucketId: 'invalid-fraction', remainingFraction: Number.NaN },
      ],
    }],
  });
  assert.deepEqual(entries, []);
});

test('grouped quota summary keeps colliding labels canonical and bounded', () => {
  const repeatedBuckets = Array.from({ length: 40 }, (_, index) => ({
    bucketId: 'weekly',
    displayName: `Weekly ${index + 1}`,
    remainingFraction: 0.5,
  }));
  const entries = parseAntigravityQuotaSummary({
    response: {
      groups: [
        { displayName: 'A+B', buckets: repeatedBuckets },
        { displayName: 'A B', buckets: [{ bucketId: 'weekly', remainingFraction: 0.25 }] },
      ],
    },
  });

  assert.equal(entries.length, 33);
  assert.notEqual(entries[0].target.id, entries[32].target.id);
  assert.equal(new Set(entries.map(entry => entry.key)).size, entries.length);
  assert.ok(validateProviderQuotaSnapshot({
    provider: 'antigravity',
    source: 'localRpc',
    capturedAt: Date.now(),
    entries,
  }));
});
