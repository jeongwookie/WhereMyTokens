import test from 'node:test';
import assert from 'node:assert/strict';

import storeModule from '../dist/main/usageLedgerStore.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';
import types from '../dist/main/usageLedgerTypes.js';

const { UsageLedgerStore } = storeModule;
const { emptyUsageLedgerSnapshot, emptyUsageAggregate, minuteKey } = aggregates;
const { USAGE_LEDGER_SCHEMA_VERSION } = types;
const EXPECTED_SCHEMA_VERSION = USAGE_LEDGER_SCHEMA_VERSION;

function validBreakdownDelta(overrides = {}) {
  return {
    thinking: 10,
    response: 20,
    toolOutputRead: 0,
    toolOutputEditWrite: 0,
    toolOutputSearch: 0,
    toolOutputGit: 0,
    toolOutputBuildTest: 0,
    toolOutputTerminal: 0,
    toolOutputSubagents: 0,
    toolOutputWeb: 0,
    read: 1,
    editWrite: 2,
    search: 3,
    git: 4,
    buildTest: 5,
    terminal: 6,
    subagents: 7,
    web: 8,
    ...overrides,
  };
}

function validDailyBreakdownRow(firstSeenDate = '2026-06-15', overrides = {}) {
  return {
    ...validBreakdownDelta(overrides),
    firstSeenDate,
  };
}

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

test('usage ledger store hard-cuts dirty daily breakdown rows on load', () => {
  const fake = new FakeStore();
  fake.state.ledger = {
    ...emptyUsageLedgerSnapshot(),
    dailyBreakdown: {
      '2026-06-15|claude': {
        ...validDailyBreakdownRow(),
        read: -1,
      },
    },
  };

  const snapshot = new UsageLedgerStore(fake).getSnapshot();
  assert.deepEqual(snapshot, emptyUsageLedgerSnapshot());
});

test('usage ledger store hard-cuts dirty daily model keys on load', () => {
  const fake = new FakeStore();
  fake.state.ledger = {
    ...emptyUsageLedgerSnapshot(),
    dailyModel: {
      '2026-06-15|bogus|model': emptyUsageAggregate(),
    },
  };

  const snapshot = new UsageLedgerStore(fake).getSnapshot();
  assert.deepEqual(snapshot, emptyUsageLedgerSnapshot());
});

test('usage ledger store hard-cuts dirty daily breakdown keys on load', () => {
  const fake = new FakeStore();
  fake.state.ledger = {
    ...emptyUsageLedgerSnapshot(),
    dailyBreakdown: {
      '2026-06-15|bogus': validDailyBreakdownRow(),
    },
  };

  const snapshot = new UsageLedgerStore(fake).getSnapshot();
  assert.deepEqual(snapshot, emptyUsageLedgerSnapshot());
});

test('usage ledger store hard-cuts v5 daily breakdown rows with negative tool output on load', () => {
  const fake = new FakeStore();
  fake.state.ledger = {
    ...emptyUsageLedgerSnapshot(),
    dailyBreakdown: {
      '2026-06-15|claude': validDailyBreakdownRow('2026-06-15', { toolOutputRead: -1 }),
    },
    minuteRecent: {
      [minuteKey(Date.parse('2026-06-15T10:00:00Z'), 'claude', 'sonnet')]: emptyUsageAggregate(),
    },
  };

  const snapshot = new UsageLedgerStore(fake).getSnapshot();
  assert.deepEqual(snapshot, emptyUsageLedgerSnapshot());
});

test('usage ledger store hard-cuts v5 daily breakdown rows missing a tool output field on load', () => {
  const fake = new FakeStore();
  const dirtyRow = validDailyBreakdownRow();
  delete dirtyRow.toolOutputEditWrite;
  fake.state.ledger = {
    ...emptyUsageLedgerSnapshot(),
    dailyBreakdown: {
      '2026-06-15|claude': dirtyRow,
    },
    minuteRecent: {
      [minuteKey(Date.parse('2026-06-15T10:00:00Z'), 'claude', 'sonnet')]: emptyUsageAggregate(),
    },
  };

  const snapshot = new UsageLedgerStore(fake).getSnapshot();
  assert.deepEqual(snapshot, emptyUsageLedgerSnapshot());
});

test('usage ledger store hard-cuts dirty recent breakdown index deltas on load', () => {
  const fake = new FakeStore();
  const dirtyDelta = validBreakdownDelta();
  delete dirtyDelta.toolOutputEditWrite;
  fake.state.ledger = {
    ...emptyUsageLedgerSnapshot(),
    minuteRecent: {
      [minuteKey(Date.parse('2026-06-15T10:00:00Z'), 'claude', 'sonnet')]: emptyUsageAggregate(),
    },
    recentBreakdownIndex: {
      'source|request': {
        dailyBreakdownKey: '2026-06-15|claude',
        delta: dirtyDelta,
      },
    },
  };

  const snapshot = new UsageLedgerStore(fake).getSnapshot();
  assert.deepEqual(snapshot, emptyUsageLedgerSnapshot());
});

test('usage ledger store resets the whole snapshot for v4 persisted ledgers', () => {
  const fake = new FakeStore();
  fake.state.ledger = {
    ...emptyUsageLedgerSnapshot(),
    schemaVersion: 4,
    minuteRecent: {
      [minuteKey(Date.parse('2026-06-15T10:00:00Z'), 'claude', 'sonnet')]: emptyUsageAggregate(),
    },
    dailyBreakdown: {
      '2026-06-15|claude': validDailyBreakdownRow(),
    },
    recentBreakdownIndex: {
      'source|request': {
        dailyBreakdownKey: '2026-06-15|claude',
        delta: validBreakdownDelta(),
      },
    },
    breakdownStartedDate: '2026-06-15',
  };

  const snapshot = new UsageLedgerStore(fake).getSnapshot();
  assert.deepEqual(snapshot, emptyUsageLedgerSnapshot());
});

test('usage ledger store hard-cuts a malformed breakdownStartedDate on load', () => {
  const fake = new FakeStore();
  fake.state.ledger = {
    ...emptyUsageLedgerSnapshot(),
    breakdownStartedDate: '2026/06/15', // not YYYY-MM-DD
  };

  const snapshot = new UsageLedgerStore(fake).getSnapshot();
  assert.deepEqual(snapshot, emptyUsageLedgerSnapshot());
});

test('usage ledger store round-trips valid daily breakdown fields', () => {
  const fake = new FakeStore();
  const store = new UsageLedgerStore(fake);
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.dailyBreakdown['2026-06-15|claude'] = validDailyBreakdownRow();
  snapshot.breakdownStartedDate = '2026-06-15';

  store.replaceSnapshot(snapshot);
  const reloaded = new UsageLedgerStore(fake).getSnapshot();

  assert.deepEqual(reloaded.dailyBreakdown, snapshot.dailyBreakdown);
  assert.equal(reloaded.breakdownStartedDate, '2026-06-15');
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

test('usage ledger store preserves generic provider checkpoints without file offsets', () => {
  const fake = new FakeStore();
  fake.state.ledger = {
    ...emptyUsageLedgerSnapshot(),
    sourceCheckpoints: {
      source: {
        provider: 'antigravity',
        sourceHash: 'source',
        sourceKey: 'antigravity:cascade:cascade-1',
        cursor: 'step-12',
        lastImportedAt: 30,
        hasUsage: true,
      },
    },
  };

  const checkpoint = new UsageLedgerStore(fake).getSnapshot().sourceCheckpoints.source;
  assert.ok(checkpoint);
  assert.equal(checkpoint.provider, 'antigravity');
  assert.equal(checkpoint.sourceKey, 'antigravity:cascade:cascade-1');
  assert.equal(checkpoint.cursor, 'step-12');
  assert.equal('byteOffset' in checkpoint, false);
});
