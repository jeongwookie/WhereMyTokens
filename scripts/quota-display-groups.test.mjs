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
      modelWindows: {},
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

test('quota display groups keep waiting rows when provider quota is disconnected', async () => {
  const { buildQuotaDisplayModels } = await loadQuotaDisplayModels();
  const options = baseOptions();
  options.providerQuotas.codex.status = { connected: false, code: 'no-credentials', label: 'login required' };
  options.providerQuotas.codex.windows = {};
  options.usage.byProvider.codex.windows.burst = stats(0);
  options.usage.byProvider.codex.windows.durable = stats(0);

  const models = buildQuotaDisplayModels(options);
  const rendered = models.richGroups.find(group => group.id === 'codex.group.account');

  assert.ok(rendered);
  assert.deepEqual(rendered.rows.map(row => row.label), ['burst', 'durable']);
  assert.equal(rendered.rows.every(row => row.apiConnected === false), true);
});

test('quota display groups render unlimited quota rows as ready provider data', async () => {
  const { buildQuotaDisplayModels } = await loadQuotaDisplayModels();
  const options = baseOptions({
    quotaTargetModes: {
      'codex.group.account': 'simple',
    },
  });
  options.providerQuotas.codex.windows.burst = {
    pct: 0,
    resetMs: null,
    limitState: 'unlimited',
    source: 'api',
  };
  options.usage.byProvider.codex.windows.burst = stats(0);
  delete options.providerQuotas.codex.windows.durable;
  options.usage.byProvider.codex.windows.durable = stats(0);

  const models = buildQuotaDisplayModels(options);
  const rendered = models.simpleGroups.find(group => group.id === 'codex.group.account');

  assert.ok(rendered);
  assert.deepEqual(rendered.rows.map(row => row.label), ['burst']);
  assert.equal(rendered.rows[0].pending, false);
  assert.equal(rendered.rows[0].quota.limitState, 'unlimited');
  assert.equal(rendered.rows[0].apiConnected, true);
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

test('rich card rows pair visible cards by provider and leave odd cards full width', async () => {
  const { buildQuotaDisplayModels, buildRichCardRows } = await loadQuotaDisplayModels();
  const options = baseOptions({
    quotaTargetOrder: [
      'claude.group.primary',
      'codex.group.account',
      'claude.group.extra',
    ],
  });
  options.providerQuotas.claude.groups.push({
    key: 'extra',
    label: 'Provider Alpha Extra',
    defaultMode: 'rich',
    windowKeys: ['extra'],
    sortOrder: 1,
  });
  options.providerQuotas.claude.windowDisplay.extra = {
    label: 'extra',
    visualKind: 'pace',
    cacheMetricTitle: 'Alpha cache metric',
    durationMs: 6_000,
  };
  options.providerQuotas.claude.windows.extra = quota(60);
  options.usage.byProvider.claude.windows.extra = stats(6_000);

  const models = buildQuotaDisplayModels(options);
  const rows = buildRichCardRows(models.richGroups);

  assert.deepEqual(rows.map(row => row.provider), ['claude', 'claude', 'codex']);
  assert.deepEqual(rows.map(row => row.cards.length), [2, 1, 2]);
  assert.deepEqual(rows.map(row => row.cards.map(card => `${card.group.label}:${card.row.label}`)), [
    ['Provider Alpha:fast', 'Provider Alpha:slow'],
    ['Provider Alpha Extra:extra'],
    ['Provider Beta:burst', 'Provider Beta:durable'],
  ]);
});

test('antigravity snapshots with models and no groups render model fallback groups', async () => {
  const { buildQuotaDisplayModels } = await loadQuotaDisplayModels();
  const options = baseOptions({
    enabledProviders: ['antigravity'],
  });
  options.providerQuotas = {
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: Date.now(),
      status: { connected: true, code: 'connected' },
      models: [
        { model: 'MODEL_GEMINI_3_PRO', label: 'Gemini 3 Pro', remainingPct: 70, defaultMode: 'simple', visualKind: 'percentOnly', hideCost: true },
        { model: 'MODEL_CLAUDE_OPUS', label: 'Claude Opus', remainingPct: 30, defaultMode: 'simple', visualKind: 'percentOnly', hideCost: true },
        { model: 'MODEL_OTHER', label: 'Other Model', remainingPct: 90, defaultMode: 'none', visualKind: 'percentOnly', hideCost: true },
      ],
    },
  };

  const models = buildQuotaDisplayModels(options);

  const byLabel = new Map(models.simpleGroups.map(group => [group.label, group]));
  assert.deepEqual([...byLabel.keys()].sort(), ['Claude Opus', 'Gemini 3 Pro']);
  assert.equal(byLabel.get('Gemini 3 Pro').rows[0].quotaPct, 30);
  assert.equal(byLabel.get('Claude Opus').rows[0].quotaPct, 70);
  assert.equal(models.targets.find(group => group.label === 'Other Model').mode, 'none');
  assert.equal(models.targets.every(group => group.provider === 'antigravity'), true);
});

test('model fallback rich cards use a generic quota row and preserve provider quota source', async () => {
  const { buildQuotaDisplayModels, buildQuotaTargetSettingsOptions } = await loadQuotaDisplayModels();
  const options = baseOptions({
    enabledProviders: ['antigravity'],
  });
  options.providerQuotas = {
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: Date.now(),
      status: { connected: true, code: 'connected' },
      models: [
        { model: 'MODEL_GEMINI_3_PRO', label: 'Gemini 3 Pro', remainingPct: 42, resetMs: 90_000, durationMs: 5 * 60 * 60 * 1000, defaultMode: 'rich', visualKind: 'pace', hideCost: true },
      ],
    },
  };

  const models = buildQuotaDisplayModels(options);
  const group = models.richGroups[0];
  const settingsTargets = buildQuotaTargetSettingsOptions(options.settings, options.providerQuotas);
  const settingsTarget = settingsTargets.find(target => target.label === 'Gemini 3 Pro');

  assert.equal(group.label, 'Gemini 3 Pro');
  assert.equal(group.rows[0].label, 'Quota');
  assert.equal(group.rows[0].quota.source, 'localRpc');
  assert.equal(group.badges.some(badge => badge.label === 'RPC'), true);
  assert.equal(settingsTarget.period, '5h');
  assert.equal(settingsTarget.taskbarEligible, true);
});

test('model fallback quota rows attach matching model usage stats', async () => {
  const { buildQuotaDisplayModels } = await loadQuotaDisplayModels();
  const options = baseOptions({
    enabledProviders: ['antigravity'],
  });
  options.usage.models = [
    { provider: 'antigravity', model: 'Gemini 3 Pro', tokens: 99_999, costUSD: 9 },
    { provider: 'codex', model: 'Gemini 3 Pro', tokens: 99_999, costUSD: 9 },
  ];
  options.usage.modelWindows = {
    antigravity: {
      windows: {
        h5: {
          'Gemini 3 Pro': {
            inputTokens: 1000,
            outputTokens: 2000,
            cacheCreationTokens: 3000,
            cacheReadTokens: 6345,
            totalTokens: 12_345,
            costUSD: 0.456,
            requestCount: 3,
            cacheEfficiency: 67,
            cacheSavingsUSD: 0.123,
          },
          'Gemini 3 Flash': stats(50_000),
        },
        week: {
          'Gemini 3 Pro': stats(88_888),
        },
      },
    },
  };
  options.providerQuotas = {
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: Date.now(),
      status: { connected: true, code: 'connected' },
      models: [
        {
          model: 'MODEL_GEMINI_3_PRO',
          label: 'Gemini 3 Pro',
          usageModel: 'Gemini 3 Pro',
          remainingPct: 42,
          defaultMode: 'rich',
          visualKind: 'pace',
          durationMs: 5 * 60 * 60 * 1000,
          hideCost: false,
        },
      ],
    },
  };

  const models = buildQuotaDisplayModels(options);
  const row = models.richGroups[0].rows[0];

  assert.equal(row.stats.totalTokens, 12_345);
  assert.equal(row.stats.costUSD, 0.456);
  assert.equal(row.stats.requestCount, 3);
  assert.equal(models.richGroups[0].badges.some(badge => badge.key === 'tokens.total'), false);
  assert.equal(models.richGroups[0].badges.some(badge => badge.key === 'cost.total'), false);
});

test('pace model quota rows fall back to duration bucket stats when dedicated model window is empty', async () => {
  const { buildQuotaDisplayModels } = await loadQuotaDisplayModels();
  const options = baseOptions({
    enabledProviders: ['antigravity'],
  });
  options.usage.modelWindows = {
    antigravity: {
      windows: {
        'model.MODEL_GEMINI_3_PRO': {},
        h5: {
          'Gemini 3 Pro': {
            inputTokens: 1000,
            outputTokens: 2000,
            cacheCreationTokens: 3000,
            cacheReadTokens: 6345,
            totalTokens: 12_345,
            costUSD: 0.456,
            requestCount: 3,
            cacheEfficiency: 67,
            cacheSavingsUSD: 0.123,
          },
        },
      },
    },
  };
  options.providerQuotas = {
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: Date.now(),
      status: { connected: true, code: 'connected' },
      models: [
        {
          model: 'MODEL_GEMINI_3_PRO',
          label: 'Gemini 3 Pro',
          usageModel: 'Gemini 3 Pro',
          remainingPct: 42,
          defaultMode: 'rich',
          visualKind: 'pace',
          durationMs: 5 * 60 * 60 * 1000,
          statsWindowKey: 'model.MODEL_GEMINI_3_PRO',
          hideCost: false,
        },
      ],
    },
  };

  const models = buildQuotaDisplayModels(options);
  const row = models.richGroups[0].rows[0];

  assert.equal(row.stats.totalTokens, 12_345);
  assert.equal(row.stats.costUSD, 0.456);
});

test('model fallback quota rows preserve precomputed cache efficiency from usage windows', async () => {
  const { buildQuotaDisplayModels } = await loadQuotaDisplayModels();
  const options = baseOptions({
    enabledProviders: ['antigravity'],
  });
  options.usage.modelWindows = {
    antigravity: {
      windows: {
        h5: {
          'Gemini 3 Pro': {
            inputTokens: 8500,
            outputTokens: 5900,
            cacheCreationTokens: 0,
            cacheReadTokens: 167_200,
            totalTokens: 181_600,
            costUSD: 0.1211,
            requestCount: 1,
            cacheEfficiency: 95.16277746176665,
            cacheSavingsUSD: 0.1834,
          },
        },
      },
    },
  };
  options.providerQuotas = {
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: Date.now(),
      status: { connected: true, code: 'connected' },
      models: [
        {
          model: 'MODEL_GEMINI_3_PRO',
          label: 'Gemini 3 Pro',
          usageModel: 'Gemini 3 Pro',
          remainingPct: 80,
          defaultMode: 'rich',
          visualKind: 'pace',
          durationMs: 5 * 60 * 60 * 1000,
          hideCost: false,
        },
      ],
    },
  };

  const models = buildQuotaDisplayModels(options);
  const row = models.richGroups[0].rows[0];

  assert.equal(Math.round(row.stats.cacheEfficiency), 95);
});

test('model fallback quota badges do not show all-time token or cost totals', async () => {
  const { buildQuotaDisplayModels } = await loadQuotaDisplayModels();
  const options = baseOptions({
    enabledProviders: ['antigravity'],
  });
  options.usage.models = [
    { provider: 'antigravity', model: 'Gemini 3 Pro', tokens: 12_345, costUSD: 0.123 },
    { provider: 'codex', model: 'Gemini 3 Pro', tokens: 88_888, costUSD: 8 },
  ];
  options.usage.modelWindows = {
    antigravity: {
      windows: {
        'model.MODEL_GEMINI_3_PRO': {},
      },
    },
  };
  options.providerQuotas = {
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: Date.now(),
      status: { connected: true, code: 'connected' },
      models: [
        {
          model: 'MODEL_GEMINI_3_PRO',
          label: 'Gemini 3 Pro',
          usageModel: 'Gemini 3 Pro',
          remainingPct: 42,
          defaultMode: 'simple',
          visualKind: 'pace',
          durationMs: 5 * 60 * 60 * 1000,
          hideCost: false,
        },
      ],
    },
  };

  const models = buildQuotaDisplayModels(options);
  const group = models.simpleGroups[0];

  assert.equal(group.rows[0].stats.totalTokens, 0);
  assert.equal(group.badges.some(badge => badge.key === 'tokens.total'), false);
  assert.equal(group.badges.some(badge => badge.key === 'cost.total'), false);
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
  assert.match(panelBody, /buildRichCardRows\(richGroups\)/);
  assert.match(panelBody, /richRows\.map/);
  assert.doesNotMatch(panelBody, /gridTemplateColumns:\s*group\.rows\.length/);
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
