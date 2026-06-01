# Provider Quota Target Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Keep the checkbox state current while executing.

**Goal:** `providerQuotas` becomes the only Plan Usage quota surface. Generic renderer, settings, widget, and sizing code must not hardcode concrete provider ids or model names. Each provider/model supplies metadata and quota rows; the shared UI renders those parameters.

**Architecture:** Provider adapters assemble `ProviderQuotaSnapshot` objects that include quota windows, optional model quotas, and display metadata. Generic selectors convert snapshots into Rich/Simple/Widget view models without provider-specific branches. Rich can reproduce the current full card behavior; Simple is the shared compact row layout used by both Plan Usage and the floating widget.

**Non-goals:** No legacy `usageLimits`, no per-window settings compatibility, no old-shape parser, no double-read path. When a shape changes, production code, tests, docs, and settings validation move together.

---

## Core Rules

- Generic code must not branch on concrete provider ids or model names.
- Provider-specific knowledge is allowed only while constructing provider snapshots in provider adapter modules or their small metadata builders.
- Settings persist quota target group ids and optional target order, not window ids.
- A target group may contain one or more rows. Rich and Simple are display modes for the same target group.
- Provider enablement controls token/cost usage visibility. Quota target visibility controls quota UI display only.
- Model target visibility never narrows provider token/cost statistics.
- Activity historical hourly heatmaps follow the same provider-wide visibility rule.
- Row behavior such as pace comparison, percent-only display, cache title, cost visibility, and label text comes from metadata.
- `TokenStatsCard` receives generic props. It must not own provider-specific cache wording.
- The floating widget always renders visible target groups using the Simple layout.

---

## Data Model

Add shared quota display metadata to `src/main/providers/types.ts` and mirror it in `src/renderer/types.ts`.

```ts
export type QuotaDisplayMode = 'rich' | 'simple' | 'none';
export type ProviderQuotaRowVisualKind = 'pace' | 'percentOnly';

export interface ProviderQuotaDisplayBadge {
  key: string;
  label: string;
  title?: string;
  tone?: 'good' | 'neutral' | 'warning';
}

export interface ProviderQuotaWindowDisplay {
  label: string;
  visualKind?: ProviderQuotaRowVisualKind;
  cacheMetricTitle?: string;
  durationMs?: number;
  hideCost?: boolean;
  badges?: ProviderQuotaDisplayBadge[];
}

export interface ProviderQuotaGroupSpec {
  key: string;
  label: string;
  windowKeys: string[];
  defaultMode: QuotaDisplayMode;
  accentColor?: string;
  badges?: ProviderQuotaDisplayBadge[];
  sortOrder?: number;
}

export interface ProviderModelQuota {
  model: string;
  label: string;
  remainingPct: number;
  resetMs?: number | null;
  groupKey?: string;
  defaultMode?: QuotaDisplayMode;
  visualKind?: ProviderQuotaRowVisualKind;
  cacheMetricTitle?: string;
  durationMs?: number;
  hideCost?: boolean;
  accentColor?: string;
  badges?: ProviderQuotaDisplayBadge[];
}

export interface ProviderQuotaSnapshot {
  provider: ProviderId;
  windows?: Record<string, ProviderQuotaWindow>;
  models?: ProviderModelQuota[];
  groups?: ProviderQuotaGroupSpec[];
  windowDisplay?: Record<string, ProviderQuotaWindowDisplay>;
}
```

Implementation notes:

- `groups` is the configurable unit.
- `windowKeys` defines Rich side-by-side card order and Simple vertical row order.
- Models that are not represented by `groups` become synthetic groups using `ProviderModelQuota.groupKey`.
- If a model only provides a percent, the provider passes `visualKind: 'percentOnly'`.
- If a provider/model has only one quota row, the Simple layout renders exactly one row.
- `accentColor` is optional. If absent, generic UI derives a stable color from the group id without provider-name branching.

---

## API Cache Label Decision

The API Cache label should be handled through `providerQuotas` display metadata, not as a separate main-view special case.

Reason:

- The numeric usage stats still come from usage aggregation.
- The meaning/title of that cache metric is provider/model-specific display metadata.
- Rich card and Simple badges can both consume the same metadata.
- Keeping it in `providerQuotas` avoids reintroducing provider-name branches in `MainView` or `TokenStatsCard`.

Concrete rule:

- `cacheMetricTitle` lives on `ProviderQuotaWindowDisplay` or `ProviderModelQuota`.
- `TokenStatsCard` receives `cacheMetricTitle?: string`.
- Group header badges use `ProviderQuotaDisplayBadge[]`.
- Main-view code never decides cache wording from a provider id.

---

## Generic Target Identity

Use one generic target-id helper in renderer and main-process sizing:

```ts
function quotaGroupId(provider: ProviderId, groupKey: string): string {
  return `${provider}.group.${encodeURIComponent(groupKey)}`;
}
```

Settings validation parses target ids generically:

```ts
function isSafeQuotaGroupKey(value: string): boolean {
  return /^[A-Za-z0-9._~%-]+$/.test(value);
}

function isQuotaTargetId(value: string): boolean {
  const [provider, namespace, ...groupParts] = value.split('.');
  const encodedGroupKey = groupParts.join('.');
  return isProviderId(provider) && namespace === 'group' && encodedGroupKey.length > 0 && isSafeQuotaGroupKey(encodedGroupKey);
}
```

No validator regex may enumerate provider names or known target keys.

---

## Target View Models

Create or refactor `src/renderer/quotaDisplayModels.ts` around generic view models.

```ts
export interface QuotaDisplayRowViewModel {
  key: string;
  label: string;
  visualKind: ProviderQuotaRowVisualKind;
  quotaPct: number;
  quota: ProviderQuotaWindow;
  resetMs?: number | null;
  resetLabel?: string;
  stats: UsageWindowStats;
  cacheMetricTitle?: string;
  durationMs?: number;
  hideCost?: boolean;
  badges: ProviderQuotaDisplayBadge[];
  pending: boolean;
  pendingTitle?: string;
}

export interface QuotaDisplayGroupViewModel {
  id: string;
  provider: ProviderId;
  label: string;
  mode: QuotaDisplayMode;
  defaultMode: QuotaDisplayMode;
  accentColor?: string;
  rows: QuotaDisplayRowViewModel[];
  badges: ProviderQuotaDisplayBadge[];
  sortOrder: number;
}
```

Selector behavior:

- Iterate `settings.enabledProviders`.
- Read `state.providerQuotas[provider]`.
- For each `snapshot.groups`, build a group from metadata.
- For each `snapshot.models` that is not already covered by a group, build a model group from model metadata.
- Resolve display mode with `settings.quotaTargetModes[groupId] ?? group.defaultMode`.
- Resolve group ordering with `settings.quotaTargetOrder` first, then provider metadata `sortOrder`, then id.
- Resolve accent color from `group.accentColor ?? stableColorFromId(groupId)`.
- Exclude `mode === 'none'`.
- Return:

```ts
{
  richGroups: QuotaDisplayGroupViewModel[];
  simpleGroups: QuotaDisplayGroupViewModel[];
  widgetGroups: QuotaDisplayGroupViewModel[];
  settingsTargets: QuotaDisplayGroupViewModel[];
  extraUsage: ExtraUsageViewModel | null;
}
```

Rich groups use the same rows as Simple groups; only rendering differs.

---

## Layout Spec

### Rich

- Render one block per target group.
- If a group has two rows, render two `TokenStatsCard` instances side by side.
- If a group has one row, render one full-width `TokenStatsCard`.
- Preserve the full card details currently shown: source badge, quota percentage, reset, elapsed comparison for pace rows, token stats, cache metric, and cost unless `hideCost` is true.
- `visualKind: 'percentOnly'` hides reset/elapsed details even in Rich mode.

### Simple

- Render one compact block per target group.
- Header left: group label.
- Header right: group badges.
- Rows are vertical and reuse the widget row model.
- Header labels, source badges, and quota progress colors use the same visual rules as Rich cards.
- If the group has one row, only one progress row is shown.
- `visualKind: 'pace'`: percentage, reset, elapsed comparison, progress bar.
- `visualKind: 'percentOnly'`: percentage and progress only.

### Floating Widget

- Always uses Simple group layout.
- Includes Rich-mode targets as Simple blocks.
- Hides `mode === 'none'`.
- Height is derived from group count plus row count, so adding or hiding target groups changes the widget size automatically.

### Settings

- Settings list target groups, not individual windows.
- Each target has `Rich / Simple / None`.
- Each target can be moved up or down. Mode buttons appear before sorting buttons, with sorting controls at the far right to match the main-card layout controls.
- The saved `quotaTargetOrder` applies to Rich, Simple, Settings, and widget target order.
- Labels, default mode, badges, and row count come from metadata.
- Future providers/models can add many groups without increasing hardcoded UI branches.

---

## Implementation Tasks

### Task 1: Remove Legacy Limit Shape

**Files:**

- `src/main/providers/types.ts`
- `src/renderer/types.ts`
- `src/main/stateManager.ts`
- `src/renderer/App.tsx`
- `scripts/provider-usage-shape.test.mjs`
- `scripts/state-readiness.test.mjs`

Steps:

- [x] Add or update tests that fail if `usageLimits`, `UsageLimits`, or old per-provider limit fields appear in production state.
- [x] Remove remaining `usageLimits` state fields, normalizers, IPC payload handling, renderer props, and tests.
- [x] Ensure `AppState.providerQuotas` is the only quota state shape.
- [x] Run:

```powershell
node --test scripts/provider-usage-shape.test.mjs scripts/state-readiness.test.mjs
```

Expected: `# fail 0`.

### Task 2: Add Generic Metadata Types

**Files:**

- `src/main/providers/types.ts`
- `src/renderer/types.ts`
- `scripts/provider-state-assembly.test.mjs`

Steps:

- [x] Add the data model types from this plan.
- [x] Extend `ProviderQuotaSnapshot` and `ProviderModelQuota`.
- [x] Mirror the renderer types exactly.
- [x] Add source tests that assert the generic type names exist.
- [x] Add source tests that assert generic modules do not define concrete-provider display enums.
- [x] Run:

```powershell
npm.cmd run build:main
node --test scripts/provider-state-assembly.test.mjs
```

Expected: `# fail 0`.

### Task 3: Build Provider Metadata At Snapshot Assembly

**Files:**

- `src/main/providers/*/quota.ts`
- `src/main/stateManager.ts`
- `src/renderer/App.tsx`
- `scripts/provider-state-assembly.test.mjs`

Steps:

- [x] For each quota-capable provider adapter, attach `groups` and `windowDisplay` to the returned snapshot.
- [x] Move display-specific constants into provider-local metadata builders, not generic UI files.
- [x] In fallback/effective snapshot assembly, preserve metadata from the source snapshot.
- [x] If a fallback snapshot must be synthesized, call a provider-local metadata builder instead of branching in generic rendering code.
- [x] Normalize `groups`, `windowDisplay`, badge arrays, model display fields, and row visual kinds in `App.tsx`.
- [x] Reject malformed metadata instead of creating legacy fallback shapes.
- [x] Run:

```powershell
npm.cmd run build:main
node --test scripts/provider-state-assembly.test.mjs
```

Expected: `# fail 0`.

### Task 4: Generic Selector

**Files:**

- `src/renderer/quotaDisplayModels.ts`
- `scripts/quota-display-groups.test.mjs`
- `package.json`

Steps:

- [x] Add selector behavior tests with fixture snapshots whose group keys, row keys, labels, cache titles, and badges are arbitrary metadata.
- [x] Assert Rich groups keep related rows together.
- [x] Assert Simple groups hide missing second rows.
- [x] Assert percent-only rows do not render reset/elapsed fields.
- [x] Assert mode resolution uses `quotaTargetModes[groupId] ?? defaultMode`.
- [x] Assert widget groups include non-hidden Rich targets in Simple form.
- [x] Add a source guard:

```js
for (const filePath of [
  'src/renderer/quotaDisplayModels.ts',
  'src/renderer/components/TokenStatsCard.tsx',
  'src/renderer/views/MainView.tsx',
  'src/renderer/views/CompactWidgetView.tsx',
  'src/main/compactWidgetSizing.ts',
]) {
  const source = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(source, /provider\s*===\s*['"][^'"]+['"]/);
  assert.doesNotMatch(source, /cacheMetricMode/);
}
```

- [x] Implement `buildQuotaDisplayModels()` from snapshot metadata.
- [x] Run:

```powershell
node --test scripts/quota-display-groups.test.mjs
```

Expected: `# fail 0`.

### Task 5: Provider-Neutral Rich Card

**Files:**

- `src/renderer/components/TokenStatsCard.tsx`
- `src/renderer/views/MainView.tsx`
- `scripts/state-readiness.test.mjs`

Steps:

- [x] Replace provider-specific cache mode props with `cacheMetricTitle?: string`.
- [x] Replace any provider-derived card copy with view-model props.
- [x] Add `hideCost?: boolean`.
- [x] Ensure `visualKind: 'percentOnly'` suppresses reset/elapsed card details.
- [x] Update `MainView` to pass `row.cacheMetricTitle`, `row.hideCost`, and generic labels from selector output.
- [x] Run:

```powershell
node --test scripts/state-readiness.test.mjs scripts/quota-display-groups.test.mjs
```

Expected: `# fail 0`.

### Task 6: Main Simple Layout And Widget Layout

**Files:**

- `src/renderer/views/MainView.tsx`
- `src/renderer/views/CompactWidgetView.tsx`
- `scripts/state-readiness.test.mjs`
- `scripts/quota-display-groups.test.mjs`

Steps:

- [x] Render `richGroups` as grouped Rich blocks.
- [x] Render `simpleGroups` with the shared compact row component.
- [x] Move widget row rendering onto the same Simple row view model.
- [x] Ensure one-row groups show one row only.
- [x] Ensure group header badges render from metadata.
- [x] Replace provider-name accent selection with `group.accentColor` or a deterministic id-based fallback.
- [x] Ensure widget includes Rich targets as Simple blocks and hides None targets.
- [x] Run:

```powershell
node --test scripts/state-readiness.test.mjs scripts/quota-display-groups.test.mjs
```

Expected: `# fail 0`.

### Task 7: Generic Settings

**Files:**

- `src/main/ipc.ts`
- `src/renderer/App.tsx`
- `src/renderer/views/SettingsView.tsx`
- `scripts/provider-settings.test.mjs`

Steps:

- [x] Replace target-id validation with generic `ProviderId + encoded group key` parsing.
- [x] Remove validation regexes that enumerate providers, models, or known windows.
- [x] Build settings options from `settingsTargets`.
- [x] Persist only `Rich / Simple / None` by group id.
- [x] Delete per-window option generation.
- [x] Reject old target ids during normalization; do not alias them.
- [x] Run:

```powershell
node --test scripts/provider-settings.test.mjs
```

Expected: `# fail 0`.

### Task 8: Generic Widget Sizing

**Files:**

- `src/main/compactWidgetSizing.ts`
- `scripts/compact-widget-sizing.test.mjs`

Steps:

- [x] Count visible groups from metadata, not known provider/window names.
- [x] Count rows from `group.windowKeys` plus standalone model groups.
- [x] Exclude `mode === 'none'`.
- [x] Treat Rich groups as Simple rows for widget height.
- [x] Use a stable base height plus `groupCount` and `rowCount`.
- [x] Add tests where changing metadata row count changes height.
- [x] Add source guards against concrete-provider branches.
- [x] Run:

```powershell
node --test scripts/compact-widget-sizing.test.mjs
```

Expected: `# fail 0`.

### Task 9: Docs And Verification

**Files:**

- `README.md`
- `README.zh-CN.md`
- `docs/superpowers/plans/2026-05-31-provider-quotas-plan-usage.md`

Steps:

- [x] Document that Plan Usage is provider/model metadata-driven.
- [x] Update the earlier providerQuotas migration plan to reference this refinement.
- [x] Run focused verification:

```powershell
node --test scripts/quota-display-groups.test.mjs scripts/compact-widget-sizing.test.mjs scripts/provider-settings.test.mjs scripts/state-readiness.test.mjs scripts/provider-state-assembly.test.mjs scripts/provider-usage-shape.test.mjs
```

- [x] Run full verification:

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run dist
git diff --check
```

Expected:

- Tests exit with `# fail 0`.
- Build succeeds.
- Package generation succeeds.
- `git diff --check` exits 0.

---

## Review Checklist

- [x] No production `usageLimits` shape remains.
- [x] Generic renderer files do not compare provider ids or model names.
- [x] Generic main sizing code does not compare provider ids or model names.
- [x] Settings validation does not enumerate provider ids, model names, or quota windows.
- [x] Rich card cache wording comes from props.
- [x] Simple Plan Usage and floating widget share the same group/row view model.
- [x] Provider adapters are the only place where provider-specific display metadata is authored.
- [x] API Cache wording is metadata-driven through `providerQuotas`.
- [x] Tests use arbitrary metadata labels/keys to prove behavior is parameter-driven.
