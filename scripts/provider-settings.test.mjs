import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import ipcModule from '../dist/main/ipc.js';
import { tCallRegex } from './test-support/i18n.mjs';

const { DEFAULT_SETTINGS, normalizeSettings } = ipcModule;

test('settings use implemented enabledProviders as the canonical provider selection', () => {
  const settings = normalizeSettings({ enabledProviders: ['antigravity', 'claude', 'claude', 'bogus'] });

  assert.deepEqual(settings.enabledProviders, ['antigravity', 'claude']);
  assert.equal('provider' in settings, false);
});

test('legacy provider mode migrates when enabledProviders is absent', () => {
  assert.deepEqual(normalizeSettings({ provider: 'claude' }).enabledProviders, ['claude']);
  assert.deepEqual(normalizeSettings({ provider: 'codex' }).enabledProviders, ['codex']);
  assert.deepEqual(normalizeSettings({ provider: 'both' }).enabledProviders, ['claude', 'codex']);
  assert.equal('provider' in DEFAULT_SETTINGS, false);
  assert.equal('provider' in normalizeSettings({ provider: 'codex' }), false);
});

test('enabledProviders is the only accepted provider selection setting', () => {
  const settings = normalizeSettings({ provider: 'codex', enabledProviders: ['claude'] });

  assert.deepEqual(settings.enabledProviders, ['claude']);
  assert.equal('provider' in settings, false);
});

test('invalid enabledProviders returns the builtin default providers', () => {
  assert.deepEqual(normalizeSettings({ enabledProviders: [] }).enabledProviders, ['claude', 'codex']);
  assert.deepEqual(normalizeSettings({ enabledProviders: ['bogus'] }).enabledProviders, ['claude', 'codex']);
  assert.deepEqual(normalizeSettings({ enabledProviders: ['antigravity'] }).enabledProviders, ['antigravity']);
  assert.deepEqual(normalizeSettings({ enabledProviders: ['claude', 'antigravity'] }).enabledProviders, ['claude', 'antigravity']);
});

test('settings normalize quota target display modes by target id', () => {
  const settings = normalizeSettings({
    quotaTargetModes: {
      'claude.group.account': 'rich',
      'claude.group.percent-family': 'simple',
      'codex.group.model.gpt-5.1': 'none',
      'antigravity.group.model.gemini-3-pro': 'simple',
      'claude.h5': 'rich',
      'codex.week': 'none',
      'bogus.week': 'rich',
      'claude.week': 'full',
      'claude.bad key': 'none',
    },
    quotaTargetOrder: [
      'codex.group.model.gpt-5.1',
      'claude.group.account',
      'codex.group.model.gpt-5.1',
      'claude.week',
      'bogus.group.account',
      'antigravity.group.model.gemini-3-pro',
      'claude.group.bad key',
    ],
  });

  assert.deepEqual(settings.quotaTargetModes, {
    'claude.group.account': 'rich',
    'claude.group.percent-family': 'simple',
    'codex.group.model.gpt-5.1': 'none',
    'antigravity.group.model.gemini-3-pro': 'simple',
  });
  assert.deepEqual(settings.quotaTargetOrder, [
    'codex.group.model.gpt-5.1',
    'claude.group.account',
    'antigravity.group.model.gemini-3-pro',
  ]);
  assert.deepEqual(DEFAULT_SETTINGS.quotaTargetModes, {});
  assert.deepEqual(DEFAULT_SETTINGS.quotaTargetOrder, []);
});

test('Antigravity quota duration pace setting defaults off and normalizes boolean values', () => {
  assert.equal(DEFAULT_SETTINGS.antigravityQuotaDurationPaceEnabled, false);
  assert.equal(normalizeSettings({}).antigravityQuotaDurationPaceEnabled, false);
  assert.equal(normalizeSettings({ antigravityQuotaDurationPaceEnabled: true }).antigravityQuotaDurationPaceEnabled, true);
  assert.equal(normalizeSettings({ antigravityQuotaDurationPaceEnabled: false }).antigravityQuotaDurationPaceEnabled, false);
  assert.equal(normalizeSettings({ antigravityQuotaDurationPaceEnabled: 'true' }).antigravityQuotaDurationPaceEnabled, false);
});

test('language preference is stored through AppSettings, not renderer localStorage', () => {
  const i18nSource = fs.readFileSync('src/renderer/i18n/index.ts', 'utf8');

  assert.equal(DEFAULT_SETTINGS.language, 'system');
  assert.equal(normalizeSettings({}).language, 'system');
  assert.equal(normalizeSettings({ language: 'en' }).language, 'en');
  assert.equal(normalizeSettings({ language: 'ja' }).language, 'ja');
  assert.equal(normalizeSettings({ language: 'system' }).language, 'system');
  assert.equal(normalizeSettings({ language: 'ko' }).language, 'system');
  assert.equal(normalizeSettings({ language: true }).language, 'system');
  assert.match(i18nSource, /applyLanguagePreference/);
  assert.doesNotMatch(i18nSource, /localStorage|LANGUAGE_STORAGE_KEY|setItem|getItem/);
});

test('taskbar quota settings default off and normalize abbreviation overrides', () => {
  const settings = normalizeSettings({
    taskbarQuotaEnabled: true,
    taskbarQuotaMaxBlocks: 9,
    quotaTargetAbbreviations: {
      'claude.group.account': ' c ',
      'codex.group.account': 'x1',
      'antigravity.group.model.gemini-3-pro': 'ag3',
      'codex.group.model.gpt-5.1': 'TOOLONG',
      'claude.group.percent-family': '',
      'claude.group.bad value': 'BAD',
      'bogus.group.account': 'B',
      'claude.group.account.duplicate': '@@',
    },
  });

  assert.equal(DEFAULT_SETTINGS.taskbarQuotaEnabled, false);
  assert.equal(DEFAULT_SETTINGS.taskbarQuotaMaxBlocks, 2);
  assert.deepEqual(DEFAULT_SETTINGS.quotaTargetAbbreviations, {});
  assert.equal(settings.taskbarQuotaEnabled, true);
  assert.equal(settings.taskbarQuotaMaxBlocks, 3);
  assert.deepEqual(settings.quotaTargetAbbreviations, {
    'claude.group.account': 'C',
    'codex.group.account': 'X1',
    'antigravity.group.model.gemini-3-pro': 'AG3',
  });
});

test('settings:set persists taskbar quota settings through the explicit allowlist', () => {
  const handlers = new Map();
  const store = {
    store: {},
    set(key, value) {
      this.store[key] = value;
    },
  };

  ipcModule.registerIpcHandlers({
    store,
    getState: () => ({}),
    forceRefresh: async () => {},
    applySettingsChange: () => {},
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
  });

  const setSettings = handlers.get('settings:set');
  assert.ok(setSettings);

  let saved = setSettings(null, {
    taskbarQuotaEnabled: true,
    taskbarQuotaMaxBlocks: 1,
    language: 'ja',
    quotaTargetAbbreviations: {
      'claude.group.account': ' cc ',
      'codex.group.account': 'x',
    },
  });
  assert.equal(saved.taskbarQuotaEnabled, true);
  assert.equal(saved.taskbarQuotaMaxBlocks, 1);
  assert.equal(saved.language, 'ja');
  assert.deepEqual(saved.quotaTargetAbbreviations, {
    'claude.group.account': 'CC',
    'codex.group.account': 'X',
  });
  assert.equal(store.store.taskbarQuotaEnabled, true);
  assert.equal(store.store.taskbarQuotaMaxBlocks, 1);
  assert.equal(store.store.language, 'ja');

  saved = setSettings(null, { taskbarQuotaEnabled: false, taskbarQuotaMaxBlocks: 99, language: 'bogus' });
  assert.equal(saved.taskbarQuotaEnabled, false);
  assert.equal(saved.taskbarQuotaMaxBlocks, 3);
  assert.equal(saved.language, 'ja');
  assert.equal(store.store.taskbarQuotaEnabled, false);
  assert.equal(store.store.taskbarQuotaMaxBlocks, 3);
  assert.equal(store.store.language, 'ja');

  saved = setSettings(null, { taskbarQuotaEnabled: 'true', taskbarQuotaMaxBlocks: '2' });
  assert.equal(saved.taskbarQuotaEnabled, false);
  assert.equal(saved.taskbarQuotaMaxBlocks, 3);
  assert.equal(store.store.taskbarQuotaEnabled, false);
  assert.equal(store.store.taskbarQuotaMaxBlocks, 3);
});

test('renderer settings model exposes enabledProviders as editable state', () => {
  const types = fs.readFileSync('src/renderer/types.ts', 'utf8');
  const settingsView = fs.readFileSync('src/renderer/views/SettingsView.tsx', 'utf8');
  const app = fs.readFileSync('src/renderer/App.tsx', 'utf8');

  assert.match(types, /enabledProviders: ProviderId\[\]/);
  assert.match(types, /from '\.\.\/shared\/quotaTypes'/);
  assert.match(types, /quotaTargetModes: Partial<Record<string, QuotaDisplayMode>>/);
  assert.match(types, /quotaTargetOrder: string\[\]/);
  assert.match(types, /taskbarQuotaEnabled: boolean/);
  assert.match(types, /taskbarQuotaMaxBlocks: number/);
  assert.match(types, /quotaTargetAbbreviations: Partial<Record<string, string>>/);
  assert.match(types, /antigravityQuotaDurationPaceEnabled: boolean/);
  assert.match(types, /language: 'system' \| 'en' \| 'ja'/);
  assert.doesNotMatch(types, /provider: 'claude' \| 'codex' \| 'both'/);
  assert.match(settingsView, /'enabledProviders'/);
  assert.match(settingsView, /'quotaTargetModes'/);
  assert.match(settingsView, /'quotaTargetOrder'/);
  assert.match(settingsView, /'taskbarQuotaEnabled'/);
  assert.match(settingsView, /'taskbarQuotaMaxBlocks'/);
  assert.match(settingsView, /'quotaTargetAbbreviations'/);
  assert.match(settingsView, /'antigravityQuotaDurationPaceEnabled'/);
  assert.match(settingsView, /'language'/);
  assert.match(settingsView, /normalizeLanguagePreference\(s\.language\)/);
  assert.doesNotMatch(settingsView, /localStorage/);
  assert.match(settingsView, tCallRegex('settingsView.providers.antigravityPace'));
  assert.match(app, /taskbarQuotaEnabled: false/);
  assert.match(app, /taskbarQuotaMaxBlocks: 2/);
  assert.match(app, /language: 'system'/);
  assert.match(app, /applyLanguagePreference\(state\.settings\.language\)/);
  assert.match(app, /quotaTargetAbbreviations: \{\}/);
  assert.doesNotMatch(settingsView, /'plan'/);
  assert.doesNotMatch(settingsView, /'provider'/);
});

test('renderer provider settings use provider checkboxes backed by enabledProviders', () => {
  const settingsView = fs.readFileSync('src/renderer/views/SettingsView.tsx', 'utf8');

  assert.match(settingsView, /const PROVIDER_OPTIONS/);
  assert.match(settingsView, tCallRegex('settingsView.providers.heading'));
  assert.doesNotMatch(settingsView, /<SectionHeader label="Tracking" \/>/);
  assert.match(settingsView, tCallRegex('settingsView.quotaDisplay.heading'));
  assert.match(settingsView, tCallRegex('settingsView.general.taskbarQuota'));
  assert.match(settingsView, tCallRegex('settingsView.general.taskbarMaxBlocks'));
  assert.match(settingsView, tCallRegex('settingsView.general.taskbarQuotaHint'));
  assert.match(settingsView, /setQuotaTargetAbbreviation/);
  assert.match(settingsView, /normalizeQuotaTargetAbbreviationInput/);
  assert.match(settingsView, tCallRegex('settingsView.quotaDisplay.modeRich'));
  assert.match(settingsView, tCallRegex('settingsView.quotaDisplay.modeSimple'));
  assert.match(settingsView, tCallRegex('settingsView.quotaDisplay.modeNone'));
  assert.match(settingsView, /setQuotaTargetMode/);
  assert.match(settingsView, /target\.period/);
  assert.match(settingsView, /target\.taskbarEligible/);
  assert.match(settingsView, /target\.badges/);
  assert.match(settingsView, /target\.rowCount/);
  assert.match(settingsView, /s\.taskbarQuotaEnabled && isTaskbarEligibleQuotaTarget\(target\)/);
  assert.match(settingsView, /moveQuotaTarget/);
  assert.match(settingsView, /quotaTargetOrder/);
  assert.match(settingsView, tCallRegex('settingsView.quotaDisplay.moveUp'));
  assert.match(settingsView, tCallRegex('settingsView.quotaDisplay.moveDown'));
  assert.match(settingsView, tCallRegex('settingsView.quotaDisplay.resetOrder'));
  assert.match(settingsView, /quotaSourceBadgeToneStyle/);
  assert.match(settingsView, /function toggleProvider/);
  assert.match(settingsView, /enabledProviders/);
  assert.match(settingsView, /type="checkbox"/);
  assert.match(settingsView, /lockedLastProvider/);
  assert.match(settingsView, /disabled=\{disabled\}/);
  assert.match(settingsView, /ACTIVE_PROVIDER_OPTIONS/);
  assert.match(settingsView, /id: 'antigravity'/);
  assert.match(settingsView, /label: 'Antigravity'/);
  assert.match(settingsView, tCallRegex('settingsView.providers.antigravityDetail'));
  assert.match(settingsView, tCallRegex('settingsView.providers.atLeastOneProvider'));
  assert.doesNotMatch(settingsView, /Coming soon, not tracked yet/);
  assert.doesNotMatch(settingsView, /credit/i);
  assert.doesNotMatch(settingsView, /legacyProviderFromEnabled/);
  assert.doesNotMatch(settingsView, /Claude \+ Codex/);
});

test('quota display target ordering controls are placed after display mode controls', () => {
  const settingsView = fs.readFileSync('src/renderer/views/SettingsView.tsx', 'utf8');
  const targetStart = settingsView.indexOf('{quotaTargetOptions.map((target, index)');
  const targetEnd = settingsView.indexOf("t('settingsView.quotaDisplay.resetOrder')", targetStart);
  const targetBody = settingsView.slice(targetStart, targetEnd);
  const moveUpTitle = tCallRegex('settingsView.quotaDisplay.moveUp').source;
  const moveDownTitle = tCallRegex('settingsView.quotaDisplay.moveDown').source;

  assert.notEqual(targetStart, -1);
  assert.notEqual(targetEnd, -1);
  assert.ok(targetBody.indexOf("aria-label={t('settingsView.quotaDisplay.abbreviationLabel'") < targetBody.indexOf("(['rich', 'simple', 'none'] as const).map"));
  assert.ok(targetBody.indexOf('value={s.quotaTargetAbbreviations?.[target.id] ?? \'\'}') < targetBody.indexOf("(['rich', 'simple', 'none'] as const).map"));
  assert.ok(targetBody.indexOf("(['rich', 'simple', 'none'] as const).map") < targetBody.search(moveUpTitle));
  assert.ok(targetBody.search(moveUpTitle) < targetBody.search(moveDownTitle));
});

test('compact widget height uses visible quota target count', () => {
  const mainIndex = fs.readFileSync('src/main/index.ts', 'utf8');
  const sizing = fs.readFileSync('src/main/compactWidgetSizing.ts', 'utf8');

  assert.match(mainIndex, /compactWidgetSize\(settings, stateManager\?\.getState\(\)\)/);
  assert.match(sizing, /compactWidgetTargetSummary/);
  assert.match(sizing, /settings\.quotaTargetModes/);
  assert.match(sizing, /state\?\.providerQuotas/);
  assert.match(sizing, /groupQuotaEntries/);
  assert.match(sizing, /group\.entries\.length/);
  assert.doesNotMatch(sizing, /provider === 'claude'/);
  assert.doesNotMatch(sizing, /provider === 'codex'/);
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
  assert.match(source, /isClaudeAgentJsonlName\(path\.basename\(filePath\)\)/);
  assert.match(source, /if \(isClaudeAgentJsonlPath\(source\.filePath\)\) return null/);
});

test('provider source ownership uses directory-boundary containment', () => {
  const sharedSource = fs.readFileSync('src/main/providers/shared/sourceFiles.ts', 'utf8');
  const claudeSource = fs.readFileSync('src/main/providers/claude/sources.ts', 'utf8');
  const codexSource = fs.readFileSync('src/main/providers/codex/sources.ts', 'utf8');

  assert.match(sharedSource, /function isSourcePathInside/);
  assert.match(sharedSource, /path\.relative\(parent, child\)/);
  assert.match(claudeSource, /isSourcePathInside\(CLAUDE_PROJECTS_DIR, filePath\)/);
  assert.match(codexSource, /CODEX_USAGE_DIRS\.some\(root => isSourcePathInside\(root, filePath\)\)/);
  assert.doesNotMatch(codexSource, /normalized\.startsWith/);
});

test('help and notification copy match provider checkbox and Codex live fallback model', () => {
  const helpView = fs.readFileSync('src/renderer/views/HelpView.tsx', 'utf8');
  const notificationsView = fs.readFileSync('src/renderer/views/NotificationsView.tsx', 'utf8');

  assert.doesNotMatch(helpView, /Tracking Provider: Claude \/ Codex \/ Both/);
  assert.doesNotMatch(helpView, /provider mode/);
  assert.match(helpView, /provider checkboxes/);
  assert.match(helpView, /Disabled providers are not scanned locally/);
  assert.match(notificationsView, tCallRegex('notificationsView.targets.codexFiveHour.detail'));
  assert.match(notificationsView, tCallRegex('notificationsView.targets.codexWeekly.detail'));
});

test('public README copy matches provider checkbox settings', () => {
  for (const filePath of [
    'README.md',
    'README.ko.md',
    'README.ja.md',
    'README.zh-CN.md',
    'README.es.md',
  ]) {
    const source = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(source, /Tracking Provider/);
    assert.doesNotMatch(source, /Claude \/ Codex \/ Both/);
  }

  const readme = fs.readFileSync('README.md', 'utf8');
  assert.match(readme, /provider checkboxes/);
  assert.match(readme, /providers\//);
  assert.doesNotMatch(readme, /sessionDiscovery\.ts/);
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
