import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import codexFetcher from '../dist/main/codexUsageFetcher.js';
import codexProvider from '../dist/main/providers/codex/quota.js';

const { parseCodexQuotaPayload, resolveCodexUsageUrl, normalizeCodexUsageBaseUrl } = codexFetcher;
const { codexQuotaEntries } = codexProvider;
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/quota/codex-windows.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-07-18T00:00:00Z');

test('Codex usage URL remains on the official backend path', () => {
  assert.equal(resolveCodexUsageUrl('https://chatgpt.com'), 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(normalizeCodexUsageBaseUrl('https://chatgpt.com/backend-api/'), 'https://chatgpt.com/backend-api');
});

test('Codex maps 7d-only and 5h-only windows by exact duration, not slot position', () => {
  const seven = parseCodexQuotaPayload(fixture.sevenDayOnly, NOW).usage;
  const five = parseCodexQuotaPayload(fixture.fiveHourOnly, NOW).usage;
  assert.deepEqual(seven.windows.map(window => window.durationMs), [604_800_000]);
  assert.deepEqual(five.windows.map(window => window.durationMs), [18_000_000]);
  assert.deepEqual(codexQuotaEntries(seven).map(entry => entry.key), ['codex.account.7d']);
  assert.deepEqual(codexQuotaEntries(five).map(entry => entry.key), ['codex.account.5h']);
});

test('Codex reversed primary/secondary slots preserve semantic 7d then 5h durations', () => {
  const usage = parseCodexQuotaPayload(fixture.reversed, NOW).usage;
  assert.deepEqual(usage.windows.map(window => [window.durationMs, window.usedPct]), [
    [604_800_000, 41],
    [18_000_000, 21],
  ]);
});

test('Codex unknown-only duration is schema-invalid and does not become a placeholder', () => {
  const parsed = parseCodexQuotaPayload(fixture.unknownDuration, NOW);
  assert.equal(parsed.usage, null);
  assert.equal(parsed.authoritativeEmpty, false);
});

test('Codex absent windows and credits-unlimited are authoritative empty quota arrays', () => {
  for (const payload of [fixture.absent, fixture.creditsUnlimited]) {
    const parsed = parseCodexQuotaPayload(payload, NOW);
    assert.equal(parsed.authoritativeEmpty, true);
    assert.deepEqual(parsed.usage.windows, []);
    assert.deepEqual(codexQuotaEntries(parsed.usage), []);
  }
  assert.equal(parseCodexQuotaPayload(fixture.creditsUnlimited, NOW).usage.credits.unlimited, true);
});

test('Codex keeps genuine zero utilization as a limited zero entry', () => {
  const parsed = parseCodexQuotaPayload({
    rate_limit: { primary_window: { window_minutes: 300, used_percent: 0, reset_after_seconds: 60 } },
  }, NOW);
  const [entry] = codexQuotaEntries(parsed.usage);
  assert.equal(entry.state, 'limited');
  assert.equal(entry.usedPct, 0);
});
