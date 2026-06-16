import test from 'node:test';
import assert from 'node:assert/strict';

import gitOutput from '../dist/main/gitOutputLedger.js';

const { mergeGitDailyOutput, buildCodeOutputFromGitLedger, emptyGitOutputLedgerSnapshot } = gitOutput;

const CATEGORIES = ['product_code', 'test_code', 'docs_spec', 'config_build', 'schema_migration', 'vendor', 'asset'];

function zeroCategories() {
  return Object.fromEntries(CATEGORIES.map(category => [category, { added: 0, removed: 0 }]));
}

function day(overrides) {
  return { byCategory: zeroCategories(), ...overrides };
}

test('git daily output merge uses repo and date as stable dimensions', () => {
  const snapshot = emptyGitOutputLedgerSnapshot();
  mergeGitDailyOutput(snapshot, 'repo-a', [
    day({ date: '2026-05-25', commits: 2, added: 10, removed: 3 }),
  ]);
  mergeGitDailyOutput(snapshot, 'repo-a', [
    day({ date: '2026-05-25', commits: 3, added: 11, removed: 4 }),
  ]);
  const key = Object.keys(snapshot.dailyOutput)[0];
  assert.match(key, /^2026-05-25\|repo:/);
  assert.deepEqual(snapshot.dailyOutput[key], {
    date: '2026-05-25',
    repoKey: key.split('|')[1],
    commits: 3,
    added: 11,
    removed: 4,
    netLines: 7,
    byCategory: zeroCategories(),
  });
});

test('git daily output builds today all and daily7d code output stats', () => {
  const snapshot = emptyGitOutputLedgerSnapshot();
  mergeGitDailyOutput(snapshot, 'repo-a', [
    day({ date: '2026-05-24', commits: 1, added: 5, removed: 1 }),
    day({ date: '2026-05-25', commits: 2, added: 10, removed: 3 }),
  ]);
  const stats = buildCodeOutputFromGitLedger(snapshot, ['repo-a'], '2026-05-25');
  assert.equal(stats.today.commits, 2);
  assert.equal(stats.today.added, 10);
  assert.equal(stats.all.commits, 3);
  assert.equal(stats.all.added, 15);
  assert.equal(stats.daily7d.length, 7);
});

test('git daily output merge prunes repo days missing from the latest history', () => {
  const snapshot = emptyGitOutputLedgerSnapshot();
  mergeGitDailyOutput(snapshot, 'repo-a', [
    day({ date: '2026-05-24', commits: 1, added: 5, removed: 1 }),
    day({ date: '2026-05-25', commits: 2, added: 10, removed: 3 }),
  ]);
  mergeGitDailyOutput(snapshot, 'repo-a', [
    day({ date: '2026-05-25', commits: 2, added: 10, removed: 3 }),
  ]);

  assert.equal(Object.values(snapshot.dailyOutput).some(row => row.date === '2026-05-24'), false);
  assert.equal(Object.values(snapshot.dailyOutput).some(row => row.date === '2026-05-25'), true);
});

test('git daily output merge preserves repo history when latest history scan is empty', () => {
  const snapshot = emptyGitOutputLedgerSnapshot();
  mergeGitDailyOutput(snapshot, 'repo-a', [
    day({ date: '2026-05-24', commits: 1, added: 5, removed: 1 }),
    day({ date: '2026-05-25', commits: 2, added: 10, removed: 3 }),
  ]);
  mergeGitDailyOutput(snapshot, 'repo-a', []);

  assert.equal(Object.values(snapshot.dailyOutput).some(row => row.date === '2026-05-24'), true);
  assert.equal(Object.values(snapshot.dailyOutput).some(row => row.date === '2026-05-25'), true);
});
