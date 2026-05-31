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
const { emptyUsageAggregate, emptyUsageLedgerSnapshot, dayModelKey } = aggregates;

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

function checkpoint(provider, overrides = {}) {
  return {
    provider,
    sourceHash: `${provider}-source`,
    size: 1,
    mtimeMs: 1,
    byteOffset: 1,
    lastImportedAt: Date.parse('2026-05-25T12:00:00.000Z'),
    hasUsage: true,
    ...overrides,
  };
}

function ledgerSource(filePath, provider = 'claude', priority = false) {
  return {
    provider,
    sourceId: filePath,
    sourcePath: filePath,
    priority,
    importIntoSnapshot: (snapshot, nowMs) =>
      importUsageJsonlIntoSnapshot(snapshot, filePath, provider, nowMs),
  };
}

test('state manager owns usage ledger import and query paths', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  assert.match(src, /UsageLedgerStore/);
  assert.match(src, /ProviderLedgerSource/);
  assert.match(src, /refreshUsageLedgerSources/);
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

test('usage ledger is disabled for a provider with a checkpoint that needs rebuild', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const canUseMatch = src.match(/private canUseUsageLedger\([\s\S]*?\): boolean \{([\s\S]*?)\n  \}/);
  assert.ok(canUseMatch);
  assert.match(canUseMatch[1], /usageLedgerNeedsRebuild\(settings, snapshot\)/);
  const rebuildMatch = src.match(/private usageLedgerNeedsRebuild\([\s\S]*?\): boolean \{([\s\S]*?)\n  \}/);
  assert.ok(rebuildMatch);
  assert.match(rebuildMatch[1], /checkpoint\.needsRebuild/);
  assert.match(rebuildMatch[1], /enabledProviderSet\(settings\)\.has\(checkpoint\.provider\)/);
});

test('usage ledger rebuild state is surfaced and completed imports suppress repeated startup warmup', () => {
  const stateSource = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const rendererSource = fs.readFileSync('src/renderer/views/MainView.tsx', 'utf8');

  assert.match(stateSource, /usageLedgerNeedsRebuild: boolean/);
  assert.match(stateSource, /private hasCompletedUsageLedgerImport/);
  assert.match(stateSource, /lastFullImportAt \?\? 0/);
  assert.match(stateSource, /sourceList\.partial && !alreadyCompletedFullImport/);
  assert.match(rendererSource, /LedgerNeedsRebuildBanner/);
  assert.match(rendererSource, /state\.usageLedgerNeedsRebuild/);
  assert.match(rendererSource, /Historical totals are using recent fallback data/);
});

test('trend falls back when excluded projects disable the ledger', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const trendMatch = src.match(/private buildUsageTrend\([\s\S]*?\): UsageTrendData \{([\s\S]*?)\n  \}/);
  assert.ok(trendMatch);
  assert.match(trendMatch[1], /canUseUsageLedger/);
  assert.match(trendMatch[1], /emptyUsageTrendData/);
});

test('usage ledger queries receive the enabled provider set', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const derivedMatch = src.match(/private computeDerivedUsage\([\s\S]*?\): Pick<AppState, 'usage' \| 'limits' \| 'bridgeActive' \| 'extraUsage'> \{([\s\S]*?)\n  \}/);
  assert.ok(derivedMatch);
  assert.match(derivedMatch[1], /computeUsageFromLedger\([\s\S]*this\.enabledUsageLedgerProviders\(settings\)/);

  const trendMatch = src.match(/private buildUsageTrend\([\s\S]*?\): UsageTrendData \{([\s\S]*?)\n  \}/);
  assert.ok(trendMatch);
  assert.match(trendMatch[1], /buildTrendDataFromLedger\([\s\S]*this\.enabledUsageLedgerProviders\(settings\)/);

  const countMatch = src.match(/private countAllTimeUsageSessions\(settings: AppSettings\): number \{([\s\S]*?)\n  \}/);
  assert.ok(countMatch);
  assert.match(countMatch[1], /this\.enabledProviderSet\(settings\)\.has\(checkpoint\.provider\)/);
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

    await manager.refreshUsageLedgerSources([ledgerSource(filePath, 'claude')]);

    assert.equal(usageLedgerStore.replaceCount, 0);
    assert.equal(usageLedgerStore.compactCount, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state manager disables stale ledger usage after source import failures', async () => {
  const snapshot = {
    ...emptyUsageLedgerSnapshot(),
    dailyModel: {
      [dayModelKey('2026-05-25', 'claude', 'Sonnet')]: {
        ...emptyUsageAggregate(),
        requestCount: 1,
        totalTokens: 30,
      },
    },
    sourceCheckpoints: {
      'claude-source': checkpoint('claude'),
    },
  };
  const usageLedgerStore = new CountingUsageLedgerStore(snapshot);
  const manager = new StateManager(makeStore(), () => {});
  manager.usageLedgerStore = usageLedgerStore;

  assert.equal(manager.canUseUsageLedger(snapshot, manager.getState().settings), true);
  await manager.refreshUsageLedgerSources([{
    provider: 'claude',
    sourceId: 'broken-source',
    sourcePath: path.join(os.tmpdir(), 'broken-source.jsonl'),
    priority: true,
    importIntoSnapshot: async () => {
      throw new Error('boom');
    },
  }]);

  assert.equal(manager.usageLedgerImportFailed, true);
  assert.equal(manager.canUseUsageLedger(snapshot, manager.getState().settings), false);

  await manager.refreshUsageLedgerSources([{
    provider: 'claude',
    sourceId: 'stable-source',
    sourcePath: path.join(os.tmpdir(), 'stable-source.jsonl'),
    priority: true,
    importIntoSnapshot: async (current) => current,
  }]);

  assert.equal(manager.usageLedgerImportFailed, false);
  assert.equal(manager.canUseUsageLedger(snapshot, manager.getState().settings), true);
});

test('full-history warmup skips source discovery when the enabled ledger needs rebuild', async () => {
  const snapshot = {
    ...emptyUsageLedgerSnapshot(),
    sourceCheckpoints: {
      'claude-source': checkpoint('claude', {
        needsRebuild: true,
        rebuildReason: 'jsonl checkpoint missing byte offset',
      }),
    },
  };
  const usageLedgerStore = new CountingUsageLedgerStore(snapshot);
  const manager = new StateManager(makeStore({ enabledProviders: ['claude', 'codex'] }), () => {});
  let listedSources = false;
  manager.usageLedgerStore = usageLedgerStore;
  manager.ledgerSourceFiles = () => {
    listedSources = true;
    return {
      files: [ledgerSource(path.join(os.tmpdir(), 'should-not-scan.jsonl'))],
      partial: false,
    };
  };

  const result = await manager.refreshUsageLedgerFromDiscoveredSources(null, undefined, true);

  assert.equal(result.partial, true);
  assert.equal(result.scannedFiles, 0);
  assert.equal(listedSources, false);
  assert.equal(usageLedgerStore.replaceCount, 0);
});

test('budgeted full-history ledger scans do not mark the import complete when truncated', async () => {
  const usageLedgerStore = new CountingUsageLedgerStore(emptyUsageLedgerSnapshot());
  const manager = new StateManager(makeStore(), () => {});
  manager.usageLedgerStore = usageLedgerStore;
  manager.ledgerSourceFiles = () => ({
    files: [ledgerSource(path.join(os.tmpdir(), 'unreached.jsonl'))],
    partial: false,
  });

  const result = await manager.refreshUsageLedgerFromDiscoveredSources(0, undefined, true);

  assert.equal(result.partial, true);
  assert.equal(result.scannedFiles, 0);
  assert.equal(usageLedgerStore.snapshot.lastFullImportAt ?? 0, 0);
});

test('budgeted full-history ledger scans remain partial with an existing completion marker', async () => {
  const snapshot = {
    ...emptyUsageLedgerSnapshot(),
    lastFullImportAt: Date.parse('2026-05-25T12:00:00.000Z'),
    sourceCheckpoints: {
      'claude-source': checkpoint('claude'),
    },
  };
  const usageLedgerStore = new CountingUsageLedgerStore(snapshot);
  const manager = new StateManager(makeStore(), () => {});
  manager.usageLedgerStore = usageLedgerStore;
  manager.ledgerSourceFiles = () => ({
    files: [ledgerSource(path.join(os.tmpdir(), 'unreached.jsonl'))],
    partial: false,
  });

  const result = await manager.refreshUsageLedgerFromDiscoveredSources(0, undefined, true);

  assert.equal(result.partial, true);
  assert.equal(result.scannedFiles, 0);
  assert.equal(usageLedgerStore.snapshot.lastFullImportAt, snapshot.lastFullImportAt);
});

test('full-history ledger import failures do not mark the import complete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-ledger-failed-source-'));
  try {
    const usageLedgerStore = new CountingUsageLedgerStore(emptyUsageLedgerSnapshot());
    const manager = new StateManager(makeStore(), () => {});
    manager.usageLedgerStore = usageLedgerStore;
    manager.ledgerSourceFiles = () => ({
      files: [ledgerSource(dir)],
      partial: false,
    });

    const result = await manager.refreshUsageLedgerFromDiscoveredSources(10_000, undefined, true);

    assert.equal(result.partial, true);
    assert.equal(result.scannedFiles, 0);
    assert.equal(usageLedgerStore.snapshot.lastFullImportAt ?? 0, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provider-specific stale full-import markers do not suppress warmup', async () => {
  const snapshot = {
    ...emptyUsageLedgerSnapshot(),
    lastFullImportAt: Date.parse('2026-05-25T12:00:00.000Z'),
    sourceCheckpoints: {
      'claude-source': checkpoint('claude'),
    },
  };
  const usageLedgerStore = new CountingUsageLedgerStore(snapshot);
  const manager = new StateManager(makeStore({ enabledProviders: ['claude', 'codex'] }), () => {});
  manager.usageLedgerStore = usageLedgerStore;
  manager.ledgerSourceFiles = () => ({
    files: [ledgerSource(path.join(os.tmpdir(), 'codex-recent.jsonl'), 'codex')],
    partial: true,
  });

  const result = await manager.refreshUsageLedgerFromDiscoveredSources(null, undefined, false);

  assert.equal(result.partial, true);
});
