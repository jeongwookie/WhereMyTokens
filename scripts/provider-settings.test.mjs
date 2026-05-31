import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import ipcModule from '../dist/main/ipc.js';

const { DEFAULT_SETTINGS, normalizeSettings } = ipcModule;

test('settings use implemented enabledProviders as the canonical provider selection', () => {
  const settings = normalizeSettings({ enabledProviders: ['antigravity', 'claude', 'claude', 'bogus'] });

  assert.deepEqual(settings.enabledProviders, ['claude']);
  assert.equal('provider' in settings, false);
});

test('legacy provider mode migrates to enabledProviders', () => {
  assert.deepEqual(normalizeSettings({ provider: 'claude' }).enabledProviders, ['claude']);
  assert.deepEqual(normalizeSettings({ provider: 'codex' }).enabledProviders, ['codex']);
  assert.deepEqual(normalizeSettings({ provider: 'both' }).enabledProviders, ['claude', 'codex']);
  assert.equal('provider' in DEFAULT_SETTINGS, false);
  assert.equal('provider' in normalizeSettings({ provider: 'codex' }), false);
});

test('enabledProviders takes precedence over legacy provider mode', () => {
  const settings = normalizeSettings({ provider: 'codex', enabledProviders: ['claude'] });

  assert.deepEqual(settings.enabledProviders, ['claude']);
  assert.equal('provider' in settings, false);
});

test('invalid enabledProviders returns the builtin default providers', () => {
  assert.deepEqual(normalizeSettings({ enabledProviders: [] }).enabledProviders, ['claude', 'codex']);
  assert.deepEqual(normalizeSettings({ enabledProviders: ['bogus'] }).enabledProviders, ['claude', 'codex']);
  assert.deepEqual(normalizeSettings({ enabledProviders: ['antigravity'] }).enabledProviders, ['claude', 'codex']);
});

test('renderer settings model exposes enabledProviders as editable state', () => {
  const types = fs.readFileSync('src/renderer/types.ts', 'utf8');
  const settingsView = fs.readFileSync('src/renderer/views/SettingsView.tsx', 'utf8');

  assert.match(types, /enabledProviders: Array<'claude' \| 'codex' \| 'antigravity'>/);
  assert.doesNotMatch(types, /provider: 'claude' \| 'codex' \| 'both'/);
  assert.match(settingsView, /'enabledProviders'/);
  assert.doesNotMatch(settingsView, /'provider'/);
});

test('renderer tracking settings use provider checkboxes backed by enabledProviders', () => {
  const settingsView = fs.readFileSync('src/renderer/views/SettingsView.tsx', 'utf8');

  assert.match(settingsView, /const PROVIDER_OPTIONS/);
  assert.match(settingsView, /function toggleProvider/);
  assert.match(settingsView, /enabledProviders/);
  assert.match(settingsView, /type="checkbox"/);
  assert.match(settingsView, /lockedLastProvider/);
  assert.match(settingsView, /disabled=\{disabled\}/);
  assert.match(settingsView, /Coming soon, not tracked yet/);
  assert.match(settingsView, /ACTIVE_PROVIDER_OPTIONS/);
  assert.doesNotMatch(settingsView, /legacyProviderFromEnabled/);
  assert.doesNotMatch(settingsView, /Claude \+ Codex/);
});

test('compact widget height uses enabled plan provider count', () => {
  const mainIndex = fs.readFileSync('src/main/index.ts', 'utf8');

  assert.match(mainIndex, /activePlanProviders/);
  assert.match(mainIndex, /settings\.enabledProviders/);
  assert.doesNotMatch(mainIndex, /settings\.provider/);
});

test('provider selection production code has no legacy provider-mode helpers', () => {
  for (const filePath of [
    'src/main/ipc.ts',
    'src/main/providers/settings.ts',
    'src/main/providers/types.ts',
    'src/main/stateManager.ts',
    'src/main/index.ts',
    'src/renderer/views/MainView.tsx',
    'src/renderer/views/CompactWidgetView.tsx',
    'src/renderer/views/NotificationsView.tsx',
  ]) {
    const source = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(source, /LegacyProviderMode|legacyProviderFromEnabled|enabledProvidersFromLegacy|TrackingProvider/);
    assert.doesNotMatch(source, /settings\.provider/);
    assert.doesNotMatch(source, /providerChanged = settings\.provider/);
  }
});

test('Claude provider keeps agent JSONL files out of visible startup sessions', () => {
  const source = fs.readFileSync('src/main/providers/claude/sources.ts', 'utf8');

  assert.match(source, /function isClaudeAgentJsonlPath/);
  assert.match(source, /path\.basename\(filePath\)\.startsWith\('agent-'\)/);
  assert.match(source, /if \(isClaudeAgentJsonlPath\(source\.filePath\)\) return null/);
});

test('help and notification copy match provider checkbox and Codex live fallback model', () => {
  const helpView = fs.readFileSync('src/renderer/views/HelpView.tsx', 'utf8');
  const notificationsView = fs.readFileSync('src/renderer/views/NotificationsView.tsx', 'utf8');

  assert.doesNotMatch(helpView, /Tracking Provider: Claude \/ Codex \/ Both/);
  assert.doesNotMatch(helpView, /provider mode/);
  assert.match(helpView, /provider checkboxes/);
  assert.match(notificationsView, /Codex live usage, cache, or local log 5-hour window/);
  assert.match(notificationsView, /Codex live usage, cache, or local log weekly window/);
});

test('renderer provider labels explicitly handle Antigravity instead of non-Codex-as-Claude', () => {
  for (const filePath of [
    'src/renderer/components/SessionRow.tsx',
    'src/renderer/components/ModelBreakdown.tsx',
    'src/renderer/views/MainView.tsx',
  ]) {
    const source = fs.readFileSync(filePath, 'utf8');
    assert.match(source, /antigravity/);
    assert.match(source, /Antigravity/);
    assert.doesNotMatch(source, /provider === 'codex' \? 'Codex' : 'Claude'/);
    assert.doesNotMatch(source, /session\.provider === 'codex' \? 'Codex' : 'Claude'/);
  }
});
