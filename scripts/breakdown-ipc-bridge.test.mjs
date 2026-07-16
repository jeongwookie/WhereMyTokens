import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import sm from '../dist/main/stateManager.js';
import ipc from '../dist/main/ipc.js';

const { currentLedgerRepoKeys } = sm;
const { registerIpcHandlers } = ipc;

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
