import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('state manager owns usage ledger import and query paths', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  assert.match(src, /UsageLedgerStore/);
  assert.match(src, /importUsageJsonlIntoSnapshot/);
  assert.match(src, /computeUsageFromLedger/);
  assert.match(src, /buildTrendDataFromLedger/);
});

test('manual refresh does not clear persisted usage ledger', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const forceRefreshMatch = src.match(/async forceRefresh\(\): Promise<void> \{([\s\S]*?)\n  \}/);
  assert.ok(forceRefreshMatch);
  const forceRefresh = forceRefreshMatch[1];
  assert.doesNotMatch(forceRefresh, /usageLedgerStore\.reset/);
});
