import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import sizing from '../dist/main/compactWidgetSizing.js';

const { compactWidgetSize, compactWidgetTargetSummary } = sizing;
const NOW = Date.parse('2026-07-18T00:00:00Z');

function target(id, label, order, mode = 'rich') {
  return { id, label, defaultMode: mode, defaultOrder: order, taskbarAbbreviation: label[0] };
}

function entry(key, targetValue, period, usedPct = 10) {
  const durationMs = period === '5h' ? 18_000_000 : period === '7d' ? 604_800_000 : null;
  return { key, target: targetValue, scope: { kind: 'account' }, state: 'limited', usedPct, resetsAt: NOW + 60_000, durationMs, durationInferred: false, period };
}

function settings(overrides = {}) {
  return { enabledProviders: ['claude', 'codex'], quotaTargetModes: {}, ...overrides };
}

const claude = target('claude.group.account', 'Claude', 0);
const fable = target('claude.group.fable', 'Fable', 10, 'simple');
const codex = target('codex.group.account', 'Codex', 0);
const state = {
  providerQuotas: {
    claude: { provider: 'claude', source: 'api', capturedAt: NOW, entries: [entry('claude.account.5h', claude, '5h'), entry('claude.account.7d', claude, '7d'), entry('claude.fable.7d', fable, '7d')] },
    codex: { provider: 'codex', source: 'api', capturedAt: NOW, entries: [entry('codex.account.5h', codex, '5h'), entry('codex.account.7d', codex, '7d')] },
  },
};

test('compact widget height counts visible canonical targets and entries', () => {
  assert.deepEqual(compactWidgetTargetSummary(settings(), state), { groupCount: 3, rowCount: 5 });
  const hiddenSettings = settings({ quotaTargetModes: { [fable.id]: 'none', [codex.id]: 'none' } });
  assert.deepEqual(compactWidgetTargetSummary(hiddenSettings, state), { groupCount: 1, rowCount: 2 });
  assert.ok(compactWidgetSize(settings(), state).height > compactWidgetSize(hiddenSettings, state).height);
});

test('dynamic model target contributes exactly its current entry count', () => {
  const model = target('codex.group.model.gpt-5', 'GPT-5', 20, 'simple');
  const withModel = { providerQuotas: { ...state.providerQuotas, codex: { ...state.providerQuotas.codex, entries: [...state.providerQuotas.codex.entries, entry('codex.model.gpt-5.7d', model, '7d')] } } };
  assert.deepEqual(compactWidgetTargetSummary(settings(), withModel), { groupCount: 4, rowCount: 6 });
});

test('absent entries create no rows or placeholder groups', () => {
  const partial = { providerQuotas: { ...state.providerQuotas, codex: { ...state.providerQuotas.codex, entries: [state.providerQuotas.codex.entries[0]] } } };
  assert.deepEqual(compactWidgetTargetSummary(settings(), partial), { groupCount: 3, rowCount: 4 });
});

test('compact widget sizing stays entry-driven and provider-generic', () => {
  const source = fs.readFileSync('src/main/compactWidgetSizing.ts', 'utf8');
  assert.match(source, /groupQuotaEntries\(quota\.entries\)/);
  assert.match(source, /group\.entries\.length/);
  assert.doesNotMatch(source, /quota\.groups|windowKeys|quota\.models/);
  assert.doesNotMatch(source, /provider\s*===/);
});
