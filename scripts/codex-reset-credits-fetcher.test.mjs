import test from 'node:test';
import assert from 'node:assert/strict';
import codexUsageFetcher from '../dist/main/codexUsageFetcher.js';

const {
  resolveCodexResetCreditsUrl,
  parseCodexResetCreditsPayload,
  resetCreditsFromUsagePayload,
} = codexUsageFetcher;

test('reset-credits URL follows the wham path style', () => {
  assert.equal(resolveCodexResetCreditsUrl('https://chatgpt.com'), 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(resolveCodexResetCreditsUrl('https://chat.openai.com/'), 'https://chat.openai.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(resolveCodexResetCreditsUrl('https://example.test'), 'https://example.test/api/codex/rate-limit-reset-credits');
  // A user may set chatgpt_base_url to the FULL usage endpoint — PRESERVE its route family, never double-append:
  assert.equal(resolveCodexResetCreditsUrl('https://chatgpt.com/backend-api/wham/usage'), 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(resolveCodexResetCreditsUrl('https://example.test/api/codex/usage'), 'https://example.test/api/codex/rate-limit-reset-credits');
  // Custom proxy on the /wham/ family WITHOUT /backend-api must stay on /wham/ (not be re-derived to /api/codex/):
  assert.equal(resolveCodexResetCreditsUrl('https://myproxy.com/wham/usage'), 'https://myproxy.com/wham/rate-limit-reset-credits');
});

test('parses available credits sorted soonest-first, drops non-available', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  const data = parseCodexResetCreditsPayload({
    available_count: 2,
    total_earned_count: 5,
    credits: [
      { id: 'RateLimitReset_bbb', status: 'available', expires_at: '2026-07-18T08:36:00.000000Z', granted_at: '2026-06-18T08:36:00Z' },
      { id: 'RateLimitReset_aaa', status: 'available', expires_at: '2026-07-12T11:46:00.000000Z' },
      { id: 'RateLimitReset_ccc', status: 'redeemed', expires_at: '2026-07-01T00:00:00Z', redeemed_at: '2026-06-30T00:00:00Z' },
    ],
  }, now);
  assert.equal(data.credits.length, 2);
  assert.equal(data.credits[0].expiresAtUtc, '2026-07-12T11:46:00.000000Z');
  assert.equal(data.credits[1].expiresAtUtc, '2026-07-18T08:36:00.000000Z');
  assert.equal(data.credits[0].status, 'available');
  assert.equal(data.credits[0].idSuffix, 'aaa');
  assert.equal(data.availableCount, 2);
  assert.equal(data.totalEarnedCount, 5);
  assert.equal(data.countOnly, false);
  assert.equal(data.source, 'api');
});

test('expires_at variants: trailing Z, explicit offset, and null all parse', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  const data = parseCodexResetCreditsPayload({
    available_count: 3,
    credits: [
      { id: 'z', status: 'available', expires_at: '2026-07-12T11:46:00Z' },
      { id: 'o', status: 'available', expires_at: '2026-07-10T00:00:00+02:00' },
      { id: 'n', status: 'available', expires_at: null },
    ],
  }, now);
  // null-expiry credit is retained (available) but sorts last
  assert.equal(data.credits.length, 3);
  assert.equal(data.credits[data.credits.length - 1].expiresAtUtc, null);
  assert.equal(data.credits[0].expiresAtUtc, '2026-07-10T00:00:00+02:00');
});

test('available_count absent is derived from the available list', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  const data = parseCodexResetCreditsPayload({
    credits: [
      { id: 'a', status: 'available', expires_at: '2026-07-12T00:00:00Z' },
      { id: 'b', status: 'available', expires_at: '2026-07-13T00:00:00Z' },
    ],
  }, now);
  assert.equal(data.availableCount, 2);
});

test('usage-embedded fallback carries the REAL reset status, not a synthetic ok (R2-1)', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  // The count-only fallback must stamp the FAILING reset status so backoff/eviction still fire downstream.
  const failing = { code: 'rate-limited', connected: false, label: 'rate limited', detail: 'slow', retryAfterMs: 90_000 };
  const data = resetCreditsFromUsagePayload({ rate_limit_reset_credits: { available_count: 4 } }, now, failing);
  assert.equal(data.countOnly, true);
  assert.equal(data.availableCount, 4);
  assert.equal(data.credits.length, 0);
  assert.equal(data.status.code, 'rate-limited');       // NOT laundered to ok
  assert.equal(data.status.retryAfterMs, 90_000);
  assert.equal(data.source, 'api');
});

test('usage payload without reset-credit field yields no fallback', () => {
  const failing = { code: 'network', connected: false, label: 'api disconnected', detail: 'x' };
  assert.equal(resetCreditsFromUsagePayload({ rate_limit: {} }, Date.now(), failing), null);
});

test('empty-but-well-formed 200 is a valid zero result, not schema-changed', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  // A present credits array OR a numeric available_count makes it a legit zero.
  const withArray = parseCodexResetCreditsPayload({ credits: [], available_count: 0 }, now);
  assert.notEqual(withArray, null);
  assert.equal(withArray.availableCount, 0);
  assert.equal(withArray.credits.length, 0);
  const countOnlyShape = parseCodexResetCreditsPayload({ available_count: 0 }, now);
  assert.notEqual(countOnlyShape, null);
  assert.equal(countOnlyShape.availableCount, 0);
});

test('unexpected-shape 200 (neither credits array nor numeric available_count) returns null', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  assert.equal(parseCodexResetCreditsPayload({}, now), null);
  assert.equal(parseCodexResetCreditsPayload({ unrelated: true }, now), null);
  assert.equal(parseCodexResetCreditsPayload('not-json-object', now), null);
});
