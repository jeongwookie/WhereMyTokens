import assert from 'node:assert/strict';
import test from 'node:test';
import alerts from '../dist/main/usageAlertManager.js';

const { quotaChecks, checkAlerts } = alerts;
const NOW = Date.parse('2026-07-18T00:00:00Z');

function entry(key, targetId, label, period, usedPct, resetsAt = NOW + 60_000) {
  const durationMs = period === '5h' ? 18_000_000 : 604_800_000;
  return {
    key,
    target: { id: targetId, label, defaultMode: 'simple', defaultOrder: 0, taskbarAbbreviation: label[0] },
    scope: targetId.includes('fable') ? { kind: 'model', label } : { kind: 'account' },
    state: 'limited', usedPct, resetsAt, durationMs, durationInferred: false, period,
  };
}

function snapshot(entries, source = 'api') {
  return { provider: 'claude', source, capturedAt: NOW, entries };
}

test('quota checks key account 5h, account 7d, and Fable independently', () => {
  const checks = quotaChecks({ claude: snapshot([
    entry('alert.a.5h', 'claude.group.account', 'Claude', '5h', 51),
    entry('alert.a.7d', 'claude.group.account', 'Claude', '7d', 81),
    entry('alert.f.7d', 'claude.group.fable', 'Fable', '7d', 91),
  ]) }, new Set(['claude']));
  assert.deepEqual(checks.map(check => check.key), ['alert.a.5h', 'alert.a.7d', 'alert.f.7d']);
  assert.deepEqual(checks.map(check => check.label), ['Claude 5h usage', 'Claude weekly usage', 'Fable weekly usage']);
});

test('display mode none does not suppress alerts', () => {
  const checks = quotaChecks({ claude: snapshot([
    entry('alert.none.5h', 'claude.group.account', 'Claude', '5h', 60),
  ]) }, new Set(['claude']), { quotaTargetModes: { 'claude.group.account': 'none' } });
  assert.equal(checks.length, 1);
});

test('explicit unlimited and absent entries never alert', () => {
  const unlimited = entry('alert.unlimited.5h', 'claude.group.account', 'Claude', '5h', 0);
  unlimited.state = 'unlimited';
  delete unlimited.usedPct;
  assert.deepEqual(quotaChecks({ claude: snapshot([unlimited]) }, new Set(['claude'])), []);
  assert.deepEqual(quotaChecks({}, new Set(['claude'])), []);
});

test('reset boundary re-arms only the matching entry key', () => {
  const emitted = [];
  const emitNotification = (title, body) => emitted.push({ title, body });
  const first = snapshot([entry('alert.reset.5h', 'claude.group.account', 'Claude', '5h', 60, NOW + 60_000)]);
  checkAlerts({ claude: first }, [50], true, new Set(['claude']), { nowMs: NOW, emitNotification });
  checkAlerts({ claude: first }, [50], true, new Set(['claude']), { nowMs: NOW + 3_600_001, emitNotification });
  assert.equal(emitted.length, 1);
  const nextCycle = snapshot([entry('alert.reset.5h', 'claude.group.account', 'Claude', '5h', 60, NOW + 7_200_000)]);
  checkAlerts({ claude: nextCycle }, [50], true, new Set(['claude']), { nowMs: NOW + 3_600_002, emitNotification });
  assert.equal(emitted.length, 2);
  assert.match(emitted[1].body, /resets in/);
});
