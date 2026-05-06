import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import stateManager from '../dist/main/stateManager.js';
import * as gitStatsKeys from '../dist/main/gitStatsKeys.js';

const { StateManager, resolveSessionRepoKeys } = stateManager;
const { normalizeGitPathKey } = gitStatsKeys;

function repoStatsFor(root) {
  const toplevel = normalizeGitPathKey(root);
  const gitCommonDir = normalizeGitPathKey(path.join(root, '.git'));
  return {
    toplevel,
    gitCommonDir,
    commitsToday: 1,
    linesAdded: 10,
    linesRemoved: 2,
    commits7d: 1,
    linesAdded7d: 10,
    linesRemoved7d: 2,
    commits30d: 1,
    linesAdded30d: 10,
    linesRemoved30d: 2,
    totalCommits: 5,
    totalLinesAdded: 100,
    totalLinesRemoved: 20,
    daily7d: [],
  };
}

test('initial app state does not release the startup splash', () => {
  const store = { store: {}, get: () => null };
  const manager = new StateManager(store, () => {});

  assert.equal(manager.getState().initialRefreshComplete, false);
});

test('only heavy refresh marks the initial state as complete', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const fastStart = source.indexOf('private fastRefresh');
  const heavyStart = source.indexOf('private async heavyRefresh');
  const fastBody = source.slice(fastStart, heavyStart);
  const heavyBody = source.slice(heavyStart);

  assert.equal(fastBody.includes('initialRefreshComplete: true'), false);
  assert.equal(heavyBody.includes('initialRefreshComplete: true'), true);
});

test('repo stats collection includes session cwd candidates', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');

  assert.match(source, /getRepoGitStats\(settings, force, sessions\)/);
  assert.match(source, /const cwdSet = new Set\(sessions\.map\(session => session\.cwd\)\)/);
});

test('renderer splash and session stabilization use initial readiness and daily stats', () => {
  const source = fs.readFileSync(path.resolve('src', 'renderer', 'App.tsx'), 'utf8');

  assert.match(source, /state\.initialRefreshComplete/);
  assert.match(source, /sameDailyStats\(a\.daily7d, b\.daily7d\)/);
  assert.match(source, /normalizeState\(next\)/);
});

test('renderer mutes cached Claude usage text while keeping the progress bar active', () => {
  const source = fs.readFileSync(path.resolve('src', 'renderer', 'components', 'TokenStatsCard.tsx'), 'utf8');

  assert.match(source, /cachedDisconnected = apiConnected === false && limitSourceLabel === 'cached'/);
  assert.match(source, /limitValueColor = pendingLimit \? C\.textMuted : barColor/);
  assert.match(source, /noData \|\| cachedDisconnected \? C\.textMuted : limitValueColor/);
});

test('warmup mode marks Codex local-log limits as provisional and defers alerts', () => {
  const mainSource = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'MainView.tsx'), 'utf8');
  const cardSource = fs.readFileSync(path.resolve('src', 'renderer', 'components', 'TokenStatsCard.tsx'), 'utf8');
  const widgetSource = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'CompactWidgetView.tsx'), 'utf8');
  const alertSource = fs.readFileSync(path.resolve('src', 'main', 'usageAlertManager.ts'), 'utf8');
  const stateSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');

  assert.match(mainSource, /historyWarmupPending=\{state\.historyWarmupPending\}/);
  assert.match(mainSource, /pendingLimit=\{codexWeekPending\}/);
  assert.match(mainSource, /limits\.codexWeek\.source === 'localLog' \|\| !codexWeekHasLimit/);
  assert.match(cardSource, /pendingLimitLabel/);
  assert.match(cardSource, /displayLimitSourceLabel = pendingLimit/);
  assert.match(widgetSource, /const codexWeekPending = state\.historyWarmupPending/);
  assert.match(widgetSource, /unknownLabel: 'waiting'/);
  assert.match(widgetSource, /No 5h reset data yet/);
  assert.match(widgetSource, /5h limits appear after first usage event/);
  assert.match(widgetSource, /scanning: codexH5Pending \|\| codexWeekPending/);
  assert.match(widgetSource, /agent\.scanning \? \(/);
  assert.match(widgetSource, />--<\/span>/);
  assert.doesNotMatch(widgetSource, /C\.accent[^>]+>scanning<\/span>/);
  assert.match(widgetSource, /bootPending = !state\.initialRefreshComplete/);
  assert.match(mainSource, /historyWarmupPending \|\|/);
  assert.match(alertSource, /deferCodexLocalLog/);
  assert.match(alertSource, /key\.startsWith\('codex-'\) && source === 'localLog'/);
  assert.match(stateSource, /deferCodexLocalLog: startupPartial/);
});

test('settings and widget integration guard malformed persisted values', () => {
  const ipcSource = fs.readFileSync(path.resolve('src', 'main', 'ipc.ts'), 'utf8');
  const mainSource = fs.readFileSync(path.resolve('src', 'main', 'index.ts'), 'utf8');
  const sectionsSource = fs.readFileSync(path.resolve('src', 'renderer', 'mainSections.ts'), 'utf8');
  const settingsSource = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'SettingsView.tsx'), 'utf8');
  const widgetSource = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'CompactWidgetView.tsx'), 'utf8');

  assert.match(ipcSource, /function normalizedSettingsPartial\(partial: unknown\)/);
  assert.match(ipcSource, /typeof record\.globalHotkey === 'string'/);
  assert.match(ipcSource, /typeof record\.compactWidgetEnabled === 'boolean'/);
  assert.match(ipcSource, /return \[\.\.\.new Set\(thresholds\)\]\.sort/);
  assert.match(ipcSource, /hasOwnProperty\.call\(record, 'compactWidgetBounds'\)/);
  assert.match(ipcSource, /normalizeSettings\(store\.store\)/);
  assert.match(mainSource, /installNavigationGuards\(win\)/);
  assert.match(mainSource, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(mainSource, /store\.set\('globalHotkey', registeredGlobalHotkey\)/);
  assert.match(mainSource, /rollbackHotkeySettingAfterFailedRegistration/);
  assert.match(mainSource, /if \(!registeredGlobalHotkey\) return false/);
  assert.match(mainSource, /registerGlobalHotkey\(hotkey: string\): boolean/);
  assert.match(mainSource, /syncUiVisibility\(\)/);
  assert.match(mainSource, /stateManager\?\.setUiVisible\(popupVisible\)/);
  assert.match(mainSource, /readyWidgetWindows/);
  assert.doesNotMatch(mainSource, /did-finish-load[^;]+revealCompactWidget/);
  assert.match(mainSource, /schedulePersistWidgetPosition/);
  assert.match(mainSource, /alwaysOnTop: true/);
  assert.match(mainSource, /widgetWindow\.setAlwaysOnTop\(true\)/);
  const stateManagerSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  assert.match(stateManagerSource, /return normalizeSettings\(this\.store\.store\)/);
  assert.match(stateManagerSource, /this\.state = \{ \.\.\.this\.state, sessions, settings, codeOutputStats, codeOutputLoading: true/);
  assert.match(widgetSource, /dragSeqRef/);
  assert.match(widgetSource, /dragSeq !== dragSeqRef\.current/);
  assert.match(widgetSource, /const toolbarButtonStyle: React\.CSSProperties/);
  assert.match(widgetSource, /return `\$\{hours\}h \$\{minutes\}m`/);
  assert.match(widgetSource, /gridTemplateColumns: '24px minmax\(0, 1fr\) 38px 64px'/);
  assert.match(sectionsSource, /Array\.isArray\(value\) \? value : \[\]/);
  assert.match(settingsSource, /compactWidgetBounds: _compactWidgetBounds/);
  assert.match(settingsSource, /Use Ctrl\+Shift or Ctrl\+Alt/);
});

test('Codex account limit collection is separated from visible usage filters', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const collectStart = source.indexOf('private collectCodexRateLimits');
  const collectEnd = source.indexOf('private async loadProviderSummaries', collectStart);
  const collectBody = source.slice(collectStart, collectEnd);
  const fastStart = source.indexOf('private async fastRefresh');
  const fastEnd = source.indexOf('private async refreshGitStatsAfterStartup', fastStart);
  const fastBody = source.slice(fastStart, fastEnd);

  assert.match(source, /scanCodexRateLimitsOnly/);
  assert.match(source, /const excludedForUsage = this\.isExcludedSummary\(filePath, 'codex', isExcluded\)/);
  assert.match(source, /codexRateLimits = this\.mergeCodexRateLimits\(codexRateLimits, await scanCodexRateLimitsOnly\(filePath\)\)/);
  assert.doesNotMatch(collectBody, /getVisibleSummaries/);
  assert.match(source, /private async refreshRecentCodexRateLimits/);
  assert.match(fastBody, /await this\.refreshRecentCodexRateLimits\(settings\)/);
});

test('bottom refresh label distinguishes scan countdown from update age', () => {
  const source = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'MainView.tsx'), 'utf8');

  assert.match(source, /\$\{elapsed\}s ago/);
  assert.match(source, /scan \$\{formatWarmupEta\(historyWarmupStartsAt\)\}/);
});

test('startup refresh uses lightweight session bootstrapping and API status labels', () => {
  const mainSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const rendererSource = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'MainView.tsx'), 'utf8');

  assert.match(mainSource, /buildScopedSessionInfosDetailed\(loaded\.summaries\)/);
  assert.match(mainSource, /buildStartupPriorityFiles/);
  assert.match(mainSource, /historyWarmupStartsAt/);
  assert.match(rendererSource, /apiStatusLabel/);
  assert.match(rendererSource, /formatWarmupStatus/);
  assert.match(rendererSource, /resetLabel=\{limits\.so\.resetLabel\}/);
});

test('session cwd under a repo root scopes that repo output', () => {
  const repoRoot = path.resolve('tmp', 'example-repo');
  const repoStats = repoStatsFor(repoRoot);
  const repoKey = repoStats.gitCommonDir;
  const sessions = [{ cwd: path.join(repoRoot, 'packages', 'app'), gitStats: null }];

  const scoped = resolveSessionRepoKeys(sessions, { [repoKey]: repoStats });

  assert.deepEqual([...scoped], [repoKey]);
});

test('direct session git stats still scope the repo when cwd differs', () => {
  const repoRoot = path.resolve('tmp', 'example-repo');
  const repoStats = repoStatsFor(repoRoot);
  const repoKey = repoStats.gitCommonDir;
  const sessions = [{
    cwd: path.resolve('tmp', 'outside-cwd'),
    gitStats: { gitCommonDir: repoStats.gitCommonDir, toplevel: repoStats.toplevel },
  }];

  const scoped = resolveSessionRepoKeys(sessions, { [repoKey]: repoStats });

  assert.deepEqual([...scoped], [repoKey]);
});
