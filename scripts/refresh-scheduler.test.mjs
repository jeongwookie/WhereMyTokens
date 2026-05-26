import test from 'node:test';
import assert from 'node:assert/strict';

import refreshSchedulerModule from '../dist/main/refreshScheduler.js';

const { RefreshScheduler } = refreshSchedulerModule;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

test('refresh scheduler runs one task at a time and merges overlapping file changes', async () => {
  const gate = deferred();
  const works = [];
  let active = 0;
  let maxActive = 0;
  const scheduler = new RefreshScheduler({
    foregroundScanBudgetMs: 2500,
    getState: () => ({ uiVisible: true, uiBusy: false }),
    execute: async (work) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      works.push(work);
      if (works.length === 1) await gate.promise;
      active -= 1;
    },
  });

  const first = scheduler.request({ mode: 'fast', reason: 'watcher', changedFiles: ['a.jsonl'] });
  await tick();
  const second = scheduler.request({ mode: 'fast', reason: 'watcher', changedFiles: ['b.jsonl', 'a.jsonl'] });
  await tick();

  assert.equal(works.length, 1);
  assert.equal(maxActive, 1);

  gate.resolve();
  await Promise.all([first, second]);

  assert.equal(works.length, 2);
  assert.deepEqual([...works[1].changedFiles].sort(), ['a.jsonl', 'b.jsonl']);
  assert.equal(maxActive, 1);
});

test('heavy refresh supersedes pending fast refresh and keeps foreground scan budget', async () => {
  const gate = deferred();
  const works = [];
  const scheduler = new RefreshScheduler({
    foregroundScanBudgetMs: 2500,
    getState: () => ({ uiVisible: true, uiBusy: false }),
    execute: async (work) => {
      works.push(work);
      if (works.length === 1) await gate.promise;
    },
  });

  const first = scheduler.request({ mode: 'fast', reason: 'watcher', changedFiles: ['a.jsonl'] });
  await tick();
  const pendingFast = scheduler.request({ mode: 'fast', reason: 'watcher', changedFiles: ['b.jsonl'] });
  const pendingHeavy = scheduler.request({ mode: 'heavy', reason: 'foreground' });
  await tick();

  gate.resolve();
  await Promise.all([first, pendingFast, pendingHeavy]);

  assert.equal(works.length, 2);
  assert.equal(works[1].mode, 'heavy');
  assert.equal(works[1].scanBudgetMs, 2500);
  assert.deepEqual([...works[1].changedFiles], ['b.jsonl']);
  assert.deepEqual(works[1].reasons.sort(), ['foreground', 'watcher']);
});

test('hidden automatic heavy refresh still keeps a scan budget so hotkeys stay responsive', async () => {
  const works = [];
  const scheduler = new RefreshScheduler({
    foregroundScanBudgetMs: 2500,
    getState: () => ({ uiVisible: false, uiBusy: false }),
    execute: async (work) => {
      works.push(work);
    },
  });

  await scheduler.request({ mode: 'heavy', reason: 'timer', allowHiddenFullScan: true });

  assert.equal(works.length, 1);
  assert.equal(works[0].scanBudgetMs, 2500);
  assert.equal(works[0].allowHiddenFullScan, true);
});

test('manual force refresh can still request an unbudgeted scan', async () => {
  const works = [];
  const scheduler = new RefreshScheduler({
    foregroundScanBudgetMs: 2500,
    getState: () => ({ uiVisible: false, uiBusy: false }),
    execute: async (work) => {
      works.push(work);
    },
  });

  await scheduler.request({ mode: 'heavy', reason: 'manual', force: true });

  assert.equal(works.length, 1);
  assert.equal(works[0].scanBudgetMs, null);
});

test('manual provider refresh keeps foreground scan budget without force', async () => {
  const works = [];
  const scheduler = new RefreshScheduler({
    foregroundScanBudgetMs: 2500,
    getState: () => ({ uiVisible: true, uiBusy: false }),
    execute: async (work) => {
      works.push(work);
    },
  });

  await scheduler.request({ mode: 'heavy', reason: 'manual', forceProviderUsage: true, scanBudgetMs: 1200 });

  assert.equal(works.length, 1);
  assert.equal(works[0].force, false);
  assert.equal(works[0].forceProviderUsage, true);
  assert.equal(works[0].scanBudgetMs, 1200);
});

test('manual force refresh overrides an already pending scan budget', async () => {
  const works = [];
  let uiBusy = true;
  const scheduler = new RefreshScheduler({
    foregroundScanBudgetMs: 2500,
    getState: () => ({ uiVisible: true, uiBusy }),
    execute: async (work) => {
      works.push(work);
    },
  });

  const pendingBudgeted = scheduler.request({ mode: 'heavy', reason: 'foreground', scanBudgetMs: 2500 });
  await tick();
  const manual = scheduler.request({ mode: 'heavy', reason: 'manual', force: true });
  await Promise.all([pendingBudgeted, manual]);

  assert.equal(works.length, 1);
  assert.equal(works[0].force, true);
  assert.equal(works[0].scanBudgetMs, null);
});

test('history warmup can request budgeted full-history work', async () => {
  const works = [];
  const scheduler = new RefreshScheduler({
    foregroundScanBudgetMs: 2500,
    getState: () => ({ uiVisible: false, uiBusy: false }),
    execute: async (work) => {
      works.push(work);
    },
  });

  await scheduler.request({
    mode: 'heavy',
    reason: 'history-warmup',
    includeFullHistory: true,
    allowHiddenFullScan: true,
    scanBudgetMs: 2500,
  });

  assert.equal(works.length, 1);
  assert.equal(works[0].includeFullHistory, true);
  assert.equal(works[0].allowHiddenFullScan, true);
  assert.equal(works[0].scanBudgetMs, 2500);
});

test('non-forced refresh waits while UI is busy', async () => {
  const works = [];
  let uiBusy = true;
  const scheduler = new RefreshScheduler({
    foregroundScanBudgetMs: 2500,
    getState: () => ({ uiVisible: true, uiBusy }),
    execute: async (work) => {
      works.push(work);
    },
  });

  const request = scheduler.request({ mode: 'heavy', reason: 'foreground' });
  await tick();
  assert.equal(works.length, 0);

  uiBusy = false;
  scheduler.notifyStateChanged();
  await request;

  assert.equal(works.length, 1);
  assert.equal(works[0].scanBudgetMs, 2500);
});
