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

// --- Task 7b: renderer IPC-state normalizer (anti-假接入 boundary, R7-1) ---

// Shared esbuild helper: bundle a renderer .tsx/.ts entry, import it.
// Task 8+ reuse this to render components; here it drives the real App.tsx normalizer.
// `packages: 'external'` leaves every npm import (react, react-dom, lucide-react, …) for
// node to resolve from node_modules — so react stays a singleton shared with
// react-dom/server, and lucide-react loads its ESM build instead of esbuild inlining the
// CJS build (whose module-eval `require('react')` throws under ESM). Only our own relative
// source is bundled; App.tsx has no top-level render side effect, so importing it is safe.
async function importComponent(entry, name) {
  const outdir = fs.mkdtempSync(path.resolve(`.tmp-${name}-`));
  const outfile = path.join(outdir, `${name}.mjs`);
  await esbuild.build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'silent' });
  const mod = await import(pathToFileURL(outfile).href);
  fs.rmSync(outdir, { recursive: true, force: true });
  return mod;
}

test('renderer normalizeProviderQuotas preserves resetCredits (R7-1 anti-假接入)', async () => {
  const mod = await importComponent(path.resolve('src', 'renderer', 'App.tsx'), 'AppNormalize');
  const { normalizeProviderQuotas } = mod;
  const out = normalizeProviderQuotas({
    codex: {
      provider: 'codex', source: 'api', capturedAt: 1,
      resetCredits: {
        credits: [{ idSuffix: 'aaa', status: 'available', expiresAtUtc: '2026-07-12T00:00:00Z', title: 'leak' }],
        availableCount: 1, totalEarnedCount: 0, checkedAt: 123, countOnly: false, source: 'api',
        status: { connected: true, code: 'ok', httpStatus: 200 },
      },
    },
  });
  assert.ok(out.codex.resetCredits, 'resetCredits survives renderer IPC normalization');
  assert.equal(out.codex.resetCredits.credits.length, 1);
  assert.deepEqual(Object.keys(out.codex.resetCredits.credits[0]).sort(), ['expiresAtUtc', 'idSuffix', 'status']);
  assert.equal(out.codex.resetCredits.availableCount, 1);
  assert.equal(out.codex.resetCredits.status.code, 'ok');
  assert.equal('httpStatus' in out.codex.resetCredits.status, false); // public status shape only
});

// --- Task 7 xreview backfill: cross-phase integration bugs the unit tests missed ---

// F1 (BLOCKER): the `resets` group has empty windowKeys; the renderer IPC normalizer must
// NOT drop it, else the "Codex Resets" settings row is invisible in the running app. Drives
// the REAL App.tsx normalizer (anti-假接入), unlike the Task 6 test which bypasses it.
test('renderer normalizeProviderQuotas keeps the empty-windowKeys resets group (F1)', async () => {
  const app = await importComponent(path.resolve('src', 'renderer', 'App.tsx'), 'AppGroupNorm');
  const out = app.normalizeProviderQuotas({ codex: resetSnapshot() });
  const groups = out.codex.groups ?? [];
  const resets = groups.find(g => g.key === 'resets');
  assert.ok(resets, 'resets group survives renderer IPC normalization');
  assert.deepEqual(resets.windowKeys, [], 'resets keeps its empty windowKeys');
  // End-to-end: the normalized snapshot must still surface the settings target.
  const M = await loadModels();
  const models = M.buildQuotaDisplayModels(baseOptions(out.codex));
  assert.ok(models.settingsTargets.find(g => g.label === 'Codex Resets'), 'settings target present after real IPC normalization');
});

// F2 (MAJOR): reset card routing must respect the enabledProviders gate like every other group.
test('reset card is null when codex is not an enabled provider (F2)', async () => {
  const M = await loadModels();
  const opts = baseOptions(resetSnapshot());
  opts.settings = { ...opts.settings, enabledProviders: ['claude'] };  // codex NOT enabled
  const models = M.buildQuotaDisplayModels(opts);
  assert.equal(models.resetCredits, null, 'no reset card when codex disabled');
});
