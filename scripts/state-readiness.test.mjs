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
  const alertSource = fs.readFileSync(path.resolve('src', 'main', 'usageAlertManager.ts'), 'utf8');
  const stateSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');

  assert.match(mainSource, /historyWarmupPending=\{state\.historyWarmupPending\}/);
  assert.match(mainSource, /pendingLimit=\{codexWeekPending\}/);
  assert.match(mainSource, /limits\.codexWeek\.source === 'localLog' \|\| !codexWeekHasLimit/);
  assert.match(cardSource, /pendingLimitLabel/);
  assert.match(cardSource, /displayLimitSourceLabel = pendingLimit/);
  assert.match(alertSource, /deferCodexLocalLog/);
  assert.match(alertSource, /key\.startsWith\('codex-'\) && source === 'localLog'/);
  assert.match(stateSource, /deferCodexLocalLog: startupPartial/);
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
