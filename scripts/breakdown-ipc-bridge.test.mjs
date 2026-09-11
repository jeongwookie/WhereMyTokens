import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import ledger from '../dist/main/gitOutputLedger.js';
import ipc from '../dist/main/ipc.js';

const { emptyGitOutputLedgerSnapshot, mergeGitDailyOutput, trackedGitScope, buildCodeOutputFromGitLedger, hasCommitsInRange, buildCategoryNetLines } = ledger;
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

test('persistent Git scope preserves historical repos and selected-empty returns zero everywhere', () => {
  const snapshot = emptyGitOutputLedgerSnapshot();
  mergeGitDailyOutput(snapshot, path.resolve('repo-a/.git'), [{ date: '2026-06-08', added: 100, removed: 10, commits: 1, byCategory: {} }]);
  mergeGitDailyOutput(snapshot, path.resolve('repo-b/.git'), [{ date: '2026-06-08', added: 200, removed: 20, commits: 2, byCategory: {} }]);
  assert.equal(buildCodeOutputFromGitLedger(snapshot, trackedGitScope(snapshot, [])).all.added, 300);
  const excluded = trackedGitScope(snapshot, ['repo-a']);
  assert.equal(buildCodeOutputFromGitLedger(snapshot, excluded).all.added, 200);
  const empty = { kind: 'selected', repoIds: [] };
  assert.equal(buildCodeOutputFromGitLedger(snapshot, empty).all.added, 0);
  assert.equal(hasCommitsInRange(snapshot, empty, '2026-06-01', '2026-06-30'), false);
  assert.equal(Object.values(buildCategoryNetLines(snapshot, empty, '2026-06-01', '2026-06-30')).every(x => x.added === 0 && x.removed === 0), true);
  assert.equal(buildCodeOutputFromGitLedger(snapshot, trackedGitScope(snapshot, [])).all.added, 300);
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

test('historical correction IPC never invokes reset or provider refresh',async()=>{
  const handlers=new Map();let reset=0,refresh=0,recheck=0,dismissed=0;
  const status={state:'complete',checkedSources:1,totalSources:1,notice:true,report:null};
  registerIpcHandlers({ipcMain:{handle:(channel,handler)=>handlers.set(channel,handler)},store:{store:{}},getState:()=>({}),
    forceRefresh:async()=>{refresh++;},resetUsageIndex:async()=>{reset++;},applySettingsChange:()=>{},
    getAccountingRevision:()=>status,retryAccountingRevision:()=>{recheck++;return {...status,state:'running'};},
    dismissAccountingRevision:()=>{dismissed++;return {...status,notice:false};}});
  assert.equal(handlers.get('usage-accounting:get')().notice,true);
  assert.equal(handlers.get('usage-accounting:retry')().state,'running');
  assert.equal(handlers.get('usage-accounting:dismiss')().notice,false);
  assert.equal(recheck,1);assert.equal(dismissed,1);assert.equal(reset,0);assert.equal(refresh,0);
});
