import test from 'node:test';
import assert from 'node:assert/strict';
import mod from '../dist/main/gitOutputLedger.js';

const { mergeGitDailyOutput, buildCategoryNetLines, emptyGitOutputLedgerSnapshot } = mod;

function day(over = {}) {
  return {
    date: '2026-06-10',
    commits: 1,
    added: 10,
    removed: 2,
    byCategory: { product_code: { added: 7, removed: 1 }, test_code: { added: 3, removed: 1 } },
    ...over,
  };
}

test('merge stores per-category lines and stays idempotent on rescan', () => {
  const snap = emptyGitOutputLedgerSnapshot();
  mergeGitDailyOutput(snap, 'repo-a', [day()]);
  mergeGitDailyOutput(snap, 'repo-a', [day()]);
  const net = buildCategoryNetLines(snap, ['repo-a'], '2026-06-10', '2026-06-10');
  assert.equal(net.product_code.added, 7);
  assert.equal(net.product_code.removed, 1);
  assert.equal(net.test_code.added, 3);
});

test('rescan with new data for a repo replaces that repo/day, not doubles (F10)', () => {
  const snap = emptyGitOutputLedgerSnapshot();
  mergeGitDailyOutput(snap, 'repo-a', [day()]);
  mergeGitDailyOutput(snap, 'repo-a', [day({ byCategory: { product_code: { added: 100, removed: 0 } } })]);
  const net = buildCategoryNetLines(snap, ['repo-a'], '2026-06-10', '2026-06-10');
  assert.equal(net.product_code.added, 100);
  assert.equal(net.product_code.removed, 0);
  assert.equal(net.test_code.added, 0);
  assert.equal(net.test_code.removed, 0);
});
