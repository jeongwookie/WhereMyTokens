import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  compactWidgetSize,
  compactWidgetTargetSummary,
} from '../dist/main/compactWidgetSizing.js';

function settings(overrides = {}) {
  return {
    enabledProviders: ['claude', 'codex'],
    quotaTargetModes: {},
    ...overrides,
  };
}

function quotaWindow(source = 'api') {
  return { pct: 10, resetMs: 60_000, source };
}

function usageWindow(totalTokens = 0) {
  return { totalTokens };
}

const state = {
  historyWarmupPending: false,
  usage: {
    byProvider: {
      claude: { windows: { short: usageWindow(), long: usageWindow(), percent: usageWindow() } },
      codex: { windows: { short: usageWindow(), long: usageWindow() } },
    },
  },
  providerQuotas: {
    claude: {
      groups: [
        { key: 'account', label: 'Provider A', defaultMode: 'rich', windowKeys: ['short', 'long'] },
        { key: 'percent-family', label: 'Percent Family', defaultMode: 'simple', windowKeys: ['percent'] },
      ],
      windowDisplay: {
        short: { label: '5h', visualKind: 'pace' },
        long: { label: '1w', visualKind: 'pace' },
        percent: { label: '1w', visualKind: 'percentOnly' },
      },
      windows: { short: quotaWindow(), long: quotaWindow(), percent: quotaWindow() },
    },
    codex: {
      groups: [
        { key: 'account', label: 'Provider B', defaultMode: 'rich', windowKeys: ['short', 'long'] },
      ],
      windowDisplay: {
        short: { label: '5h', visualKind: 'pace' },
        long: { label: '1w', visualKind: 'pace' },
      },
      windows: { short: quotaWindow(), long: quotaWindow() },
    },
  },
};

test('compact widget height estimates visible quota groups and rows from metadata', () => {
  const full = compactWidgetTargetSummary(settings(), state);
  assert.deepEqual(full, { groupCount: 3, rowCount: 5 });

  const hidden = compactWidgetTargetSummary(settings({
    quotaTargetModes: {
      'claude.group.percent-family': 'none',
      'codex.group.account': 'none',
    },
  }), state);
  assert.deepEqual(hidden, { groupCount: 1, rowCount: 2 });

  assert.ok(compactWidgetSize(settings(), state).height > compactWidgetSize(settings({
    quotaTargetModes: {
      'claude.group.percent-family': 'none',
      'codex.group.account': 'none',
    },
  }), state).height);
});

test('compact widget height includes provider model quota groups', () => {
  const withModelState = {
    ...state,
    providerQuotas: {
      ...state.providerQuotas,
      codex: {
        ...state.providerQuotas.codex,
        models: [
          { model: 'gpt-5.1', label: 'GPT-5.1', remainingPct: 70, resetMs: 60_000 },
        ],
      },
    },
  };

  assert.deepEqual(compactWidgetTargetSummary(settings(), withModelState), { groupCount: 4, rowCount: 6 });
  assert.ok(compactWidgetSize(settings(), withModelState).height > compactWidgetSize(settings(), state).height);
});

test('compact widget height ignores quota rows with no displayed data', () => {
  const partialState = {
    ...state,
    usage: {
      ...state.usage,
      byProvider: {
        ...state.usage.byProvider,
        codex: { windows: { short: usageWindow(), long: usageWindow() } },
      },
    },
    providerQuotas: {
      ...state.providerQuotas,
      codex: {
        ...state.providerQuotas.codex,
        windows: { short: quotaWindow() },
      },
    },
  };

  assert.deepEqual(compactWidgetTargetSummary(settings(), partialState), { groupCount: 3, rowCount: 4 });
  assert.ok(compactWidgetSize(settings(), partialState).height < compactWidgetSize(settings(), state).height);
});

test('compact widget sizing stays metadata-driven in generic code', () => {
  const source = fs.readFileSync('src/main/compactWidgetSizing.ts', 'utf8');

  assert.doesNotMatch(source, /provider\s*===\s*['"][^'"]+['"]/);
  assert.doesNotMatch(source, /defaultWindowKeys|sonnetWeek|cacheMetricMode/);
  assert.match(source, /quota\.groups/);
  assert.match(source, /group\.windowKeys/);
});
