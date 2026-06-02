# Hotkey Popup Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the global hotkey show the WhereMyTokens dashboard immediately without freezing while the app refreshes local Claude/Codex usage data in the background.

**Architecture:** Decouple window visibility from expensive foreground refresh work. Showing the popup should reuse the current cached state, keep watcher scope narrow at first, and schedule a budgeted refresh after the first interactive moment; explicit user refresh remains a full forced refresh.

**Tech Stack:** Electron main process, TypeScript, chokidar, electron-store, Node `node:test`, existing source-guard regression tests.

---

## File Structure

- Modify: `src/main/stateManager.ts`
  - Owns visibility state, watcher scope, refresh scheduling, budgeted history scans, and performance logging.
- Modify: `src/main/index.ts`
  - Owns Electron window show/hide events and should continue to call `setUiVisible()` only as a visibility signal.
- Modify: `scripts/state-readiness.test.mjs`
  - Add static regression guards for popup show responsiveness and visibility refresh scheduling.
- Modify: `scripts/stability-regressions.test.mjs`
  - Add static regression guards that visible watcher promotion and foreground refresh remain delayed/budgeted.
- No PRD update required unless a PRD is added later. Current repository scan found `README*.md` and `RELEASE.md`, but no PRD file.

## Design Boundaries

- Do not make `showPopup()` await refresh work.
- Do not make `setUiVisible(true)` synchronously start `heavyRefresh()`.
- Do not make the first visible watcher immediately watch all Claude/Codex JSONL trees.
- Keep `forceRefresh()` as the full refresh path for explicit user refresh.
- Keep startup behavior budgeted and compatible with the existing `historyWarmupPending` UI.
- Prefer small changes in `StateManager`; do not restructure renderer views for this fix.

### Task 1: Add Responsiveness Regression Guards

**Files:**
- Modify: `scripts/state-readiness.test.mjs`

- [ ] **Step 1: Add a source-level test that the popup show path remains state-only**

Append this test near the existing settings/widget integration guard:

```js
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
```

- [ ] **Step 2: Add a source-level test that visibility changes schedule refresh work**

Append this test after the previous one:

```js
test('visible UI transition schedules refresh instead of running heavy refresh inline', () => {
  const stateSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const visibleStart = stateSource.indexOf('  setUiVisible(visible: boolean): void');
  const visibleEnd = stateSource.indexOf('  private isPerfDebugEnabled', visibleStart);
  const visibleBody = stateSource.slice(visibleStart, visibleEnd);

  assert.match(visibleBody, /this\.scheduleForegroundRefresh\(\)/);
  assert.match(visibleBody, /this\.scheduleWideWatcherPromotion\(\)/);
  assert.doesNotMatch(visibleBody, /void this\.heavyRefresh\(/);
  assert.doesNotMatch(visibleBody, /this\.heavyRefresh\(/);
});
```

- [ ] **Step 3: Run the targeted test and verify it fails before implementation**

Run:

```powershell
npm.cmd run build:main
node --test scripts/state-readiness.test.mjs
```

Expected before implementation: `state-readiness.test.mjs` fails because `scheduleForegroundRefresh()` and `scheduleWideWatcherPromotion()` do not exist yet, and `setUiVisible()` still calls `heavyRefresh()` inline.

- [ ] **Step 4: Commit the failing test**

Run:

```powershell
git add scripts/state-readiness.test.mjs
git commit -m "test: guard popup visibility responsiveness"
```

### Task 2: Defer Foreground Refresh From Visibility Changes

**Files:**
- Modify: `src/main/stateManager.ts`

- [ ] **Step 1: Add foreground scheduling fields and constants**

In `StateManager`, near the existing timer fields:

```ts
private foregroundRefreshTimer: NodeJS.Timeout | null = null;
private wideWatcherPromotionTimer: NodeJS.Timeout | null = null;
```

Near the existing static timing constants:

```ts
private static readonly FOREGROUND_REFRESH_DELAY_MS = 750;
private static readonly FOREGROUND_SCAN_BUDGET_MS = 2_500;
private static readonly WIDE_WATCHER_PROMOTION_DELAY_MS = 5_000;
```

- [ ] **Step 2: Clear new timers on stop**

In `stop()`, after clearing `gitWarmupTimer`:

```ts
if (this.foregroundRefreshTimer) clearTimeout(this.foregroundRefreshTimer);
if (this.wideWatcherPromotionTimer) clearTimeout(this.wideWatcherPromotionTimer);
this.foregroundRefreshTimer = null;
this.wideWatcherPromotionTimer = null;
```

- [ ] **Step 3: Add helper methods for foreground scheduling**

Add these methods before `isPerfDebugEnabled()`:

```ts
private clearForegroundTimers(): void {
  if (this.foregroundRefreshTimer) clearTimeout(this.foregroundRefreshTimer);
  if (this.wideWatcherPromotionTimer) clearTimeout(this.wideWatcherPromotionTimer);
  this.foregroundRefreshTimer = null;
  this.wideWatcherPromotionTimer = null;
}

private scheduleForegroundRefresh(): void {
  if (this.foregroundRefreshTimer) clearTimeout(this.foregroundRefreshTimer);
  this.foregroundRefreshTimer = setTimeout(() => {
    this.foregroundRefreshTimer = null;
    if (!this.uiVisible) return;
    if (this.uiBusy) {
      this.scheduleForegroundRefresh();
      return;
    }
    void this.heavyRefresh(false, false, StateManager.FOREGROUND_SCAN_BUDGET_MS);
  }, StateManager.FOREGROUND_REFRESH_DELAY_MS);
}

private scheduleWideWatcherPromotion(): void {
  if (this.wideWatcherPromotionTimer) clearTimeout(this.wideWatcherPromotionTimer);
  this.wideWatcherPromotionTimer = setTimeout(() => {
    this.wideWatcherPromotionTimer = null;
    if (!this.uiVisible) return;
    this.startWatcher('popup:show:wide', 'wide');
  }, StateManager.WIDE_WATCHER_PROMOTION_DELAY_MS);
}
```

- [ ] **Step 4: Replace inline refresh in `setUiVisible()`**

Change `setUiVisible()` to this shape:

```ts
setUiVisible(visible: boolean): void {
  if (this.uiVisible === visible) return;
  this.uiVisible = visible;
  this.startTimers();
  if (visible) {
    this.startWatcher('popup:show:recent', 'recent');
    if (this.state.initialRefreshComplete) {
      this.scheduleForegroundRefresh();
      this.scheduleWideWatcherPromotion();
    }
    return;
  }
  this.clearForegroundTimers();
  this.startWatcher('popup:hide', 'recent');
}
```

- [ ] **Step 5: Run the targeted test**

Run:

```powershell
npm.cmd run build:main
node --test scripts/state-readiness.test.mjs
```

Expected: The new visibility scheduling test now passes. TypeScript may still fail until Task 3 adds the new `startWatcher()` mode parameter.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/main/stateManager.ts
git commit -m "fix: defer foreground refresh after popup show"
```

### Task 3: Keep Watcher Scope Narrow During Initial Popup Show

**Files:**
- Modify: `src/main/stateManager.ts`
- Modify: `scripts/stability-regressions.test.mjs`

- [ ] **Step 1: Add a watcher-mode type**

Near `type WatcherProfile = 'wide' | 'recent' | 'off';` add:

```ts
type WatcherMode = 'auto' | 'wide' | 'recent';
```

- [ ] **Step 2: Update `startWatcher()` signature and scope decision**

Change:

```ts
private startWatcher(reason = 'refresh') {
```

to:

```ts
private startWatcher(reason = 'refresh', mode: WatcherMode = 'auto') {
```

Replace the `if (this.uiVisible) { ... } else { ... }` watcher target branch with:

```ts
const useWideWatcher = mode === 'wide' || (mode === 'auto' && this.uiVisible);

if (useWideWatcher) {
  if ((provider === 'claude' || provider === 'both') && fs.existsSync(SESSIONS_DIR)) {
    watchTargets.push(SESSIONS_DIR);
  }
  if ((provider === 'claude' || provider === 'both') && fs.existsSync(PROJECTS_DIR)) {
    watchTargets.push(PROJECTS_DIR.replace(/\\/g, '/') + '/**/*.jsonl');
  }
  if ((provider === 'codex' || provider === 'both') && fs.existsSync(CODEX_SESSIONS_DIR)) {
    watchTargets.push(CODEX_SESSIONS_DIR.replace(/\\/g, '/') + '/**/*.jsonl');
  }
  this.watcherProfile = 'wide';
} else {
  watchTargets.push(...this.buildRecentWatchTargets(provider));
  this.watcherProfile = watchTargets.length > 0 ? 'recent' : 'off';
}
```

- [ ] **Step 3: Add a regression guard for watcher promotion**

Append to `scripts/stability-regressions.test.mjs`:

```js
test('popup show starts with recent watcher and promotes wide watcher later', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const visibleStart = source.indexOf('  setUiVisible(visible: boolean): void');
  const visibleEnd = source.indexOf('  private isPerfDebugEnabled', visibleStart);
  const visibleBody = source.slice(visibleStart, visibleEnd);
  const watcherStart = source.indexOf('  private startWatcher');
  const watcherEnd = source.indexOf('  private async fastRefresh', watcherStart);
  const watcherBody = source.slice(watcherStart, watcherEnd);

  assert.match(visibleBody, /this\.startWatcher\('popup:show:recent', 'recent'\)/);
  assert.match(visibleBody, /this\.scheduleWideWatcherPromotion\(\)/);
  assert.match(watcherBody, /mode: WatcherMode = 'auto'/);
  assert.match(watcherBody, /const useWideWatcher = mode === 'wide' \|\| \(mode === 'auto' && this\.uiVisible\)/);
  assert.match(source, /this\.startWatcher\('popup:show:wide', 'wide'\)/);
});
```

- [ ] **Step 4: Run targeted tests**

Run:

```powershell
npm.cmd run build:main
node --test scripts/state-readiness.test.mjs scripts/stability-regressions.test.mjs
```

Expected: Both scripts pass.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/main/stateManager.ts scripts/stability-regressions.test.mjs
git commit -m "fix: delay wide watcher promotion after popup show"
```

### Task 4: Budget Foreground Heavy Refresh

**Files:**
- Modify: `src/main/stateManager.ts`
- Modify: `scripts/stability-regressions.test.mjs`

- [ ] **Step 1: Extend `heavyRefresh()` with an explicit scan budget**

Change:

```ts
private async heavyRefresh(force = false, allowStartupBudget = false) {
```

to:

```ts
private async heavyRefresh(force = false, allowStartupBudget = false, scanBudgetMs: number | null = null) {
```

Inside the method, after `const initialRefreshDone = this.state.initialRefreshComplete;`, add:

```ts
const effectiveScanBudgetMs = scanBudgetMs ?? (allowStartupBudget && !initialRefreshDone ? StateManager.STARTUP_SCAN_BUDGET_MS : null);
```

Replace:

```ts
const loaded = await this.loadProviderSummaries(
  force,
  allowStartupBudget && !initialRefreshDone ? StateManager.STARTUP_SCAN_BUDGET_MS : null,
);
```

with:

```ts
const loaded = await this.loadProviderSummaries(force, effectiveScanBudgetMs);
```

- [ ] **Step 2: Make partial scan UI work for foreground budgeted scans**

Replace:

```ts
const startupPartial = allowStartupBudget && !initialRefreshDone && loaded.partial;
const historyWarmupStartsAt = startupPartial
  ? this.scheduleHistoryWarmup()
  : null;
if (!startupPartial) this.clearHistoryWarmup();
```

with:

```ts
const partialHistoryScan = effectiveScanBudgetMs !== null && loaded.partial;
const historyWarmupStartsAt = partialHistoryScan
  ? this.scheduleHistoryWarmup()
  : null;
if (!partialHistoryScan) this.clearHistoryWarmup();
```

Replace both state assignments:

```ts
historyWarmupPending: startupPartial,
historyWarmupStartsAt,
```

with:

```ts
historyWarmupPending: partialHistoryScan,
historyWarmupStartsAt,
```

Replace alert deferral:

```ts
deferCodexLocalLog: startupPartial,
```

with:

```ts
deferCodexLocalLog: partialHistoryScan,
```

Replace the perf extras:

```ts
partial: loaded.partial,
```

with:

```ts
partial: loaded.partial,
scanBudgetMs: effectiveScanBudgetMs,
```

- [ ] **Step 3: Keep explicit user refresh full**

Leave `forceRefresh()` as:

```ts
async forceRefresh(): Promise<void> {
  this.clearHistoryWarmup();
  this.clearGitWarmup();
  await this.heavyRefresh(true);
}
```

This is intentional: the bottom refresh button and context menu refresh should still do a full forced refresh.

- [ ] **Step 4: Add a regression guard for budgeted foreground refresh**

Append to `scripts/stability-regressions.test.mjs`:

```js
test('foreground refresh uses a scan budget while force refresh remains full', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');
  const scheduleStart = source.indexOf('  private scheduleForegroundRefresh');
  const scheduleEnd = source.indexOf('  private scheduleWideWatcherPromotion', scheduleStart);
  const scheduleBody = source.slice(scheduleStart, scheduleEnd);
  const forceStart = source.indexOf('  async forceRefresh');
  const forceEnd = source.indexOf('  private startTimers', forceStart);
  const forceBody = source.slice(forceStart, forceEnd);
  const heavyStart = source.indexOf('  private async heavyRefresh');
  const heavyEnd = source.indexOf('  private buildStartupPriorityFiles', heavyStart);
  const heavyBody = source.slice(heavyStart, heavyEnd);

  assert.match(scheduleBody, /this\.heavyRefresh\(false, false, StateManager\.FOREGROUND_SCAN_BUDGET_MS\)/);
  assert.match(heavyBody, /scanBudgetMs: number \| null = null/);
  assert.match(heavyBody, /const effectiveScanBudgetMs = scanBudgetMs \?\? /);
  assert.match(heavyBody, /historyWarmupPending: partialHistoryScan/);
  assert.match(forceBody, /await this\.heavyRefresh\(true\)/);
  assert.doesNotMatch(forceBody, /FOREGROUND_SCAN_BUDGET_MS/);
});
```

- [ ] **Step 5: Run targeted tests**

Run:

```powershell
npm.cmd run build:main
node --test scripts/state-readiness.test.mjs scripts/stability-regressions.test.mjs
```

Expected: Both scripts pass.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/main/stateManager.ts scripts/stability-regressions.test.mjs
git commit -m "fix: budget foreground history refresh"
```

### Task 5: Preserve Popup Responsiveness in the Electron Main Path

**Files:**
- Modify: `src/main/index.ts`
- Modify: `scripts/state-readiness.test.mjs`

- [ ] **Step 1: Keep `showPopup()` simple and cached-state first**

If needed after runtime testing, adjust `showPopup()` so cached state is prepared before window display and sent immediately after display:

```ts
function showPopup(view: AppView = 'main') {
  if (!popupWindow || popupWindow.isDestroyed()) popupWindow = createPopupWindow();
  if (!tray) return;
  const currentState = stateManager?.getState();
  syncCompactWidget();

  popupWindow.setBounds(resolvePopupBounds(tray.getBounds()));
  popupWindow.show();
  popupWindow.focus();
  keepWindowOutOfTaskbar(popupWindow);
  sendPopupNavigation(view);
  if (currentState) {
    pendingStateUpdate = null;
    if (stateUpdateTimer) clearTimeout(stateUpdateTimer);
    stateUpdateTimer = null;
    popupWindow.webContents.send('state:updated', currentState);
  }
}
```

This preserves the existing behavior but makes the intended order obvious: snapshot current state, show window, send snapshot, let scheduled refresh update later.

- [ ] **Step 2: Run targeted test**

Run:

```powershell
npm.cmd run build:main
node --test scripts/state-readiness.test.mjs
```

Expected: Pass.

- [ ] **Step 3: Commit only if `src/main/index.ts` changed**

Run:

```powershell
git add src/main/index.ts scripts/state-readiness.test.mjs
git commit -m "fix: keep popup show path refresh-free"
```

### Task 6: Full Verification and Manual Performance Check

**Files:**
- No source changes unless verification exposes a defect.

- [ ] **Step 1: Run the full automated suite**

Run:

```powershell
npm.cmd test
```

Expected: all listed `node --test` scripts pass.

- [ ] **Step 2: Build the app**

Run:

```powershell
npm.cmd run build
```

Expected: TypeScript and renderer builds complete without errors.

- [ ] **Step 3: Run a debug performance session outside the sandbox**

Use an external desktop PowerShell because Electron GUI and global hotkey testing need the real desktop session:

```powershell
$env:WMT_DEBUG_PERF='1'
$env:WMT_DEBUG_INSTRUMENTATION='1'
npm.cmd start
```

Manual steps:

1. Wait for the tray app to finish initial startup.
2. Hide the dashboard.
3. Press the configured global hotkey.
4. Confirm the window appears immediately and can be clicked/scrolled within about one second.
5. Watch console output for:

```text
[WhereMyTokens][watcher] reason: 'popup:show:recent'
[WhereMyTokens][perf] label: 'heavyRefresh'
scanBudgetMs: 2500
[WhereMyTokens][watcher] reason: 'popup:show:wide'
```

Expected: `popup:show:recent` appears before `popup:show:wide`, and the first hotkey display is usable before `heavyRefresh` finishes.

- [ ] **Step 4: Check debug memory snapshot if needed**

If the UI still stalls, use the existing IPC/debug path or inspect:

```powershell
Get-Content -LiteralPath "$env:LOCALAPPDATA\WhereMyTokens\debug-mem.jsonl" -Encoding UTF8 -Tail 20
```

Expected: watcher starts as `recent`, then promotes to `wide`; JSONL cache and watcher counts should not jump before the popup is interactive.

- [ ] **Step 5: Commit verification-only docs if any were added**

Only commit documentation or test updates that were actually changed:

```powershell
git status --short
```

Expected: no uncommitted files except intentional changes.

## Rollback Plan

If the optimization causes stale data or missed file updates:

1. Keep the delayed foreground refresh but lower `FOREGROUND_REFRESH_DELAY_MS` to `250`.
2. Keep budgeted foreground refresh but raise `FOREGROUND_SCAN_BUDGET_MS` to `5_000`.
3. Keep recent watcher on immediate show but lower `WIDE_WATCHER_PROMOTION_DELAY_MS` to `1_500`.
4. Do not revert to inline `heavyRefresh()` inside `setUiVisible()` unless there is a proven correctness issue that cannot be solved with the three knobs above.

## Acceptance Criteria

- Pressing the configured global hotkey shows the dashboard immediately from hidden state.
- The first visible frame uses cached state and does not wait for local JSONL scanning.
- `setUiVisible(true)` does not directly call `heavyRefresh()`.
- The watcher starts in recent scope and promotes to wide scope later.
- Foreground automatic refresh is budgeted and can show `historyWarmupPending`.
- Manual `forceRefresh()` remains a full refresh.
- `npm.cmd test` passes.
- A debug run with `WMT_DEBUG_PERF=1` shows delayed/budgeted foreground refresh behavior.

## Self-Review

- Spec coverage: Covers the observed hotkey freeze root cause: visibility transition, watcher widening, foreground heavy refresh, and manual refresh boundary.
- Placeholder scan: No placeholder markers remain; every task has file paths, code snippets, commands, and expected outcomes.
- Type consistency: New names are consistent across tasks: `foregroundRefreshTimer`, `wideWatcherPromotionTimer`, `scheduleForegroundRefresh()`, `scheduleWideWatcherPromotion()`, `WatcherMode`, and `scanBudgetMs`.
