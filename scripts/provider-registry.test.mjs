import test from 'node:test';
import assert from 'node:assert/strict';

import providersModule from '../dist/main/providers/index.js';

test('provider registry registers Claude and Codex adapters', () => {
  const registry = providersModule.createProviderRegistry();

  assert.deepEqual(registry.getAll().map(provider => provider.id), ['claude', 'codex']);
  assert.equal(registry.get('claude').displayName, 'Claude Code');
  assert.equal(registry.get('codex').displayName, 'Codex');
});

test('provider registry rejects duplicate provider ids', () => {
  const registry = new providersModule.ProviderRegistry();
  const provider = {
    id: 'claude',
    displayName: 'Claude Code',
    capabilities: new Set(['sessions']),
    isAvailable: async () => true,
  };

  registry.register(provider);

  assert.throws(() => registry.register(provider), /Provider already registered: claude/);
});

test('provider registry getEnabled resolves requested ids in order and ignores unknown ids', () => {
  const registry = providersModule.createProviderRegistry();

  assert.deepEqual(
    registry.getEnabled(['codex', 'claude']).map(provider => provider.id),
    ['codex', 'claude'],
  );
  assert.deepEqual(
    registry.getEnabled(['claude', 'antigravity', 'bogus']).map(provider => provider.id),
    ['claude'],
  );
});

test('provider registry getEnabled excludes disabled providers', () => {
  const registry = providersModule.createProviderRegistry();

  assert.deepEqual(registry.getEnabled(['claude']).map(provider => provider.id), ['claude']);
  assert.deepEqual(registry.getEnabled([]).map(provider => provider.id), []);
});

test('source-backed Claude and Codex adapters expose discovery and source methods', () => {
  const registry = providersModule.createProviderRegistry();
  const claude = registry.get('claude');
  const codex = registry.get('codex');

  for (const provider of [claude, codex]) {
    assert.ok(provider.capabilities.has('sessions'));
    assert.ok(provider.capabilities.has('usage'));
    assert.ok(provider.capabilities.has('quota'));
    assert.equal(typeof provider.discoverSessions, 'function');
    assert.equal(typeof provider.ownsPath, 'function');
    assert.equal(typeof provider.listRecentSources, 'function');
    assert.equal(typeof provider.listAllSources, 'function');
    assert.equal(typeof provider.scanSourceSummary, 'function');
    assert.equal(typeof provider.buildStartupSession, 'function');
    assert.equal(typeof provider.isExcludedSource, 'function');
    assert.equal(typeof provider.fetchQuota, 'function');
  }
});
