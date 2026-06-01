import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

async function loadQuotaDisplayModels() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-quota-display-'));
  const outfile = path.join(outdir, 'quotaDisplayModels.mjs');
  await esbuild.build({
    entryPoints: [path.resolve('src', 'renderer', 'quotaDisplayModels.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

function stats(totalTokens = 0) {
  return {
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens,
    costUSD: 0,
    requestCount: totalTokens > 0 ? 1 : 0,
    cacheEfficiency: 0,
    cacheSavingsUSD: 0,
  };
}

function quota(pct, source = 'api', resetMs = 60 * 60 * 1000) {
  return { pct, resetMs, source };
}

function baseOptions(settings = {}) {
  return {
    usage: {
      byProvider: {
        claude: { windows: { short: stats(1000), long: stats(2000), percent: stats(300) } },
        codex: { windows: { burst: stats(4000), durable: stats(5000) } },
      },
      models: [],
      heatmap: [],
      heatmap30: [],
      heatmap90: [],
      weeklyTimeline: [],
      todBuckets: [],
    },
    providerQuotas: {
      claude: {
        provider: 'claude',
        source: 'api',
        capturedAt: Date.now(),
        groups: [
          { key: 'primary', label: 'Provider Alpha', defaultMode: 'rich', windowKeys: ['short', 'long'], sortOrder: 0 },
          { key: 'percent-family', label: 'Percent Family', defaultMode: 'simple', windowKeys: ['percent'], sortOrder: 10 },
        ],
        windowDisplay: {
          short: { label: 'fast', visualKind: 'pace', cacheMetricTitle: 'Alpha cache metric', durationMs: 1_000 },
          long: { label: 'slow', visualKind: 'pace', cacheMetricTitle: 'Alpha cache metric', durationMs: 2_000 },
          percent: { label: 'quota', visualKind: 'percentOnly', hideCost: true, durationMs: 3_000 },
        },
        windows: { short: quota(10), long: quota(20), percent: quota(30) },
        status: { connected: true, code: 'ok' },
      },
      codex: {
        provider: 'codex',
        source: 'api',
        capturedAt: Date.now(),
        groups: [
          {
            key: 'account',
            label: 'Provider Beta',
            defaultMode: 'rich',
            windowKeys: ['burst', 'durable'],
            badges: [{ key: 'api', label: 'API', title: 'API backed' }],
            sortOrder: 5,
          },
        ],
        windowDisplay: {
          burst: { label: 'burst', visualKind: 'pace', cacheMetricTitle: 'Beta cache metric', durationMs: 4_000 },
          durable: { label: 'durable', visualKind: 'pace', cacheMetricTitle: 'Beta cache metric', durationMs: 5_000 },
        },
        windows: { burst: quota(40), durable: quota(50) },
        status: { connected: true, code: 'ok' },
      },
    },
    settings: {
      enabledProviders: ['claude', 'codex'],
      quotaTargetModes: {},
      ...settings,
    },
    historyWarmupPending: false,
    historyWarmupStartsAt: null,
    formatWarmupEta: () => 'now',
  };
}

test('quota display groups are built from provider metadata', async () => {
  const { buildQuotaDisplayModels } = await loadQuotaDisplayModels();
  const models = buildQuotaDisplayModels(baseOptions());

  assert.deepEqual(models.richGroups.map(group => group.label), ['Provider Alpha', 'Provider Beta']);
  assert.deepEqual(models.richGroups[0].rows.map(row => row.label), ['fast', 'slow']);
  assert.deepEqual(models.simpleGroups.map(group => group.label), ['Percent Family']);
  assert.deepEqual(models.simpleGroups[0].rows.map(row => row.visualKind), ['percentOnly']);
  assert.equal(models.simpleGroups[0].rows[0].hideCost, true);
  assert.equal(models.simpleGroups[0].rows[0].durationMs, 3000);
  assert.equal(models.richGroups[0].rows[0].cacheMetricTitle, 'Alpha cache metric');
  assert.equal(models.richGroups[1].badges.some(badge => badge.label === 'API'), true);
});

test('quota display groups hide missing rows from rendered targets while keeping settings metadata', async () => {
  const { buildQuotaDisplayModels } = await loadQuotaDisplayModels();
  const options = baseOptions({
    quotaTargetModes: {
      'codex.group.account': 'simple',
    },
  });
  delete options.providerQuotas.codex.windows.durable;
  options.usage.byProvider.codex.windows.durable = stats(0);

  const models = buildQuotaDisplayModels(options);
  const rendered = models.simpleGroups.find(group => group.id === 'codex.group.account');
  const settingsTarget = models.settingsTargets.find(group => group.id === 'codex.group.account');

  assert.deepEqual(rendered.rows.map(row => row.label), ['burst']);
  assert.deepEqual(settingsTarget.rows.map(row => row.label), ['burst', 'durable']);
});

test('quota display modes are group-level settings', async () => {
  const { buildQuotaDisplayModels } = await loadQuotaDisplayModels();
  const models = buildQuotaDisplayModels(baseOptions({
    quotaTargetModes: {
      'claude.group.primary': 'simple',
      'claude.group.percent-family': 'none',
      'codex.group.account': 'rich',
    },
  }));

  assert.deepEqual(models.richGroups.map(group => group.id), ['codex.group.account']);
  assert.deepEqual(models.simpleGroups.map(group => group.id), ['claude.group.primary']);
  assert.deepEqual(models.widgetGroups.map(group => group.id), ['claude.group.primary']);
  assert.deepEqual(models.settingsTargets.map(group => group.id), [
    'claude.group.primary',
    'codex.group.account',
    'claude.group.percent-family',
  ]);
});

test('quota display groups follow persisted target ordering before provider metadata order', async () => {
  const { buildQuotaDisplayModels } = await loadQuotaDisplayModels();
  const models = buildQuotaDisplayModels(baseOptions({
    quotaTargetOrder: [
      'claude.group.percent-family',
      'codex.group.account',
      'claude.group.primary',
    ],
  }));

  assert.deepEqual(models.settingsTargets.map(group => group.id), [
    'claude.group.percent-family',
    'codex.group.account',
    'claude.group.primary',
  ]);
  assert.deepEqual(models.richGroups.map(group => group.id), [
    'codex.group.account',
    'claude.group.primary',
  ]);
  assert.deepEqual(models.simpleGroups.map(group => group.id), [
    'claude.group.percent-family',
  ]);
});

test('generic quota display files avoid provider-specific UI branches', () => {
  for (const filePath of [
    'src/renderer/quotaDisplayModels.ts',
    'src/renderer/components/TokenStatsCard.tsx',
    'src/main/compactWidgetSizing.ts',
  ]) {
    const source = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(source, /provider\s*===\s*['"][^'"]+['"]/);
    assert.doesNotMatch(source, /cacheMetricMode|Claude:|Codex:/);
  }

  const mainSource = fs.readFileSync('src/renderer/views/MainView.tsx', 'utf8');
  const panelStart = mainSource.indexOf('const PlanUsagePanel');
  const panelEnd = mainSource.indexOf('const HistoryWarmupBanner', panelStart);
  const panelBody = mainSource.slice(panelStart, panelEnd);
  assert.doesNotMatch(panelBody, /providerQuotas\.claude|providerQuotas\.codex|provider\s*===/);

  const widgetSource = fs.readFileSync('src/renderer/views/CompactWidgetView.tsx', 'utf8');
  const agentsStart = widgetSource.indexOf('function buildWidgetAgents');
  const agentsEnd = widgetSource.indexOf('function buildHealthItems', agentsStart);
  const agentsBody = widgetSource.slice(agentsStart, agentsEnd);
  assert.doesNotMatch(agentsBody, /provider\s*===|enabledProviders\.has\(['"]/);
});

test('quota display models do not own usage visibility filtering', () => {
  const modelSource = fs.readFileSync('src/renderer/quotaDisplayModels.ts', 'utf8');

  assert.doesNotMatch(modelSource, /buildUsageVisibilityFilter/);
  assert.match(modelSource, /Extra usage is an account-credit balance/);
});
