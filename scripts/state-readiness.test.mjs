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
  assert.match(source, /stateFreshness: 'empty'/);
  assert.match(source, /normalizeStateFreshness/);
  assert.match(source, /normalizeProviderWindowUsage/);
  assert.match(source, /Object\.entries\(rawWindows\)/);
  assert.doesNotMatch(source, /nextByProvider\.antigravity\.windows\?\.h5/);
});

test('renderer mutes cached usage text and shows soft loading states', () => {
  const source = fs.readFileSync(path.resolve('src', 'renderer', 'components', 'TokenStatsCard.tsx'), 'utf8');

  assert.match(source, /cachedDisconnected = apiConnected === false && limitSourceLabel === 'Cache'/);
  assert.match(source, /limitValueColor = pendingLimit \? C\.textMuted : barColor/);
  assert.match(source, /noData \|\| cachedDisconnected \? C\.textMuted : limitValueColor/);
  assert.match(source, /LimitStatusIndicator/);
  assert.match(source, /LimitStatusBar/);
});

test('warmup mode marks Codex local-log limits as provisional and defers alerts', () => {
  const mainSource = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'MainView.tsx'), 'utf8');
  const modelSource = fs.readFileSync(path.resolve('src', 'renderer', 'quotaDisplayModels.ts'), 'utf8');
  const cardSource = fs.readFileSync(path.resolve('src', 'renderer', 'components', 'TokenStatsCard.tsx'), 'utf8');
  const widgetSource = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'CompactWidgetView.tsx'), 'utf8');
  const alertSource = fs.readFileSync(path.resolve('src', 'main', 'usageAlertManager.ts'), 'utf8');
  const stateSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');

  assert.match(mainSource, /historyWarmupPending=\{state\.historyWarmupPending\}/);
  assert.match(mainSource, /pendingLimit=\{card\.pending\}/);
  assert.match(modelSource, /quotaWindow\.source === 'localLog'/);
  assert.match(cardSource, /pendingLimitLabel/);
  assert.match(cardSource, /displayLimitSourceLabel = pendingLimit/);
  assert.match(modelSource, /isPendingQuotaWindow/);
  assert.match(widgetSource, /unknownLabel: 'waiting'/);
  assert.match(widgetSource, /No 5h reset data yet/);
  assert.match(widgetSource, /It will appear after local usage or provider data is detected/);
  assert.match(widgetSource, /target instanceof Element && !!target\.closest\('\[data-no-drag="true"\]'\)/);
  assert.match(widgetSource, /const scanning = rows\.some\(row => row\.pending\)/);
  assert.match(widgetSource, /agent\.scanning \? \(/);
  assert.match(widgetSource, /MiniLimitStatus/);
  assert.match(widgetSource, /Provider limit-data health/);
  assert.match(widgetSource, /\`\$\{providerLabel\} OK\`/);
  assert.match(widgetSource, /tone: 'good'/);
  assert.doesNotMatch(widgetSource, />--<\/span>/);
  assert.match(widgetSource, /bootPending = !state\.initialRefreshComplete/);
  assert.match(stateSource, /API_MIN_INTERVAL_MS = 300_000/);
  assert.match(stateSource, /MANUAL_PROVIDER_USAGE_FORCE_MIN_INTERVAL_MS = 60_000/);
  assert.match(stateSource, /consumeManualProviderUsageForce/);
  assert.match(stateSource, /forceProviderUsage: this\.consumeManualProviderUsageForce\(\)/);
  assert.match(stateSource, /refreshProviderQuotas\(settingsForApi, force \|\| forceProviderUsage\)/);
  assert.match(stateSource, /provider\.fetchQuota/);
  assert.match(mainSource, /codexStatusLabel/);
  assert.match(mainSource, /Codex limited/);
  assert.match(mainSource, /historyWarmupPending/);
  assert.match(alertSource, /deferCodexLocalLog/);
  assert.match(alertSource, /provider === 'codex' && source === 'localLog'/);
  assert.match(stateSource, /deferCodexLocalLog: partialHistoryScan/);
});

test('Plan Usage and floating widget render providerQuotas through generic provider selectors', () => {
  const mainSource = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'MainView.tsx'), 'utf8');
  const widgetSource = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'CompactWidgetView.tsx'), 'utf8');
  const modelSource = fs.readFileSync(path.resolve('src', 'renderer', 'quotaDisplayModels.ts'), 'utf8');
  const tokenStatsSource = fs.readFileSync(path.resolve('src', 'renderer', 'components', 'TokenStatsCard.tsx'), 'utf8');
  const panelStart = mainSource.indexOf('const PlanUsagePanel');
  const panelEnd = mainSource.indexOf('const HistoryWarmupBanner', panelStart);
  const panelBody = mainSource.slice(panelStart, panelEnd);
  const agentsStart = widgetSource.indexOf('function buildWidgetAgents');
  const agentsEnd = widgetSource.indexOf('function buildHealthItems', agentsStart);
  const agentsBody = widgetSource.slice(agentsStart, agentsEnd);
  const healthStart = widgetSource.indexOf('function providerHealth');
  const healthEnd = widgetSource.indexOf('function buildWidgetAgents', healthStart);
  const healthBody = widgetSource.slice(healthStart, healthEnd);

  assert.match(modelSource, /export interface QuotaDisplayGroupViewModel/);
  assert.match(modelSource, /export interface QuotaDisplayRowViewModel/);
  assert.match(modelSource, /ProviderQuotaRowVisualKind/);
  assert.match(modelSource, /buildQuotaDisplayModels/);
  assert.match(modelSource, /buildQuotaDisplayGroups/);
  assert.match(modelSource, /quotaGroupId/);
  assert.match(modelSource, /group\.windowKeys/);
  assert.match(modelSource, /rowHasDisplaySignal/);
  assert.match(panelBody, /buildQuotaDisplayModels/);
  assert.match(panelBody, /simpleGroups/);
  assert.match(panelBody, /richGroups/);
  assert.match(panelBody, /SimpleQuotaGroupBlock/);
  assert.match(panelBody, /durationMs=\{card\.durationMs\}/);
  assert.match(agentsBody, /buildQuotaDisplayModels/);
  assert.match(agentsBody, /widgetGroups/);
  assert.match(agentsBody, /row\.visualKind/);
  assert.match(agentsBody, /durationMs: row\.durationMs/);
  assert.doesNotMatch(agentsBody, /rowFor\('week'/);
  assert.doesNotMatch(agentsBody, /enabledProviders\.has\('claude'\)/);
  assert.doesNotMatch(agentsBody, /enabledProviders\.has\('codex'\)/);
  assert.doesNotMatch(tokenStatsSource, /normalized === '5h'|normalized === '1w'/);
  assert.doesNotMatch(widgetSource, /function windowDurationMs/);
  assert.match(widgetSource, /function quotaStatusTone/);
  assert.ok(healthBody.indexOf("sources.includes('Log')") < healthBody.indexOf('if (statusLabel && !connected)'));
});

test('settings and widget integration guard malformed persisted values', () => {
  const ipcSource = fs.readFileSync(path.resolve('src', 'main', 'ipc.ts'), 'utf8');
  const mainSource = fs.readFileSync(path.resolve('src', 'main', 'index.ts'), 'utf8');
  const appSource = fs.readFileSync(path.resolve('src', 'renderer', 'App.tsx'), 'utf8');
  const mainViewSource = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'MainView.tsx'), 'utf8');
  const sectionsSource = fs.readFileSync(path.resolve('src', 'renderer', 'mainSections.ts'), 'utf8');
  const settingsSource = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'SettingsView.tsx'), 'utf8');
  const widgetSource = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'CompactWidgetView.tsx'), 'utf8');

  assert.match(ipcSource, /function normalizedSettingsPartial\(partial: unknown\)/);
  assert.match(ipcSource, /typeof record\.globalHotkey === 'string'/);
  assert.match(ipcSource, /typeof record\.compactWidgetEnabled === 'boolean'/);
  assert.match(ipcSource, /compactWidgetWaitingAnimationEnabled: boolean/);
  assert.match(ipcSource, /typeof record\.compactWidgetWaitingAnimationEnabled === 'boolean'/);
  assert.match(ipcSource, /compactWidgetWaitingAnimationEnabled: false/);
  assert.match(ipcSource, /return \[\.\.\.new Set\(thresholds\)\]\.sort/);
  assert.match(ipcSource, /hasOwnProperty\.call\(record, 'compactWidgetBounds'\)/);
  assert.match(ipcSource, /normalizeQuotaTargetOrder/);
  assert.match(ipcSource, /normalizeSettings\(store\.store\)/);
  assert.match(mainSource, /installNavigationGuards\(win\)/);
  assert.match(mainSource, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(mainSource, /store\.set\('globalHotkey', registeredGlobalHotkey\)/);
  assert.match(mainSource, /rollbackHotkeySettingAfterFailedRegistration/);
  assert.match(mainSource, /if \(!registeredGlobalHotkey\) return false/);
  assert.match(mainSource, /registerGlobalHotkey\(hotkey: string\): boolean/);
  assert.match(mainSource, /syncUiVisibility\(\)/);
  assert.match(mainSource, /const widgetVisible = .*widgetWindow.*isVisible\(\)/);
  assert.match(mainSource, /const foregroundVisible = popupVisible \|\| widgetVisible/);
  assert.match(mainSource, /stateManager\?\.setUiVisible\(foregroundVisible\)/);
  assert.match(mainSource, /function keepWindowOutOfTaskbar\(win: BrowserWindow\)/);
  assert.match(mainSource, /win\.setSkipTaskbar\(true\)/);
  assert.match(mainSource, /keepWindowOutOfTaskbar\(popupWindow\)/);
  assert.match(mainSource, /keepWindowOutOfTaskbar\(win\)/);
  const widgetDragStart = mainSource.indexOf("ipcMain.handle('window:set-compact-widget-position'");
  const widgetDragEnd = mainSource.indexOf("ipcMain.handle('theme:resolved'", widgetDragStart);
  const widgetDragBody = mainSource.slice(widgetDragStart, widgetDragEnd);
  assert.match(widgetDragBody, /widgetWindow\.setBounds/);
  assert.match(widgetDragBody, /keepWindowOutOfTaskbar\(widgetWindow\)/);
  assert.match(mainSource, /readyWidgetWindows/);
  assert.doesNotMatch(mainSource, /did-finish-load[^;]+revealCompactWidget/);
  assert.match(mainSource, /schedulePersistWidgetPosition/);
  assert.match(mainSource, /function flushWidgetPosition/);
  assert.match(mainSource, /win\.on\('close', \(\) => flushWidgetPosition\(win\)\)/);
  assert.match(mainSource, /alwaysOnTop: true/);
  assert.match(mainSource, /widgetWindow\.setAlwaysOnTop\(true\)/);
  assert.match(appSource, /handleToggleCompactWidget/);
  assert.match(appSource, /compactWidgetEnabled: !state\.settings\.compactWidgetEnabled/);
  assert.match(appSource, /compactWidgetWaitingAnimationEnabled: next\.settings\?\.compactWidgetWaitingAnimationEnabled === true/);
  assert.match(appSource, /normalizeQuotaTargetOrder/);
  assert.match(mainViewSource, /PictureInPicture2/);
  assert.match(mainViewSource, /aria-pressed=\{compactWidgetEnabled\}/);
  assert.match(mainViewSource, /Show floating Quota Pace widget/);
  assert.match(mainViewSource, /quotaSourceBadgeToneStyle/);
  const stateManagerSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  assert.match(stateManagerSource, /return normalizeSettings\(this\.store\.store\)/);
  assert.match(stateManagerSource, /enabled\.has\(session\.provider\)/);
  assert.match(stateManagerSource, /usage: derived\.usage/);
  assert.match(stateManagerSource, /providerQuotas: derived\.providerQuotas/);
  assert.match(widgetSource, /dragSeqRef/);
  assert.match(widgetSource, /dragSeq !== dragSeqRef\.current/);
  assert.match(widgetSource, /const toolbarButtonStyle: React\.CSSProperties/);
  assert.match(widgetSource, /animateWaiting=\{state\.settings\.compactWidgetWaitingAnimationEnabled === true\}/);
  assert.match(widgetSource, /visualState === 'waiting' && !animateWaiting/);
  assert.match(widgetSource, /quotaPctBarColor/);
  assert.match(widgetSource, /quotaSourceBadgeToneStyle/);
  assert.match(widgetSource, /return `\$\{hours\}h \$\{minutes\}m`/);
  assert.match(widgetSource, /percentOnly \? '24px minmax\(0, 1fr\) 64px' : '24px minmax\(0, 1fr\) 38px 64px'/);
  assert.match(sectionsSource, /Array\.isArray\(value\) \? value : \[\]/);
  assert.match(settingsSource, /buildSettingsPatch\(s, baseSettings, latestSettings\)/);
  assert.match(settingsSource, /compactWidgetWaitingAnimationEnabled/);
  assert.match(settingsSource, /Waiting animation/);
  assert.match(settingsSource, /moveQuotaTarget/);
  assert.match(settingsSource, /quotaTargetOrder/);
  assert.match(settingsSource, /if \(sameSettingValue\(currentValue, settingValue\(latest, key\)\)\) continue/);
  assert.match(settingsSource, /Use Ctrl\+Shift or Ctrl\+Alt/);
});

test('popup show path sends cached state without forcing refresh', () => {
  const mainSource = fs.readFileSync(path.resolve('src', 'main', 'index.ts'), 'utf8');
  const showStart = mainSource.indexOf('function showPopup');
  const showEnd = mainSource.indexOf('function sendWidgetStateUpdate', showStart);
  const showBody = mainSource.slice(showStart, showEnd);

  assert.match(showBody, /popupWindow\.show\(\)/);
  assert.match(showBody, /popupWindow\.webContents\.send\('state:updated', currentState\)/);
  assert.doesNotMatch(showBody, /forceRefresh\(/);
  assert.doesNotMatch(showBody, /heavyRefresh\(/);
  assert.doesNotMatch(showBody, /await /);
});

test('visible UI transition schedules refresh instead of running heavy refresh inline', () => {
  const stateSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const visibleStart = stateSource.indexOf('  setUiVisible(visible: boolean): void');
  const visibleEnd = stateSource.indexOf('  private clearForegroundTimers', visibleStart);
  const visibleBody = stateSource.slice(visibleStart, visibleEnd);

  assert.match(visibleBody, /this\.scheduleForegroundRefresh\(\)/);
  assert.match(visibleBody, /this\.scheduleWideWatcherPromotion\(\)/);
  assert.doesNotMatch(visibleBody, /void this\.heavyRefresh\(/);
  assert.doesNotMatch(visibleBody, /this\.heavyRefresh\(/);
});

test('restored startup state uses the normal async startup refresh budget', () => {
  const stateSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const startStart = stateSource.indexOf('  start()');
  const startEnd = stateSource.indexOf('  stop()', startStart);
  const startBody = stateSource.slice(startStart, startEnd);
  const visibleStart = stateSource.indexOf('  setUiVisible(visible: boolean): void');
  const visibleEnd = stateSource.indexOf('  private clearForegroundTimers', visibleStart);
  const visibleBody = stateSource.slice(visibleStart, visibleEnd);
  const promotionStart = stateSource.indexOf('  private scheduleWideWatcherPromotion');
  const promotionEnd = stateSource.indexOf('  private isPerfDebugEnabled', promotionStart);
  const promotionBody = stateSource.slice(promotionStart, promotionEnd);

  assert.doesNotMatch(stateSource, /RESTORED_STARTUP_REFRESH_DELAY_MS = 30_000/);
  assert.doesNotMatch(stateSource, /RESTORED_STARTUP_SCAN_BUDGET_MS = 250/);
  assert.match(startBody, /void this\.requestRefresh\(\{ mode: 'heavy', reason: 'startup', allowStartupBudget: true \}\)/);
  assert.match(visibleBody, /this\.scheduleForegroundRefresh\(\)/);
  assert.match(promotionBody, /this\.scheduleForegroundRefresh\(\)/);
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
  assert.match(source, /provider\.isExcludedSource\?\.\(source, isExcluded\)/);
  assert.match(source, /codexRateLimits = this\.mergeCodexRateLimits\(codexRateLimits, await scanCodexRateLimitsOnly\(source\.filePath\)\)/);
  assert.doesNotMatch(collectBody, /getVisibleSummaries/);
  assert.match(source, /private async refreshRecentCodexRateLimits/);
  assert.match(fastBody, /await this\.refreshRecentCodexRateLimits\(settings\)/);
});

test('bottom refresh label distinguishes scan countdown from update age', () => {
  const source = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'MainView.tsx'), 'utf8');

  assert.match(source, /\$\{elapsed\}s ago/);
  assert.match(source, /scan \$\{formatWarmupEta\(historyWarmupStartsAt\)\}/);
  assert.match(source, /last run ·/);
  assert.doesNotMatch(source, /Restoring/);
  assert.doesNotMatch(source, /Restored/);
});

test('header today cache metric uses today aggregates instead of the 5-hour window', () => {
  const source = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'MainView.tsx'), 'utf8');

  assert.match(source, /const cacheEff = isAll \? usage\.allTimeAvgCacheEfficiency : usage\.todayCacheEfficiency/);
  assert.match(source, /const saved = isAll \? usage\.allTimeSavedUSD : usage\.todayCacheSavingsUSD/);
});

test('startup refresh uses lightweight session bootstrapping and API status labels', () => {
  const mainSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const rendererSource = fs.readFileSync(path.resolve('src', 'renderer', 'views', 'MainView.tsx'), 'utf8');

  assert.match(mainSource, /buildScopedSessionInfosDetailed\(nextSummaries\)/);
  assert.match(mainSource, /buildStartupPriorityFiles/);
  assert.match(mainSource, /historyWarmupStartsAt/);
  assert.match(rendererSource, /apiStatusLabel/);
  assert.match(rendererSource, /formatWarmupStatus/);
  assert.match(rendererSource, /resetLabel=\{card\.visualKind === 'percentOnly' \? undefined : card\.quota\.resetLabel\}/);
});

test('README release blocks stay compact and screenshots are full width', () => {
  const readmes = [
    'README.md',
    'README.ko.md',
    'README.ja.md',
    'README.zh-CN.md',
    'README.es.md',
  ];
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const currentVersion = `v${packageJson.version}`;

  for (const file of readmes) {
    const source = fs.readFileSync(path.resolve(file), 'utf8');
    const releaseRows = source.match(/^\| \*\*\[v\d+\.\d+\.\d+\]/gm) ?? [];
    assert.equal(releaseRows.length, 5, `${file} should show the latest five releases only`);
    assert.match(releaseRows[0], new RegExp(`\\[${currentVersion.replaceAll('.', '\\.')}\\]`), `${file} first release row should match package version`);
    assert.doesNotMatch(source, /<th width="50%">/, `${file} should not render overview screenshots in a two-column table`);
    assert.match(source, /<th>.*?(Dark|다크|ダーク|深色|oscura).*?<\/th>[\s\S]*screenshot-overview-dark\.png/);
    assert.match(source, /<th>.*?(Light|라이트|ライト|浅色|clara).*?<\/th>[\s\S]*screenshot-overview-light\.png/);
  }
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
