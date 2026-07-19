import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import esbuild from 'esbuild';

async function loadModels() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-quota-models-'));
  const outfile = path.join(outdir, 'models.mjs');
  await esbuild.build({ entryPoints: [path.resolve('src/renderer/quotaDisplayModels.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(`${new URL(`file:///${outfile.replace(/\\/g, '/')}`).href}?${Date.now()}`);
}

const models = await loadModels();
const NOW = Date.parse('2026-07-18T00:00:00Z');
const EMPTY_STATS = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0, requestCount: 0, cacheEfficiency: 0, cacheSavingsUSD: 0 };

function target(id, label, defaultMode, defaultOrder) {
  return { id, label, defaultMode, defaultOrder, taskbarAbbreviation: label[0], hideCost: true };
}

function entry(key, targetValue, period, usedPct, options = {}) {
  const durationMs = period === '5h' ? 18_000_000 : period === '7d' ? 604_800_000 : null;
  return {
    key, target: targetValue, scope: options.scope ?? { kind: 'account' },
    state: options.unlimited ? 'unlimited' : 'limited',
    ...(!options.unlimited ? { usedPct } : {}),
    resetsAt: options.resetsAt === undefined ? (durationMs ? NOW + durationMs / 2 : NOW + 3_600_000) : options.resetsAt,
    durationMs, durationInferred: options.durationInferred ?? false, period,
    ...(options.binding ? { usageBinding: options.binding } : {}),
  };
}

function settings(overrides = {}) {
  return { enabledProviders: ['claude', 'antigravity', 'codex'], quotaTargetModes: {}, quotaTargetOrder: [], quotaTargetAbbreviations: {}, ...overrides };
}

function build(providerQuotas, usage = { entryStats: {} }, settingOverrides = {}) {
  return models.buildQuotaDisplayModels({ usage, providerQuotas, settings: settings(settingOverrides), historyWarmupPending: false, historyWarmupStartsAt: null, formatWarmupEta: () => '' });
}

const account = target('claude.group.account', 'Claude', 'rich', 0);
const fable = target('claude.group.fable', 'Fable', 'simple', 10);

test('groups rows directly by current target identity without placeholders', () => {
  const result = build({ claude: { provider: 'claude', source: 'api', capturedAt: NOW, entries: [
    entry('claude.account.5h', account, '5h', 0),
    entry('claude.account.7d', account, '7d', 20),
    entry('claude.fable.7d', fable, '7d', 30, { scope: { kind: 'model', label: 'Fable' } }),
  ] } });
  assert.deepEqual(result.targets.map(group => [group.id, group.rows.map(row => row.key)]), [
    [account.id, ['claude.account.5h', 'claude.account.7d']],
    [fable.id, ['claude.fable.7d']],
  ]);
});

test('unbound Fable renders in simple and user-selected rich mode without fabricated local stats', () => {
  const quotas = { claude: { provider: 'claude', source: 'api', capturedAt: NOW, entries: [entry('claude.fable.7d', fable, '7d', 56, { scope: { kind: 'model', label: 'Fable' } })] } };
  const simple = build(quotas);
  assert.equal(simple.simpleGroups[0].rows[0].hasLocalStats, false);
  assert.deepEqual(simple.simpleGroups[0].rows[0].stats, EMPTY_STATS);
  const rich = build(quotas, { entryStats: {} }, { quotaTargetModes: { [fable.id]: 'rich' } });
  assert.equal(rich.richGroups[0].rows[0].entry.usedPct, 56);
  assert.equal(rich.richGroups[0].rows[0].hasLocalStats, false);
});

test('bound genuine-zero stats remain distinguishable from an unbound entry', () => {
  const bound = entry('claude.account.5h', account, '5h', 0, { binding: { kind: 'all-provider-models' } });
  const row = build({ claude: { provider: 'claude', source: 'api', capturedAt: NOW, entries: [bound] } }, { entryStats: { [bound.key]: EMPTY_STATS } }).targets[0].rows[0];
  assert.equal(row.hasLocalStats, true);
  assert.deepEqual(row.stats, EMPTY_STATS);
  assert.equal(row.entry.usedPct, 0);
});

test('period-null Antigravity keeps reset countdown data but has no inferred elapsed contract', () => {
  const ag = target('antigravity.group.model.gemini', 'Gemini', 'simple', 100);
  const row = build({ antigravity: { provider: 'antigravity', source: 'localRpc', capturedAt: NOW, entries: [entry('antigravity.model.gemini', ag, null, 25)] } }).targets[0].rows[0];
  assert.equal(row.entry.resetsAt, NOW + 3_600_000);
  assert.equal(row.entry.durationMs, null);
  assert.equal(row.entry.period, null);
});

test('explicit unlimited and limited zero are separate canonical states', () => {
  const result = build({ claude: { provider: 'claude', source: 'api', capturedAt: NOW, entries: [
    entry('claude.account.5h', account, '5h', 0),
    entry('claude.account.7d', account, '7d', 0, { unlimited: true }),
  ] } });
  assert.deepEqual(result.targets[0].rows.map(row => [row.entry.state, row.entry.state === 'limited' ? row.entry.usedPct : null]), [['limited', 0], ['unlimited', null]]);
});

test('settings options contain only targets present in the selected snapshots', () => {
  const options = models.buildQuotaTargetSettingsOptions(settings(), { claude: { provider: 'claude', source: 'api', capturedAt: NOW, entries: [entry('claude.fable.7d', fable, '7d', 1)] } });
  assert.deepEqual(options.map(option => option.id), [fable.id]);
  assert.equal(options[0].taskbarEligible, true);
});

test('configured target ordering precedes canonical default order', () => {
  const quotas = { claude: { provider: 'claude', source: 'api', capturedAt: NOW, entries: [entry('claude.fable.7d', fable, '7d', 1), entry('claude.account.7d', account, '7d', 1)] } };
  assert.deepEqual(build(quotas).targets.map(group => group.id), [account.id, fable.id]);
  assert.deepEqual(build(quotas, { entryStats: {} }, { quotaTargetOrder: [fable.id, account.id] }).targets.map(group => group.id), [fable.id, account.id]);
});

test('credits and reset credits remain sibling cards outside entry grouping', () => {
  const result = build({ codex: {
    provider: 'codex', source: 'api', capturedAt: NOW, entries: [],
    credits: { extra: { available: 50, used: 50, total: 100, remainingPct: 50 } },
    resetCredits: { credits: [], availableCount: 2, totalEarnedCount: 3, checkedAt: NOW, countOnly: true, source: 'api', status: { connected: true, code: 'ok' } },
  } });
  assert.equal(result.targets.length, 0);
  assert.equal(result.extraUsage.utilization, 50);
  assert.equal(result.resetCredits.availableCount, 2);
});
