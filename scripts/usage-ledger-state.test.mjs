import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import stateManagerModule from '../dist/main/stateManager.js';
import importerModule from '../dist/main/usageLedgerImporter.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { StateManager } = stateManagerModule;
const { importUsageJsonlIntoSnapshot } = importerModule;
const { emptyUsageLedgerSnapshot } = aggregates;

function makeStore(overrides = {}) {
  return {
    store: { ...overrides },
    get(key, fallback = null) {
      return key in this.store ? this.store[key] : fallback;
    },
    set(key, value) {
      this.store[key] = value;
    },
    delete(key) {
      delete this.store[key];
    },
  };
}

function claudeUsageLine() {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-25T10:15:00.000Z',
    message: {
      id: 'unchanged-ledger-source',
      model: 'claude-sonnet-4',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [{ type: 'text', text: 'done' }],
    },
  });
}

class CountingUsageLedgerStore {
  constructor(snapshot) {
    this.snapshot = snapshot;
    this.replaceCount = 0;
    this.compactCount = 0;
  }

  getSnapshot() {
    return this.snapshot;
  }

  replaceSnapshot(snapshot) {
    this.replaceCount += 1;
    this.snapshot = snapshot;
  }

  compact() {
    this.compactCount += 1;
    return this.snapshot;
  }
}

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

test('manual refresh stays budgeted and does not force old full-summary scans', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const forceRefreshMatch = src.match(/async forceRefresh\(\): Promise<void> \{([\s\S]*?)\n  \}/);
  assert.ok(forceRefreshMatch);
  const forceRefresh = forceRefreshMatch[1];
  assert.match(forceRefresh, /reason: 'manual'/);
  assert.match(forceRefresh, /includeFullHistory: true/);
  assert.match(forceRefresh, /scanBudgetMs: StateManager\.FOREGROUND_SCAN_BUDGET_MS/);
  assert.doesNotMatch(forceRefresh, /force: true/);
});

test('all-time session count ignores ledger checkpoints without usage', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const countMatch = src.match(/private countAllTimeUsageSessions\(settings: AppSettings\): number \{([\s\S]*?)\n  \}/);
  assert.ok(countMatch);
  const countBody = countMatch[1];
  assert.match(countBody, /checkpoint\.hasUsage !== false/);
});

test('usage ledger is not globally disabled when one checkpoint needs rebuild', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const canUseMatch = src.match(/private canUseUsageLedger\([\s\S]*?\): boolean \{([\s\S]*?)\n  \}/);
  assert.ok(canUseMatch);
  assert.doesNotMatch(canUseMatch[1], /needsRebuild/);
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

test('provider changes refresh recent summaries without clearing the JSONL cache or forcing full history', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const settingsMatch = src.match(/applySettingsChange\(\) \{([\s\S]*?)\n  private async logMemorySnapshot/);
  assert.ok(settingsMatch);
  const settingsBody = settingsMatch[1];
  assert.doesNotMatch(settingsBody, /jsonlCache\.clearAll/);
  assert.match(settingsBody, /reason: 'settings'/);
  assert.match(settingsBody, /includeFullHistory: true/);
  assert.match(settingsBody, /scanBudgetMs: StateManager\.FOREGROUND_SCAN_BUDGET_MS/);
  assert.doesNotMatch(settingsBody, /reason: 'settings'[\s\S]*force: true/);
});

test('history warmup imports ledger sources instead of expanding summary scans to full history', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const heavyStart = src.indexOf('  private async heavyRefresh');
  const heavyEnd = src.indexOf('  private buildStartupPriorityFiles', heavyStart);
  const heavyBody = src.slice(heavyStart, heavyEnd);
  assert.match(heavyBody, /refreshUsageLedgerFromDiscoveredSources/);
  assert.match(heavyBody, /const summaryIncludeFullHistory = includeFullHistory && hasExcludedProjects/);
  assert.match(heavyBody, /this\.loadProviderSummaries\(summaryForce, effectiveScanBudgetMs, priorityFiles, summaryIncludeFullHistory\)/);
  assert.doesNotMatch(heavyBody, /this\.loadProviderSummaries\(force, effectiveScanBudgetMs, priorityFiles, includeFullHistory\)/);
});

test('state manager skips persisted usage ledger writes when sources are unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-usage-ledger-state-'));
  try {
    const filePath = path.join(dir, 'stable.jsonl');
    fs.writeFileSync(filePath, `${claudeUsageLine()}\n`, 'utf8');
    const imported = await importUsageJsonlIntoSnapshot(
      emptyUsageLedgerSnapshot(),
      filePath,
      'claude',
      Date.parse('2026-05-25T12:00:00.000Z'),
    );
    const usageLedgerStore = new CountingUsageLedgerStore(imported);
    const manager = new StateManager(makeStore(), () => {});
    manager.usageLedgerStore = usageLedgerStore;

    await manager.refreshUsageLedgerFromFiles([{ filePath, provider: 'claude' }]);

    assert.equal(usageLedgerStore.replaceCount, 0);
    assert.equal(usageLedgerStore.compactCount, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
