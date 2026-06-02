import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import stateManagerModule from '../dist/main/stateManager.js';
import providersModule from '../dist/main/providers/index.js';
import jsonlTypesModule from '../dist/main/jsonlTypes.js';

const { StateManager } = stateManagerModule;
const { ProviderRegistry } = providersModule;
const { emptyHistoricalRollup, emptySessionSnapshot } = jsonlTypesModule;

const source = fs.readFileSync('src/main/stateManager.ts', 'utf8');

function methodBody(name) {
  const markers = [`private ${name}`, `private async ${name}`];
  const start = markers
    .map(marker => source.indexOf(marker))
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0] ?? -1;
  assert.notEqual(start, -1, `${name} method not found`);
  const nextPrivate = source.indexOf('\n  private ', start + name.length);
  return source.slice(start, nextPrivate === -1 ? undefined : nextPrivate);
}

test('generic provider scanUsage results are reused for summary and ledger refresh in one heavy refresh', () => {
  const loadBody = methodBody('loadProviderSummaries');
  const ledgerBody = methodBody('ledgerSourceFiles');
  const heavyBody = methodBody('heavyRefresh');

  assert.match(loadBody, /ledgerSources: ProviderLedgerSource\[\]/);
  assert.match(loadBody, /const remainingBudgetMs = budgetMs === null \? null : Math\.max\(0, budgetMs - elapsedMs\)/);
  assert.match(loadBody, /const genericUsage = await this\.scanGenericProviderUsage\(settings, genericCtx\)/);
  assert.match(loadBody, /ledgerSources = genericUsage\.ledgerSources/);
  assert.doesNotMatch(ledgerBody, /scanGenericProviderUsage/);
  assert.match(heavyBody, /\.\.\.loaded\.ledgerSources/);
});

function makeStore(settings) {
  const values = {};
  return {
    store: settings,
    get(key, fallback = null) {
      return key in values ? values[key] : fallback;
    },
    set(key, value) {
      values[key] = value;
    },
    delete(key) {
      delete values[key];
    },
  };
}

function makeSummary(provider) {
  return {
    provider,
    sessionSnapshot: emptySessionSnapshot('tokens'),
    recentEntries: [],
    historicalRollup: emptyHistoricalRollup(),
    byteOffset: 0,
    mtimeMs: 1,
    size: 1,
    lastAccessedAt: Date.now(),
    rehydratedFromPersistence: false,
  };
}

function installFakeLedgerStore(manager) {
  let snapshot = {
    schemaVersion: 1,
    minuteRecent: {},
    recentRequestIndex: {},
    hourlyActivity: {},
    dailyModel: {},
    monthlyModel: {},
    sourceCheckpoints: {},
    sourceRepairRollup: {},
  };
  manager.usageLedgerStore = {
    getSnapshot: () => snapshot,
    replaceSnapshot: next => {
      snapshot = next;
    },
    compact: () => {},
  };
}

test('generic provider scanUsage is skipped when source-backed scans exhaust the summary budget', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-generic-budget-'));
  const sourcePath = path.join(tempDir, 'session.jsonl');
  fs.writeFileSync(sourcePath, '{}\n');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let genericScanCalls = 0;

  const claudeProvider = {
    id: 'claude',
    displayName: 'Claude',
    capabilities: new Set(['sessions', 'usage']),
    isAvailable: async () => true,
    ownsPath: filePath => filePath === sourcePath,
    listRecentSources: () => ({ sources: [{ provider: 'claude', sourceId: sourcePath, filePath: sourcePath }], truncated: false }),
    listAllSources: () => ({ sources: [{ provider: 'claude', sourceId: sourcePath, filePath: sourcePath }], truncated: false }),
    scanSourceSummary: async () => {
      await delay(40);
      return makeSummary('claude');
    },
  };
  const antigravityProvider = {
    id: 'antigravity',
    displayName: 'Antigravity',
    capabilities: new Set(['usage']),
    isAvailable: async () => true,
    scanUsage: async () => {
      genericScanCalls += 1;
      return { summaries: new Map(), ledgerSources: [], scannedSources: 0, partial: false };
    },
  };

  const registry = new ProviderRegistry();
  registry.register(claudeProvider);
  registry.register(antigravityProvider);
  const manager = new StateManager(
    makeStore({ enabledProviders: ['claude', 'antigravity'] }),
    () => {},
    { providerRegistry: registry },
  );
  installFakeLedgerStore(manager);

  const loaded = await manager.loadProviderSummaries(false, 20);

  assert.equal(genericScanCalls, 0);
  assert.equal(loaded.partial, true);
});

test('generic provider scanUsage results can feed summaries and ledger import without rescanning', async () => {
  let genericScanCalls = 0;
  let ledgerImports = 0;
  const summary = makeSummary('antigravity');
  const ledgerSource = {
    provider: 'antigravity',
    sourceId: 'antigravity:cascade:single',
    priority: false,
    importIntoSnapshot: async snapshot => {
      ledgerImports += 1;
      return {
        ...snapshot,
        sourceCheckpoints: {
          ...snapshot.sourceCheckpoints,
          single: {
            provider: 'antigravity',
            sourceHash: 'single',
            lastImportedAt: Date.now(),
            hasUsage: true,
          },
        },
      };
    },
  };
  const antigravityProvider = {
    id: 'antigravity',
    displayName: 'Antigravity',
    capabilities: new Set(['usage']),
    isAvailable: async () => true,
    scanUsage: async () => {
      genericScanCalls += 1;
      return {
        summaries: new Map([['antigravity:cascade:single', summary]]),
        ledgerSources: [ledgerSource],
        scannedSources: 1,
        partial: false,
      };
    },
  };

  const registry = new ProviderRegistry();
  registry.register(antigravityProvider);
  const manager = new StateManager(
    makeStore({ enabledProviders: ['antigravity'] }),
    () => {},
    { providerRegistry: registry },
  );
  installFakeLedgerStore(manager);

  const loaded = await manager.loadProviderSummaries(false, null);
  await manager.refreshUsageLedgerSources(loaded.ledgerSources);

  assert.equal(genericScanCalls, 1);
  assert.equal(loaded.summaries.get('antigravity:cascade:single'), summary);
  assert.equal(ledgerImports, 1);
});
