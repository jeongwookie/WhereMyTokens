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
