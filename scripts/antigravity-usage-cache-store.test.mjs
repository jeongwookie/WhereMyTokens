import test from 'node:test';
import assert from 'node:assert/strict';

import storeModule from '../dist/main/providers/antigravity/usageCacheStore.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { AntigravityUsageCacheStore, emptyAntigravityUsageCacheSnapshot } = storeModule;
const { dayModelKey, monthModelKey } = aggregates;

function memoryStore(initial) {
  let value = initial;
  return {
    get(key) {
      assert.equal(key, 'cache');
      return value;
    },
    set(key, next) {
      assert.equal(key, 'cache');
      value = next;
    },
  };
}

function call(overrides = {}) {
  return {
    cascadeId: 'cascade-1',
    executionId: 'exec-1',
    stepIndices: [1],
    timestampMs: Date.parse('2026-06-01T10:00:00.000Z'),
    model: 'Gemini 3 Pro',
    rawModel: 'MODEL_GEMINI_3_PRO',
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationTokens: 5,
    cacheReadTokens: 50,
    thinkingTokens: 10,
    responseTokens: 10,
    toolNames: ['read_file'],
    ...overrides,
  };
}

test('Antigravity usage cache upserts calls and builds a provider ledger slice', () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const cache = new AntigravityUsageCacheStore(memoryStore(emptyAntigravityUsageCacheSnapshot()));

  cache.upsertCascade({
    cascadeId: 'cascade-1',
    title: 'Work',
    totalSteps: 4,
    status: 'CASCADE_RUN_STATUS_IDLE',
    lastModifiedMs: nowMs,
    fetchedAtMs: nowMs,
    calls: [call()],
  }, nowMs);

  const snapshot = cache.getSnapshot();
  const slice = cache.buildLedgerSlice(nowMs);

  assert.equal(Object.keys(snapshot.cascades).length, 1);
  assert.equal(Object.keys(snapshot.cascades['cascade-1'].calls).length, 1);
  assert.equal(slice.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].totalTokens, 175);
  assert.equal(slice.monthlyModel[monthModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].requestCount, 1);
});

test('Antigravity usage cache replaces a richer version of the same call', () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const cache = new AntigravityUsageCacheStore(memoryStore(emptyAntigravityUsageCacheSnapshot()));
  const base = call();
  const richer = call({ inputTokens: 200, outputTokens: 30 });

  cache.upsertCascade({
    cascadeId: 'cascade-1',
    title: 'Work',
    totalSteps: 4,
    status: 'CASCADE_RUN_STATUS_RUNNING',
    lastModifiedMs: nowMs,
    fetchedAtMs: nowMs,
    calls: [base],
  }, nowMs);
  cache.upsertCascade({
    cascadeId: 'cascade-1',
    title: 'Work',
    totalSteps: 4,
    status: 'CASCADE_RUN_STATUS_IDLE',
    lastModifiedMs: nowMs,
    fetchedAtMs: nowMs + 1000,
    calls: [richer],
  }, nowMs + 1000);

  const slice = cache.buildLedgerSlice(nowMs + 1000);
  assert.equal(slice.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].requestCount, 1);
  assert.equal(slice.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].inputTokens, 200);
  assert.equal(slice.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].outputTokens, 30);
});

test('Antigravity usage cache writes one ledger checkpoint per cascade', () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const cache = new AntigravityUsageCacheStore(memoryStore(emptyAntigravityUsageCacheSnapshot()));

  cache.upsertCascade({
    cascadeId: 'cascade-1',
    title: 'First',
    totalSteps: 4,
    status: 'CASCADE_RUN_STATUS_IDLE',
    lastModifiedMs: nowMs,
    fetchedAtMs: nowMs,
    calls: [call()],
  }, nowMs);
  cache.upsertCascade({
    cascadeId: 'cascade-2',
    title: 'Second',
    totalSteps: 5,
    status: 'CASCADE_RUN_STATUS_IDLE',
    lastModifiedMs: nowMs,
    fetchedAtMs: nowMs,
    calls: [call({ cascadeId: 'cascade-2', executionId: 'exec-2', stepIndices: [2] })],
  }, nowMs);

  const checkpoints = Object.values(cache.buildLedgerSlice(nowMs).sourceCheckpoints);
  assert.equal(checkpoints.length, 2);
  assert.deepEqual(checkpoints.map(checkpoint => checkpoint.sourceKey).sort(), [
    'antigravity:cascade:cascade-1',
    'antigravity:cascade:cascade-2',
  ]);
});

test('Antigravity usage cache normalizes invalid persisted shapes', () => {
  const cache = new AntigravityUsageCacheStore(memoryStore({ schemaVersion: 999, cascades: { broken: true } }));
  assert.deepEqual(cache.getSnapshot(), emptyAntigravityUsageCacheSnapshot());
});
