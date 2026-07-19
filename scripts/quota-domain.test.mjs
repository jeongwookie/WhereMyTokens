import test from 'node:test';
import assert from 'node:assert/strict';
import quotaDomain from '../dist/shared/quotaDomain.js';

const {
  FIVE_HOURS_MS,
  SEVEN_DAYS_MS,
  QUOTA_CACHE_WITHOUT_RESET_TTL_MS,
  normalizeQuotaPeriod,
  validateProviderQuotaSnapshot,
  quotaElapsedPct,
  ageProviderQuotaSnapshot,
  selectProviderQuotaSnapshot,
  groupQuotaEntries,
  selectFixedPeriodQuota,
} = quotaDomain;

const now = Date.UTC(2026, 6, 18, 12);

function target(overrides = {}) {
  return {
    id: 'claude.group.account',
    label: 'Claude',
    defaultMode: 'rich',
    defaultOrder: 0,
    taskbarAbbreviation: 'C',
    ...overrides,
  };
}

function limited(overrides = {}) {
  const durationMs = overrides.durationMs === undefined ? FIVE_HOURS_MS : overrides.durationMs;
  return {
    key: 'claude.account.5h',
    target: target(),
    scope: { kind: 'account' },
    state: 'limited',
    usedPct: 42,
    resetsAt: now + FIVE_HOURS_MS / 2,
    durationMs,
    durationInferred: false,
    period: normalizeQuotaPeriod(durationMs),
    ...overrides,
  };
}

function snapshot(entries, overrides = {}) {
  return { provider: 'claude', source: 'api', capturedAt: now, entries, ...overrides };
}

test('normalizes only exact supported durations and preserves unknown duration', () => {
  assert.equal(normalizeQuotaPeriod(FIVE_HOURS_MS), '5h');
  assert.equal(normalizeQuotaPeriod(SEVEN_DAYS_MS), '7d');
  assert.equal(normalizeQuotaPeriod(FIVE_HOURS_MS + 1), null);
  assert.equal(normalizeQuotaPeriod(null), null);
});

test('validates one canonical entry shape and rejects duplicate or inconsistent targets', () => {
  assert.ok(validateProviderQuotaSnapshot(snapshot([limited()])));
  assert.equal(validateProviderQuotaSnapshot(snapshot([limited(), limited()])), null);
  assert.equal(validateProviderQuotaSnapshot(snapshot([
    limited(),
    limited({ key: 'claude.account.7d', durationMs: SEVEN_DAYS_MS, period: '7d', target: target({ label: 'Other' }) }),
  ])), null);
  assert.equal(validateProviderQuotaSnapshot(snapshot([limited({ period: '7d' })])), null);
  assert.equal(validateProviderQuotaSnapshot(snapshot([limited({ usedPct: 101 })])), null);
});

test('computes elapsed from reset and duration without requiring a usage binding', () => {
  const entry = limited({ durationMs: SEVEN_DAYS_MS, period: '7d', resetsAt: now + SEVEN_DAYS_MS / 2 });
  assert.equal(quotaElapsedPct(entry, now), 50);
  assert.equal(quotaElapsedPct({ ...entry, resetsAt: null }, now), null);
  assert.equal(quotaElapsedPct({ ...entry, durationMs: null, period: null }, now), null);
});

test('ages entries independently and never converts expiry into zero utilization', () => {
  const known = limited({ resetsAt: now + 1 });
  const unknown = limited({ key: 'claude.account.7d', resetsAt: null, durationMs: SEVEN_DAYS_MS, period: '7d' });
  assert.equal(ageProviderQuotaSnapshot(snapshot([known, unknown]), now).entries.length, 2);
  assert.deepEqual(ageProviderQuotaSnapshot(snapshot([known, unknown]), now + QUOTA_CACHE_WITHOUT_RESET_TTL_MS + 1).entries, []);
});

test('selects ordered whole snapshots and lets authoritative empty win', () => {
  const empty = snapshot([]);
  const fallback = snapshot([limited()], { source: 'cache' });
  assert.deepEqual(selectProviderQuotaSnapshot([empty, fallback], now)?.entries, []);
  assert.equal(selectProviderQuotaSnapshot([{ broken: true }, fallback], now)?.source, 'cache');
});

test('groups entries by stable target and orders by target metadata', () => {
  const fable = limited({
    key: 'claude.fable.7d',
    target: target({ id: 'claude.group.fable', label: 'Fable', defaultMode: 'simple', defaultOrder: 10, taskbarAbbreviation: 'F' }),
    scope: { kind: 'model', label: 'Fable' },
    durationMs: SEVEN_DAYS_MS,
    period: '7d',
  });
  const groups = groupQuotaEntries([fable, limited()]);
  assert.deepEqual(groups.map(group => group.target.id), ['claude.group.account', 'claude.group.fable']);
});

test('fixed-period selection distinguishes real zero, provisional, unlimited, and absence', () => {
  assert.deepEqual(selectFixedPeriodQuota([limited({ usedPct: 0 })], '5h'), { state: 'limited', usedPct: 0 });
  assert.deepEqual(selectFixedPeriodQuota([limited({ provisional: true })], '5h'), { state: 'provisional', usedPct: null });
  const unlimited = { ...limited(), state: 'unlimited' };
  delete unlimited.usedPct;
  assert.deepEqual(selectFixedPeriodQuota([unlimited], '5h'), { state: 'unlimited', usedPct: null });
  assert.deepEqual(selectFixedPeriodQuota([], '7d'), { state: 'absent', usedPct: null });
});
