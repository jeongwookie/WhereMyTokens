import assert from 'node:assert/strict';
import test from 'node:test';
import startup from '../dist/main/startupStateSnapshot.js';

const { STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION, makeStartupStateSnapshot, normalizeStartupStateSnapshot } = startup;
const NOW = Date.parse('2026-07-18T00:00:00Z');
const BASE = {
  initialRefreshComplete: false,
  historyWarmupPending: true,
  historyWarmupStartsAt: NOW,
  codeOutputLoading: true,
  lastUpdated: NOW,
  sessions: [],
  repoGitStats: {},
  providerQuotas: {},
};

test('startup snapshot schema is bumped for the atomic quota cutover', () => {
  assert.equal(STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION, 6);
});

test('startup persistence strips every provider quota snapshot', () => {
  const saved = makeStartupStateSnapshot({
    ...BASE,
    providerQuotas: {
      claude: { provider: 'claude', windows: { h5: { pct: 1 } } },
      codex: { provider: 'codex', entries: [{ key: 'private' }] },
      antigravity: { provider: 'antigravity', entries: [{ key: 'model' }] },
    },
  }, NOW);
  assert.deepEqual(saved.state.providerQuotas, {});
  assert.equal(saved.state.initialRefreshComplete, true);
  assert.equal(saved.state.historyWarmupPending, false);
});

test('startup persistence removes settings and sanitizes session paths', () => {
  const saved = makeStartupStateSnapshot({
    ...BASE,
    settings: { secret: true },
    sessions: [{ pid: 123, cwd: 'D:/private', projectName: 'secret', jsonlPath: 'D:/private/log.jsonl' }],
  }, NOW);
  assert.equal('settings' in saved.state, false);
  assert.equal(saved.state.sessions[0].pid, null);
  assert.equal(saved.state.sessions[0].cwd, '');
  assert.equal(saved.state.sessions[0].jsonlPath, null);
});

test('normalizer rejects prior and future schemas', () => {
  const current = makeStartupStateSnapshot(BASE, NOW);
  assert.equal(normalizeStartupStateSnapshot({ ...current, schemaVersion: 5 }, BASE, NOW), null);
  assert.equal(normalizeStartupStateSnapshot({ ...current, schemaVersion: 7 }, BASE, NOW), null);
});

test('normalizer restores only fresh schema-valid snapshots', () => {
  const current = makeStartupStateSnapshot(BASE, NOW);
  const restored = normalizeStartupStateSnapshot(current, BASE, NOW + 1000);
  assert.equal(restored.stateFreshness, 'restored');
  assert.equal(restored.initialRefreshComplete, true);
  assert.deepEqual(restored.providerQuotas, {});
  assert.equal(normalizeStartupStateSnapshot(current, BASE, NOW + 8 * 24 * 60 * 60 * 1000), null);
});
