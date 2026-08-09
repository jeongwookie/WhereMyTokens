import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import statusLineModule from '../dist/shared/claudeStatusLine.js';
import statusLineFileModule from '../dist/bridge/claudeStatusLineFile.js';
import claudeQuotaModule from '../dist/main/providers/claude/quota.js';
import compatibilityModule from '../dist/main/providers/claude/readOnlyUsage.js';
import bridgeWatcherModule from '../dist/main/bridgeWatcher.js';

const { normalizeClaudeStatusLineSnapshot } = statusLineModule;
const { readClaudeStatusLineFile, writeClaudeStatusLineFile } = statusLineFileModule;
const { buildClaudeCompatibilityQuota, buildClaudeStatusLineQuota, fetchClaudeQuota } = claudeQuotaModule;
const { __resetClaudeCompatibilityStateForTest, __setClaudeCompatibilityHttpForTest } = compatibilityModule;
const { BridgeWatcher } = bridgeWatcherModule;
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-claude-statusline-'));
  tempDirs.push(dir);
  return dir;
}

function legacyPayload(now, overrides = {}) {
  return {
    session_id: 'must-not-persist',
    cwd: 'C:\\private-project',
    transcript_path: 'C:\\private-transcript.jsonl',
    rate_limits: {
      five_hour: { used_percentage: 31, resets_at: Math.floor((now + 60_000) / 1000) },
      seven_day: { used_percentage: 62, resets_at: Math.floor((now + 120_000) / 1000) },
      model_scoped: [{
        display_name: 'Fable',
        utilization: 47,
        resets_at: new Date(now + 180_000).toISOString(),
      }],
    },
    ...overrides,
  };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test.afterEach(() => {
  __setClaudeCompatibilityHttpForTest(null);
  __resetClaudeCompatibilityStateForTest();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizer converts official reset seconds and accepts local model-scoped limits', () => {
  const now = Date.now();
  const snapshot = normalizeClaudeStatusLineSnapshot(legacyPayload(now), { nowMs: now, capturedAtMs: now });
  assert.ok(snapshot);
  assert.equal(snapshot.rateLimits.fiveHour.resetsAtMs, Math.floor((now + 60_000) / 1000) * 1000);
  assert.equal(snapshot.rateLimits.modelScoped[0].label, 'Fable');
  assert.equal(snapshot.rateLimits.modelScoped[0].usedPct, 47);
});

test('normalizer rejects quota-less, future, and malformed payloads', () => {
  const now = Date.now();
  assert.equal(normalizeClaudeStatusLineSnapshot({}, { nowMs: now, capturedAtMs: now }), null);
  assert.equal(normalizeClaudeStatusLineSnapshot(legacyPayload(now), {
    nowMs: now,
    capturedAtMs: now + 60_001,
  }), null);
  assert.equal(normalizeClaudeStatusLineSnapshot({
    rate_limits: { five_hour: { used_percentage: '31', resets_at: 1 } },
  }, { nowMs: now, capturedAtMs: now }), null);
});

test('writer stores only canonical quota data and updates atomically', () => {
  const now = Date.now();
  const dir = makeTempDir();
  const filePath = path.join(dir, 'live-session.json');
  assert.equal(writeClaudeStatusLineFile(legacyPayload(now), filePath, now), true);
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(raw, /session_id|cwd|transcript_path|private-project/);
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ['capturedAt', 'rateLimits', 'schemaVersion']);
});

test('reader atomically minimizes an existing legacy snapshot on upgrade', () => {
  const now = Date.now();
  const dir = makeTempDir();
  const filePath = path.join(dir, 'live-session.json');
  fs.writeFileSync(filePath, JSON.stringify({ ...legacyPayload(now), _ts: now }), 'utf8');
  const snapshot = readClaudeStatusLineFile(filePath, now);
  assert.ok(snapshot);
  const migrated = fs.readFileSync(filePath, 'utf8');
  assert.equal(migrated, JSON.stringify(snapshot));
  assert.doesNotMatch(migrated, /session_id|cwd|transcript_path|private-project/);
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
});

test('reader removes invalid legacy files and disabled watcher reads nothing', () => {
  const now = Date.now();
  const filePath = path.join(makeTempDir(), 'live-session.json');
  fs.writeFileSync(filePath, JSON.stringify({ session_id: 'legacy-private-field', _ts: now }), 'utf8');
  let notified = false;
  const watcher = new BridgeWatcher(() => { notified = true; }, filePath, () => false);
  watcher.readAndNotify();
  assert.equal(notified, false);
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(readClaudeStatusLineFile(filePath, now), null);
  assert.equal(fs.existsSync(filePath), false);
});

test('an older write cannot replace a newer trusted snapshot', () => {
  const now = Date.now();
  const filePath = path.join(makeTempDir(), 'live-session.json');
  assert.equal(writeClaudeStatusLineFile(legacyPayload(now), filePath, now + 10), true);
  assert.equal(writeClaudeStatusLineFile(legacyPayload(now, {
    rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor((now + 60_000) / 1000) } },
  }), filePath, now), false);
  assert.equal(readClaudeStatusLineFile(filePath, now + 10).rateLimits.fiveHour.usedPct, 31);
});

test('an old lock owned by a live process is never stolen by elapsed time alone', () => {
  const now = Date.now();
  const filePath = path.join(makeTempDir(), 'live-session.json');
  assert.equal(writeClaudeStatusLineFile(legacyPayload(now), filePath, now), true);
  const lockPath = `${filePath}.lock`;
  fs.writeFileSync(lockPath, `${process.pid}:00000000-0000-4000-8000-000000000000`, 'utf8');
  const oldTime = new Date(now - 60_000);
  fs.utimesSync(lockPath, oldTime, oldTime);
  assert.equal(writeClaudeStatusLineFile(legacyPayload(now, {
    rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor((now + 60_000) / 1000) } },
  }), filePath, now + 1), false);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).rateLimits.fiveHour.usedPct, 31);
  fs.rmSync(lockPath, { force: true });
});

test('an old malformed lock with a live PID prefix is recovered', () => {
  const now = Date.now();
  const filePath = path.join(makeTempDir(), 'live-session.json');
  assert.equal(writeClaudeStatusLineFile(legacyPayload(now), filePath, now), true);
  const lockPath = `${filePath}.lock`;
  fs.writeFileSync(lockPath, `${process.pid}:`, 'utf8');
  const oldTime = new Date(now - 60_000);
  fs.utimesSync(lockPath, oldTime, oldTime);
  assert.equal(writeClaudeStatusLineFile(legacyPayload(now, {
    rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor((now + 60_000) / 1000) } },
  }), filePath, now + 1), true);
  assert.equal(readClaudeStatusLineFile(filePath).rateLimits.fiveHour.usedPct, 99);
  assert.equal(fs.existsSync(lockPath), false);
});

test('overlapping bridge processes preserve the newest process-start snapshot', async () => {
  const now = Date.now();
  const appData = makeTempDir();
  const bridgePath = path.resolve('dist', 'bridge', 'bridge.js');
  const env = { ...process.env, APPDATA: appData };
  const older = spawn(process.execPath, [bridgePath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  await delay(250);
  const newer = spawn(process.execPath, [bridgePath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  await delay(250);

  const newerExit = waitForExit(newer);
  newer.stdin.end(JSON.stringify(legacyPayload(now, {
    rate_limits: { five_hour: { used_percentage: 88, resets_at: Math.floor((now + 60_000) / 1000) } },
  })));
  assert.deepEqual(await newerExit, { code: 0, signal: null });

  const olderExit = waitForExit(older);
  older.stdin.end(JSON.stringify(legacyPayload(now, {
    rate_limits: { five_hour: { used_percentage: 11, resets_at: Math.floor((now + 60_000) / 1000) } },
  })));
  assert.deepEqual(await olderExit, { code: 0, signal: null });

  const filePath = path.join(appData, 'WhereMyTokens', 'live-session.json');
  assert.equal(readClaudeStatusLineFile(filePath).rateLimits.fiveHour.usedPct, 88);
  assert.equal(fs.existsSync(`${filePath}.lock`), false);
});

test('quota builder exposes Fable only when Claude reports it locally', () => {
  const now = Date.now();
  const snapshot = normalizeClaudeStatusLineSnapshot(legacyPayload(now), { nowMs: now, capturedAtMs: now });
  const quota = buildClaudeStatusLineQuota(snapshot, now);
  assert.equal(quota.source, 'statusLine');
  assert.equal(quota.status.connected, true);
  assert.deepEqual(quota.entries.map(entry => entry.key), [
    'claude.account.5h',
    'claude.account.7d',
    'claude.fable.7d',
  ]);
  assert.equal(quota.entries[2].target.badges[0].label, 'Local');
});

test('compatibility account quota carries an explicit Compat badge', () => {
  const now = Date.now();
  const quota = buildClaudeCompatibilityQuota({
    fiveHour: { usedPct: 12, resetsAtMs: now + 60_000 },
    sevenDay: { usedPct: 34, resetsAtMs: now + 120_000 },
    modelScoped: [],
    planName: 'Max',
    extraUsage: null,
  }, now, now);
  assert.deepEqual(quota.entries.map(entry => entry.target.badges?.[0]?.label), ['Compat', 'Compat']);
});

test('stale snapshots remain cached only until each reported reset', () => {
  const now = Date.now();
  const snapshot = normalizeClaudeStatusLineSnapshot(legacyPayload(now), { nowMs: now, capturedAtMs: now - 10 * 60_000 });
  const beforeReset = buildClaudeStatusLineQuota(snapshot, now);
  assert.equal(beforeReset.source, 'cache');
  assert.equal(beforeReset.entries.length, 3);
  const afterFiveHourReset = buildClaudeStatusLineQuota(snapshot, now + 90_000);
  assert.deepEqual(afterFiveHourReset.entries.map(entry => entry.key), [
    'claude.account.7d',
    'claude.fable.7d',
  ]);
  const afterAllResets = buildClaudeStatusLineQuota(snapshot, now + 240_000);
  assert.deepEqual(afterAllResets.entries, []);
});

test('stale snapshots expire after 30 minutes even when reset times are later', () => {
  const now = Date.now();
  const snapshot = normalizeClaudeStatusLineSnapshot(legacyPayload(now, {
    rate_limits: {
      five_hour: { used_percentage: 31, resets_at: Math.floor((now + 4 * 60 * 60_000) / 1000) },
      seven_day: { used_percentage: 62, resets_at: Math.floor((now + 6 * 24 * 60 * 60_000) / 1000) },
    },
  }), { nowMs: now, capturedAtMs: now - 31 * 60_000 });
  const quota = buildClaudeStatusLineQuota(snapshot, now);
  assert.deepEqual(quota.entries, []);
  assert.equal(quota.status.code, 'bridge-unavailable');
});

test('bundled bridge preserves the last good snapshot on invalid or oversized input', () => {
  const now = Date.now();
  const appData = makeTempDir();
  const bridgePath = path.resolve('dist', 'bridge', 'bridge.js');
  const env = { ...process.env, APPDATA: appData };
  const first = spawnSync(process.execPath, [bridgePath], {
    input: JSON.stringify(legacyPayload(now)),
    env,
    encoding: 'utf8',
  });
  assert.equal(first.status, 0, first.stderr);
  const filePath = path.join(appData, 'WhereMyTokens', 'live-session.json');
  const saved = fs.readFileSync(filePath, 'utf8');
  const invalid = spawnSync(process.execPath, [bridgePath], { input: '{', env, encoding: 'utf8' });
  assert.equal(invalid.status, 0, invalid.stderr);
  assert.equal(fs.readFileSync(filePath, 'utf8'), saved);
  const oversized = spawnSync(process.execPath, [bridgePath], {
    input: JSON.stringify({ padding: 'x'.repeat(300 * 1024) }),
    env,
    encoding: 'utf8',
  });
  assert.equal(oversized.status, 0, oversized.stderr);
  assert.equal(fs.readFileSync(filePath, 'utf8'), saved);
});

test('Claude quota fetch prefers a fresh local bridge and uses read-only compatibility otherwise', async () => {
  const originalAppData = process.env.APPDATA;
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const appData = makeTempDir();
  const claudeConfig = makeTempDir();
  process.env.APPDATA = appData;
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  fs.writeFileSync(path.join(claudeConfig, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'compat-access', subscriptionType: 'max' },
  }));
  let compatibilityCalls = 0;
  __setClaudeCompatibilityHttpForTest(async () => {
    compatibilityCalls += 1;
    return { status: 200, body: JSON.stringify({
      five_hour: { utilization: 44, resets_at: '2099-01-01T00:00:00Z' },
      seven_day: { utilization: 55, resets_at: '2099-01-02T00:00:00Z' },
    }), headers: {} };
  });
  try {
    const now = Date.now();
    const compatibility = await fetchClaudeQuota({ nowMs: now, force: false });
    assert.equal(compatibility.status.code, 'compatibility-api');
    assert.equal(compatibility.source, 'api');
    assert.equal(compatibilityCalls, 1);
    const filePath = path.join(appData, 'WhereMyTokens', 'live-session.json');
    assert.equal(writeClaudeStatusLineFile(legacyPayload(now), filePath, now), true);
    const quota = await fetchClaudeQuota({ nowMs: now, force: false });
    assert.equal(quota.source, 'statusLine');
    assert.equal(quota.entries.length, 3);
    assert.equal(compatibilityCalls, 1);
  } finally {
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
});

test('Claude compatibility source contains no token refresh or credential write path', () => {
  const files = [
    'src/bridge/bridge.ts',
    'src/bridge/claudeStatusLineFile.ts',
    'src/main/providers/claude/quota.ts',
    'src/main/providers/claude/readOnlyUsage.ts',
    'src/main/stateManager.ts',
    'src/main/index.ts',
  ];
  const source = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  assert.match(source, /api\/oauth\/usage/);
  assert.doesNotMatch(source, /v1\/oauth\/token|platform\.claude\.com\/v1\/oauth|refresh_token|refreshToken\s*[:=]/i);
  const compatibilitySource = fs.readFileSync('src/main/providers/claude/readOnlyUsage.ts', 'utf8');
  assert.doesNotMatch(compatibilitySource, /writeFile|renameSync|createWriteStream|appendFile/);
  assert.equal(fs.existsSync('src/main/oauthRefresh.ts'), false);
  assert.equal(fs.existsSync('src/main/rateLimitFetcher.ts'), false);
  const bundle = fs.readFileSync('dist/bridge/bridge.js', 'utf8');
  assert.doesNotMatch(bundle, /\.\.\/main\/claudeStatusLineFile|\.\.\/shared\/claudeStatusLine/);
});
