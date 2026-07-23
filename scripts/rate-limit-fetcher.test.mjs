import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import rateLimitFetcher from '../dist/main/rateLimitFetcher.js';
import claudeQuota from '../dist/main/providers/claude/quota.js';

const { parseClaudeUsagePayload } = rateLimitFetcher;
const { parseClaudeQuotaEntries } = claudeQuota;
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/quota/claude-limits.json', import.meta.url), 'utf8'));

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
