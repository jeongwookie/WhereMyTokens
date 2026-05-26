import test from 'node:test';
import assert from 'node:assert/strict';

import storeModule from '../dist/main/usageLedgerStore.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { UsageLedgerStore } = storeModule;
const { emptyUsageLedgerSnapshot, emptyUsageAggregate, minuteKey } = aggregates;

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
  assert.equal(snapshot.schemaVersion, 1);
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
