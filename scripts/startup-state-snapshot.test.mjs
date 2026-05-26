import test from 'node:test';
import assert from 'node:assert/strict';

import snapshotModule from '../dist/main/startupStateSnapshot.js';
import stateManagerModule from '../dist/main/stateManager.js';

const {
  STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION,
  makeStartupStateSnapshot,
  normalizeStartupStateSnapshot,
} = snapshotModule;
const { StateManager } = stateManagerModule;

const BASE_STATE = {
  sessions: [],
  initialRefreshComplete: false,
  historyWarmupPending: false,
  historyWarmupStartsAt: null,
  lastUpdated: 0,
  stateFreshness: 'empty',
  codeOutputLoading: false,
  usage: { todayTokens: 0 },
  usageTrend: { daily: [], weekly: [], monthly: [] },
};

function makeStore(values = {}) {
  return {
    store: {},
    get(key, fallback = null) {
      return key in values ? values[key] : fallback;
    },
    set(key, value) {
      values[key] = value;
    },
    delete(key) {
      delete values[key];
    },
  };
}

test('startup snapshot normalizer marks recent snapshots as restored UI state', () => {
  const now = 1_800_000;
  const snapshot = makeStartupStateSnapshot({
    ...BASE_STATE,
    initialRefreshComplete: true,
    historyWarmupPending: true,
    historyWarmupStartsAt: now - 30_000,
    stateFreshness: 'fresh',
    codeOutputLoading: true,
    lastUpdated: now - 10_000,
    usage: { todayTokens: 123 },
  }, now);

  const restored = normalizeStartupStateSnapshot(snapshot, BASE_STATE, now);

  assert.ok(restored);
  assert.equal(restored.initialRefreshComplete, true);
  assert.equal(restored.stateFreshness, 'restored');
  assert.equal(restored.historyWarmupPending, false);
  assert.equal(restored.historyWarmupStartsAt, null);
  assert.equal(restored.codeOutputLoading, false);
  assert.deepEqual(restored.usage, { todayTokens: 123 });
});

test('startup snapshot normalizer rejects stale and mismatched snapshots', () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const good = makeStartupStateSnapshot(BASE_STATE, 1_000);

  assert.equal(
    normalizeStartupStateSnapshot({ ...good, schemaVersion: STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION + 1 }, BASE_STATE, now),
    null,
  );
  assert.equal(normalizeStartupStateSnapshot(good, BASE_STATE, now), null);
  assert.equal(normalizeStartupStateSnapshot({ schemaVersion: STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION, savedAt: now }, BASE_STATE, now), null);
});

test('StateManager revives restored snapshot session dates before watcher sorting', () => {
  const startedAt = '2026-05-26T00:00:00.000Z';
  const lastModified = '2026-05-26T00:10:00.000Z';
  const snapshot = makeStartupStateSnapshot({
    ...BASE_STATE,
    sessions: [{
      provider: 'claude',
      pid: null,
      sessionId: 'restored-session',
      cwd: 'D:\\Git\\wheremytokens-ledger',
      projectName: 'wheremytokens-ledger',
      startedAt,
      entrypoint: 'cli',
      source: 'Terminal',
      state: 'waiting',
      jsonlPath: 'D:\\Temp\\restored-session.jsonl',
      lastModified,
      modelName: '',
      contextUsed: 0,
      contextMax: 200000,
      toolCounts: {},
      gitStats: null,
      activityBreakdown: null,
      activityBreakdownKind: null,
      isWorktree: false,
      worktreeBranch: null,
      gitBranch: null,
      mainRepoName: null,
    }],
  }, Date.now());
  const manager = new StateManager(makeStore({ _startupStateSnapshot: snapshot }), () => {});

  const restored = manager.getState().sessions[0];
  assert.ok(restored.startedAt instanceof Date);
  assert.ok(restored.lastModified instanceof Date);
  assert.deepEqual(manager.collectTrackedSessionFiles('claude', 1), ['D:\\Temp\\restored-session.jsonl']);
});

test('StateManager keeps live settings when restoring a cached startup snapshot', () => {
  const snapshot = makeStartupStateSnapshot({
    ...BASE_STATE,
    settings: {
      provider: 'both',
      mainSectionOrder: ['planUsage', 'codeOutput', 'trend', 'sessions', 'activity', 'modelUsage'],
      hiddenMainSections: [],
    },
  }, Date.now());
  const store = makeStore({ _startupStateSnapshot: snapshot });
  store.store = {
    provider: 'both',
    mainSectionOrder: ['planUsage', 'codeOutput', 'trend', 'sessions', 'activity', 'modelUsage'],
    hiddenMainSections: ['codeOutput', 'modelUsage'],
  };

  const manager = new StateManager(store, () => {});

  assert.deepEqual(manager.getState().settings.hiddenMainSections, ['codeOutput', 'modelUsage']);
});
