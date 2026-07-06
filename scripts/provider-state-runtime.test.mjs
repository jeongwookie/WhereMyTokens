import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import stateManagerModule from '../dist/main/stateManager.js';
import providersModule from '../dist/main/providers/index.js';

const { StateManager } = stateManagerModule;
const { ProviderRegistry } = providersModule;

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

function makeSession(provider, sessionId) {
  return {
    provider,
    pid: null,
    sessionId,
    cwd: `/tmp/wmt-runtime-${provider}-${sessionId}`,
    projectName: 'proj',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    entrypoint: 'cli',
    source: 'Terminal',
    state: 'active',
    jsonlPath: null,
    lastModified: new Date('2026-01-01T00:00:00Z'),
    isWorktree: false,
    worktreeBranch: null,
    gitBranch: null,
    mainRepoName: null,
  };
}

function makeMockProvider(id, sessions) {
  const calls = { discover: 0 };
  const adapter = {
    id,
    displayName: id,
    capabilities: new Set(['sessions', 'usage']),
    isAvailable: async () => true,
    discoverSessions: () => {
      calls.discover += 1;
      return sessions;
    },
    ownsPath: () => false,
    listRecentSources: () => ({ sources: [], truncated: false }),
    listAllSources: () => ({ sources: [], truncated: false }),
    scanSourceSummary: async () => null,
    buildStartupSession: () => null,
    isExcludedSource: () => false,
  };
  return { adapter, calls };
}

function buildManager(enabledProviders, mocks) {
  const registry = new ProviderRegistry();
  for (const mock of mocks) registry.register(mock.adapter);
  const store = makeStore({ enabledProviders });
  return new StateManager(store, () => {}, { providerRegistry: registry });
}

test('assembly surfaces enabled provider sessions and never invokes disabled providers', async () => {
  const claude = makeMockProvider('claude', [makeSession('claude', 'c1')]);
  const codex = makeMockProvider('codex', [makeSession('codex', 'x1')]);
  const manager = buildManager(['claude'], [claude, codex]);

  const result = await manager.buildScopedSessionInfosDetailed(new Map());

  assert.equal(claude.calls.discover, 1, 'enabled provider should be discovered');
  assert.equal(codex.calls.discover, 0, 'disabled provider must not be invoked');
  assert.ok(result.sessions.some(session => session.sessionId === 'c1'));
  assert.ok(result.sessions.every(session => session.provider !== 'codex'));
});

test('codex sessions without a usage summary are skipped while claude sessions are retained', async () => {
  const claude = makeMockProvider('claude', [makeSession('claude', 'c1')]);
  const codex = makeMockProvider('codex', [makeSession('codex', 'x1')]);
  const manager = buildManager(['claude', 'codex'], [claude, codex]);

  const result = await manager.buildScopedSessionInfosDetailed(new Map());

  assert.equal(codex.calls.discover, 1, 'enabled codex provider should be invoked');
  assert.ok(result.sessions.some(session => session.sessionId === 'c1'));
  assert.ok(
    result.sessions.every(session => session.sessionId !== 'x1'),
    'codex session lacking a summary should be skipped',
  );
});

test('disabled Codex does not read or expose account service tier', () => {
  const originalReadFileSync = fs.readFileSync;
  let codexAccountReads = 0;
  fs.readFileSync = function patchedReadFileSync(file, ...args) {
    if (String(file).includes('.codex-global-state.json')) {
      codexAccountReads += 1;
      return JSON.stringify({
        'electron-persisted-atom-state': {
          'default-service-tier': 'team',
        },
      });
    }
    return originalReadFileSync.call(this, file, ...args);
  };

  try {
    const disabled = buildManager(['claude'], []);
    assert.equal(disabled.getState().codexAccount.serviceTier, null);
    assert.equal(codexAccountReads, 0);

    const enabled = buildManager(['codex'], []);
    assert.equal(enabled.getState().codexAccount.serviceTier, 'team');
    assert.equal(codexAccountReads, 1);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});
