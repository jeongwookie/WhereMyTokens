import assert from 'node:assert/strict';
import test from 'node:test';
import taskbar from '../dist/main/taskbarQuotaSnapshot.js';

const { buildTaskbarQuotaSnapshot, resolveQuotaAbbreviation } = taskbar;
const NOW = Date.parse('2026-07-18T00:00:00Z');
const H5 = 18_000_000;
const D7 = 604_800_000;

function target(id, label, order, abbreviation = label[0].toUpperCase(), mode = 'simple') {
  return { id, label, defaultMode: mode, defaultOrder: order, taskbarAbbreviation: abbreviation };
}

function limited(key, targetValue, period, usedPct, options = {}) {
  const durationMs = period === '5h' ? H5 : D7;
  return {
    key, target: targetValue, scope: { kind: 'account' }, state: 'limited', usedPct,
    resetsAt: options.resetsAt ?? NOW + durationMs / 2,
    durationMs, durationInferred: options.durationInferred ?? false, period,
    ...(options.provisional ? { provisional: true } : {}),
  };
}

function snapshot(provider, entries, source = 'api') {
  return { provider, source, capturedAt: NOW, entries, status: { connected: true, code: 'ok' } };
}

function state(providerQuotas, overrides = {}) {
  return {
    lastUpdated: NOW,
    providerQuotas,
    settings: {
      enabledProviders: ['claude', 'codex', 'antigravity'],
      quotaTargetModes: {}, quotaTargetOrder: [], quotaTargetAbbreviations: {},
      taskbarQuotaMaxBlocks: 2, theme: 'dark',
      ...overrides,
    },
  };
}

const claude = target('claude.group.account', 'Claude', 0, 'C', 'rich');
const fable = target('claude.group.fable', 'Fable', 10, 'F');
const codex = target('codex.group.account', 'Codex', 0, 'X', 'rich');

test('abbreviation uses explicit override, then canonical target default', () => {
  assert.equal(resolveQuotaAbbreviation(fable.id, 'F', { quotaTargetAbbreviations: {} }), 'F');
  assert.equal(resolveQuotaAbbreviation(fable.id, 'F', { quotaTargetAbbreviations: { [fable.id]: 'FB' } }), 'FB');
  assert.equal(resolveQuotaAbbreviation(fable.id, 'bad', { quotaTargetAbbreviations: {} }), '?');
});

test('both periods allocate one physical line each with canonical block state', () => {
  const result = buildTaskbarQuotaSnapshot(state({
    claude: snapshot('claude', [limited('claude.account.5h', claude, '5h', 0), limited('claude.account.7d', claude, '7d', 40)]),
    codex: snapshot('codex', [limited('codex.account.5h', codex, '5h', 20)]),
  }, { theme: 'auto' }), 'light');
  assert.equal(result.theme, 'light');
  assert.deepEqual(result.lines.map(line => [line.period, line.label]), [['5h', '5h'], ['7d', '1w']]);
  assert.deepEqual(result.lines[0].blocks.map(block => block.usedPct), [0, 20]);
  assert.ok(result.lines.flatMap(line => line.blocks).every(block => block.state === 'limited'));
});

test('single 7d period repeats label and balances contiguously across two lines', () => {
  const entries = [
    limited('claude.account.7d', claude, '7d', 10),
    limited('claude.fable.7d', fable, '7d', 20),
    limited('codex.account.7d', codex, '7d', 30),
  ];
  const result = buildTaskbarQuotaSnapshot(state({ claude: snapshot('claude', entries.slice(0, 2)), codex: snapshot('codex', entries.slice(2)) }));
  assert.deepEqual(result.lines.map(line => line.period), ['7d', '7d']);
  assert.deepEqual(result.lines.map(line => line.label), ['1w', '1w']);
  assert.deepEqual(result.lines.map(line => line.blocks.map(block => block.targetId)), [[claude.id, codex.id], [fable.id]]);
});

test('one fixed-period entry leaves the second physical line empty without placeholder text', () => {
  const result = buildTaskbarQuotaSnapshot(state({ claude: snapshot('claude', [limited('claude.account.5h', claude, '5h', 1)]) }));
  assert.equal(result.lines[0].blocks.length, 1);
  assert.equal(result.lines[1].blocks.length, 0);
  assert.equal('statusLabel' in result.lines[1], false);
});

test('single-period cap selects at most 2x cap and reports overflow only on line two', () => {
  const entries = Array.from({ length: 6 }, (_, index) => {
    const t = target(`claude.group.t${index}`, `T${index}`, index, `T${index}`.slice(0, 3));
    return limited(`claude.t${index}.7d`, t, '7d', index * 10);
  });
  const result = buildTaskbarQuotaSnapshot(state({ claude: snapshot('claude', entries) }, { taskbarQuotaMaxBlocks: 2 }));
  assert.deepEqual(result.lines.map(line => line.blocks.length), [2, 2]);
  assert.deepEqual(result.lines.map(line => line.hiddenCount), [0, 2]);
});

test('configured/default ordering is stable and severity never reorders targets', () => {
  const entries = [limited('claude.fable.7d', fable, '7d', 99), limited('claude.account.7d', claude, '7d', 1)];
  const natural = buildTaskbarQuotaSnapshot(state({ claude: snapshot('claude', entries) }));
  assert.deepEqual(natural.lines.flatMap(line => line.blocks).map(block => block.targetId), [claude.id, fable.id]);
  const configured = buildTaskbarQuotaSnapshot(state({ claude: snapshot('claude', entries) }, { quotaTargetOrder: [fable.id, claude.id] }));
  assert.deepEqual(configured.lines.flatMap(line => line.blocks).map(block => block.targetId), [fable.id, claude.id]);
});

test('inferred timing is carried while explicit unlimited has no fabricated percent', () => {
  const inferred = limited('claude.account.5h', claude, '5h', 25, { durationInferred: true });
  const unlimited = { ...limited('claude.account.7d', claude, '7d', 0), state: 'unlimited' };
  delete unlimited.usedPct;
  const result = buildTaskbarQuotaSnapshot(state({ claude: snapshot('claude', [inferred, unlimited]) }));
  assert.equal(result.lines[0].blocks[0].durationInferred, true);
  assert.equal(result.lines[0].blocks[0].elapsedPct, 50);
  assert.equal(result.lines[1].blocks[0].state, 'unlimited');
  assert.equal(result.lines[1].blocks[0].usedPct, null);
});

test('period-null, hidden targets, and total absence produce no placeholder snapshot', () => {
  const hiddenState = state({ claude: snapshot('claude', [limited('claude.account.5h', claude, '5h', 10)]) }, { quotaTargetModes: { [claude.id]: 'none' } });
  assert.equal(buildTaskbarQuotaSnapshot(hiddenState), null);
  assert.equal(buildTaskbarQuotaSnapshot(state({})), null);
});
