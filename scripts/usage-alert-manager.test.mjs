import test from 'node:test';
import assert from 'node:assert/strict';

test('quota alert checks include model-only provider quotas', async () => {
  const alerts = await import('../dist/main/usageAlertManager.js');

  assert.equal(typeof alerts.quotaChecks, 'function');

  const checks = alerts.quotaChecks({
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: Date.now(),
      status: { connected: true, code: 'connected' },
      models: [
        {
          model: 'MODEL_GEMINI_3_PRO',
          label: 'Gemini 3 Pro',
          remainingPct: 10,
          resetMs: 60 * 60 * 1000,
          visualKind: 'pace',
          durationMs: 5 * 60 * 60 * 1000,
        },
      ],
    },
  }, new Set(['antigravity']));

  assert.equal(checks.length, 1);
  assert.equal(checks[0].key, 'antigravity-model-MODEL_GEMINI_3_PRO-5h');
  assert.equal(checks[0].pct, 90);
  assert.equal(checks[0].label, 'Antigravity Gemini 3 Pro 5h usage');
  assert.equal(checks[0].source, 'localRpc');
});

test('quota alert checks keep quota targets even when display mode is none', async () => {
  const alerts = await import('../dist/main/usageAlertManager.js');

  const checks = alerts.quotaChecks({
    claude: {
      provider: 'claude',
      source: 'api',
      capturedAt: Date.now(),
      groups: [
        { key: 'account', label: 'Claude', defaultMode: 'rich', windowKeys: ['h5', 'week'] },
      ],
      windows: {
        h5: { pct: 85, resetMs: 60 * 60 * 1000, source: 'api' },
        week: { pct: 91, resetMs: 6 * 24 * 60 * 60 * 1000, source: 'api' },
      },
    },
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: Date.now(),
      status: { connected: true, code: 'connected' },
      models: [
        {
          model: 'MODEL_GEMINI_3_PRO',
          label: 'Gemini 3 Pro',
          remainingPct: 5,
          resetMs: 60 * 60 * 1000,
          visualKind: 'pace',
          durationMs: 5 * 60 * 60 * 1000,
        },
      ],
    },
  }, new Set(['claude', 'antigravity']), {
    quotaTargetModes: {
      'claude.group.account': 'none',
      'antigravity.group.model.MODEL_GEMINI_3_PRO': 'none',
    },
  });

  assert.deepEqual(checks.map(check => check.key), [
    'claude-h5',
    'claude-week',
    'antigravity-model-MODEL_GEMINI_3_PRO-5h',
  ]);
});

test('checkAlerts preserves the single alert notification format', async () => {
  const alerts = await import('../dist/main/usageAlertManager.js');
  const emitted = [];

  alerts.checkAlerts({
    codex: {
      provider: 'codex',
      source: 'api',
      capturedAt: Date.now(),
      groups: [
        { key: 'account', label: 'Codex', defaultMode: 'rich', windowKeys: ['h5'] },
      ],
      windows: {
        h5: { pct: 84, resetMs: 60 * 60 * 1000, source: 'api' },
      },
    },
  }, [50, 80, 90], true, new Set(['codex']), {
    nowMs: 10_000_000,
    emitNotification: (title, body) => emitted.push({ title, body }),
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].title, 'Usage alert: Codex 5h usage reached 80%');
  assert.equal(emitted[0].body, 'Currently at 84% usage · resets in 1h · source: API');
});

test('checkAlerts batches multiple threshold hits into one notification', async () => {
  const alerts = await import('../dist/main/usageAlertManager.js');
  const emitted = [];

  alerts.checkAlerts({
    claude: {
      provider: 'claude',
      source: 'api',
      capturedAt: Date.now(),
      groups: [
        { key: 'account', label: 'Claude', defaultMode: 'rich', windowKeys: ['h5', 'week'] },
      ],
      windows: {
        h5: { pct: 82, resetMs: 2 * 60 * 60 * 1000, source: 'api' },
        week: { pct: 93, resetMs: 6 * 24 * 60 * 60 * 1000, source: 'api' },
      },
    },
  }, [50, 80, 90], true, new Set(['claude']), {
    nowMs: 10_000_000,
    emitNotification: (title, body) => emitted.push({ title, body }),
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].title, 'Usage alerts: 2 limits reached thresholds');
  assert.match(emitted[0].body, /Claude 5h usage reached 80%/);
  assert.match(emitted[0].body, /Claude weekly usage reached 90%/);
});
