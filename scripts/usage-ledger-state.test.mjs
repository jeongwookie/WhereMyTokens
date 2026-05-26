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

test('all-time session count ignores ledger checkpoints without usage', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const countMatch = src.match(/private countAllTimeUsageSessions\(settings: AppSettings\): number \{([\s\S]*?)\n  \}/);
  assert.ok(countMatch);
  const countBody = countMatch[1];
  assert.match(countBody, /checkpoint\.hasUsage !== false/);
});

test('usage ledger is disabled when any checkpoint needs rebuild', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const canUseMatch = src.match(/private canUseUsageLedger\([\s\S]*?\): boolean \{([\s\S]*?)\n  \}/);
  assert.ok(canUseMatch);
  assert.match(canUseMatch[1], /needsRebuild/);
});

test('trend falls back when excluded projects disable the ledger', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const trendMatch = src.match(/private buildUsageTrend\([\s\S]*?\): UsageTrendData \{([\s\S]*?)\n  \}/);
  assert.ok(trendMatch);
  assert.match(trendMatch[1], /canUseUsageLedger/);
  assert.match(trendMatch[1], /emptyUsageTrendData/);
});

test('usage ledger queries receive the selected provider mode', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const derivedMatch = src.match(/private computeDerivedUsage\([\s\S]*?\): Pick<AppState, 'usage' \| 'limits' \| 'bridgeActive' \| 'extraUsage'> \{([\s\S]*?)\n  \}/);
  assert.ok(derivedMatch);
  assert.match(derivedMatch[1], /computeUsageFromLedger\([\s\S]*settings\.provider/);

  const trendMatch = src.match(/private buildUsageTrend\([\s\S]*?\): UsageTrendData \{([\s\S]*?)\n  \}/);
  assert.ok(trendMatch);
  assert.match(trendMatch[1], /buildTrendDataFromLedger\([\s\S]*settings\.provider/);

  const countMatch = src.match(/private countAllTimeUsageSessions\(settings: AppSettings\): number \{([\s\S]*?)\n  \}/);
  assert.ok(countMatch);
  assert.match(countMatch[1], /checkpoint\.provider === settings\.provider/);
});
