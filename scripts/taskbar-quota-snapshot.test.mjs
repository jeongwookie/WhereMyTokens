import assert from 'node:assert/strict';
import test from 'node:test';
import taskbar from '../dist/main/taskbarQuotaSnapshot.js';
import antigravityQuota from '../dist/main/providers/antigravity/quota.js';

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
  assert.ok(result.lines.flatMap(line => line.blocks).filter(Boolean).every(block => block.state === 'limited'));
});

test('mixed periods align each source by target id and preserve empty cells', () => {
  const gemini = target('antigravity.group.summary.gemini-models', 'Gemini Models', 100, 'GM');
  const agent = target('antigravity.group.summary.gemini-4-agent', 'Gemini 4 Agent', 101, 'G4A');
  const result = buildTaskbarQuotaSnapshot(state({
    codex: snapshot('codex', [limited('codex.account.7d', codex, '7d', 45)]),
    antigravity: snapshot('antigravity', [
      limited('gemini.weekly', gemini, '7d', 0),
      limited('agent.weekly', agent, '7d', 0),
      limited('gemini.session', gemini, '5h', 0),
    ]),
  }, { taskbarQuotaMaxBlocks: 3 }));
  assert.deepEqual(result.lines.map(line => line.blocks.map(block => block?.targetId ?? null)), [
    [null, gemini.id, null],
    [codex.id, gemini.id, agent.id],
  ]);
  assert.deepEqual(result.lines.map(line => line.hiddenCount), [0, 0]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).lines[0].blocks, [null, result.lines[0].blocks[1], null]);
});

test('mixed-period column limits follow configured order and count only omitted entries', () => {
  const quotas = {
    claude: snapshot('claude', [
      limited('claude.account.5h', claude, '5h', 10),
      limited('claude.account.7d', claude, '7d', 20),
      limited('claude.fable.5h', fable, '5h', 30),
    ]),
    codex: snapshot('codex', [limited('codex.account.7d', codex, '7d', 40)]),
  };
  for (const cap of [1, 2, 3]) {
    const result = buildTaskbarQuotaSnapshot(state(quotas, {
      taskbarQuotaMaxBlocks: cap,
      quotaTargetOrder: [codex.id, fable.id, claude.id],
      quotaTargetAbbreviations: { [codex.id]: 'G', [fable.id]: 'G', [claude.id]: 'G' },
    }));
    assert.deepEqual(result.lines.map(line => line.blocks.map(block => block?.targetId ?? null)), [
      [null, fable.id, claude.id].slice(0, cap),
      [codex.id, null, claude.id].slice(0, cap),
    ]);
    assert.deepEqual(result.lines.map(line => line.hiddenCount), [
      2 - result.lines[0].blocks.filter(Boolean).length,
      2 - result.lines[1].blocks.filter(Boolean).length,
    ]);
  }
});

test('multiple entries for a target retain their slots and overflow counts', () => {
  const result = buildTaskbarQuotaSnapshot(state({
    claude: snapshot('claude', [
      limited('claude.account.5h.a', claude, '5h', 10),
      limited('claude.account.5h.b', claude, '5h', 20),
      limited('claude.account.7d', claude, '7d', 30),
      limited('claude.fable.7d', fable, '7d', 40),
    ]),
  }));
  assert.deepEqual(result.lines.map(line => line.blocks.map(block => block?.usedPct ?? null)), [[10, 20], [30, null]]);
  assert.deepEqual(result.lines.map(line => line.hiddenCount), [0, 1]);
});

test('Antigravity summary abbreviations stay distinct through the taskbar snapshot', () => {
  const entries = antigravityQuota.parseAntigravityQuotaSummary({ groups: [
    { displayName: 'Gemini Models', buckets: [{ bucketId: 'session', remainingFraction: 1 }] },
    { displayName: 'Gemini 4 Agent', buckets: [{ bucketId: 'weekly', remainingFraction: 1 }] },
  ] }, []);
  const result = buildTaskbarQuotaSnapshot(state({ antigravity: snapshot('antigravity', entries) }));
  assert.equal(result.lines[0].blocks[0].abbreviation, 'GM');
  assert.equal(result.lines[1].blocks[1].abbreviation, 'G4A');
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

test('five-column cap preserves aligned periods and counts only omitted entries', () => {
  const targets = Array.from({ length: 6 }, (_, i) => target(`antigravity.group.t${i}`, `T${i}`, i));
  const entries = targets.flatMap((target, i) => [
    limited(`${target.id}.7d`, target, '7d', i * 10),
    ...(i % 2 === 0 ? [limited(`${target.id}.5h`, target, '5h', i * 10)] : []),
  ]);
  for (const cap of [4, 5, 99]) {
    const result = buildTaskbarQuotaSnapshot(state({ antigravity: snapshot('antigravity', entries) }, { taskbarQuotaMaxBlocks: cap }));
    const count = Math.min(5, cap);
    assert.deepEqual(result.lines.map(line => line.blocks.length), [count, count]);
    assert.deepEqual(result.lines[1].blocks.map(block => block.targetId), targets.slice(0, count).map(target => target.id));
    assert.deepEqual(result.lines[0].blocks.map(block => block?.targetId ?? null), targets.slice(0, count).map((target, i) => i % 2 === 0 ? target.id : null));
    assert.deepEqual(result.lines.map(line => line.hiddenCount), [count === 4 ? 1 : 0, 6 - count]);
  }
});

test('single-period five-block limit balances ten entries with remaining overflow on line two', () => {
  const entries = Array.from({ length: 12 }, (_, i) => limited(`claude.t${i}.7d`, target(`claude.group.t${i}`, `T${i}`, i), '7d', 10));
  const result = buildTaskbarQuotaSnapshot(state({ claude: snapshot('claude', entries) }, { taskbarQuotaMaxBlocks: 5 }));
  assert.deepEqual(result.lines.map(line => line.blocks.length), [5, 5]);
  assert.deepEqual(result.lines.map(line => line.hiddenCount), [0, 2]);
  assert.equal(new Set(result.lines.flatMap(line => line.blocks).map(block => block.targetId)).size, 10);
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
