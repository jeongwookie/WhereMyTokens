import test from 'node:test';
import assert from 'node:assert/strict';

import * as gmParser from '../dist/main/providers/antigravity/gmParser.js';
import { antigravityUsageEntryFromCall } from '../dist/main/providers/antigravity/summary.js';
import {
  estimateAntigravityCacheSavingsUSD,
  estimateAntigravityCostUSD,
  resolveAntigravityPrice,
  resolveAntigravityPriceForModel,
} from '../dist/main/providers/antigravity/pricing.js';

const { parseAntigravityGmEntry, activityBreakdownFromCalls } = gmParser;

test('Antigravity GM parser extracts token fields, model labels, fallback output, and tool names', () => {
  const fallbackMs = Date.parse('2026-06-01T12:00:00.000Z');
  const call = parseAntigravityGmEntry('cascade-1', {
    executionId: 'exec-1',
    chatModel: {
      responseModel: 'MODEL_GEMINI_3_PRO',
      usage: {
        inputTokens: 100,
        thinkingOutputTokens: 20,
        responseOutputTokens: 30,
        cacheReadTokens: 40,
        cacheCreationTokens: 10,
      },
      tools: [{ name: 'grep_search' }],
      messagePrompts: [{ toolCalls: [{ name: 'edit_file' }] }],
    },
    plannerConfig: { truncationThresholdTokens: 1_000_000 },
  }, fallbackMs, new Map([['MODEL_GEMINI_3_PRO', 'Gemini 3 Pro']]));

  assert.equal(call.requestId, undefined);
  assert.equal(call.executionId, 'exec-1');
  assert.equal(call.model, 'Gemini 3 Pro');
  assert.equal(call.rawModel, 'MODEL_GEMINI_3_PRO');
  assert.equal(call.inputTokens, 100);
  assert.equal(call.outputTokens, 50);
  assert.equal(call.cacheReadTokens, 40);
  assert.equal(call.cacheCreationTokens, 10);
  assert.deepEqual(call.toolNames.sort(), ['edit_file', 'grep_search']);
  assert.equal(call.contextMax, 1_000_000);
});

test('Antigravity GM parser preserves configured model labels to keep variants distinct', () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const flash = parseAntigravityGmEntry('cascade-1', {
    executionId: 'flash',
    chatModel: {
      responseModel: 'MODEL_GEMINI_3_FLASH',
      usage: { inputTokens: 10 },
    },
  }, nowMs, new Map([['MODEL_GEMINI_3_FLASH', 'Gemini 3 Flash']]));
  const flashLite = parseAntigravityGmEntry('cascade-1', {
    executionId: 'flash-lite',
    chatModel: {
      responseModel: 'MODEL_GEMINI_3_1_FLASH_LITE',
      usage: { inputTokens: 10 },
    },
  }, nowMs, new Map([['MODEL_GEMINI_3_1_FLASH_LITE', 'Gemini 3.1 Flash Lite']]));

  assert.equal(flash.model, 'Gemini 3 Flash');
  assert.equal(flashLite.model, 'Gemini 3.1 Flash Lite');
});

test('Antigravity GM parser prefers quota model id over response alias for stats matching', () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const call = parseAntigravityGmEntry('cascade-1', {
    executionId: 'quota-model',
    chatModel: {
      responseModel: 'gemini-pro-default',
      model: 'MODEL_PLACEHOLDER_M16',
      usage: {
        model: 'MODEL_PLACEHOLDER_M16',
        inputTokens: '18808',
        outputTokens: '631',
      },
    },
  }, nowMs, new Map([['MODEL_PLACEHOLDER_M16', 'Gemini 3.1 Pro (High)']]));

  assert.equal(call.model, 'Gemini 3.1 Pro (High)');
  assert.match(call.rawModel, /MODEL_PLACEHOLDER_M16/);
  assert.match(call.rawModel, /gemini-pro-default/);
});

test('Antigravity GM parser skips entries without token fields and usage entries carry estimated cost', () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const empty = parseAntigravityGmEntry('cascade-1', { chatModel: { usage: {} } }, nowMs);
  const call = parseAntigravityGmEntry('cascade-1', {
    executionId: 'exec-2',
    chatModel: {
      model: 'MODEL_CLAUDE_OPUS',
      usage: { inputTokens: 10, outputTokens: 5 },
      messagePrompts: [{ toolCalls: [{ name: 'terminal_command' }] }],
    },
  }, nowMs, new Map([['MODEL_CLAUDE_OPUS', 'Claude Opus']]));
  const entry = antigravityUsageEntryFromCall(call);
  const activity = activityBreakdownFromCalls([call]);

  assert.equal(empty, null);
  assert.equal(entry.provider, 'antigravity');
  assert.equal(entry.costUSD, 0.000175);
  assert.equal(entry.cacheSavingsUSD, 0);
  assert.equal(activity.terminal, 1);
});

test('Antigravity pricing estimates Gemini threshold costs and cache savings', () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const belowThreshold = parseAntigravityGmEntry('cascade-1', {
    executionId: 'gemini-small',
    chatModel: {
      responseModel: 'MODEL_GEMINI_3_PRO',
      usage: { inputTokens: 1_000, outputTokens: 500, cacheCreationTokens: 200, cacheReadTokens: 100 },
    },
  }, nowMs, new Map([['MODEL_GEMINI_3_PRO', 'Gemini 3 Pro']]));
  const aboveThreshold = parseAntigravityGmEntry('cascade-1', {
    executionId: 'gemini-large',
    chatModel: {
      responseModel: 'MODEL_GEMINI_3_PRO',
      usage: { inputTokens: 200_001, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 },
    },
  }, nowMs, new Map([['MODEL_GEMINI_3_PRO', 'Gemini 3 Pro']]));

  assert.equal(resolveAntigravityPrice(belowThreshold).in, 2);
  assert.equal(estimateAntigravityCostUSD(belowThreshold), 0.00842);
  assert.equal(estimateAntigravityCacheSavingsUSD(belowThreshold), 0.00018);
  assert.equal(resolveAntigravityPrice(aboveThreshold).in, 4);
  assert.deepEqual(resolveAntigravityPriceForModel('Gemini 3.1 Flash Image'), {
    in: 0.50,
    out: 3.00,
    cw: 0.50,
    cr: 0.50,
  });
});

test('Antigravity GM helpers keep repeated execution ids distinct by step indices', () => {
  const first = {
    cascadeId: 'c1',
    executionId: 'same-exec',
    stepIndices: [4, 5],
    timestampMs: Date.parse('2026-06-01T10:00:00.000Z'),
    model: 'Gemini 3 Pro',
    rawModel: 'MODEL_GEMINI_3_PRO',
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    responseTokens: 5,
    toolNames: [],
  };
  const second = { ...first, stepIndices: [8, 9], inputTokens: 20, outputTokens: 7 };

  assert.notEqual(gmParser.antigravityCallKey(first), gmParser.antigravityCallKey(second));
  const merged = gmParser.mergeAntigravityCalls([first], [second]);
  assert.equal(merged.length, 2);
  assert.equal(merged.reduce((sum, call) => sum + call.inputTokens, 0), 30);
});

test('Antigravity GM helpers replace a matching call with richer token data', () => {
  const light = {
    cascadeId: 'c1',
    executionId: 'exec-1',
    stepIndices: [1],
    timestampMs: Date.parse('2026-06-01T10:00:00.000Z'),
    model: 'Gemini 3 Pro',
    rawModel: 'MODEL_GEMINI_3_PRO',
    inputTokens: 10,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    responseTokens: 1,
    toolNames: [],
  };
  const rich = { ...light, inputTokens: 100, outputTokens: 7, cacheReadTokens: 50 };

  const merged = gmParser.mergeAntigravityCalls([light], [rich]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].inputTokens, 100);
  assert.equal(merged[0].cacheReadTokens, 50);
});

test('Antigravity GM helpers request enrichment for placeholder and large cascades', () => {
  const parsedCall = {
    cascadeId: 'c1',
    executionId: 'exec-1',
    stepIndices: [1],
    timestampMs: Date.parse('2026-06-01T10:00:00.000Z'),
    model: 'antigravity',
    rawModel: 'antigravity',
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    responseTokens: 1,
    toolNames: [],
  };

  assert.equal(gmParser.shouldEnrichForTokens({
    stepCount: 10,
    rawGm: [{ chatModel: {} }],
    calls: [parsedCall],
  }), true);
  assert.equal(gmParser.shouldEnrichForTokens({
    stepCount: 350,
    rawGm: [{ chatModel: { responseModel: 'MODEL_GEMINI_3_PRO' } }],
    calls: [parsedCall],
  }), true);
});
