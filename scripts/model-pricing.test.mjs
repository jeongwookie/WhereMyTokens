import test from 'node:test';
import assert from 'node:assert/strict';

import modelPricingModule from '../dist/main/modelPricing.js';

const { estimateUsageCost } = modelPricingModule;

function estimate(model, timestampMs, overrides = {}) {
  return estimateUsageCost({
    model,
    timestampMs,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    ...overrides,
  });
}

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test('current Claude model families use explicit vendor rates', () => {
  const timestamp = Date.parse('2026-08-04T00:00:00Z');
  const opus5 = estimate('claude-opus-5', timestamp);
  const opus48 = estimate('claude-opus-4-8', timestamp);
  closeTo(opus5.costUSD, 36.75);
  closeTo(opus48.costUSD, opus5.costUSD);
  closeTo(opus5.cacheSavingsUSD, 4.5);

  const fable = estimate('claude-fable-5', timestamp);
  closeTo(fable.costUSD, 73.5);
  closeTo(fable.cacheSavingsUSD, 9);
});

test('Sonnet 5 promotional pricing changes atomically on 2026-09-01 UTC', () => {
  const promo = estimate('claude-sonnet-5', Date.parse('2026-08-31T23:59:59.999Z'));
  const standard = estimate('claude-sonnet-5', Date.parse('2026-09-01T00:00:00.000Z'));
  closeTo(promo.costUSD, 14.7);
  closeTo(standard.costUSD, 22.05);
});

test('GPT-5.6 Sol, Terra, and Luna use their distinct standard rates', () => {
  const timestamp = Date.parse('2026-08-04T00:00:00Z');
  const standardRequest = {
    inputTokens: 100_000,
    outputTokens: 100_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 100_000,
  };
  closeTo(estimate('gpt-5.6-sol', timestamp, standardRequest).costUSD, 3.55);
  closeTo(estimate('gpt-5.6-terra', timestamp, standardRequest).costUSD, 1.42);
  closeTo(estimate('gpt-5.6-luna', timestamp, standardRequest).costUSD, 0.142);
  closeTo(estimate('gpt-5.6', timestamp, standardRequest).costUSD, 3.55);
});

test('GPT-5.6 Terra and Luna preserve launch pricing before the July 30 cut', () => {
  const beforeCut = Date.parse('2026-07-29T23:59:59.999Z');
  const atCut = Date.parse('2026-07-30T00:00:00.000Z');
  const request = {
    inputTokens: 100_000,
    outputTokens: 100_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 100_000,
  };
  closeTo(estimate('gpt-5.6-terra', beforeCut, request).costUSD, 1.775);
  closeTo(estimate('gpt-5.6-luna', beforeCut, request).costUSD, 0.71);
  closeTo(estimate('gpt-5.6-terra', atCut, request).costUSD, 1.42);
  closeTo(estimate('gpt-5.6-luna', atCut, request).costUSD, 0.142);
});

test('GPT-5.6 long-context surcharge begins only above 272K prompt tokens', () => {
  const timestamp = Date.parse('2026-08-04T00:00:00Z');
  const boundary = estimate('gpt-5.6-sol', timestamp, {
    inputTokens: 272_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
  const long = estimate('gpt-5.6-sol', timestamp, {
    inputTokens: 272_001,
    outputTokens: 1_000_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
  closeTo(boundary.costUSD, 31.36);
  closeTo(long.costUSD, 47.72001);
});

test('GPT-6 Astra uses explicit standard input, output, cache-write and cache-read rates', () => {
  const timestamp = Date.parse('2026-09-07T00:00:00Z');
  const empty = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  for (const [field, expected] of [
    ['inputTokens', 0.01],
    ['outputTokens', 0.05],
    ['cacheCreationTokens', 0.0125],
    ['cacheReadTokens', 0.001],
  ]) {
    closeTo(estimate('gpt-6-astra', timestamp, { ...empty, [field]: 1000 }).costUSD, expected);
  }
  const cached = estimate(' GPT-6-ASTRA ', timestamp, { ...empty, cacheReadTokens: 1000 });
  closeTo(cached.costUSD, 0.001);
  closeTo(cached.cacheSavingsUSD, 0.009);
});

test('GPT-6 Astra applies full-request long-context rates only above 272K total prompt tokens', () => {
  const timestamp = Date.parse('2026-09-07T00:00:00Z');
  const request = { inputTokens: 100_000, outputTokens: 100_000, cacheCreationTokens: 100_000, cacheReadTokens: 72_000 };
  const boundary = estimate('gpt-6-astra', timestamp, request);
  const long = estimate('gpt-6-astra', timestamp, { ...request, cacheReadTokens: 72_001 });
  closeTo(boundary.costUSD, 7.322);
  closeTo(boundary.cacheSavingsUSD, 0.648);
  closeTo(long.costUSD, 12.144002);
  closeTo(long.cacheSavingsUSD, 1.296018);
});

test('unlisted GPT-6 variants do not inherit an unverified Astra price', () => {
  const request = { inputTokens: 1000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  closeTo(estimate('gpt-6-unlisted', Date.parse('2026-09-07T00:00:00Z'), request).costUSD, 0.0025);
});

test('invalid token counts fail loudly instead of producing a corrupt cost', () => {
  assert.throws(() => estimate('gpt-5.6-sol', Date.now(), { inputTokens: -1 }), /invalid inputTokens/);
});
