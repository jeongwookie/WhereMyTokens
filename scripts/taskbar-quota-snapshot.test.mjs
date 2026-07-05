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
  assert.equal(resolveQuotaAbbreviation('codex.group.account', 'codex', 'Codex', settings()), 'X');
  assert.equal(resolveQuotaAbbreviation('antigravity.group.model.foo', 'antigravity', 'Gemini 3 Pro', settings()), 'A');
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
  assert.deepEqual(snapshot.rows[0].blocks.map(block => block.abbreviation), ['C', 'X']);
  assert.deepEqual(snapshot.rows[1].blocks.map(block => block.abbreviation), ['C', 'X']);
  assert.equal(snapshot.rows[0].blocks[0].elapsedPct, 50);
  assert.match(snapshot.rows[0].blocks[0].resetLabel, /^\d+h/);
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
  assert.equal(h5.hiddenCount, 0);
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
