# Rich Provider Card Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render visible Rich quota cards from the same provider in two-column rows, with any odd leftover card spanning the full row.

**Architecture:** Keep quota display grouping provider-neutral by adding a pure renderer-facing layout helper in `src/renderer/quotaDisplayModels.ts`. `MainView` consumes the helper output and continues passing the same card data into `TokenStatsCard`, so Rich card content, Simple mode, widget mode, settings modes, quota stats, and provider adapters do not change.

**Tech Stack:** TypeScript, React, Electron renderer, Node test runner, esbuild-based renderer model tests.

---

## Scope

Implement only the Plan Usage Rich-card layout rule:

- Use only visible `richGroups` from `buildQuotaDisplayModels()`.
- Group Rich cards by `provider`.
- Preserve the first visible provider order.
- Preserve card order within each provider.
- Chunk each provider's Rich cards into rows of two.
- Render rows with two cards as `1fr 1fr`.
- Render rows with one card as `1fr`.
- Do not cross-pair cards from different providers.
- Do not change `TokenStatsCard` props, content, colors, stats, badges, reset display, Simple mode, widget mode, settings, provider snapshots, or usage aggregation.

If a user's configured target order interleaves providers, this helper intentionally coalesces cards by the provider's first visible occurrence so same-provider Rich cards can pair.

No PRD file was found in this repository during planning, so there is no PRD update task.

## File Structure

- Modify: `src/renderer/quotaDisplayModels.ts`
  - Add exported `QuotaDisplayRichCardViewModel`.
  - Add exported `QuotaDisplayRichRowViewModel`.
  - Add exported `buildRichCardRows(richGroups)` pure helper.
  - No concrete provider id branches.

- Modify: `src/renderer/views/MainView.tsx`
  - Import `buildRichCardRows`.
  - Replace direct `richGroups.map(group => ...)` Rich rendering with `richRows.map(row => ...)`.
  - Continue rendering the same `TokenStatsCard` props from `cardView.group` and `cardView.row`.

- Modify: `scripts/quota-display-groups.test.mjs`
  - Add behavior coverage for same-provider Rich card pairing.
  - Add source guard that `PlanUsagePanel` consumes `buildRichCardRows(richGroups)` instead of deriving Rich grid width from `group.rows.length`.

---

### Task 1: Add Failing Rich Layout Tests

**Files:**
- Modify: `scripts/quota-display-groups.test.mjs`
- Test: `scripts/quota-display-groups.test.mjs`

- [ ] **Step 1: Add the failing behavior test**

Add this test after `quota display groups follow persisted target ordering before provider metadata order`:

```js
test('rich card rows pair visible cards by provider and leave odd cards full width', async () => {
  const { buildQuotaDisplayModels, buildRichCardRows } = await loadQuotaDisplayModels();
  const options = baseOptions({
    quotaTargetOrder: [
      'claude.group.primary',
      'codex.group.account',
      'claude.group.extra',
    ],
  });
  options.providerQuotas.claude.groups.push({
    key: 'extra',
    label: 'Provider Alpha Extra',
    defaultMode: 'rich',
    windowKeys: ['extra'],
    sortOrder: 1,
  });
  options.providerQuotas.claude.windowDisplay.extra = {
    label: 'extra',
    visualKind: 'pace',
    cacheMetricTitle: 'Alpha cache metric',
    durationMs: 6_000,
  };
  options.providerQuotas.claude.windows.extra = quota(60);
  options.usage.byProvider.claude.windows.extra = stats(6_000);

  const models = buildQuotaDisplayModels(options);
  const rows = buildRichCardRows(models.richGroups);

  assert.deepEqual(rows.map(row => row.provider), ['claude', 'claude', 'codex']);
  assert.deepEqual(rows.map(row => row.cards.length), [2, 1, 2]);
  assert.deepEqual(rows.map(row => row.cards.map(card => `${card.group.label}:${card.row.label}`)), [
    ['Provider Alpha:fast', 'Provider Alpha:slow'],
    ['Provider Alpha Extra:extra'],
    ['Provider Beta:burst', 'Provider Beta:durable'],
  ]);
});
```

- [ ] **Step 2: Add the failing MainView source guard**

In the existing `generic quota display files avoid provider-specific UI branches` test, after `const panelBody = mainSource.slice(panelStart, panelEnd);`, add:

```js
  assert.match(panelBody, /buildRichCardRows\(richGroups\)/);
  assert.match(panelBody, /richRows\.map/);
  assert.doesNotMatch(panelBody, /gridTemplateColumns:\s*group\.rows\.length/);
```

- [ ] **Step 3: Run the focused test and confirm RED**

Run:

```bash
rtk node --test scripts/quota-display-groups.test.mjs
```

Expected: FAIL because `buildRichCardRows` is not exported yet, and `MainView.tsx` still renders `richGroups` directly.

---

### Task 2: Add Provider-Neutral Rich Row Helper

**Files:**
- Modify: `src/renderer/quotaDisplayModels.ts`
- Test: `scripts/quota-display-groups.test.mjs`

- [ ] **Step 1: Add Rich row view-model interfaces**

In `src/renderer/quotaDisplayModels.ts`, after `QuotaDisplayGroupViewModel`, add:

```ts
export interface QuotaDisplayRichCardViewModel {
  key: string;
  provider: ProviderId;
  group: QuotaDisplayGroupViewModel;
  row: QuotaDisplayRowViewModel;
}

export interface QuotaDisplayRichRowViewModel {
  key: string;
  provider: ProviderId;
  cards: QuotaDisplayRichCardViewModel[];
}
```

- [ ] **Step 2: Add `buildRichCardRows`**

In `src/renderer/quotaDisplayModels.ts`, after `buildQuotaDisplayGroups()` and before `buildQuotaTargetSettingsOptions()`, add:

```ts
export function buildRichCardRows(
  richGroups: readonly QuotaDisplayGroupViewModel[],
): QuotaDisplayRichRowViewModel[] {
  const providerOrder: ProviderId[] = [];
  const cardsByProvider = new Map<ProviderId, QuotaDisplayRichCardViewModel[]>();

  for (const group of richGroups) {
    if (!cardsByProvider.has(group.provider)) {
      providerOrder.push(group.provider);
      cardsByProvider.set(group.provider, []);
    }

    const cards = cardsByProvider.get(group.provider)!;
    for (const row of group.rows) {
      cards.push({
        key: row.key,
        provider: group.provider,
        group,
        row,
      });
    }
  }

  const rows: QuotaDisplayRichRowViewModel[] = [];
  for (const provider of providerOrder) {
    const cards = cardsByProvider.get(provider) ?? [];
    for (let index = 0; index < cards.length; index += 2) {
      const rowCards = cards.slice(index, index + 2);
      if (rowCards.length === 0) continue;
      rows.push({
        key: `${provider}.${Math.floor(index / 2)}`,
        provider,
        cards: rowCards,
      });
    }
  }

  return rows;
}
```

- [ ] **Step 3: Run the focused test**

Run:

```bash
rtk node --test scripts/quota-display-groups.test.mjs
```

Expected: The behavior test passes, but the MainView source guard still fails because `PlanUsagePanel` does not yet use `buildRichCardRows`.

---

### Task 3: Render Rich Rows In MainView

**Files:**
- Modify: `src/renderer/views/MainView.tsx`
- Test: `scripts/quota-display-groups.test.mjs`

- [ ] **Step 1: Import the helper**

Replace the current quota display import:

```ts
import { buildQuotaDisplayModels, QuotaDisplayGroupViewModel, QuotaDisplayRowViewModel } from '../quotaDisplayModels';
```

with:

```ts
import {
  buildQuotaDisplayModels,
  buildRichCardRows,
  QuotaDisplayGroupViewModel,
  QuotaDisplayRowViewModel,
} from '../quotaDisplayModels';
```

- [ ] **Step 2: Build Rich rows after display models**

In `PlanUsagePanel`, after the `buildQuotaDisplayModels()` call and before `const showExtraUsage`, add:

```ts
  const richRows = buildRichCardRows(richGroups);
```

- [ ] **Step 3: Replace Rich rendering**

Replace the current Rich block:

```tsx
      {richGroups.map(group => (
        <div key={`quota-rich-${group.id}`} style={{ display: 'grid', gridTemplateColumns: group.rows.length === 1 ? '1fr' : '1fr 1fr', borderBottom: `1px solid ${C.border}` }}>
          {group.rows.map((card, cardIndex) => {
            const source = limitSourceDisplay(card.quota);
            return (
              <TokenStatsCard
                key={card.key}
                provider={group.label}
                period={card.label}
                stats={card.stats}
                currency={currency}
                usdToKrw={usdToKrw}
                limitPct={card.quota.pct}
                resetMs={card.visualKind === 'percentOnly' ? null : card.quota.resetMs}
                resetLabel={card.visualKind === 'percentOnly' ? undefined : card.quota.resetLabel}
                apiConnected={card.apiConnected}
                limitSourceLabel={source.label}
                limitSourceTitle={source.title}
                limitSourceTone={source.tone}
                limitDataState={limitDataState(card.quota, card.pending)}
                pendingLimit={card.pending}
                pendingLimitLabel="Syncing"
                pendingLimitTitle={card.pendingTitle}
                cacheMetricTitle={card.cacheMetricTitle}
                durationMs={card.durationMs}
                hideCost={card.hideCost}
                hero
                borderRight={group.rows.length > 1 && cardIndex === 0}
              />
            );
          })}
        </div>
      ))}
```

with:

```tsx
      {richRows.map(richRow => (
        <div key={`quota-rich-row-${richRow.key}`} style={{ display: 'grid', gridTemplateColumns: richRow.cards.length === 1 ? '1fr' : '1fr 1fr', borderBottom: `1px solid ${C.border}` }}>
          {richRow.cards.map((cardView, cardIndex) => {
            const { group, row: card } = cardView;
            const source = limitSourceDisplay(card.quota);
            return (
              <TokenStatsCard
                key={cardView.key}
                provider={group.label}
                period={card.label}
                stats={card.stats}
                currency={currency}
                usdToKrw={usdToKrw}
                limitPct={card.quota.pct}
                resetMs={card.visualKind === 'percentOnly' ? null : card.quota.resetMs}
                resetLabel={card.visualKind === 'percentOnly' ? undefined : card.quota.resetLabel}
                apiConnected={card.apiConnected}
                limitSourceLabel={source.label}
                limitSourceTitle={source.title}
                limitSourceTone={source.tone}
                limitDataState={limitDataState(card.quota, card.pending)}
                pendingLimit={card.pending}
                pendingLimitLabel="Syncing"
                pendingLimitTitle={card.pendingTitle}
                cacheMetricTitle={card.cacheMetricTitle}
                durationMs={card.durationMs}
                hideCost={card.hideCost}
                hero
                borderRight={richRow.cards.length > 1 && cardIndex === 0}
              />
            );
          })}
        </div>
      ))}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run:

```bash
rtk node --test scripts/quota-display-groups.test.mjs
```

Expected: PASS. The behavior test confirms provider pairing, and the source guard confirms `PlanUsagePanel` consumes the helper.

---

### Task 4: Verify Renderer Build And Full Suite

**Files:**
- No new files.
- Verify: `src/renderer/quotaDisplayModels.ts`, `src/renderer/views/MainView.tsx`, `scripts/quota-display-groups.test.mjs`

- [ ] **Step 1: Run renderer build**

Run:

```bash
rtk npm.cmd run build:renderer
```

Expected: PASS. Renderer bundle compiles with the new helper import and JSX render loop.

- [ ] **Step 2: Run full test suite**

Run:

```bash
rtk npm.cmd test
```

Expected: PASS. Existing quota display, provider state, widget sizing, ledger, and Antigravity tests continue to pass.

- [ ] **Step 3: Check whitespace**

Run:

```bash
rtk git diff --check
```

Expected: no whitespace errors. Existing CRLF/LF warnings are acceptable if they match the current repo behavior, but whitespace errors must be fixed.

- [ ] **Step 4: Inspect diff scope**

Run:

```bash
rtk git diff -- src/renderer/quotaDisplayModels.ts src/renderer/views/MainView.tsx scripts/quota-display-groups.test.mjs
```

Expected: diff is limited to:

- new Rich row helper and interfaces in `quotaDisplayModels.ts`
- Plan Usage Rich rendering consuming `buildRichCardRows`
- test coverage for pairing and MainView helper usage

---

### Task 5: Commit The Layout Change

**Files:**
- Stage only:
  - `src/renderer/quotaDisplayModels.ts`
  - `src/renderer/views/MainView.tsx`
  - `scripts/quota-display-groups.test.mjs`

- [ ] **Step 1: Check for unrelated dirty files**

Run:

```bash
rtk git status --short
```

Expected: note any pre-existing dirty files. Do not stage unrelated Antigravity review-fix files or untracked archives/plans unless the user explicitly wants them included.

- [ ] **Step 2: Stage only this plan's implementation files**

Run:

```bash
rtk git add src/renderer/quotaDisplayModels.ts src/renderer/views/MainView.tsx scripts/quota-display-groups.test.mjs
```

- [ ] **Step 3: Commit**

Run:

```bash
rtk git commit -m "Refine provider rich quota card layout"
```

Expected: one commit containing only the Rich layout helper, renderer use, and tests.

---

## Self-Review

**Spec coverage:** The plan covers same-provider Rich card pairing, two-column rows, full-width odd leftovers, provider-neutral implementation, no Simple/widget change, and no card-content change.

**Placeholder scan:** The plan contains no placeholder markers, no unspecified error handling, and no "similar to" shortcuts.

**Type consistency:** `QuotaDisplayRichCardViewModel`, `QuotaDisplayRichRowViewModel`, and `buildRichCardRows()` are introduced before `MainView` imports them. The render snippet uses `cardView.group` and `cardView.row`, matching the helper output.

**Provider neutrality:** The helper groups by `group.provider` without checking concrete provider names. The existing source guard still rejects `provider === ...` inside generic quota display files and `PlanUsagePanel`.

**Verification coverage:** Focused behavior tests, source guard, renderer build, full suite, whitespace check, and diff scope inspection are all included.
