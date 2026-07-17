import test from 'node:test';
import assert from 'node:assert/strict';

import snapshotModule from '../dist/main/taskbarQuotaSnapshot.js';

const {
  buildTaskbarQuotaSnapshot,
  resolveQuotaAbbreviation,
} = snapshotModule;

const H5 = 5 * 60 * 60 * 1000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

function settings(overrides = {}) {
  return {
    enabledProviders: ['claude', 'codex', 'antigravity'],
    quotaTargetModes: {},
    quotaTargetOrder: [],
    quotaTargetAbbreviations: {},
    taskbarQuotaEnabled: false,
    taskbarQuotaMaxBlocks: 2,
    ...overrides,
  };
}

function state(settingsOverrides = {}, providerQuotas = {}) {
  return {
    lastUpdated: 1234,
    settings: settings(settingsOverrides),
    providerQuotas,
  };
}

function accountQuota(provider, label, h5Pct = 40, weekPct = 30) {
  return {
    provider,
    source: 'api',
    capturedAt: 1000,
    windows: {
      h5: { pct: h5Pct, resetMs: H5 / 2, source: 'api' },
      week: { pct: weekPct, resetMs: WEEK / 2, source: 'api' },
    },
    groups: [
      {
        key: 'account',
        label,
        windowKeys: ['h5', 'week'],
        defaultMode: 'rich',
      },
    ],
    windowDisplay: {
      h5: { label: '5h', visualKind: 'pace', durationMs: H5 },
      week: { label: '1w', visualKind: 'pace', durationMs: WEEK },
    },
    status: { connected: true, code: 'ok' },
  };
}

test('resolves taskbar abbreviations from overrides, provider defaults, and target label fallback', () => {
  assert.equal(resolveQuotaAbbreviation('claude.group.account', 'claude', 'Claude', settings()), 'C');
  assert.equal(resolveQuotaAbbreviation('claude.group.sonnet', 'claude', 'Sonnet', settings()), 'S');
  assert.equal(resolveQuotaAbbreviation('codex.group.account', 'codex', 'Codex', settings()), 'CX');
  assert.equal(resolveQuotaAbbreviation('antigravity.group.model.foo', 'antigravity', 'Gemini 3 Pro', settings()), 'G3P');
  assert.equal(
    resolveQuotaAbbreviation(
      'codex.group.account',
      'codex',
      'Codex',
      settings({ quotaTargetAbbreviations: { 'codex.group.account': 'ZX' } }),
    ),
    'ZX',
  );
  assert.equal(
    resolveQuotaAbbreviation(
      'future.group.account',
      'future',
      '  4 Omni',
      settings({ quotaTargetAbbreviations: { 'future.group.account': '' } }),
    ),
    '4',
  );
});

test('builds exactly fixed 5h and 1w rows with provider default abbreviations and theme', () => {
  const snapshot = buildTaskbarQuotaSnapshot(state({}, {
    claude: accountQuota('claude', 'Claude', 72, 38),
    codex: accountQuota('codex', 'Codex', 33, 44),
  }));

  assert.equal(snapshot.theme, 'dark');
  assert.deepEqual(snapshot.rows.map(row => row.period), ['5h', '1w']);
  assert.deepEqual(snapshot.rows[0].blocks.map(block => block.abbreviation), ['C', 'CX']);
  assert.deepEqual(snapshot.rows[1].blocks.map(block => block.abbreviation), ['CX', 'C']);
  assert.equal(snapshot.rows[0].hiddenCount, 0);
  assert.deepEqual(snapshot.rows[0].blocks.map(block => Object.hasOwn(block, 'sourceLabel')), [false, false]);
  assert.equal(snapshot.rows[0].blocks[0].elapsedPct, 50);
  assert.match(snapshot.rows[0].blocks[0].resetLabel, /^\d+h/);
});

test('shows unlimited quota windows as taskbar blocks without usage severity', () => {
  const quota = accountQuota('codex', 'Codex', 0, 44);
  quota.windows.h5 = { pct: 0, resetMs: null, limitState: 'unlimited', source: 'api' };

  const snapshot = buildTaskbarQuotaSnapshot(state({}, { codex: quota }));
  const h5 = snapshot.rows[0];

  assert.equal(h5.statusLabel, null);
  assert.equal(h5.blocks[0].abbreviation, 'CX');
  assert.equal(h5.blocks[0].quotaPct, null);
  assert.equal(h5.blocks[0].elapsedPct, null);
  assert.equal(h5.blocks[0].resetLabel, 'unlimited');
  assert.equal(h5.blocks[0].severity, 'normal');
});

test('shows unreported quota windows as taskbar unlimited blocks', () => {
  const quota = accountQuota('codex', 'Codex', 0, 44);
  quota.windows.h5 = { pct: 0, resetMs: null, limitState: 'unreported', source: 'api' };

  const snapshot = buildTaskbarQuotaSnapshot(state({}, { codex: quota }));
  const block = snapshot.rows[0].blocks[0];

  assert.equal(block.quotaPct, null);
  assert.equal(block.elapsedPct, null);
  assert.equal(block.resetLabel, 'unlimited');
  assert.equal(block.severity, 'normal');
});

test('uses resolved display theme for taskbar snapshot when app theme is auto', () => {
  assert.equal(buildTaskbarQuotaSnapshot(state({ theme: 'auto' }), 'light').theme, 'light');
  assert.equal(buildTaskbarQuotaSnapshot(state({ theme: 'auto' }), 'dark').theme, 'dark');
  assert.equal(buildTaskbarQuotaSnapshot(state({ theme: 'dark' }), 'light').theme, 'dark');
});

test('formats reset labels with only the largest remaining unit', () => {
  const quota = accountQuota('codex', 'Codex', 26, 19);
  quota.windows.h5.resetMs = (3 * 60 * 60 * 1000) + (9 * 60 * 1000);
  quota.windows.week.resetMs = (6 * 24 * 60 * 60 * 1000) + (5 * 60 * 60 * 1000);

  const snapshot = buildTaskbarQuotaSnapshot(state({}, { codex: quota }));

  assert.equal(snapshot.rows[0].blocks[0].resetLabel, '3h');
  assert.equal(snapshot.rows[1].blocks[0].resetLabel, '6d');
});

test('orders by configured quota order before risk, then natural target order', () => {
  const snapshot = buildTaskbarQuotaSnapshot(state({
    quotaTargetOrder: ['claude.group.account', 'codex.group.account'],
    taskbarQuotaMaxBlocks: 3,
    theme: 'light',
  }, {
    claude: accountQuota('claude', 'Claude', 70, 50),
    codex: accountQuota('codex', 'Codex', 80, 50),
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: 1000,
      models: [
        {
          model: 'gemini-3-pro',
          label: 'Gemini 3 Pro',
          remainingPct: 30,
          resetMs: H5 / 2,
          durationMs: H5,
          defaultMode: 'simple',
          visualKind: 'pace',
        },
      ],
      status: { connected: true, code: 'ok' },
    },
  }));

  const h5 = snapshot.rows[0];
  assert.equal(snapshot.theme, 'light');
  assert.deepEqual(h5.blocks.map(block => block.targetId), [
    'claude.group.account',
    'codex.group.account',
    'antigravity.group.model.gemini-3-pro',
  ]);
});

test('orders unconfigured targets by quota risk before applying the default taskbar row limit', () => {
  const snapshot = buildTaskbarQuotaSnapshot(state({}, {
    claude: accountQuota('claude', 'Claude', 20, 20),
    codex: accountQuota('codex', 'Codex', 30, 30),
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: 1000,
      models: [
        {
          model: 'gemini-low',
          label: 'Gemini Low',
          remainingPct: 60,
          resetMs: H5 / 2,
          durationMs: H5,
          defaultMode: 'simple',
          visualKind: 'pace',
        },
        {
          model: 'gemini-danger',
          label: 'Gemini Danger',
          remainingPct: 5,
          resetMs: H5 / 2,
          durationMs: H5,
          defaultMode: 'simple',
          visualKind: 'pace',
        },
      ],
      status: { connected: true, code: 'ok' },
    },
  }));

  assert.deepEqual(snapshot.rows[0].blocks.map(block => block.targetId), [
    'antigravity.group.model.gemini-danger',
    'antigravity.group.model.gemini-low',
  ]);
  assert.equal(snapshot.rows[0].hiddenCount, 2);
});

test('applies explicit taskbar row block limits between one and three blocks', () => {
  const providerQuotas = {
    claude: accountQuota('claude', 'Claude', 20, 20),
    codex: accountQuota('codex', 'Codex', 30, 30),
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: 1000,
      models: [
        {
          model: 'gemini-danger',
          label: 'Gemini Danger',
          remainingPct: 5,
          resetMs: H5 / 2,
          durationMs: H5,
          defaultMode: 'simple',
          visualKind: 'pace',
        },
      ],
      status: { connected: true, code: 'ok' },
    },
  };

  const one = buildTaskbarQuotaSnapshot(state({ taskbarQuotaMaxBlocks: 1 }, providerQuotas));
  const three = buildTaskbarQuotaSnapshot(state({ taskbarQuotaMaxBlocks: 3 }, providerQuotas));
  const clamped = buildTaskbarQuotaSnapshot(state({ taskbarQuotaMaxBlocks: 99 }, providerQuotas));

  assert.equal(one.rows[0].blocks.length, 1);
  assert.equal(one.rows[0].hiddenCount, 2);
  assert.equal(three.rows[0].blocks.length, 3);
  assert.equal(three.rows[0].hiddenCount, 0);
  assert.equal(clamped.rows[0].blocks.length, 3);
  assert.equal(clamped.rows[0].hiddenCount, 0);
});

test('excludes none mode and percent-only Antigravity models without 5h or 1w period', () => {
  const snapshot = buildTaskbarQuotaSnapshot(state({
    quotaTargetModes: { 'codex.group.account': 'none' },
  }, {
    codex: accountQuota('codex', 'Codex', 80, 70),
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: 1000,
      models: [
        {
          model: 'percent-only',
          label: 'Percent Only',
          remainingPct: 10,
          resetMs: null,
          defaultMode: 'simple',
          visualKind: 'percentOnly',
        },
        {
          model: 'weekly-model',
          label: 'Weekly Model',
          remainingPct: 20,
          resetMs: WEEK / 2,
          durationMs: WEEK,
          defaultMode: 'simple',
          visualKind: 'pace',
        },
      ],
      status: { connected: true, code: 'ok' },
    },
  }));

  assert.deepEqual(snapshot.rows[0].blocks, []);
  assert.deepEqual(snapshot.rows[1].blocks.map(block => block.targetId), ['antigravity.group.model.weekly-model']);
});

test('formats unknown quota signals as nullable fields and uses severity boundaries', () => {
  const quota = accountQuota('claude', 'Claude', 60, 50);
  quota.windows.h5 = { pct: 60, resetMs: 0, source: 'api' };
  quota.windows.week = { pct: 90, resetMs: WEEK / 2, source: 'api' };
  quota.groups.push({
    key: 'fallback-label',
    label: 'Fallback Label',
    windowKeys: ['labelOnly'],
    defaultMode: 'simple',
  });
  quota.windows.labelOnly = { pct: 80, resetMs: null, source: 'api' };
  quota.windowDisplay.labelOnly = { label: '5h', visualKind: 'pace' };

  const snapshot = buildTaskbarQuotaSnapshot(state({}, { claude: quota }));
  const normal = snapshot.rows[0].blocks.find(block => block.targetId === 'claude.group.account');
  const unknownElapsed = snapshot.rows[0].blocks.find(block => block.targetId === 'claude.group.fallback-label');
  const dangerAt90 = snapshot.rows[1].blocks[0];

  assert.equal(normal?.elapsedPct, 100);
  assert.equal(normal?.resetLabel, null);
  assert.equal(normal?.severity, 'normal');
  assert.equal(unknownElapsed?.elapsedPct, null);
  assert.equal(unknownElapsed?.resetLabel, null);
  assert.equal(unknownElapsed?.severity, 'unknown');
  assert.equal(dangerAt90.severity, 'danger');
});

test('uses provider status tones instead of rendering fallback taskbar source labels', () => {
  const codex = accountQuota('codex', 'Codex', 60, 50);
  codex.source = 'localLog';
  codex.windows.h5.source = 'localLog';
  codex.windows.week.source = 'cache';
  const claude = accountQuota('claude', 'Claude', 20, 20);
  claude.source = 'statusLine';
  claude.windows.h5.source = 'statusLine';

  const snapshot = buildTaskbarQuotaSnapshot(state({ taskbarQuotaMaxBlocks: 3 }, {
    codex,
    claude,
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: 1000,
      models: [
        {
          model: 'gemini-3-pro',
          label: 'Gemini 3 Pro',
          remainingPct: 40,
          resetMs: H5 / 2,
          durationMs: H5,
          defaultMode: 'simple',
          visualKind: 'pace',
        },
      ],
      status: { connected: true, code: 'ok' },
    },
  }));

  const h5Blocks = Object.fromEntries(snapshot.rows[0].blocks.map(block => [block.targetId, block]));
  const weekBlocks = Object.fromEntries(snapshot.rows[1].blocks.map(block => [block.targetId, block]));
  assert.equal(h5Blocks['codex.group.account'].providerStatusTone, 'warning');
  assert.equal(h5Blocks['claude.group.account'].providerStatusTone, 'normal');
  assert.equal(h5Blocks['antigravity.group.model.gemini-3-pro'].providerStatusTone, 'normal');
  assert.equal(weekBlocks['codex.group.account'].providerStatusTone, 'normal');
  assert.equal(Object.hasOwn(h5Blocks['codex.group.account'], 'sourceLabel'), false);
  assert.equal(Object.hasOwn(h5Blocks['claude.group.account'], 'sourceLabel'), false);
  assert.equal(Object.hasOwn(weekBlocks['codex.group.account'], 'sourceLabel'), false);
});

test('assigns provider status tones independently from quota severity', () => {
  const api = accountQuota('claude', 'Claude', 20, 20);
  const localRpc = {
    provider: 'antigravity',
    source: 'localRpc',
    capturedAt: 1000,
    models: [
      {
        model: 'gemini-3-pro',
        label: 'Gemini 3 Pro',
        remainingPct: 60,
        resetMs: H5 / 2,
        durationMs: H5,
        defaultMode: 'simple',
        visualKind: 'pace',
      },
    ],
    status: { connected: true, code: 'ok' },
  };
  const localLog = accountQuota('codex', 'Codex', 95, 95);
  localLog.source = 'localLog';
  localLog.windows.h5.source = 'localLog';
  localLog.windows.week.source = 'localLog';
  const cache = accountQuota('claude', 'Claude Cache', 35, 35);
  cache.source = 'cache';
  cache.windows.h5.source = 'cache';
  cache.windows.week.source = 'cache';
  const offline = accountQuota('codex', 'Codex Offline', 15, 15);
  offline.source = 'cache';
  offline.windows.h5.source = 'cache';
  offline.windows.week.source = 'cache';
  offline.status = { connected: false, code: 'offline', severity: 'warning' };
  const unknown = accountQuota('claude', 'Claude Unknown', 45, 45);
  unknown.source = 'futureSource';
  unknown.windows.h5.source = 'futureSource';
  unknown.windows.week.source = 'futureSource';
  unknown.status = undefined;

  const normalSnapshot = buildTaskbarQuotaSnapshot(state({ taskbarQuotaMaxBlocks: 3 }, {
    claude: api,
    antigravity: localRpc,
  }));
  assert.deepEqual(
    Object.fromEntries(normalSnapshot.rows[0].blocks.map(block => [block.targetId, block.providerStatusTone])),
    {
      'claude.group.account': 'normal',
      'antigravity.group.model.gemini-3-pro': 'normal',
    },
  );

  const warningSnapshot = buildTaskbarQuotaSnapshot(state({ taskbarQuotaMaxBlocks: 3 }, {
    codex: localLog,
    claude: cache,
  }));
  assert.deepEqual(
    Object.fromEntries(warningSnapshot.rows[0].blocks.map(block => [block.targetId, block.providerStatusTone])),
    {
      'codex.group.account': 'warning',
      'claude.group.account': 'normal',
    },
  );
  assert.equal(warningSnapshot.rows[0].blocks.find(block => block.targetId === 'codex.group.account')?.severity, 'danger');

  const dangerSnapshot = buildTaskbarQuotaSnapshot(state({}, { codex: offline }));
  assert.equal(dangerSnapshot.rows[0].blocks[0].providerStatusTone, 'warning');
  assert.equal(dangerSnapshot.rows[0].blocks[0].severity, 'normal');

  const unknownSnapshot = buildTaskbarQuotaSnapshot(state({}, { claude: unknown }));
  assert.equal(unknownSnapshot.rows[0].blocks[0].providerStatusTone, 'unknown');

  const offlineUnknown = accountQuota('codex', 'Codex Offline Unknown', 15, 15);
  offlineUnknown.source = 'futureSource';
  offlineUnknown.windows.h5.source = 'futureSource';
  offlineUnknown.windows.week.source = 'futureSource';
  offlineUnknown.status = { connected: false, code: 'offline', severity: 'warning' };
  const offlineUnknownSnapshot = buildTaskbarQuotaSnapshot(state({}, { codex: offlineUnknown }));
  assert.equal(offlineUnknownSnapshot.rows[0].blocks[0].providerStatusTone, 'danger');
});

test('drops non-finite reset values from taskbar labels and pacing', () => {
  const quota = accountQuota('claude', 'Claude', 60, 50);
  quota.source = 'statusLine';
  quota.windows.h5 = { pct: 60, resetMs: Number.NaN, source: 'statusLine' };

  const snapshot = buildTaskbarQuotaSnapshot(state({}, { claude: quota }));
  const block = snapshot.rows[0].blocks.find(item => item.targetId === 'claude.group.account');

  assert.equal(block.resetLabel, null);
  assert.equal(block.elapsedPct, null);
  assert.equal(block.severity, 'unknown');
  assert.equal(Object.hasOwn(block, 'sourceLabel'), false);
  assert.equal(block.providerStatusTone, 'normal');
});

test('labels empty taskbar rows as waiting, offline, or no data', () => {
  const waiting = buildTaskbarQuotaSnapshot({
    ...state(),
    initialRefreshComplete: false,
  });
  assert.equal(waiting.rows[0].statusLabel, 'waiting');

  const offline = buildTaskbarQuotaSnapshot(state({}, {
    claude: {
      provider: 'claude',
      source: 'cache',
      capturedAt: 1000,
      groups: [
        {
          key: 'account',
          label: 'Claude',
          windowKeys: ['h5', 'week'],
          defaultMode: 'rich',
        },
      ],
      windowDisplay: {
        h5: { label: '5h', visualKind: 'pace', durationMs: H5 },
        week: { label: '1w', visualKind: 'pace', durationMs: WEEK },
      },
      status: { connected: false, code: 'offline' },
    },
  }));
  assert.deepEqual(offline.rows[0].blocks, []);
  assert.equal(offline.rows[0].statusLabel, 'offline');

  const noData = buildTaskbarQuotaSnapshot(state());
  assert.equal(noData.rows[0].statusLabel, 'no data');
});

test('labels empty taskbar rows as hidden when all eligible targets are set to none', () => {
  const hidden = buildTaskbarQuotaSnapshot(state({
    quotaTargetModes: { 'codex.group.account': 'none' },
  }, {
    codex: accountQuota('codex', 'Codex', 80, 70),
  }));

  assert.deepEqual(hidden.rows[0].blocks, []);
  assert.equal(hidden.rows[0].statusLabel, 'hidden');
  assert.equal(hidden.rows[1].statusLabel, 'hidden');
});
