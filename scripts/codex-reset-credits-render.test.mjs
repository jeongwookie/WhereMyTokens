import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

async function loadModels() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-reset-'));
  const outfile = path.join(outdir, 'quotaDisplayModels.mjs');
  await esbuild.build({ entryPoints: [path.resolve('src', 'renderer', 'quotaDisplayModels.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

function resetSnapshot(overrides = {}) {
  return {
    provider: 'codex', source: 'api', capturedAt: Date.now(),
    groups: [
      { key: 'account', label: 'Codex', windowKeys: ['h5', 'week'], defaultMode: 'rich', sortOrder: 0 },
      { key: 'resets', label: 'Codex Resets', windowKeys: [], defaultMode: 'simple', sortOrder: 1 },
    ],
    windowDisplay: { h5: { label: '5h' }, week: { label: '1w' } },
    windows: { h5: { pct: 23, resetMs: 3600000, source: 'api' }, week: { pct: 58, resetMs: 86400000, source: 'api' } },
    status: { connected: true, code: 'ok' },
    resetCredits: {
      credits: [
        { idSuffix: 'aaa', status: 'available', expiresAtUtc: '2026-07-12T11:46:00Z' },
        { idSuffix: 'bbb', status: 'available', expiresAtUtc: '2026-07-18T08:36:00Z' },
      ],
      availableCount: 2, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api',
      status: { connected: true, code: 'ok' },
    },
    ...overrides,
  };
}

function baseOptions(snapshot) {
  return {
    usage: { byProvider: {}, modelWindows: {} },
    providerQuotas: { codex: snapshot },
    settings: { enabledProviders: ['codex'], quotaTargetModes: {}, quotaTargetOrder: [] },
    historyWarmupPending: false, historyWarmupStartsAt: null, formatWarmupEta: () => '',
  };
}

test('resets group appears as a settings target when resetCredits present', async () => {
  const M = await loadModels();
  const models = M.buildQuotaDisplayModels(baseOptions(resetSnapshot()));
  const resets = models.settingsTargets.find(g => g.label === 'Codex Resets');
  assert.ok(resets, 'Codex Resets target should exist');
  assert.equal(resets.provider, 'codex');
});

test('resets group is dropped when resetCredits is null', async () => {
  const M = await loadModels();
  const models = M.buildQuotaDisplayModels(baseOptions(resetSnapshot({ resetCredits: null })));
  const resets = models.settingsTargets.find(g => g.label === 'Codex Resets');
  assert.equal(resets, undefined, 'Codex Resets target should not exist without reset data');
});

test('formatCreditDuration renders 2d 4h / 9h 3m / 12m forms', async () => {
  const M = await loadModels();
  const HOUR = 3600000, MIN = 60000, DAY = 86400000;
  assert.equal(M.formatCreditDuration(2 * DAY + 4 * HOUR), '2d 4h');
  assert.equal(M.formatCreditDuration(9 * HOUR + 3 * MIN), '9h 3m');
  assert.equal(M.formatCreditDuration(12 * MIN), '12m');
  assert.equal(M.formatCreditDuration(0), '0m');
});

test('creditUrgencyBucket maps by soonest expiry', async () => {
  const M = await loadModels();
  const DAY = 86400000, HOUR = 3600000;
  assert.equal(M.creditUrgencyBucket(8 * DAY), 'ok');     // >7d
  assert.equal(M.creditUrgencyBucket(3 * DAY), 'warn');   // 1-7d
  assert.equal(M.creditUrgencyBucket(9 * HOUR), 'red');   // <24h
  assert.equal(M.creditUrgencyBucket(null), 'muted');     // no data
});

test('buildResetCreditsViewModel exposes sorted credits + count + next expiry + mode/source', async () => {
  const M = await loadModels();
  const now = Date.parse('2026-07-04T00:00:00Z');
  const vm = M.buildResetCreditsViewModel(resetSnapshot().resetCredits, now, 'rich');
  assert.equal(vm.availableCount, 2);
  assert.equal(vm.credits.length, 2);
  assert.equal(vm.credits[0].remainingMs > 0, true);
  assert.equal(vm.nextExpiryMs, vm.credits[0].remainingMs);
  assert.equal(vm.urgency, 'ok');
  assert.equal(vm.countOnly, false);
  assert.equal(vm.errored, false);
  assert.equal(vm.mode, 'rich');
  assert.equal(vm.source, 'api');
  assert.equal(vm.stale, false);
});

test('buildResetCreditsViewModel marks cached data stale and preserves checkedAt', async () => {
  const M = await loadModels();
  const now = Date.parse('2026-07-04T00:00:00Z');
  const cached = { ...resetSnapshot().resetCredits, source: 'cache', checkedAt: now - 3600000, status: { connected: false, code: 'ok' } };
  const vm = M.buildResetCreditsViewModel(cached, now, 'simple');
  assert.equal(vm.source, 'cache');
  assert.equal(vm.stale, true);
  assert.equal(vm.checkedAt, now - 3600000);   // last successful update reachable for the tooltip
});

test('buildQuotaDisplayModels routes the reset card independently of row-signal groups (F3)', async () => {
  const M = await loadModels();
  const models = M.buildQuotaDisplayModels(baseOptions(resetSnapshot()));
  assert.ok(models.resetCredits, 'resetCredits present on models despite empty windowKeys / zero rows');
  assert.equal(models.resetCredits.mode, 'simple');   // resets defaultMode
  assert.equal(models.resetCredits.availableCount, 2);
  // and it is NOT smuggled through richGroups/simpleGroups
  assert.equal(models.richGroups.some(g => g.label === 'Codex Resets'), false);
  assert.equal(models.simpleGroups.some(g => g.label === 'Codex Resets'), false);
});
