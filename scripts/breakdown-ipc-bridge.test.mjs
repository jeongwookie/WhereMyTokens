import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import sm from '../dist/main/stateManager.js';
import gol from '../dist/main/gitOutputLedger.js';
import ipc from '../dist/main/ipc.js';
import types from '../dist/shared/breakdownTypes.js';
import agg from '../dist/main/usageLedgerAggregates.js';
import vf from '../dist/main/usageVisibilityFilter.js';

// Task 9a test approach: StateManager construction pulls in Electron stores,
// watchers, and provider runtime setup, so these tests exercise the exported
// pure helpers that StateManager delegates to: currentLedgerRepoKeys and
// buildBreakdown. Task 9b will add the IPC registration test separately.
const { currentLedgerRepoKeys, buildBreakdown } = sm;
const { emptyGitOutputLedgerSnapshot, mergeGitDailyOutput } = gol;
const { registerIpcHandlers } = ipc;
const { emptyNetLinesByCategory } = types;
const { emptyDailyBreakdownRow, emptyUsageAggregate } = agg;
const { buildUsageVisibilityFilter } = vf;

function normalizedKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function gitStats(gitCommonDir, toplevel) {
  return {
    gitCommonDir,
    toplevel,
    commitsToday: 0,
    linesAdded: 0,
    linesRemoved: 0,
    totalCommits: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
  };
}

function breakdownRow(overrides = {}) {
  return {
    ...emptyDailyBreakdownRow('2026-06-10'),
    thinking: 12,
    response: 34,
    read: 1,
    terminal: 2,
    ...overrides,
  };
}

function usageAggregate(overrides = {}) {
  return { ...emptyUsageAggregate(), ...overrides };
}

function categoryLines(category, added, removed = 0) {
  const out = emptyNetLinesByCategory();
  out[category] = { added, removed };
  return out;
}

test('currentLedgerRepoKeys returns exactly current-session repo keys', () => {
  const repoAGit = 'D:\\Repos\\repo-a\\.git';
  const repoATop = 'D:\\Repos\\repo-a';
  const repoBGit = 'D:\\Repos\\repo-b\\.git';
  const repoBTop = 'D:\\Repos\\repo-b';
  const sessions = [{ cwd: 'D:\\Repos\\repo-a\\src', gitStats: null }];
  const repoGitStats = {
    [repoAGit]: gitStats(repoAGit, repoATop),
    [repoBGit]: gitStats(repoBGit, repoBTop),
  };

  assert.deepEqual(currentLedgerRepoKeys(sessions, repoGitStats), [normalizedKey(repoAGit)]);
});

test('buildBreakdown scopes git net lines while preserving usage providers and partial date', () => {
  const repoA = 'D:\\Repos\\repo-a\\.git';
  const repoB = 'D:\\Repos\\repo-b\\.git';
  const usage = {
    dailyBreakdown: {
      '2026-06-10|claude': breakdownRow(),
    },
    dailyModel: {
      '2026-06-10|claude|Sonnet': usageAggregate({ inputTokens: 10, outputTokens: 46 }),
    },
    breakdownStartedDate: '2026-06-10',
  };
  const git = emptyGitOutputLedgerSnapshot();
  mergeGitDailyOutput(git, normalizedKey(repoA), [{
    date: '2026-06-10',
    commits: 1,
    added: 10,
    removed: 3,
    byCategory: categoryLines('product_code', 10, 3),
  }]);
  mergeGitDailyOutput(git, normalizedKey(repoB), [{
    date: '2026-06-10',
    commits: 1,
    added: 99,
    removed: 7,
    byCategory: categoryLines('product_code', 99, 7),
  }]);

  const result = buildBreakdown(
    usage,
    git,
    [normalizedKey(repoA)],
    usage.breakdownStartedDate,
    'week',
    '2026-06-08',
    buildUsageVisibilityFilter({ enabledProviders: ['claude', 'codex', 'antigravity'] }),
  );

  assert.deepEqual(result.providers.map(provider => provider.provider), ['claude']);
  assert.equal(result.providers[0].input, 10);
  assert.equal(result.providers[0].output.thinking, 12);
  assert.equal(result.providers[0].output.response, 34);
  assert.equal(result.providers[0].thinkingExact, false);
  assert.equal(result.providers[0].tools.read, 1);
  assert.equal(result.providers[0].tools.terminal, 2);
  assert.equal(result.providers[0].firstSeenDate, '2026-06-10');
  assert.equal(result.partialSinceDate, '2026-06-10');
  assert.equal(result.netLines.product_code.added, 10);
  assert.equal(result.netLines.product_code.removed, 3);
});

test('registerIpcHandlers wires breakdown:get to invoke through', async () => {
  const handlers = new Map();
  const fakeIpc = {
    handle: (channel, fn) => {
      handlers.set(channel, fn);
    },
  };
  const calls = [];
  const expected = { grain: 'week', bucketKey: '2026-06-08', providers: [], netLines: null };
  const getBreakdown = async (grain, bucketKey) => {
    calls.push([grain, bucketKey]);
    return expected;
  };

  registerIpcHandlers({
    ipcMain: fakeIpc,
    store: { store: {} },
    getState: () => ({}),
    forceRefresh: async () => {},
    applySettingsChange: () => {},
    getBreakdown,
  });

  const result = await handlers.get('breakdown:get')(null, 'week', '2026-06-08');

  assert.deepEqual(calls, [['week', '2026-06-08']]);
  assert.equal(result, expected);
});

test('registerIpcHandlers rejects invalid breakdown:get payloads', async () => {
  const handlers = new Map();
  const fakeIpc = {
    handle: (channel, fn) => {
      handlers.set(channel, fn);
    },
  };

  registerIpcHandlers({
    ipcMain: fakeIpc,
    store: { store: {} },
    getState: () => ({}),
    forceRefresh: async () => {},
    applySettingsChange: () => {},
    getBreakdown: async () => ({ grain: 'day', bucketKey: '2026-06-08', providers: [], netLines: null }),
  });

  await assert.rejects(
    () => handlers.get('breakdown:get')(null, 'wek', '2026-06-08'),
    /invalid breakdown request/,
  );
  await assert.rejects(
    () => handlers.get('breakdown:get')(null, 'month', '2026-99'),
    /invalid breakdown request/,
  );
});
