import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAntigravityModelQuotas } from '../dist/main/providers/antigravity/quota.js';

test('Antigravity quota parser converts finite remaining fractions without credits or model source', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const models = parseAntigravityModelQuotas([
    {
      label: 'Gemini 3 Pro',
      modelOrAlias: { model: 'MODEL_GEMINI_3_PRO' },
      quotaInfo: { remainingFraction: 0.7, resetTime: '2026-06-01T01:00:00.000Z' },
    },
    {
      label: 'Claude Opus',
      modelOrAlias: { model: 'MODEL_CLAUDE_OPUS' },
      quotaInfo: { remainingFraction: 0.25, resetTime: Math.floor((now + 2 * 60 * 60 * 1000) / 1000) },
    },
    {
      label: 'Other Model',
      modelOrAlias: { model: 'MODEL_OTHER' },
      quotaInfo: { resetTime: now + 3 * 60 * 60 * 1000 },
    },
  ], now);

  assert.equal(models[0].remainingPct, 70);
  assert.equal(models[0].resetMs, 60 * 60 * 1000);
  assert.equal(models[0].visualKind, 'percentOnly');
  assert.equal(models[0].durationMs, undefined);
  assert.equal(models[0].defaultMode, 'simple');
  assert.equal(models[0].hideCost, false);
  assert.equal(models[0].usageModel, 'Gemini 3 Pro');
  assert.equal(models[1].remainingPct, 25);
  assert.equal(models[1].resetMs, 2 * 60 * 60 * 1000);
  assert.equal(models[1].visualKind, 'percentOnly');
  assert.equal(models[1].durationMs, undefined);
  assert.equal(models[1].defaultMode, 'simple');
  assert.equal(models[1].hideCost, false);
  assert.equal(models[1].usageModel, 'Claude Opus');
  assert.equal(models.length, 2);
  assert.equal('source' in models[0], false);
  assert.equal('credits' in models[0], false);
});

test('Antigravity quota parser does not infer a quota duration from reset time alone', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const [model] = parseAntigravityModelQuotas([
    {
      label: 'Gemini 3 Pro',
      modelOrAlias: { model: 'MODEL_GEMINI_3_PRO' },
      quotaInfo: { remainingFraction: 0.5, resetTime: now + 6 * 60 * 60 * 1000 },
    },
  ], now);

  assert.equal(model.resetMs, 6 * 60 * 60 * 1000);
  assert.equal(model.visualKind, 'percentOnly');
  assert.equal(model.durationMs, undefined);
});
