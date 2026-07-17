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
const { emptySessionSnapshot } = jsonlTypesModule;

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

test('generic provider scanUsage results are committed to UsageIndex in one heavy refresh', () => {
  const loadBody = methodBody('loadProviderSummaries');
  const genericBody = methodBody('scanGenericProviderUsage');

  assert.match(loadBody, /const remainingBudgetMs = budgetMs === null \? null : Math\.max\(0, budgetMs - elapsedMs\)/);
  assert.match(loadBody, /const genericUsage = await this\.scanGenericProviderUsage\(settings, genericCtx\)/);
  assert.match(genericBody, /result\.usageIndexSources/);
  assert.match(genericBody, /this\.usageIndex\.declareSources/);
  assert.match(genericBody, /this\.usageIndex\.refreshSource/);
  assert.doesNotMatch(source, /ledgerSourceFiles|refreshUsageLedger|usageLedgerStore/);
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
    mtimeMs: 1,
    size: 1,
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
    usageIndexSource: (_ctx, providerSource) => ({
      descriptor: {
        sourceId: `claude:${providerSource.filePath}`,
        provider: 'claude',
        kind: 'file',
        parserVersion: 1,
        version: { token: 'v1', size: 3, mtimeMs: 1 },
        projectKeys: [],
      },
      scanner: {
        scan: async plan => {
          await delay(40);
          return {
            checkpoint: { byteOffset: 3 },
            entries: [],
            rebuildCoverage: { kind: 'full' },
            sessionProjection: {
              sourceId: plan.source.sourceId,
              provider: 'claude',
              updatedAt: Date.now(),
              byteSize: 3,
              payload: { sessionSnapshot: makeSummary('claude').sessionSnapshot },
            },
          };
        },
      },
    }),
  };
  const antigravityProvider = {
    id: 'antigravity',
    displayName: 'Antigravity',
    capabilities: new Set(['usage']),
    isAvailable: async () => true,
    scanUsage: async () => {
      genericScanCalls += 1;
      return { usageIndexSources: [], partial: false };
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
  const loaded = await manager.loadProviderSummaries(false, 20);

  assert.equal(genericScanCalls, 0);
  assert.equal(loaded.partial, true);
});

test('source-backed scanner failures mark the refresh partial and retain failed coverage', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-source-failure-'));
  const sourcePath = path.join(tempDir, 'source.jsonl');
  fs.writeFileSync(sourcePath, '{}\n');
  const provider = {
    id: 'claude',
    displayName: 'Claude',
    capabilities: new Set(['usage']),
    isAvailable: async () => true,
    ownsPath: filePath => filePath === sourcePath,
    listRecentSources: () => ({ sources: [{ provider: 'claude', sourceId: sourcePath, filePath: sourcePath }], truncated: false }),
    listAllSources: () => ({ sources: [{ provider: 'claude', sourceId: sourcePath, filePath: sourcePath }], truncated: false }),
    usageIndexSource: () => ({
      descriptor: {
        sourceId: 'claude:failed-source',
        provider: 'claude',
        kind: 'file',
        parserVersion: 1,
        version: { token: 'v1', size: 1, mtimeMs: 1 },
      },
      scanner: { scan: async () => { throw new Error('intentional scanner failure'); } },
    }),
  };
  const registry = new ProviderRegistry();
  registry.register(provider);
  const manager = new StateManager(
    makeStore({ enabledProviders: ['claude'] }),
    () => {},
    { providerRegistry: registry },
  );

  const loaded = await manager.loadProviderSummaries(false, null);
  const indexed = await manager.usageIndex.queryUsage({ grain: 'month', providers: new Set(['claude']) });

  assert.equal(loaded.scanPartial, true);
  assert.equal(loaded.partial, true);
  assert.equal(indexed.coverage.failedSourceCount, 1);
  assert.equal(indexed.coverage.state, 'incomplete');
});

test('source preparation isolates disappeared and unreadable files without blocking valid sources', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-source-preparation-'));
  const stalePath = path.join(tempDir, 'stale.jsonl');
  const unreadablePath = path.join(tempDir, 'unreadable.jsonl');
  const validPath = path.join(tempDir, 'valid.jsonl');
  fs.writeFileSync(unreadablePath, '{}\n');
  fs.writeFileSync(validPath, '{}\n');
  let validScans = 0;

  const provider = {
    id: 'claude',
    displayName: 'Claude',
    capabilities: new Set(['usage']),
    isAvailable: async () => true,
    ownsPath: filePath => filePath.startsWith(tempDir),
    listRecentSources: () => ({
      sources: [unreadablePath, validPath].map(filePath => ({
        provider: 'claude',
        sourceId: filePath,
        filePath,
      })),
      truncated: false,
    }),
    listAllSources: () => ({ sources: [], truncated: false }),
    usageIndexSource: (_ctx, source) => {
      assert.notEqual(source.filePath, stalePath, 'disappeared priority sources must be skipped before stat');
      if (source.filePath === unreadablePath) throw new Error('simulated stat failure');
      const stat = fs.statSync(source.filePath);
      return {
        descriptor: {
          sourceId: `claude:${source.filePath}`,
          provider: 'claude',
          kind: 'file',
          parserVersion: 1,
          version: { token: `${stat.size}:${stat.mtimeMs}`, size: stat.size, mtimeMs: stat.mtimeMs },
          projectKeys: [],
        },
        scanner: {
          scan: async plan => {
            validScans += 1;
            return {
              checkpoint: { byteOffset: stat.size },
              entries: [{
                requestId: 'valid-request',
                timestampMs: Date.now(),
                provider: 'claude',
                model: 'Claude',
                inputTokens: 1,
                outputTokens: 1,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                costUSD: 0,
                cacheSavingsUSD: 0,
              }],
              rebuildCoverage: { kind: 'full' },
              sessionProjection: {
                sourceId: plan.source.sourceId,
                provider: 'claude',
                updatedAt: Date.now(),
                byteSize: stat.size,
                payload: { sessionSnapshot: makeSummary('claude').sessionSnapshot },
              },
            };
          },
        },
      };
    },
  };
  const registry = new ProviderRegistry();
  registry.register(provider);
  const manager = new StateManager(
    makeStore({ enabledProviders: ['claude'] }),
    () => {},
    { providerRegistry: registry },
  );

  const loaded = await manager.loadProviderSummaries(false, null, [stalePath]);
  const indexed = await manager.usageIndex.queryUsage({ grain: 'month', providers: new Set(['claude']) });

  assert.equal(validScans, 1);
  assert.equal(loaded.scanPartial, true);
  assert.equal(indexed.aggregate.requestCount, 1);
});

test('changed-file refresh contains one scanner failure and retains it for a later retry', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-changed-source-'));
  const failedPath = path.join(tempDir, 'failed.jsonl');
  const validPath = path.join(tempDir, 'valid.jsonl');
  fs.writeFileSync(failedPath, '{}\n');
  fs.writeFileSync(validPath, '{}\n');

  const provider = {
    id: 'claude',
    displayName: 'Claude',
    capabilities: new Set(['usage']),
    isAvailable: async () => true,
    ownsPath: filePath => filePath.startsWith(tempDir),
    listRecentSources: () => ({ sources: [], truncated: false }),
    listAllSources: () => ({ sources: [], truncated: false }),
    usageIndexSource: (_ctx, source) => {
      const stat = fs.statSync(source.filePath);
      return {
        descriptor: {
          sourceId: `claude:${source.filePath}`,
          provider: 'claude',
          kind: 'file',
          parserVersion: 1,
          version: { token: `${stat.size}:${stat.mtimeMs}`, size: stat.size, mtimeMs: stat.mtimeMs },
          projectKeys: [],
        },
        scanner: {
          scan: async plan => {
            if (source.filePath === failedPath) throw new Error('simulated scan failure');
            return {
              checkpoint: { byteOffset: stat.size },
              entries: [],
              rebuildCoverage: { kind: 'full' },
              sessionProjection: {
                sourceId: plan.source.sourceId,
                provider: 'claude',
                updatedAt: Date.now(),
                byteSize: stat.size,
                payload: { sessionSnapshot: makeSummary('claude').sessionSnapshot },
              },
            };
          },
        },
      };
    },
  };
  const registry = new ProviderRegistry();
  registry.register(provider);
  const manager = new StateManager(
    makeStore({ enabledProviders: ['claude'] }),
    () => {},
    { providerRegistry: registry },
  );

  await manager.refreshChangedSummaries(new Set([failedPath, validPath]));

  assert.equal(manager.summaries.has(validPath), true);
  assert.equal(manager.summaries.has(failedPath), false);
  assert.equal(manager.dirtySessionFiles.has(failedPath), true);
});

test('generic provider scanUsage results feed summaries and UsageIndex without rescanning', async () => {
  let genericScanCalls = 0;
  const summary = makeSummary('antigravity');
  let sourceScans = 0;
  const antigravityProvider = {
    id: 'antigravity',
    displayName: 'Antigravity',
    capabilities: new Set(['usage']),
    isAvailable: async () => true,
    scanUsage: async () => {
      genericScanCalls += 1;
      return {
        usageIndexSources: [{
          descriptor: {
            sourceId: 'antigravity:cascade:single',
            provider: 'antigravity',
            kind: 'remote',
            parserVersion: 1,
            version: { token: 'v1' },
            projectKeys: [],
          },
          scanner: {
            scan: async plan => {
              sourceScans += 1;
              return {
                checkpoint: { cursor: 'v1' },
                entries: [{
                  requestId: 'single-request',
                  timestampMs: Date.now(),
                  provider: 'antigravity',
                  model: 'Gemini',
                  inputTokens: 10,
                  outputTokens: 5,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                  costUSD: 0,
                  cacheSavingsUSD: 0,
                }],
                rebuildCoverage: { kind: 'full' },
                sessionProjection: {
                  sourceId: plan.source.sourceId,
                  provider: 'antigravity',
                  updatedAt: Date.now(),
                  byteSize: 1,
                  payload: { sessionSnapshot: summary.sessionSnapshot },
                },
              };
            },
          },
        }],
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
  const loaded = await manager.loadProviderSummaries(false, null);

  assert.equal(genericScanCalls, 1);
  assert.equal(sourceScans, 1);
  assert.deepEqual(
    loaded.summaries.get('antigravity:cascade:single').sessionSnapshot,
    summary.sessionSnapshot,
  );
  assert.equal((await manager.usageIndex.queryUsage({ grain: 'month' })).aggregate.requestCount, 1);
});
