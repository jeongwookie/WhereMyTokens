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

const EMPTY_WINDOW = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  costUSD: 0,
  requestCount: 0,
  cacheEfficiency: 0,
  cacheSavingsUSD: 0,
};

const EMPTY_USAGE = {
  byProvider: {
    claude: {
      windows: { h5: EMPTY_WINDOW, week: EMPTY_WINDOW, sonnetWeek: EMPTY_WINDOW },
      burnRate: { h5OutputPerMin: 0, h5EtaMs: null, weekEtaMs: null },
    },
    codex: { windows: { h5: EMPTY_WINDOW, week: EMPTY_WINDOW } },
  },
  models: [],
  heatmap: [],
  heatmap30: [],
  heatmap90: [],
  weeklyTimeline: [],
  todayTokens: 0,
  todayCost: 0,
  todayRequestCount: 0,
  todayInputTokens: 0,
  todayOutputTokens: 0,
  todayCacheTokens: 0,
  todayCacheSavingsUSD: 0,
  todayCacheEfficiency: 0,
  allTimeRequestCount: 0,
  allTimeCost: 0,
  allTimeCacheTokens: 0,
  allTimeInputTokens: 0,
  allTimeOutputTokens: 0,
  allTimeSavedUSD: 0,
  allTimeAvgCacheEfficiency: 0,
  todBuckets: [],
};

const BASE_STATE = {
  sessions: [],
  initialRefreshComplete: false,
  historyWarmupPending: false,
  historyWarmupStartsAt: null,
  lastUpdated: 0,
  stateFreshness: 'empty',
  codeOutputLoading: false,
  usage: EMPTY_USAGE,
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
  const usage = { ...EMPTY_USAGE, todayTokens: 123 };
  const snapshot = makeStartupStateSnapshot({
    ...BASE_STATE,
    initialRefreshComplete: true,
    historyWarmupPending: true,
    historyWarmupStartsAt: now - 30_000,
    stateFreshness: 'fresh',
    codeOutputLoading: true,
    lastUpdated: now - 10_000,
    usage,
  }, now);

  const restored = normalizeStartupStateSnapshot(snapshot, BASE_STATE, now);

  assert.ok(restored);
  assert.equal(restored.initialRefreshComplete, true);
  assert.equal(restored.stateFreshness, 'restored');
  assert.equal(restored.historyWarmupPending, false);
  assert.equal(restored.historyWarmupStartsAt, null);
  assert.equal(restored.codeOutputLoading, false);
  assert.deepEqual(restored.usage, usage);
});

test('startup snapshot schema version is bumped for provider-keyed usage data', () => {
  assert.equal(STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION, 3);
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

test('StateManager revives restored snapshot session dates without persisted local paths', () => {
  const startedAt = '2026-05-26T00:00:00.000Z';
  const lastModified = '2026-05-26T00:10:00.000Z';
  const snapshot = makeStartupStateSnapshot({
    ...BASE_STATE,
    sessions: [{
      provider: 'claude',
      pid: null,
      sessionId: 'restored-session',
      cwd: 'C:\\Users\\example\\my-project',
      projectName: 'my-project',
      startedAt,
      entrypoint: 'cli',
      source: 'Terminal',
      state: 'waiting',
      jsonlPath: 'C:\\Users\\example\\AppData\\Local\\my-app\\restored-session.jsonl',
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
  assert.equal(restored.cwd, '');
  assert.equal(restored.projectName, 'Previous session');
  assert.equal(restored.jsonlPath, null);
  assert.deepEqual(manager.collectTrackedSessionFiles('claude', 1), []);
});

test('startup snapshot normalizer rejects malformed session lists', () => {
  const now = Date.now();
  const snapshot = {
    schemaVersion: STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION,
    savedAt: now,
    state: {
      ...BASE_STATE,
      sessions: { bad: true },
    },
  };

  assert.equal(normalizeStartupStateSnapshot(snapshot, BASE_STATE, now), null);
});

test('startup snapshot normalizer sanitizes schema-valid persisted sessions', () => {
  const now = Date.now();
  const snapshot = {
    schemaVersion: STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION,
    savedAt: now,
    state: {
      ...BASE_STATE,
      sessions: [{
        cwd: 'C:\\Users\\example\\my-project',
        projectName: 'my-project',
        jsonlPath: 'C:\\Users\\example\\AppData\\Local\\my-app\\session.jsonl',
        gitStats: { toplevel: 'C:\\Users\\example\\my-project' },
      }],
      repoGitStats: {
        repo: { toplevel: 'C:\\Users\\example\\my-project' },
      },
      settings: { enabledProviders: ['codex'] },
    },
  };

  const restored = normalizeStartupStateSnapshot(snapshot, BASE_STATE, now);
  assert.ok(restored);
  assert.equal(restored.sessions[0].cwd, '');
  assert.equal(restored.sessions[0].projectName, 'Previous session');
  assert.equal(restored.sessions[0].jsonlPath, null);
  assert.deepEqual(restored.sessions[0].gitStats, null);
  assert.deepEqual(restored.repoGitStats, {});
  assert.equal('settings' in restored, false);
});

test('startup snapshot normalizer rejects legacy snapshot schema', () => {
  const now = Date.now();
  const snapshot = makeStartupStateSnapshot(BASE_STATE, now);

  assert.equal(
    normalizeStartupStateSnapshot({ ...snapshot, schemaVersion: STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION - 1 }, BASE_STATE, now),
    null,
  );
  assert.equal(
    normalizeStartupStateSnapshot({ ...snapshot, schemaVersion: 2 }, BASE_STATE, now),
    null,
  );
});

test('StateManager keeps live settings when restoring a cached startup snapshot', () => {
  const snapshot = makeStartupStateSnapshot({
    ...BASE_STATE,
    settings: {
      enabledProviders: ['claude', 'codex'],
      mainSectionOrder: ['planUsage', 'codeOutput', 'trend', 'sessions', 'activity', 'modelUsage'],
      hiddenMainSections: [],
    },
  }, Date.now());
  const store = makeStore({ _startupStateSnapshot: snapshot });
  store.store = {
    enabledProviders: ['claude', 'codex'],
    mainSectionOrder: ['planUsage', 'codeOutput', 'trend', 'sessions', 'activity', 'modelUsage'],
    hiddenMainSections: ['codeOutput', 'modelUsage'],
  };

  const manager = new StateManager(store, () => {});

  assert.deepEqual(manager.getState().settings.hiddenMainSections, ['codeOutput', 'modelUsage']);
});
