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
  closeTo(estimate('gpt-5.6-terra', timestamp, standardRequest).costUSD, 1.775);
  closeTo(estimate('gpt-5.6-luna', timestamp, standardRequest).costUSD, 0.71);
  closeTo(estimate('gpt-5.6', timestamp, standardRequest).costUSD, 3.55);
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

test('invalid token counts fail loudly instead of producing a corrupt cost', () => {
  assert.throws(() => estimate('gpt-5.6-sol', Date.now(), { inputTokens: -1 }), /invalid inputTokens/);
});
