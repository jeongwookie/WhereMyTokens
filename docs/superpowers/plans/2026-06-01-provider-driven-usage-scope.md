# Provider-Driven Usage Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Settings `Providers` selection the only control for token/cost/statistics scope, while `Quota display` controls Plan Usage and floating widget presentation only.

**Architecture:** Keep `enabledProviders` as the canonical provider data-source switch for scanning, quota fetching, sessions, alerts, and statistics. Simplify `UsageVisibilityFilter` so it is derived only from `settings.enabledProviders`; remove all quota-target display mode influence from usage/trend/model/session statistics. Rename the Settings section from `Tracking` to `Providers` and update tests/docs so the UI semantics match the runtime semantics.

**Tech Stack:** TypeScript, Electron main process, React renderer, Node `node:test`, existing provider quota selectors.

---

## Scope Check

This is one coherent change: it adjusts one settings concept and one statistics-scope mechanism. It does not change quota rendering layout, provider adapter behavior, ledger storage, or provider quota fetching.

## File Structure

- Modify `src/main/usageVisibilityFilter.ts`
  - Owns provider visibility for usage statistics.
  - After this change it must not import `ProviderQuotaSnapshot` or `QuotaDisplayMode`.
  - `buildUsageVisibilityFilter(settings)` returns `providerScopes` from `settings.enabledProviders`.

- Modify `src/main/stateManager.ts`
  - Calls `buildUsageVisibilityFilter(settings)` instead of passing `providerQuotas`.
  - Keeps `providerQuotas` only for reset hints and quota UI state.

- Modify `src/renderer/views/SettingsView.tsx`
  - Rename the settings section label from `Tracking` to `Providers`.
  - Keep provider checkboxes backed by `enabledProviders`.
  - Keep `Quota display` below it as display-only target settings.

- Modify tests:
  - `scripts/usage-visibility-filter.test.mjs`
  - `scripts/provider-usage-shape.test.mjs`
  - `scripts/usage-ledger-state.test.mjs`
  - `scripts/stability-regressions.test.mjs`
  - `scripts/provider-settings.test.mjs`

- Modify docs:
  - `README.md`
  - `README.zh-CN.md`
  - `docs/superpowers/plans/2026-06-01-quota-target-usage-filtering.md`
  - `docs/superpowers/plans/2026-05-31-provider-quotas-plan-usage.md`
  - `docs/superpowers/plans/2026-05-31-quota-target-groups-layout.md`

## Core Semantics

- `enabledProviders` controls which providers are scanned, shown in session lists, queried for quota, included in statistics, and checked for quota alerts.
- `quotaTargetModes` controls only quota target presentation:
  - `rich`: show full Plan Usage target.
  - `simple`: show compact Plan Usage/widget target.
  - `none`: hide that quota target from Plan Usage/widget.
- `quotaTargetModes` must not affect:
  - Header token/cost/API/session/cache metrics.
  - Activity heatmaps, weekly timeline, time-of-day buckets.
  - Model Usage.
  - Trend.
  - all-time session count.
  - quota alerts.
- If Claude is enabled and every Claude quota target is `None`, Claude usage still counts.
- If Claude is disabled in Providers, Claude usage does not count even if its quota target modes are `rich` or `simple`.

---

### Task 1: Red Tests For Provider-Only Usage Visibility

**Files:**
- Modify: `scripts/usage-visibility-filter.test.mjs`
- Modify: `scripts/provider-usage-shape.test.mjs`
- Modify: `scripts/usage-ledger-state.test.mjs`
- Modify: `scripts/stability-regressions.test.mjs`

- [x] **Step 1: Replace quota-target visibility tests with provider-only tests**

In `scripts/usage-visibility-filter.test.mjs`, replace the current tests with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

async function loadFilterModule() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-usage-filter-'));
  const outfile = path.join(outdir, 'usageVisibilityFilter.mjs');
  await esbuild.build({
    entryPoints: [path.resolve('src', 'main', 'usageVisibilityFilter.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

function settings(enabledProviders = ['claude', 'codex'], quotaTargetModes = {}) {
  return { enabledProviders, quotaTargetModes };
}

test('usage visibility filter follows enabled providers only', async () => {
  const { buildUsageVisibilityFilter, usageProviderVisible } = await loadFilterModule();
  const filter = buildUsageVisibilityFilter(settings(['claude'], {
    'claude.group.account': 'none',
    'claude.group.sonnet': 'none',
    'codex.group.account': 'rich',
  }));

  assert.equal(usageProviderVisible(filter, 'claude'), true);
  assert.equal(usageProviderVisible(filter, 'codex'), false);
  assert.equal('modelScopes' in filter, false);
});

test('usage visibility filter does not accept provider quota metadata', async () => {
  const { buildUsageVisibilityFilter } = await loadFilterModule();

  assert.equal(buildUsageVisibilityFilter.length, 1);
});

test('empty usage visibility filter hides every provider', async () => {
  const { emptyUsageVisibilityFilter, usageProviderVisible } = await loadFilterModule();
  const filter = emptyUsageVisibilityFilter();

  assert.equal(usageProviderVisible(filter, 'claude'), false);
  assert.equal(usageProviderVisible(filter, 'codex'), false);
});
```

- [x] **Step 2: Update summary usage test so hidden quota targets do not affect stats**

In `scripts/provider-usage-shape.test.mjs`, keep the coverage centered on provider enablement:

```js
test('summary usage visibility follows enabled providers instead of quota display modes', () => {
```

Within that test, change the filter construction to:

```js
  const usage = computeUsage([claude, codex], {}, {
    providerScopes: new Set(['claude', 'codex']),
  });
```

Change the assertions to:

```js
  assert.equal(usage.todayTokens, 700);
  assert.equal(usage.todayCost, 7);
  assert.equal(usage.allTimeCost, 14);
  assert.deepEqual(usage.models.map(row => row.model), ['gpt-5-codex', 'claude-3-opus', 'claude-3-5-sonnet']);
  assert.equal(usage.byProvider.claude.windows.h5.totalTokens, 300);
  assert.equal(usage.byProvider.codex.windows.h5.totalTokens, 400);
  assert.equal(usage.heatmap30.reduce((sum, bucket) => sum + bucket.tokens, 0), 1400);
  assert.equal(usage.todBuckets.reduce((sum, bucket) => sum + bucket.tokens, 0), 1400);
  assert.equal(usage.weeklyTimeline.reduce((sum, week) => sum + week.tokens, 0), 1400);
```

Add this second assertion block in the same test after the above assertions:

```js
  const claudeOnlyUsage = computeUsage([claude, codex], {}, {
    providerScopes: new Set(['claude']),
  });

  assert.equal(claudeOnlyUsage.todayTokens, 300);
  assert.equal(claudeOnlyUsage.byProvider.claude.windows.h5.totalTokens, 300);
  assert.equal(claudeOnlyUsage.byProvider.codex.windows.h5.totalTokens, 0);
```

- [x] **Step 3: Update ledger checkpoint count test**

In `scripts/usage-ledger-state.test.mjs`, rename `usage ledger and summary queries receive the quota target usage visibility filter` to:

```js
test('usage ledger and summary queries receive the enabled-provider usage visibility filter', () => {
```

Inside that test, replace:

```js
  assert.match(derivedMatch[1], /buildUsageVisibilityFilter\(settings, providerQuotas\)/);
```

with:

```js
  assert.match(derivedMatch[1], /buildUsageVisibilityFilter\(settings\)/);
  assert.doesNotMatch(derivedMatch[1], /buildUsageVisibilityFilter\(settings, providerQuotas\)/);
```

Replace:

```js
  assert.match(trendMatch[1], /buildUsageVisibilityFilter\(settings, providerQuotas\)/);
```

with:

```js
  assert.match(trendMatch[1], /buildUsageVisibilityFilter\(settings\)/);
```

Replace:

```js
  assert.match(countMatch[1], /buildUsageVisibilityFilter\(settings, this\.buildProviderQuotas\(\)\)/);
```

with:

```js
  assert.match(countMatch[1], /buildUsageVisibilityFilter\(settings\)/);
```

Rename `all-time session count follows visible quota usage targets for ledger checkpoints` to:

```js
test('all-time session count follows enabled providers for ledger checkpoints', () => {
```

In that test's `makeStore(...)`, replace the settings with:

```js
  const manager = new StateManager(makeStore({
    enabledProviders: ['claude'],
    quotaTargetModes: {
      'claude.group.account': 'none',
      'claude.group.sonnet': 'none',
      'codex.group.account': 'rich',
    },
  }), () => {});
```

Keep the expected count:

```js
  assert.equal(manager.countAllTimeUsageSessions(manager.getState().settings), 3);
```

- [x] **Step 4: Update summary fallback session count test**

In `scripts/stability-regressions.test.mjs`, rename `all-time session count follows visible quota usage targets for summary fallback` to:

```js
test('all-time session count follows enabled providers for summary fallback', () => {
```

Change the `settings` object to:

```js
  const settings = {
    ...manager.getState().settings,
    enabledProviders: ['claude'],
    quotaTargetModes: {
      'claude.group.account': 'none',
      'claude.group.sonnet': 'none',
      'codex.group.account': 'rich',
    },
  };
```

Keep:

```js
  assert.equal(manager.countAllTimeUsageSessions(settings), 3);
```

- [x] **Step 5: Run focused tests and verify red**

Run:

```powershell
npm.cmd run build:main
node --test scripts/usage-visibility-filter.test.mjs scripts/provider-usage-shape.test.mjs scripts/usage-ledger-state.test.mjs scripts/stability-regressions.test.mjs
```

Expected:
- `build:main` passes.
- At least `usage-visibility-filter.test.mjs` fails because `buildUsageVisibilityFilter.length` is still `2`.
- StateManager source guard fails because it still calls `buildUsageVisibilityFilter(settings, providerQuotas)`.

### Task 2: Implement Provider-Only Usage Visibility

**Files:**
- Modify: `src/main/usageVisibilityFilter.ts`
- Modify: `src/main/stateManager.ts`

- [x] **Step 1: Simplify usage visibility filter implementation**

Replace the complete contents of `src/main/usageVisibilityFilter.ts` with:

```ts
import type { AppSettings } from './ipc';
import type { ProviderId } from './providers/types';

export interface UsageVisibilityFilter {
  providerScopes: ReadonlySet<ProviderId>;
}

export function buildUsageVisibilityFilter(
  settings: Pick<AppSettings, 'enabledProviders'>,
): UsageVisibilityFilter {
  return { providerScopes: new Set(settings.enabledProviders) };
}

export function usageProviderVisible(filter: UsageVisibilityFilter | undefined, provider: ProviderId): boolean {
  return !filter || filter.providerScopes.has(provider);
}

export function emptyUsageVisibilityFilter(): UsageVisibilityFilter {
  return { providerScopes: new Set() };
}
```

- [x] **Step 2: Update StateManager call sites**

In `src/main/stateManager.ts`, update `computeDerivedUsage()`:

Replace:

```ts
    const usageVisibilityFilter = buildUsageVisibilityFilter(settings, providerQuotas);
```

with:

```ts
    const usageVisibilityFilter = buildUsageVisibilityFilter(settings);
```

In `buildUsageTrend()`, replace:

```ts
    const usageVisibilityFilter = buildUsageVisibilityFilter(settings, providerQuotas);
```

with:

```ts
    const usageVisibilityFilter = buildUsageVisibilityFilter(settings);
```

Then remove the now-unused local variable in `buildUsageTrend()`:

```ts
    const providerQuotas = this.buildProviderQuotas(now);
```

In `countAllTimeUsageSessions()`, replace:

```ts
    const usageVisibilityFilter = buildUsageVisibilityFilter(settings, this.buildProviderQuotas());
```

with:

```ts
    const usageVisibilityFilter = buildUsageVisibilityFilter(settings);
```

- [x] **Step 3: Run focused tests and verify green**

Run:

```powershell
npm.cmd run build:main
node --test scripts/usage-visibility-filter.test.mjs scripts/provider-usage-shape.test.mjs scripts/usage-ledger-state.test.mjs scripts/stability-regressions.test.mjs
```

Expected:
- `build:main` passes.
- All focused tests pass.

### Task 3: Rename Settings Section From Tracking To Providers

**Files:**
- Modify: `src/renderer/views/SettingsView.tsx`
- Modify: `scripts/provider-settings.test.mjs`

- [x] **Step 1: Add failing UI/source tests**

In `scripts/provider-settings.test.mjs`, find `renderer tracking settings use provider checkboxes backed by enabledProviders` and rename it to:

```js
test('renderer provider settings use provider checkboxes backed by enabledProviders', () => {
```

Inside that test, replace:

```js
  assert.match(settingsView, /<SectionHeader label="Tracking" \/>/);
```

with:

```js
  assert.match(settingsView, /<SectionHeader label="Providers" \/>/);
  assert.doesNotMatch(settingsView, /<SectionHeader label="Tracking" \/>/);
```

Also replace any assertion name/copy that says `tracking settings` with `provider settings`.

- [x] **Step 2: Run provider settings test and verify red**

Run:

```powershell
npm.cmd run build:main
node --test scripts/provider-settings.test.mjs
```

Expected:
- `build:main` passes.
- The provider settings test fails because `SettingsView.tsx` still contains `<SectionHeader label="Tracking" />`.

- [x] **Step 3: Rename the Settings section**

In `src/renderer/views/SettingsView.tsx`, replace:

```tsx
        <SectionHeader label="Tracking" />
```

with:

```tsx
        <SectionHeader label="Providers" />
```

Do not rename `enabledProviders`, `toggleProvider`, or provider adapter APIs. Those names are already accurate.

- [x] **Step 4: Run provider settings test and verify green**

Run:

```powershell
npm.cmd run build:main
node --test scripts/provider-settings.test.mjs
```

Expected:
- All tests in `scripts/provider-settings.test.mjs` pass.

### Task 4: Update Documentation And Plan Text

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/superpowers/plans/2026-06-01-quota-target-usage-filtering.md`
- Modify: `docs/superpowers/plans/2026-05-31-provider-quotas-plan-usage.md`
- Modify: `docs/superpowers/plans/2026-05-31-quota-target-groups-layout.md`

- [x] **Step 1: Update English README semantics**

In `README.md`, update the `Per-target quota display` bullet to:

```md
- **Per-target quota display** — each provider window or model target can be shown as Rich, Simple, or hidden in Settings; this affects Plan Usage and the floating widget only
```

Update the provider quota paragraph to:

```md
Rate-limit precedence is provider-specific and is assembled into `AppState.providerQuotas`: Claude uses the Anthropic API first, then the `statusLine` bridge and cache; Codex uses live usage first, then cache and local `rate_limits` events from JSONL logs. API/Bridge/Cache/Log chips are renderer labels derived from the snapshot `source`, not separate state fields. Settings store provider enablement separately from quota display preferences. The `Providers` setting controls scanning, quota fetching, sessions, statistics, and alerts. `Quota display` stores only `Rich`, `Simple`, or `None` per target and affects Plan Usage and the floating widget only.
```

- [x] **Step 2: Update Chinese README semantics**

In `README.zh-CN.md`, update the equivalent quota display bullet to:

```md
- **按 target 配置 quota 展示** — 每个 provider window 或 model target 都可以在 Settings 中设为 Rich、Simple 或隐藏；这里只影响 Plan Usage 和悬浮小部件展示
```

Update the provider quota paragraph to:

```md
速率限制优先级按 provider 区分，并统一组装进 `AppState.providerQuotas`：Claude 优先使用 Anthropic API，然后是 `statusLine` bridge 与 cache；Codex 优先使用 live usage，然后是 cache 与 JSONL 日志中的本地 `rate_limits` 事件。API/Bridge/Cache/Log 标签由 renderer 根据 snapshot 的 `source` 派生，不再作为主界面的独立状态字段维护。Settings 将 provider 启用状态与 target 展示模式分开保存。`Providers` 控制扫描、quota 拉取、会话显示、统计和提醒范围；`Quota display` 只保存每个 target 的 `Rich`、`Simple` 或 `None`，只影响 Plan Usage 和悬浮小部件展示。
```

- [x] **Step 3: Update plan docs so they do not contradict current behavior**

In `docs/superpowers/plans/2026-06-01-quota-target-usage-filtering.md`, replace the `Goal` section bullets with:

```md
- `enabledProviders` controls provider scope for usage statistics and alerts.
- `quotaTargetModes` controls Plan Usage and floating widget presentation only.
- If a provider is enabled, its usage counts even when all of its quota targets are set to `None`.
- If a provider is disabled, its usage does not count even when one of its persisted quota target modes is `Rich` or `Simple`.
```

In `docs/superpowers/plans/2026-05-31-provider-quotas-plan-usage.md`, replace any sentence claiming a hidden quota row changes token/cost totals with:

```md
Quota target `None` hides only the quota target presentation. Provider statistics and alerts follow `enabledProviders`.
```

In `docs/superpowers/plans/2026-05-31-quota-target-groups-layout.md`, replace the core rule that says quota target visibility controls token/cost visibility with:

```md
- Provider enablement controls token/cost usage visibility. Quota target visibility controls quota UI display only.
```

- [x] **Step 4: Run documentation contradiction scan**

Run:

```powershell
rg --encoding utf-8 --glob '!docs/superpowers/plans/2026-06-01-provider-driven-usage-scope.md' -n "target.*controls.*statistics|target.*excludes.*statistics|all targets.*None|任意 target 可见|全部 target.*None|quota display.*控制.*统计|display setting.*controls.*statistics" README.md README.zh-CN.md docs/superpowers/plans
```

Expected:
- No line states that quota display preferences control token/cost statistics.
- Lines that mention target `None` must say it controls display only.

### Task 5: Final Verification

**Files:**
- No new source edits expected unless verification fails.

- [x] **Step 1: Run full test suite**

Run:

```powershell
npm.cmd test
```

Expected:
- `build:main` passes.
- All Node tests pass.

- [x] **Step 2: Run full app build**

Run:

```powershell
npm.cmd run build
```

Expected:
- icon generation passes.
- `build:main` passes.
- `build:renderer` passes.

- [x] **Step 3: Run diff whitespace check**

Run:

```powershell
git diff --check
```

Expected:
- Exit code 0.
- LF/CRLF warnings are acceptable on this repo; whitespace errors are not.

- [x] **Step 4: Inspect final diff scope**

Run:

```powershell
git diff --stat
git status --short
```

Expected:
- Diffs are limited to settings naming, provider-only usage filtering, tests, and docs.
- No generated release artifact is newly modified by this plan.

## Self-Review

**Spec coverage:** Covered provider settings semantics, quota display display-only semantics, usage filter implementation, Settings UI rename, tests, docs, and verification.

**Placeholder scan:** No placeholder markers or unspecified "add tests" steps. Each test and implementation step includes concrete code or exact replacements.

**Type consistency:** `buildUsageVisibilityFilter(settings)` is used consistently after Task 2. `UsageVisibilityFilter` remains `{ providerScopes }`. Settings UI keeps `enabledProviders` and only changes the section label to `Providers`.
