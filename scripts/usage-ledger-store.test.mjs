import test from 'node:test';
import assert from 'node:assert/strict';

import storeModule from '../dist/main/usageLedgerStore.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { UsageLedgerStore } = storeModule;
const { emptyUsageLedgerSnapshot, emptyUsageAggregate, minuteKey } = aggregates;
const EXPECTED_SCHEMA_VERSION = 2;

class FakeStore {
  constructor() {
    this.state = {};
  }
  get(key) {
    return this.state[key];
  }
  set(key, value) {
    this.state[key] = value;
  }
}

test('usage ledger store returns an initialized snapshot', () => {
  const store = new UsageLedgerStore(new FakeStore());
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.schemaVersion, EXPECTED_SCHEMA_VERSION);
  assert.deepEqual(snapshot.minuteRecent, {});
});

test('usage ledger store drops incompatible old schema snapshots', () => {
  const fake = new FakeStore();
  fake.state.ledger = {
    ...emptyUsageLedgerSnapshot(),
    schemaVersion: EXPECTED_SCHEMA_VERSION - 1,
    minuteRecent: {
      [minuteKey(Date.parse('2026-05-25T10:00:00Z'), 'claude', 'old')]: emptyUsageAggregate(),
    },
  };

  const snapshot = new UsageLedgerStore(fake).getSnapshot();
  assert.equal(snapshot.schemaVersion, EXPECTED_SCHEMA_VERSION);
  assert.deepEqual(snapshot.minuteRecent, {});
});

test('usage ledger store persists replaced snapshots', () => {
  const fake = new FakeStore();
  const store = new UsageLedgerStore(fake);
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(Date.parse('2026-05-25T10:00:00Z'), 'claude', 'sonnet')] = emptyUsageAggregate();
  store.replaceSnapshot(snapshot);
  const reloaded = new UsageLedgerStore(fake).getSnapshot();
  assert.equal(Object.keys(reloaded.minuteRecent).length, 1);
});

test('usage ledger store reset clears persisted ledger', () => {
  const fake = new FakeStore();
  const store = new UsageLedgerStore(fake);
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(Date.now(), 'codex', 'GPT-5-CODEX')] = emptyUsageAggregate();
  store.replaceSnapshot(snapshot);
  store.reset();
  assert.deepEqual(store.getSnapshot().minuteRecent, {});
});

test('usage ledger store drops path-bearing checkpoint fields', () => {
  const fake = new FakeStore();
  fake.state.ledger = {
    ...emptyUsageLedgerSnapshot(),
    sourceCheckpoints: {
      source: {
        provider: 'claude',
        sourceHash: 'source',
        sourceIdentity: 'claude:C:\\Users\\example\\history.jsonl',
        normalizedPath: 'C:\\Users\\example\\history.jsonl',
        size: 10,
        mtimeMs: 20,
        byteOffset: 10,
        lastImportedAt: 30,
        hasUsage: true,
      },
    },
  };

  const checkpoint = new UsageLedgerStore(fake).getSnapshot().sourceCheckpoints.source;
  assert.ok(checkpoint);
  assert.equal('sourceIdentity' in checkpoint, false);
  assert.equal('normalizedPath' in checkpoint, false);
});
