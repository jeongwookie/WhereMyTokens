# Antigravity RPC Usage Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Antigravity token/cost/statistics durable by persisting generatorMetadata calls as soon as RPC returns them, then deriving WMT summaries and ledger aggregates from that local cache instead of treating the language server as an append-only history source.

**Architecture:** Antigravity becomes a provider-local durable source: RPC scan updates an `AntigravityUsageCacheStore`, a GM tracker decides which cascades need refresh/enrichment, and `usage.ts` builds summaries plus a provider ledger slice from the persisted cache. The generic usage ledger keeps serving UI/Trend/Stats, but Antigravity imports replace the whole Antigravity slice idempotently instead of using JSONL cursor semantics.

**Tech Stack:** Electron main process, TypeScript, `electron-store`, Antigravity local RPC, existing WMT `UsageLedgerSnapshot` aggregate helpers, Node `node:test`.

---

## Reference Decisions

- Primary reference: `AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor`, especially `src/gm/tracker.ts` and `src/gm/parser.ts`.
- Keep from ACWM:
  - `GMTracker.fetchAll()` style persistent conversation cache.
  - Skip unchanged IDLE cascades that already have calls.
  - Re-fetch once when a cascade transitions RUNNING to IDLE.
  - Enrich lightweight `GetCascadeTrajectoryGeneratorMetadata` with embedded `GetCascadeTrajectory(...).trajectory.generatorMetadata` when the lightweight data is incomplete.
  - Keep stale cached data on RPC failure.
- Do not use `agentlytics` as the token-counting model. It is useful only for session/cascade enumeration.
- Do not keep the current experiment as-is:
  - Revert the broad `GENERIC_PROVIDER_HISTORY_SCAN_BUDGET_MS` behavior in `src/main/stateManager.ts`.
  - Remove the test that asserts Antigravity ledger sources simply omit cursors.
  - Keep or re-create the enrichment and timestamp tests under the new cache/tracker architecture.

## File Structure

- Create: `src/main/providers/antigravity/usageCacheStore.ts`
  - Owns persisted normalized Antigravity usage calls.
  - Provides `getSnapshot()`, `replaceSnapshot()`, `upsertCascade()`, `compact()`, and `buildLedgerSlice()`.
  - Persists immediately after each cascade upsert.
- Create: `src/main/providers/antigravity/gmTracker.ts`
  - Owns GM fetch policy: skip unchanged IDLE, refresh RUNNING, refresh RUNNING->IDLE, enrich when needed, keep stale cache on error.
  - Depends on `AntigravityLsClient`, `runtimeCache`, `gmParser`, and `usageCacheStore`.
- Modify: `src/main/providers/antigravity/gmParser.ts`
  - Export stable call key, fingerprint, parse-many, total-token, enrichment-decision, and merge helpers.
- Modify: `src/main/providers/antigravity/summary.ts`
  - Export entry conversion helpers so `usageCacheStore.ts` and tests do not duplicate token/cost mapping.
- Modify: `src/main/providers/antigravity/usage.ts`
  - Replace direct one-shot scan with `AntigravityGmTracker`.
  - Build summaries from persisted cache, not only from cascades returned in the current scan.
  - Return one Antigravity cache ledger source using provider-slice replacement.
- Modify: `src/main/usageLedgerIngest.ts`
  - Add a generic `replaceProviderUsageSliceInSnapshot()` helper.
  - This helper removes one provider's aggregate rows from the global ledger and merges a provider-owned slice.
- Modify: `src/main/stateManager.ts`
  - Revert the broad full-history generic-provider budget experiment.
  - Keep generic providers on the normal budget path; Antigravity durability comes from cache, not from long blocking scans.
- Modify: `scripts/antigravity-gm-parser.test.mjs`
  - Add tests for call key, fingerprint, merge, and enrichment decision.
- Create: `scripts/antigravity-usage-cache-store.test.mjs`
  - Tests cache normalization, upsert, idempotent aggregate replacement, and compaction.
- Create: `scripts/antigravity-gm-tracker.test.mjs`
  - Tests ACWM-style refresh policy with fake Antigravity RPC.
- Modify: `scripts/antigravity-provider-integration.test.mjs`
  - Replace cursor/no-cursor tests with cache-backed idempotency tests.
- Modify: `scripts/state-readiness.test.mjs`
  - Remove the generic 60s warmup assertion.
- Modify: `package.json`
  - Add the two new tests to the `test` script.

## Task 1: Settle the Current Experiment Before Building Cache

**Files:**
- Modify: `src/main/stateManager.ts`
- Modify: `scripts/state-readiness.test.mjs`
- Modify: `scripts/antigravity-provider-integration.test.mjs`

- [ ] **Step 1: Remove the broad generic-provider long-budget assertion**

Delete this test from `scripts/state-readiness.test.mjs`:

```js
test('full-history generic provider scans get an independent warmup budget', () => {
  const stateSource = fs.readFileSync(path.resolve('src', 'main', 'stateManager.ts'), 'utf8');

  assert.match(stateSource, /GENERIC_PROVIDER_HISTORY_SCAN_BUDGET_MS = 60_000/);
  assert.match(stateSource, /remainingBudgetMs !== 0 \|\| includeFullHistory/);
  assert.match(stateSource, /Math\.max\(remainingForGeneric, StateManager\.GENERIC_PROVIDER_HISTORY_SCAN_BUDGET_MS\)/);
  assert.match(stateSource, /scanBudgetMs: genericScanBudgetMs/);
});
```

- [ ] **Step 2: Restore normal generic-provider budget flow**

In `src/main/stateManager.ts`, remove:

```ts
private static readonly GENERIC_PROVIDER_HISTORY_SCAN_BUDGET_MS = 60_000;
```

Then replace the generic scan block inside `loadProviderSummaries()` with:

```ts
const elapsedMs = Date.now() - startedAt;
const remainingBudgetMs = budgetMs === null ? null : Math.max(0, budgetMs - elapsedMs);
if (remainingBudgetMs === 0) {
  partial = true;
} else {
  const genericCtx = budgetMs === null
    ? ctx
    : this.providerContext({
      settings,
      force,
      scanBudgetMs: remainingBudgetMs,
      includeFullHistory,
      prioritySourceIds: startupPriority,
    });
  const genericUsage = await this.scanGenericProviderUsage(settings, genericCtx);
  for (const [key, summary] of genericUsage.summaries.entries()) {
    summaries.set(key, summary);
  }
  scannedFiles += genericUsage.scannedFiles;
  partial = partial || genericUsage.partial;
  ledgerSources = genericUsage.ledgerSources;
}
```

- [ ] **Step 3: Remove the no-cursor experiment test**

Delete the test named:

```js
test('Antigravity usage ledger source does not use cursors for unstable local RPC windows', async () => {
```

from `scripts/antigravity-provider-integration.test.mjs`. Cache-backed idempotency will be covered in Task 5 and Task 7.

- [ ] **Step 4: Run focused readiness test**

Run:

```powershell
npm.cmd run build:main
node --test scripts/state-readiness.test.mjs
```

Expected: `state-readiness.test.mjs` passes without assertions mentioning `GENERIC_PROVIDER_HISTORY_SCAN_BUDGET_MS`.

- [ ] **Step 5: Commit**

```powershell
git add src/main/stateManager.ts scripts/state-readiness.test.mjs scripts/antigravity-provider-integration.test.mjs
git commit -m "Prepare Antigravity usage cache migration"
```

## Task 2: Extract GM Parser Helpers

**Files:**
- Modify: `src/main/providers/antigravity/gmParser.ts`
- Modify: `scripts/antigravity-gm-parser.test.mjs`

- [ ] **Step 1: Add failing parser tests**

Append these tests to `scripts/antigravity-gm-parser.test.mjs`:

```js
test('Antigravity GM helpers keep repeated execution ids distinct by step indices', () => {
  const first = {
    cascadeId: 'c1',
    executionId: 'same-exec',
    stepIndices: [4, 5],
    timestampMs: Date.parse('2026-06-01T10:00:00.000Z'),
    model: 'Gemini 3 Pro',
    rawModel: 'MODEL_GEMINI_3_PRO',
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    responseTokens: 5,
    toolNames: [],
  };
  const second = { ...first, stepIndices: [8, 9], inputTokens: 20, outputTokens: 7 };

  assert.notEqual(gmParser.antigravityCallKey(first), gmParser.antigravityCallKey(second));
  const merged = gmParser.mergeAntigravityCalls([first], [second]);
  assert.equal(merged.length, 2);
  assert.equal(merged.reduce((sum, call) => sum + call.inputTokens, 0), 30);
});

test('Antigravity GM helpers replace a matching call with richer token data', () => {
  const light = {
    cascadeId: 'c1',
    executionId: 'exec-1',
    stepIndices: [1],
    timestampMs: Date.parse('2026-06-01T10:00:00.000Z'),
    model: 'Gemini 3 Pro',
    rawModel: 'MODEL_GEMINI_3_PRO',
    inputTokens: 10,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    responseTokens: 1,
    toolNames: [],
  };
  const rich = { ...light, inputTokens: 100, outputTokens: 7, cacheReadTokens: 50 };

  const merged = gmParser.mergeAntigravityCalls([light], [rich]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].inputTokens, 100);
  assert.equal(merged[0].cacheReadTokens, 50);
});

test('Antigravity GM helpers request enrichment for placeholder and large cascades', () => {
  const parsedCall = {
    cascadeId: 'c1',
    executionId: 'exec-1',
    stepIndices: [1],
    timestampMs: Date.parse('2026-06-01T10:00:00.000Z'),
    model: 'antigravity',
    rawModel: 'antigravity',
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    responseTokens: 1,
    toolNames: [],
  };

  assert.equal(gmParser.shouldEnrichForTokens({
    stepCount: 10,
    rawGm: [{ chatModel: {} }],
    calls: [parsedCall],
  }), true);
  assert.equal(gmParser.shouldEnrichForTokens({
    stepCount: 350,
    rawGm: [{ chatModel: { responseModel: 'MODEL_GEMINI_3_PRO' } }],
    calls: [parsedCall],
  }), true);
});
```

- [ ] **Step 2: Run parser tests and verify failure**

Run:

```powershell
npm.cmd run build:main
node --test scripts/antigravity-gm-parser.test.mjs
```

Expected: fails because `antigravityCallKey`, `mergeAntigravityCalls`, and `shouldEnrichForTokens` are not exported.

- [ ] **Step 3: Export parser helpers**

Add these exports to `src/main/providers/antigravity/gmParser.ts`:

```ts
export function totalAntigravityCallTokens(call: AntigravityUsageCall): number {
  return call.inputTokens + call.outputTokens + call.cacheReadTokens + call.cacheCreationTokens;
}

export function antigravityCallKey(call: AntigravityUsageCall): string {
  if (call.executionId && call.stepIndices.length > 0) {
    return `exec:${call.executionId}|steps:${call.stepIndices.join(',')}`;
  }
  if (call.executionId) return `exec:${call.executionId}`;
  if (call.stepIndices.length > 0) return `steps:${call.stepIndices.join(',')}|model:${call.rawModel || call.model}`;
  return `time:${call.timestampMs}|model:${call.rawModel || call.model}`;
}

export function antigravityCallFingerprint(call: AntigravityUsageCall): string {
  return [
    call.timestampMs,
    call.model,
    call.rawModel,
    call.inputTokens,
    call.outputTokens,
    call.cacheCreationTokens,
    call.cacheReadTokens,
    call.thinkingTokens,
    call.responseTokens,
    call.contextMax ?? 0,
    call.toolNames.join(','),
  ].join('|');
}

export function shouldEnrichForTokens(params: {
  stepCount: number;
  rawGm: Record<string, unknown>[];
  calls: AntigravityUsageCall[];
}): boolean {
  if (params.rawGm.length === 0) return true;
  if (params.calls.length === 0 && params.stepCount > 0) return true;
  if (params.stepCount >= 350) return true;
  if (params.rawGm.some(gm => {
    const cm = (gm.chatModel || {}) as Record<string, unknown>;
    return !cm.responseModel;
  })) return true;
  return params.calls.some(call => totalAntigravityCallTokens(call) === 0);
}

export function parseAntigravityGmEntries(
  cascadeId: string,
  rawGm: Record<string, unknown>[],
  fallbackMs: number,
  labelMap?: Map<string, string>,
): AntigravityUsageCall[] {
  return rawGm
    .map(gm => parseAntigravityGmEntry(cascadeId, gm, fallbackMs, labelMap))
    .filter((call): call is AntigravityUsageCall => !!call)
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

export function mergeAntigravityCalls(
  primary: AntigravityUsageCall[],
  embedded: AntigravityUsageCall[],
): AntigravityUsageCall[] {
  const byKey = new Map<string, AntigravityUsageCall>();

  for (const call of primary) byKey.set(antigravityCallKey(call), call);

  for (const call of embedded) {
    const key = antigravityCallKey(call);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, call);
      continue;
    }
    if (totalAntigravityCallTokens(call) > totalAntigravityCallTokens(existing)) {
      byKey.set(key, { ...existing, ...call });
    }
  }

  return [...byKey.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}
```

- [ ] **Step 4: Replace duplicate helpers in `usage.ts`**

Remove local `parseCalls`, `totalCallTokens`, `shouldEnrichForTokens`, `callKey`, and `mergeAntigravityCalls` from `src/main/providers/antigravity/usage.ts`.

Update the import:

```ts
import {
  antigravityCallRequestId,
  mergeAntigravityCalls,
  parseAntigravityGmEntries,
  shouldEnrichForTokens,
  type AntigravityUsageCall,
} from './gmParser';
```

Replace each local parse call with:

```ts
let calls = parseAntigravityGmEntries(cascade.cascadeId, rawGm, cascade.lastModifiedMs, labelMap);
```

and:

```ts
const embeddedCalls = parseAntigravityGmEntries(cascade.cascadeId, embeddedRawGm, cascade.lastModifiedMs, labelMap);
```

- [ ] **Step 5: Run parser and provider tests**

Run:

```powershell
npm.cmd run build:main
node --test scripts/antigravity-gm-parser.test.mjs scripts/antigravity-provider-integration.test.mjs
```

Expected: both test files pass.

- [ ] **Step 6: Commit**

```powershell
git add src/main/providers/antigravity/gmParser.ts src/main/providers/antigravity/usage.ts scripts/antigravity-gm-parser.test.mjs
git commit -m "Extract Antigravity GM merge helpers"
```

## Task 3: Add Provider-Slice Replacement to the Ledger

**Files:**
- Modify: `src/main/usageLedgerIngest.ts`
- Modify: `scripts/usage-ledger-generic-ingest.test.mjs`

- [ ] **Step 1: Add failing provider-slice tests**

Append these tests to `scripts/usage-ledger-generic-ingest.test.mjs`:

```js
test('provider slice replacement is idempotent for Antigravity aggregates', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const usageEntry = entry({
    id: 'ag-slice-1',
    timestamp: '2026-06-01T10:15:00.000Z',
    input: 100,
    output: 200,
    model: 'Gemini 3 Pro',
  });
  const aggregate = aggregateFor(usageEntry);
  const slice = {
    provider: 'antigravity',
    minuteRecent: { [`${usageEntry.timestampMs - (usageEntry.timestampMs % 60000)}|antigravity|Gemini 3 Pro`]: aggregate },
    recentRequestIndex: {},
    hourlyActivity: { [`${usageEntry.timestampMs - (usageEntry.timestampMs % 3600000)}|antigravity`]: aggregate },
    dailyModel: { [dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')]: aggregate },
    monthlyModel: { [monthModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')]: aggregate },
    sourceCheckpoints: {
      'ag-cache-source': {
        provider: 'antigravity',
        sourceHash: 'ag-cache-source',
        sourceKey: 'antigravity:usage-cache',
        lastImportedAt: nowMs,
        hasUsage: true,
      },
    },
    sourceRepairRollup: {},
  };

  const first = ingestModule.replaceProviderUsageSliceInSnapshot(emptyUsageLedgerSnapshot(), slice, nowMs);
  const second = ingestModule.replaceProviderUsageSliceInSnapshot(first, slice, nowMs);

  assert.equal(second.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].requestCount, 1);
  assert.equal(second.monthlyModel[monthModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].totalTokens, 305);
});

test('provider slice replacement preserves other providers', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const claudeEntry = { ...entry({ id: 'claude-1', model: 'Claude Sonnet' }), provider: 'claude' };
  const base = await importUsageEntriesIntoSnapshot(emptyUsageLedgerSnapshot(), {
    provider: 'claude',
    sourceHash: 'claude-source',
    sourceKey: 'claude:file',
  }, [{ entry: claudeEntry, aggregate: aggregateFor(claudeEntry) }], nowMs);
  const slice = {
    provider: 'antigravity',
    minuteRecent: {},
    recentRequestIndex: {},
    hourlyActivity: {},
    dailyModel: {
      [dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')]: {
        requestCount: 1,
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
        totalTokens: 10,
        costUSD: 0.01,
        cacheSavingsUSD: 0.001,
      },
    },
    monthlyModel: {},
    sourceCheckpoints: {},
    sourceRepairRollup: {},
  };

  const next = ingestModule.replaceProviderUsageSliceInSnapshot(base, slice, nowMs);

  assert.equal(next.dailyModel[dayModelKey('2026-05-25', 'claude', 'Claude Sonnet')].requestCount, 1);
  assert.equal(next.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].totalTokens, 10);
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```powershell
npm.cmd run build:main
node --test scripts/usage-ledger-generic-ingest.test.mjs
```

Expected: fails because `replaceProviderUsageSliceInSnapshot` is not exported.

- [ ] **Step 3: Implement provider-slice types and replacement**

Add this to `src/main/usageLedgerIngest.ts`:

```ts
export interface UsageLedgerProviderSlice {
  provider: ProviderId;
  minuteRecent: Record<string, UsageAggregate>;
  recentRequestIndex: UsageLedgerSnapshot['recentRequestIndex'];
  hourlyActivity: Record<string, UsageAggregate>;
  dailyModel: Record<string, UsageAggregate>;
  monthlyModel: Record<string, UsageAggregate>;
  sourceCheckpoints: UsageLedgerSnapshot['sourceCheckpoints'];
  sourceRepairRollup: Record<string, UsageAggregate>;
}

function providerFromPipeKey(key: string, providerIndex: number): ProviderId | null {
  const parts = key.split('|');
  const provider = parts[providerIndex];
  return provider === 'claude' || provider === 'codex' || provider === 'antigravity' ? provider : null;
}

function withoutProviderAggregateRows(
  record: Record<string, UsageAggregate>,
  provider: ProviderId,
  providerIndex: number,
): Record<string, UsageAggregate> {
  const next: Record<string, UsageAggregate> = {};
  for (const [key, aggregate] of Object.entries(record)) {
    if (providerFromPipeKey(key, providerIndex) !== provider) next[key] = cloneAggregate(aggregate);
  }
  return next;
}

function withoutProviderRecentRequests(
  record: UsageLedgerSnapshot['recentRequestIndex'],
  provider: ProviderId,
): UsageLedgerSnapshot['recentRequestIndex'] {
  const next: UsageLedgerSnapshot['recentRequestIndex'] = {};
  for (const [key, entry] of Object.entries(record)) {
    if (providerFromPipeKey(entry.minuteKey, 1) !== provider) {
      next[key] = { ...entry, aggregate: cloneAggregate(entry.aggregate) };
    }
  }
  return next;
}

function withoutProviderCheckpoints(
  record: UsageLedgerSnapshot['sourceCheckpoints'],
  provider: ProviderId,
): UsageLedgerSnapshot['sourceCheckpoints'] {
  const next: UsageLedgerSnapshot['sourceCheckpoints'] = {};
  for (const [key, checkpoint] of Object.entries(record)) {
    if (checkpoint.provider !== provider) next[key] = { ...checkpoint };
  }
  return next;
}

function cloneAggregateRecord(record: Record<string, UsageAggregate>): Record<string, UsageAggregate> {
  return Object.fromEntries(Object.entries(record).map(([key, aggregate]) => [key, cloneAggregate(aggregate)]));
}

export function replaceProviderUsageSliceInSnapshot(
  snapshot: UsageLedgerSnapshot,
  slice: UsageLedgerProviderSlice,
  nowMs = Date.now(),
): UsageLedgerSnapshot {
  const next = cloneUsageLedgerSnapshot(snapshot);
  next.minuteRecent = {
    ...withoutProviderAggregateRows(snapshot.minuteRecent, slice.provider, 1),
    ...cloneAggregateRecord(slice.minuteRecent),
  };
  next.recentRequestIndex = {
    ...withoutProviderRecentRequests(snapshot.recentRequestIndex, slice.provider),
    ...Object.fromEntries(Object.entries(slice.recentRequestIndex).map(([key, entry]) => [key, {
      ...entry,
      aggregate: cloneAggregate(entry.aggregate),
    }])),
  };
  next.hourlyActivity = {
    ...withoutProviderAggregateRows(snapshot.hourlyActivity, slice.provider, 1),
    ...cloneAggregateRecord(slice.hourlyActivity),
  };
  next.dailyModel = {
    ...withoutProviderAggregateRows(snapshot.dailyModel, slice.provider, 1),
    ...cloneAggregateRecord(slice.dailyModel),
  };
  next.monthlyModel = {
    ...withoutProviderAggregateRows(snapshot.monthlyModel, slice.provider, 1),
    ...cloneAggregateRecord(slice.monthlyModel),
  };
  next.sourceCheckpoints = {
    ...withoutProviderCheckpoints(snapshot.sourceCheckpoints, slice.provider),
    ...Object.fromEntries(Object.entries(slice.sourceCheckpoints).map(([key, checkpoint]) => [key, { ...checkpoint }])),
  };
  next.sourceRepairRollup = {
    ...withoutProviderAggregateRows(snapshot.sourceRepairRollup, slice.provider, 2),
    ...cloneAggregateRecord(slice.sourceRepairRollup),
  };
  next.lastCompactedAt = snapshot.lastCompactedAt;
  if (slice.provider === 'antigravity') {
    next.sourceCheckpoints[Object.keys(slice.sourceCheckpoints)[0] ?? 'antigravity-cache'] ??= {
      provider: 'antigravity',
      sourceHash: 'antigravity-cache',
      sourceKey: 'antigravity:usage-cache',
      lastImportedAt: nowMs,
      hasUsage: Object.keys(slice.dailyModel).length > 0 || Object.keys(slice.monthlyModel).length > 0,
    };
  }
  return next;
}
```

- [ ] **Step 4: Run provider-slice tests**

Run:

```powershell
npm.cmd run build:main
node --test scripts/usage-ledger-generic-ingest.test.mjs
```

Expected: all tests in `usage-ledger-generic-ingest.test.mjs` pass.

- [ ] **Step 5: Commit**

```powershell
git add src/main/usageLedgerIngest.ts scripts/usage-ledger-generic-ingest.test.mjs
git commit -m "Add provider slice ledger replacement"
```

## Task 4: Add Antigravity Usage Cache Store

**Files:**
- Create: `src/main/providers/antigravity/usageCacheStore.ts`
- Modify: `src/main/providers/antigravity/summary.ts`
- Create: `scripts/antigravity-usage-cache-store.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Export Antigravity entry conversion**

In `src/main/providers/antigravity/summary.ts`, rename `entryFromCall` to an exported function:

```ts
export function antigravityUsageEntryFromCall(call: AntigravityUsageCall): AntigravityRecentEntry {
  return {
    requestId: antigravityCallRequestId(call),
    timestampMs: call.timestampMs,
    model: call.model,
    provider: 'antigravity',
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    cacheCreationTokens: call.cacheCreationTokens,
    cacheReadTokens: call.cacheReadTokens,
    costUSD: estimateAntigravityCostUSD(call),
    cacheSavingsUSD: estimateAntigravityCacheSavingsUSD(call),
  };
}
```

Update `buildAntigravitySummary()`:

```ts
const entries = params.calls.map(antigravityUsageEntryFromCall);
```

- [ ] **Step 2: Add failing cache store tests**

Create `scripts/antigravity-usage-cache-store.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import storeModule from '../dist/main/providers/antigravity/usageCacheStore.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { AntigravityUsageCacheStore, emptyAntigravityUsageCacheSnapshot } = storeModule;
const { dayModelKey, monthModelKey } = aggregates;

function memoryStore(initial) {
  let value = initial;
  return {
    get(key) {
      assert.equal(key, 'cache');
      return value;
    },
    set(key, next) {
      assert.equal(key, 'cache');
      value = next;
    },
  };
}

function call(overrides = {}) {
  return {
    cascadeId: 'cascade-1',
    executionId: 'exec-1',
    stepIndices: [1],
    timestampMs: Date.parse('2026-06-01T10:00:00.000Z'),
    model: 'Gemini 3 Pro',
    rawModel: 'MODEL_GEMINI_3_PRO',
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationTokens: 5,
    cacheReadTokens: 50,
    thinkingTokens: 10,
    responseTokens: 10,
    toolNames: ['read_file'],
    ...overrides,
  };
}

test('Antigravity usage cache upserts calls and builds a provider ledger slice', () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const cache = new AntigravityUsageCacheStore(memoryStore(emptyAntigravityUsageCacheSnapshot()));

  cache.upsertCascade({
    cascadeId: 'cascade-1',
    title: 'Work',
    totalSteps: 4,
    status: 'CASCADE_RUN_STATUS_IDLE',
    lastModifiedMs: nowMs,
    fetchedAtMs: nowMs,
    calls: [call()],
  }, nowMs);

  const snapshot = cache.getSnapshot();
  const slice = cache.buildLedgerSlice(nowMs);

  assert.equal(Object.keys(snapshot.cascades).length, 1);
  assert.equal(Object.keys(snapshot.cascades['cascade-1'].calls).length, 1);
  assert.equal(slice.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].totalTokens, 175);
  assert.equal(slice.monthlyModel[monthModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].requestCount, 1);
});

test('Antigravity usage cache replaces a richer version of the same call', () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const cache = new AntigravityUsageCacheStore(memoryStore(emptyAntigravityUsageCacheSnapshot()));
  const base = call();
  const richer = call({ inputTokens: 200, outputTokens: 30 });

  cache.upsertCascade({
    cascadeId: 'cascade-1',
    title: 'Work',
    totalSteps: 4,
    status: 'CASCADE_RUN_STATUS_RUNNING',
    lastModifiedMs: nowMs,
    fetchedAtMs: nowMs,
    calls: [base],
  }, nowMs);
  cache.upsertCascade({
    cascadeId: 'cascade-1',
    title: 'Work',
    totalSteps: 4,
    status: 'CASCADE_RUN_STATUS_IDLE',
    lastModifiedMs: nowMs,
    fetchedAtMs: nowMs + 1000,
    calls: [richer],
  }, nowMs + 1000);

  const slice = cache.buildLedgerSlice(nowMs + 1000);
  assert.equal(slice.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].requestCount, 1);
  assert.equal(slice.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].inputTokens, 200);
  assert.equal(slice.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')].outputTokens, 30);
});

test('Antigravity usage cache normalizes invalid persisted shapes', () => {
  const cache = new AntigravityUsageCacheStore(memoryStore({ schemaVersion: 999, cascades: { broken: true } }));
  assert.deepEqual(cache.getSnapshot(), emptyAntigravityUsageCacheSnapshot());
});
```

- [ ] **Step 3: Add test to `package.json`**

In the `test` script, insert:

```text
scripts/antigravity-usage-cache-store.test.mjs
```

after `scripts/antigravity-gm-parser.test.mjs`.

- [ ] **Step 4: Run cache store test and verify failure**

Run:

```powershell
npm.cmd run build:main
node --test scripts/antigravity-usage-cache-store.test.mjs
```

Expected: fails because `usageCacheStore.js` does not exist.

- [ ] **Step 5: Implement `usageCacheStore.ts`**

Create `src/main/providers/antigravity/usageCacheStore.ts`:

```ts
import Store from 'electron-store';
import type { UsageAggregate } from '../../usageLedgerTypes';
import {
  aggregateFromUsageEntry,
  type UsageLedgerProviderSlice,
} from '../../usageLedgerIngest';
import {
  addUsageAggregate,
  dayModelKey,
  emptyUsageAggregate,
  hourProviderKey,
  minuteKey,
  monthModelKey,
} from '../../usageLedgerAggregates';
import { sourceHashForIdentity } from '../../usageLedgerImporter';
import type { AntigravityUsageCall } from './gmParser';
import {
  antigravityCallFingerprint,
  antigravityCallRequestId,
} from './gmParser';
import { antigravityUsageEntryFromCall } from './summary';

const ANTIGRAVITY_USAGE_CACHE_SCHEMA_VERSION = 1;
const ANTIGRAVITY_USAGE_CACHE_SOURCE_KEY = 'antigravity:usage-cache';
const ANTIGRAVITY_USAGE_CACHE_SOURCE_HASH = sourceHashForIdentity(ANTIGRAVITY_USAGE_CACHE_SOURCE_KEY);
const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_CALL_RETENTION_MS = 395 * DAY_MS;
const MINUTE_RECENT_RETENTION_MS = 8 * DAY_MS;
const HOURLY_ACTIVITY_RETENTION_MS = 180 * DAY_MS;

export interface CachedAntigravityCall extends AntigravityUsageCall {
  requestId: string;
  fingerprint: string;
  firstSeenMs: number;
  lastSeenMs: number;
}

export interface CachedAntigravityCascade {
  cascadeId: string;
  title: string;
  totalSteps: number;
  status: string;
  lastModifiedMs: number;
  lastFetchedAtMs: number;
  calls: Record<string, CachedAntigravityCall>;
}

export interface AntigravityUsageCacheSnapshot {
  schemaVersion: number;
  cascades: Record<string, CachedAntigravityCascade>;
  lastCompactedAt: number;
}

export interface AntigravityCascadeUpdate {
  cascadeId: string;
  title: string;
  totalSteps: number;
  status: string;
  lastModifiedMs: number;
  fetchedAtMs: number;
  calls: AntigravityUsageCall[];
}

interface StoreLike {
  get(key: 'cache'): AntigravityUsageCacheSnapshot | undefined;
  set(key: 'cache', value: AntigravityUsageCacheSnapshot): void;
}

export function emptyAntigravityUsageCacheSnapshot(): AntigravityUsageCacheSnapshot {
  return {
    schemaVersion: ANTIGRAVITY_USAGE_CACHE_SCHEMA_VERSION,
    cascades: {},
    lastCompactedAt: 0,
  };
}

function objectRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, T>
    : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeCall(value: unknown): CachedAntigravityCall | null {
  const raw = objectRecord<unknown>(value);
  const cascadeId = stringValue(raw.cascadeId);
  const executionId = stringValue(raw.executionId);
  const timestampMs = finiteNumber(raw.timestampMs);
  const firstSeenMs = finiteNumber(raw.firstSeenMs);
  const lastSeenMs = finiteNumber(raw.lastSeenMs);
  if (!cascadeId || timestampMs == null || firstSeenMs == null || lastSeenMs == null) return null;
  const stepIndices = Array.isArray(raw.stepIndices)
    ? raw.stepIndices.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : [];
  return {
    cascadeId,
    executionId,
    stepIndices,
    timestampMs,
    model: stringValue(raw.model) || 'antigravity',
    rawModel: stringValue(raw.rawModel) || stringValue(raw.model) || 'antigravity',
    inputTokens: Math.max(0, Math.round(finiteNumber(raw.inputTokens) ?? 0)),
    outputTokens: Math.max(0, Math.round(finiteNumber(raw.outputTokens) ?? 0)),
    cacheCreationTokens: Math.max(0, Math.round(finiteNumber(raw.cacheCreationTokens) ?? 0)),
    cacheReadTokens: Math.max(0, Math.round(finiteNumber(raw.cacheReadTokens) ?? 0)),
    thinkingTokens: Math.max(0, Math.round(finiteNumber(raw.thinkingTokens) ?? 0)),
    responseTokens: Math.max(0, Math.round(finiteNumber(raw.responseTokens) ?? 0)),
    toolNames: Array.isArray(raw.toolNames) ? raw.toolNames.filter((item): item is string => typeof item === 'string') : [],
    ...(finiteNumber(raw.contextMax) == null ? {} : { contextMax: finiteNumber(raw.contextMax) as number }),
    requestId: stringValue(raw.requestId),
    fingerprint: stringValue(raw.fingerprint),
    firstSeenMs,
    lastSeenMs,
  };
}

function normalizeSnapshot(value: unknown): AntigravityUsageCacheSnapshot {
  const raw = objectRecord<unknown>(value);
  if (raw.schemaVersion !== ANTIGRAVITY_USAGE_CACHE_SCHEMA_VERSION) return emptyAntigravityUsageCacheSnapshot();
  const cascades: Record<string, CachedAntigravityCascade> = {};
  for (const [cascadeId, rawCascade] of Object.entries(objectRecord<unknown>(raw.cascades))) {
    const cascade = objectRecord<unknown>(rawCascade);
    const calls: Record<string, CachedAntigravityCall> = {};
    for (const [requestId, rawCall] of Object.entries(objectRecord<unknown>(cascade.calls))) {
      const call = normalizeCall(rawCall);
      if (call) calls[requestId] = { ...call, requestId: call.requestId || requestId };
    }
    cascades[cascadeId] = {
      cascadeId,
      title: stringValue(cascade.title),
      totalSteps: Math.max(0, Math.round(finiteNumber(cascade.totalSteps) ?? 0)),
      status: stringValue(cascade.status),
      lastModifiedMs: finiteNumber(cascade.lastModifiedMs) ?? 0,
      lastFetchedAtMs: finiteNumber(cascade.lastFetchedAtMs) ?? 0,
      calls,
    };
  }
  return {
    schemaVersion: ANTIGRAVITY_USAGE_CACHE_SCHEMA_VERSION,
    cascades,
    lastCompactedAt: finiteNumber(raw.lastCompactedAt) ?? 0,
  };
}

function addToRecord(record: Record<string, UsageAggregate>, key: string, aggregate: UsageAggregate): void {
  const current = record[key] ?? emptyUsageAggregate();
  addUsageAggregate(current, aggregate);
  record[key] = current;
}

export class AntigravityUsageCacheStore {
  private readonly store: StoreLike;

  constructor(store?: StoreLike) {
    this.store = store ?? new Store<{ cache: AntigravityUsageCacheSnapshot }>({
      name: 'antigravity-usage-cache',
      defaults: { cache: emptyAntigravityUsageCacheSnapshot() },
    }) as unknown as StoreLike;
  }

  getSnapshot(): AntigravityUsageCacheSnapshot {
    return normalizeSnapshot(this.store.get('cache'));
  }

  replaceSnapshot(snapshot: AntigravityUsageCacheSnapshot): void {
    this.store.set('cache', normalizeSnapshot(snapshot));
  }

  upsertCascade(update: AntigravityCascadeUpdate, nowMs = Date.now()): AntigravityUsageCacheSnapshot {
    const snapshot = this.getSnapshot();
    const current = snapshot.cascades[update.cascadeId];
    const calls = { ...(current?.calls ?? {}) };
    for (const call of update.calls) {
      const requestId = antigravityCallRequestId(call);
      const existing = calls[requestId];
      calls[requestId] = {
        ...call,
        requestId,
        fingerprint: antigravityCallFingerprint(call),
        firstSeenMs: existing?.firstSeenMs ?? nowMs,
        lastSeenMs: nowMs,
      };
    }
    snapshot.cascades[update.cascadeId] = {
      cascadeId: update.cascadeId,
      title: update.title,
      totalSteps: update.totalSteps,
      status: update.status,
      lastModifiedMs: update.lastModifiedMs,
      lastFetchedAtMs: update.fetchedAtMs,
      calls,
    };
    this.replaceSnapshot(snapshot);
    return snapshot;
  }

  compact(nowMs = Date.now()): AntigravityUsageCacheSnapshot {
    const snapshot = this.getSnapshot();
    const cutoff = nowMs - RAW_CALL_RETENTION_MS;
    for (const cascade of Object.values(snapshot.cascades)) {
      cascade.calls = Object.fromEntries(
        Object.entries(cascade.calls).filter(([, call]) => call.timestampMs >= cutoff),
      );
    }
    snapshot.lastCompactedAt = nowMs;
    this.replaceSnapshot(snapshot);
    return snapshot;
  }

  listCascades(): CachedAntigravityCascade[] {
    return Object.values(this.getSnapshot().cascades)
      .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  }

  buildLedgerSlice(nowMs = Date.now()): UsageLedgerProviderSlice {
    const minuteRecent: Record<string, UsageAggregate> = {};
    const recentRequestIndex: UsageLedgerProviderSlice['recentRequestIndex'] = {};
    const hourlyActivity: Record<string, UsageAggregate> = {};
    const dailyModel: Record<string, UsageAggregate> = {};
    const monthlyModel: Record<string, UsageAggregate> = {};
    const sourceRepairRollup: Record<string, UsageAggregate> = {};
    const minuteCutoff = nowMs - MINUTE_RECENT_RETENTION_MS;
    const hourCutoff = nowMs - HOURLY_ACTIVITY_RETENTION_MS;

    for (const cascade of this.listCascades()) {
      for (const call of Object.values(cascade.calls)) {
        const entry = antigravityUsageEntryFromCall(call);
        const aggregate = aggregateFromUsageEntry(entry);
        if (entry.timestampMs >= minuteCutoff) {
          const key = minuteKey(entry.timestampMs, 'antigravity', entry.model);
          addToRecord(minuteRecent, key, aggregate);
          recentRequestIndex[`${ANTIGRAVITY_USAGE_CACHE_SOURCE_HASH}|${entry.requestId}`] = {
            minuteKey: key,
            aggregate,
            lastSeenMs: nowMs,
          };
        }
        if (entry.timestampMs >= hourCutoff) {
          addToRecord(hourlyActivity, hourProviderKey(entry.timestampMs, 'antigravity'), aggregate);
        }
        addToRecord(dailyModel, dayModelKey(entry.timestampMs, 'antigravity', entry.model), aggregate);
        addToRecord(monthlyModel, monthModelKey(entry.timestampMs, 'antigravity', entry.model), aggregate);
      }
    }

    return {
      provider: 'antigravity',
      minuteRecent,
      recentRequestIndex,
      hourlyActivity,
      dailyModel,
      monthlyModel,
      sourceCheckpoints: {
        [ANTIGRAVITY_USAGE_CACHE_SOURCE_HASH]: {
          provider: 'antigravity',
          sourceHash: ANTIGRAVITY_USAGE_CACHE_SOURCE_HASH,
          sourceKey: ANTIGRAVITY_USAGE_CACHE_SOURCE_KEY,
          lastImportedAt: nowMs,
          hasUsage: Object.keys(dailyModel).length > 0 || Object.keys(monthlyModel).length > 0,
        },
      },
      sourceRepairRollup,
    };
  }
}
```

- [ ] **Step 6: Run cache store tests**

Run:

```powershell
npm.cmd run build:main
node --test scripts/antigravity-usage-cache-store.test.mjs
```

Expected: all tests in `antigravity-usage-cache-store.test.mjs` pass.

- [ ] **Step 7: Commit**

```powershell
git add package.json src/main/providers/antigravity/summary.ts src/main/providers/antigravity/usageCacheStore.ts scripts/antigravity-usage-cache-store.test.mjs
git commit -m "Persist Antigravity usage cache"
```

## Task 5: Add ACWM-Style GM Tracker

**Files:**
- Create: `src/main/providers/antigravity/gmTracker.ts`
- Create: `scripts/antigravity-gm-tracker.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add failing GM tracker tests**

Create `scripts/antigravity-gm-tracker.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import trackerModule from '../dist/main/providers/antigravity/gmTracker.js';
import cacheModule from '../dist/main/providers/antigravity/usageCacheStore.js';

const { AntigravityGmTracker } = trackerModule;
const { AntigravityUsageCacheStore, emptyAntigravityUsageCacheSnapshot } = cacheModule;

function context(overrides = {}) {
  return {
    settings: { enabledProviders: ['antigravity'] },
    nowMs: Date.parse('2026-06-01T12:00:00.000Z'),
    jsonlCache: {},
    scanBudgetMs: null,
    prioritySourceIds: new Set(),
    includeFullHistory: false,
    force: false,
    ...overrides,
  };
}

function memoryStore(initial = emptyAntigravityUsageCacheSnapshot()) {
  let value = initial;
  return {
    get(key) {
      assert.equal(key, 'cache');
      return value;
    },
    set(key, next) {
      assert.equal(key, 'cache');
      value = next;
    },
  };
}

async function withAntigravityServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run({ pid: 1, port: server.address().port, csrfToken: 'csrf' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function sendJson(res, payload) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendStatus(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function userStatus() {
  return {
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Gemini 3 Pro', modelOrAlias: { model: 'MODEL_GEMINI_3_PRO' } },
        ],
      },
    },
  };
}

function gmCall({ executionId = 'exec-1', input = 100, output = 20, cacheRead = 50, stepIndices = [1], responseModel = 'MODEL_GEMINI_3_PRO' } = {}) {
  return {
    executionId,
    stepIndices,
    chatModel: {
      responseModel,
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: 0,
      },
    },
  };
}

test('Antigravity GM tracker keeps cached IDLE cascades without refetching GM', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  let gmRequests = 0;
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) return sendJson(res, userStatus());
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      return sendJson(res, {
        trajectorySummaries: {
          c1: {
            summary: 'Idle work',
            lastModifiedTime: new Date(nowMs).toISOString(),
            stepCount: 2,
            status: 'CASCADE_RUN_STATUS_IDLE',
          },
        },
      });
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      gmRequests += 1;
      return sendJson(res, { generatorMetadata: [gmCall()] });
    }
    return sendJson(res, {});
  }, async serverInfo => {
    const cache = new AntigravityUsageCacheStore(memoryStore());
    const tracker = new AntigravityGmTracker(cache);
    await tracker.fetchAllFromServers(context({ nowMs }), [serverInfo], nowMs + 10_000);
    await tracker.fetchAllFromServers(context({ nowMs: nowMs + 1000 }), [serverInfo], nowMs + 11_000);

    assert.equal(gmRequests, 1);
    assert.equal(Object.keys(cache.getSnapshot().cascades.c1.calls).length, 1);
  });
});

test('Antigravity GM tracker refetches when RUNNING becomes IDLE', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  let round = 0;
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) return sendJson(res, userStatus());
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      round += 1;
      return sendJson(res, {
        trajectorySummaries: {
          c1: {
            summary: 'Run then idle',
            lastModifiedTime: new Date(nowMs + round).toISOString(),
            stepCount: 2,
            status: round === 1 ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
          },
        },
      });
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      return sendJson(res, {
        generatorMetadata: [
          round === 1
            ? gmCall({ executionId: 'exec-1', input: 100, output: 20, stepIndices: [1] })
            : gmCall({ executionId: 'exec-2', input: 200, output: 30, stepIndices: [2] }),
        ],
      });
    }
    return sendJson(res, {});
  }, async serverInfo => {
    const cache = new AntigravityUsageCacheStore(memoryStore());
    const tracker = new AntigravityGmTracker(cache);
    await tracker.fetchAllFromServers(context({ nowMs }), [serverInfo], nowMs + 10_000);
    await tracker.fetchAllFromServers(context({ nowMs: nowMs + 1000 }), [serverInfo], nowMs + 11_000);

    assert.equal(Object.keys(cache.getSnapshot().cascades.c1.calls).length, 2);
  });
});

test('Antigravity GM tracker enriches lightweight metadata from full trajectory', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) return sendJson(res, userStatus());
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      return sendJson(res, {
        trajectorySummaries: {
          c1: {
            summary: 'Enriched',
            lastModifiedTime: new Date(nowMs).toISOString(),
            stepCount: 350,
            status: 'CASCADE_RUN_STATUS_RUNNING',
          },
        },
      });
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      return sendJson(res, { generatorMetadata: [gmCall({ input: 10, output: 1, cacheRead: 0 })] });
    }
    if (req.url.endsWith('/GetCascadeTrajectory')) {
      return sendJson(res, {
        trajectory: {
          generatorMetadata: [gmCall({ input: 100, output: 20, cacheRead: 50 })],
        },
      });
    }
    return sendJson(res, {});
  }, async serverInfo => {
    const cache = new AntigravityUsageCacheStore(memoryStore());
    const tracker = new AntigravityGmTracker(cache);
    await tracker.fetchAllFromServers(context({ nowMs }), [serverInfo], nowMs + 10_000);
    const call = Object.values(cache.getSnapshot().cascades.c1.calls)[0];

    assert.equal(call.inputTokens, 100);
    assert.equal(call.outputTokens, 20);
    assert.equal(call.cacheReadTokens, 50);
  });
});

test('Antigravity GM tracker keeps stale cache when a later GM RPC fails', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  let failGm = false;
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) return sendJson(res, userStatus());
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      return sendJson(res, {
        trajectorySummaries: {
          c1: {
            summary: 'Failure keeps cache',
            lastModifiedTime: new Date(nowMs).toISOString(),
            stepCount: 2,
            status: 'CASCADE_RUN_STATUS_RUNNING',
          },
        },
      });
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      if (failGm) return sendStatus(res, 500, { error: 'temporary failure' });
      return sendJson(res, { generatorMetadata: [gmCall()] });
    }
    return sendJson(res, {});
  }, async serverInfo => {
    const cache = new AntigravityUsageCacheStore(memoryStore());
    const tracker = new AntigravityGmTracker(cache);
    await tracker.fetchAllFromServers(context({ nowMs }), [serverInfo], nowMs + 10_000);
    failGm = true;
    const result = await tracker.fetchAllFromServers(context({ nowMs: nowMs + 1000 }), [serverInfo], nowMs + 11_000);

    assert.equal(result.partial, true);
    assert.equal(Object.keys(cache.getSnapshot().cascades.c1.calls).length, 1);
  });
});
```

Expected failure before implementation: module-not-found for `gmTracker.js`.

- [ ] **Step 2: Add test to `package.json`**

In the `test` script, insert:

```text
scripts/antigravity-gm-tracker.test.mjs
```

after `scripts/antigravity-usage-cache-store.test.mjs`.

- [ ] **Step 3: Implement `gmTracker.ts`**

Create `src/main/providers/antigravity/gmTracker.ts`:

```ts
import type { ProviderContext } from '../types';
import { AntigravityLsClient } from './lsClient';
import { buildModelLabelMap } from './models';
import { parseTimestampMs } from './pathUtils';
import { getTrajectorySummariesCached, getUserStatusCached } from './runtimeCache';
import {
  mergeAntigravityCalls,
  parseAntigravityGmEntries,
  shouldEnrichForTokens,
} from './gmParser';
import type { AntigravityServerInfo, AntigravityTrajectorySummary } from './types';
import { AntigravityUsageCacheStore } from './usageCacheStore';

const DEFAULT_SCAN_LIMIT = 48;
const FULL_SCAN_LIMIT = 200;

interface TrackerCascade {
  cascadeId: string;
  title: string;
  lastModifiedMs: number;
  stepCount: number;
  status: string;
}

export interface AntigravityGmTrackerResult {
  scannedSources: number;
  partial: boolean;
}

function remainingTimeoutMs(stopAt: number): number {
  return Math.max(1, Math.min(8_000, stopAt - Date.now()));
}

function cascadeStatus(summary: AntigravityTrajectorySummary): string {
  return String(summary.status ?? summary.runStatus ?? '');
}

function isRunningStatus(status: string): boolean {
  return status === 'CASCADE_RUN_STATUS_RUNNING' || status.toLowerCase().includes('running');
}

function sortedCascades(response: unknown, nowMs: number): TrackerCascade[] {
  const summaries = (response as { trajectorySummaries?: Record<string, AntigravityTrajectorySummary> } | null)?.trajectorySummaries ?? {};
  return Object.entries(summaries)
    .map(([cascadeId, summary]) => ({
      cascadeId,
      title: typeof summary.summary === 'string' ? summary.summary : '',
      lastModifiedMs: parseTimestampMs(summary.lastModifiedTime ?? summary.createdTime, nowMs),
      stepCount: typeof summary.stepCount === 'number' ? summary.stepCount : 0,
      status: cascadeStatus(summary),
    }))
    .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
}

export class AntigravityGmTracker {
  constructor(private readonly cacheStore = new AntigravityUsageCacheStore()) {}

  async fetchAllFromServers(
    ctx: ProviderContext,
    servers: AntigravityServerInfo[],
    stopAt: number,
  ): Promise<AntigravityGmTrackerResult> {
    const scanLimit = ctx.includeFullHistory ? FULL_SCAN_LIMIT : DEFAULT_SCAN_LIMIT;
    const pastDeadline = () => Date.now() >= stopAt;
    let scannedSources = 0;
    let partial = false;
    const seenCascadeIds = new Set<string>();

    for (const server of servers) {
      if (pastDeadline()) {
        partial = true;
        break;
      }
      const status = await getUserStatusCached(server, ctx.nowMs, remainingTimeoutMs(stopAt)).catch(() => null);
      const labelMap = buildModelLabelMap(status?.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? []);
      const trajectorySummaries = await getTrajectorySummariesCached(server, ctx.nowMs, remainingTimeoutMs(stopAt));
      if (!trajectorySummaries) {
        partial = true;
        continue;
      }

      const cascades = sortedCascades(trajectorySummaries, ctx.nowMs);
      if (cascades.length > scanLimit) partial = true;
      for (const cascade of cascades.slice(0, scanLimit)) {
        if (seenCascadeIds.has(cascade.cascadeId)) continue;
        seenCascadeIds.add(cascade.cascadeId);
        if (cascade.stepCount === 0) continue;
        if (pastDeadline()) {
          partial = true;
          break;
        }

        const cached = this.cacheStore.getSnapshot().cascades[cascade.cascadeId];
        const wasRunning = cached ? isRunningStatus(cached.status) : false;
        const isRunning = isRunningStatus(cascade.status);
        const justBecameIdle = wasRunning && !isRunning;
        const hasCachedCalls = cached && Object.keys(cached.calls).length > 0;
        if (hasCachedCalls && !isRunning && !justBecameIdle && cached.totalSteps === cascade.stepCount) {
          continue;
        }

        scannedSources += 1;
        const client = new AntigravityLsClient(server);
        let rawGm: Record<string, unknown>[] = [];
        try {
          const lightweight = await client.getCascadeTrajectoryGeneratorMetadata(cascade.cascadeId, remainingTimeoutMs(stopAt));
          rawGm = lightweight.generatorMetadata ?? [];
        } catch {
          partial = true;
          continue;
        }

        let calls = parseAntigravityGmEntries(cascade.cascadeId, rawGm, cascade.lastModifiedMs, labelMap);
        if (shouldEnrichForTokens({ stepCount: cascade.stepCount, rawGm, calls }) && !pastDeadline()) {
          try {
            const full = await client.getCascadeTrajectory(cascade.cascadeId, remainingTimeoutMs(stopAt));
            const embeddedCalls = parseAntigravityGmEntries(
              cascade.cascadeId,
              full.trajectory?.generatorMetadata ?? [],
              cascade.lastModifiedMs,
              labelMap,
            );
            calls = mergeAntigravityCalls(calls, embeddedCalls);
          } catch {
            partial = true;
          }
        }

        if (calls.length > 0) {
          this.cacheStore.upsertCascade({
            cascadeId: cascade.cascadeId,
            title: cascade.title,
            totalSteps: cascade.stepCount,
            status: cascade.status,
            lastModifiedMs: cascade.lastModifiedMs,
            fetchedAtMs: ctx.nowMs,
            calls,
          }, ctx.nowMs);
        }
      }
    }

    this.cacheStore.compact(ctx.nowMs);
    return { scannedSources, partial };
  }
}
```

- [ ] **Step 4: Run GM tracker tests**

Run:

```powershell
npm.cmd run build:main
node --test scripts/antigravity-gm-tracker.test.mjs
```

Expected: all GM tracker tests pass.

- [ ] **Step 5: Commit**

```powershell
git add package.json src/main/providers/antigravity/gmTracker.ts scripts/antigravity-gm-tracker.test.mjs
git commit -m "Track Antigravity GM data incrementally"
```

## Task 6: Rewire Antigravity Usage Scan to Cache

**Files:**
- Modify: `src/main/providers/antigravity/usage.ts`
- Modify: `scripts/antigravity-provider-integration.test.mjs`

- [ ] **Step 1: Add integration test for cached historical visibility**

First update the imports in `scripts/antigravity-provider-integration.test.mjs`:

```js
import {
  AntigravityUsageCacheStore,
  emptyAntigravityUsageCacheSnapshot,
} from '../dist/main/providers/antigravity/usageCacheStore.js';
```

Then add this helper near `context()`:

```js
function memoryAntigravityCacheStore() {
  let value = emptyAntigravityUsageCacheSnapshot();
  return new AntigravityUsageCacheStore({
    get(key) {
      assert.equal(key, 'cache');
      return value;
    },
    set(key, next) {
      assert.equal(key, 'cache');
      value = next;
    },
  });
}
```

Add this test to `scripts/antigravity-provider-integration.test.mjs`:

```js
test('Antigravity usage scan returns summaries from persisted cache when current RPC omits old cascades', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  let includeCascade = true;
  const cacheStore = memoryAntigravityCacheStore();
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, { userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini 3 Pro', modelOrAlias: { model: 'MODEL_GEMINI_3_PRO' } }] } } });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendJson(res, {
        trajectorySummaries: includeCascade ? {
          cached: {
            summary: 'Cached work',
            lastModifiedTime: new Date(nowMs).toISOString(),
            stepCount: 2,
            status: 'CASCADE_RUN_STATUS_IDLE',
          },
        } : {},
      });
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      sendJson(res, {
        generatorMetadata: [
          {
            executionId: 'exec-cached',
            stepIndices: [1],
            chatModel: {
              responseModel: 'MODEL_GEMINI_3_PRO',
              usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 },
            },
          },
        ],
      });
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const first = await scanAntigravityUsageFromServers(context({ nowMs }), [serverInfo], nowMs + 10_000, cacheStore);
    includeCascade = false;
    const second = await scanAntigravityUsageFromServers(context({ nowMs: nowMs + 60_000 }), [serverInfo], nowMs + 70_000, cacheStore);

    assert.equal(first.summaries.has('antigravity:cascade:cached'), true);
    assert.equal(second.summaries.has('antigravity:cascade:cached'), true);
    assert.equal(second.ledgerSources.length, 1);
  });
});
```

- [ ] **Step 2: Add integration test for idempotent ledger replacement**

Add this test to `scripts/antigravity-provider-integration.test.mjs`:

```js
test('Antigravity cache ledger source is idempotent across repeated scans', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const cacheStore = memoryAntigravityCacheStore();
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, { userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini 3 Pro', modelOrAlias: { model: 'MODEL_GEMINI_3_PRO' } }] } } });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendJson(res, {
        trajectorySummaries: {
          stable: {
            lastModifiedTime: new Date(nowMs).toISOString(),
            stepCount: 2,
            status: 'CASCADE_RUN_STATUS_RUNNING',
          },
        },
      });
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      sendJson(res, {
        generatorMetadata: [
          {
            executionId: 'exec-stable',
            stepIndices: [1],
            chatModel: {
              responseModel: 'MODEL_GEMINI_3_PRO',
              usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 },
            },
          },
        ],
      });
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const first = await scanAntigravityUsageFromServers(context({ nowMs }), [serverInfo], nowMs + 10_000, cacheStore);
    const afterFirst = await first.ledgerSources[0].importIntoSnapshot(emptyUsageLedgerSnapshot(), nowMs);
    const second = await scanAntigravityUsageFromServers(context({ nowMs: nowMs + 1000 }), [serverInfo], nowMs + 11_000, cacheStore);
    const afterSecond = await second.ledgerSources[0].importIntoSnapshot(afterFirst, nowMs + 1000);
    const row = afterSecond.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')];

    assert.equal(row.requestCount, 1);
    assert.equal(row.totalTokens, 170);
  });
});
```

- [ ] **Step 3: Run integration test and verify failure**

Run:

```powershell
npm.cmd run build:main
node --test scripts/antigravity-provider-integration.test.mjs
```

Expected: cached historical visibility fails because `usage.ts` only returns current scan data.

- [ ] **Step 4: Rewire `usage.ts`**

Replace direct GM fetching in `src/main/providers/antigravity/usage.ts` with:

```ts
import type {
  ProviderContext,
  ProviderLedgerSource,
  ProviderUsageScanResult,
} from '../types';
import { replaceProviderUsageSliceInSnapshot } from '../../usageLedgerIngest';
import { buildAntigravitySummary } from './summary';
import { findAntigravityServersCached } from './runtimeCache';
import { AntigravityGmTracker } from './gmTracker';
import { AntigravityUsageCacheStore } from './usageCacheStore';
import type { AntigravityServerInfo } from './types';

const DEFAULT_DEADLINE_MS = 8_000;

function deadlineMs(ctx: ProviderContext): number {
  return Date.now() + Math.min(ctx.scanBudgetMs ?? DEFAULT_DEADLINE_MS, DEFAULT_DEADLINE_MS);
}

function remainingTimeoutMs(stopAt: number): number {
  return Math.max(1, Math.min(8_000, stopAt - Date.now()));
}

function buildCacheLedgerSource(cacheStore: AntigravityUsageCacheStore): ProviderLedgerSource {
  const sourceId = 'antigravity:usage-cache';
  return {
    provider: 'antigravity',
    sourceId,
    priority: false,
    importIntoSnapshot: async (snapshot, nowMs) =>
      replaceProviderUsageSliceInSnapshot(snapshot, cacheStore.buildLedgerSlice(nowMs), nowMs),
  };
}

function summariesFromCache(cacheStore: AntigravityUsageCacheStore, nowMs: number): Map<string, ReturnType<typeof buildAntigravitySummary>> {
  const summaries = new Map();
  for (const cascade of cacheStore.listCascades()) {
    const calls = Object.values(cascade.calls).sort((a, b) => a.timestampMs - b.timestampMs);
    if (calls.length === 0) continue;
    summaries.set(`antigravity:cascade:${cascade.cascadeId}`, buildAntigravitySummary({
      cascadeId: cascade.cascadeId,
      calls,
      nowMs,
      lastModifiedMs: cascade.lastModifiedMs,
    }));
  }
  return summaries;
}

export async function scanAntigravityUsageFromServers(
  ctx: ProviderContext,
  servers: AntigravityServerInfo[],
  stopAt = deadlineMs(ctx),
  cacheStore = new AntigravityUsageCacheStore(),
): Promise<ProviderUsageScanResult> {
  const tracker = new AntigravityGmTracker(cacheStore);
  const result = await tracker.fetchAllFromServers(ctx, servers, stopAt);
  const summaries = summariesFromCache(cacheStore, ctx.nowMs);
  const ledgerSources = summaries.size > 0 ? [buildCacheLedgerSource(cacheStore)] : [];
  return {
    summaries,
    ledgerSources,
    scannedSources: result.scannedSources,
    partial: result.partial,
  };
}

export async function scanAntigravityUsage(ctx: ProviderContext): Promise<ProviderUsageScanResult> {
  const stopAt = deadlineMs(ctx);
  const servers = await findAntigravityServersCached(ctx.nowMs, remainingTimeoutMs(stopAt));
  return scanAntigravityUsageFromServers(ctx, servers, stopAt);
}
```

Then remove unused `aggregateFromUsageEntry`, `importUsageEntriesIntoSnapshot`, `AntigravityLsClient`, `buildModelLabelMap`, pricing imports, and parser imports from `usage.ts`.

- [ ] **Step 5: Remove now-obsolete scan limit assertions**

In `scripts/antigravity-provider-integration.test.mjs`, replace scan limit expectations tied to direct one-shot scan with tracker/cache expectations:

```js
assert.equal(usage.partial, true);
assert.ok(usage.scannedSources <= 48);
```

for normal scans, and:

```js
assert.ok(usage.scannedSources <= 200);
```

for full-history scans.

- [ ] **Step 6: Run integration tests**

Run:

```powershell
npm.cmd run build:main
node --test scripts/antigravity-provider-integration.test.mjs scripts/antigravity-gm-tracker.test.mjs scripts/antigravity-usage-cache-store.test.mjs
```

Expected: all listed tests pass.

- [ ] **Step 7: Commit**

```powershell
git add src/main/providers/antigravity/usage.ts scripts/antigravity-provider-integration.test.mjs
git commit -m "Use Antigravity usage cache for ledger import"
```

## Task 7: Verify Usage Windows, Trend, and Stats Use Cached Antigravity Data

**Files:**
- Modify: `scripts/antigravity-provider-integration.test.mjs`
- Modify: `scripts/usage-ledger-usage.test.mjs`

- [ ] **Step 1: Add usage-window test for Antigravity cached model stats**

Update imports at the top of `scripts/usage-ledger-usage.test.mjs`:

```js
import ingestModule from '../dist/main/usageLedgerIngest.js';

const { replaceProviderUsageSliceInSnapshot } = ingestModule;
const { emptyUsageLedgerSnapshot, dayModelKey, hourProviderKey, minuteKey, monthModelKey } = aggregates;
```

Then append:

```js
test('ledger usage query exposes cached Antigravity model window stats', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const callTs = now - 60_000;
  const snapshot = emptyUsageLedgerSnapshot();
  const aggregate = agg(170, 0.12, 1, {
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 50,
    totalTokens: 170,
    cacheSavingsUSD: 0.05,
  });
  snapshot.minuteRecent[minuteKey(callTs, 'antigravity', 'Gemini 3 Pro')] = aggregate;
  snapshot.hourlyActivity[hourProviderKey(callTs, 'antigravity')] = aggregate;
  snapshot.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')] = aggregate;
  snapshot.monthlyModel[monthModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')] = aggregate;

  const providerQuotas = {
    antigravity: {
      provider: 'antigravity',
      source: 'localRpc',
      capturedAt: now,
      models: [
        {
          model: 'gemini-3-pro-high',
          label: 'Gemini 3 Pro (High)',
          usageModel: 'Gemini 3 Pro',
          statsWindowKey: 'model.gemini-3-pro-high',
          remainingPct: 80,
          resetMs: 4 * 60 * 60 * 1000,
          durationMs: 5 * 60 * 60 * 1000,
        },
      ],
    },
  };

  const usage = computeUsageFromLedger(snapshot, {}, now, undefined, providerQuotas);
  const modelWindow = usage.modelWindows.antigravity.windows['model.gemini-3-pro-high']['Gemini 3 Pro'];

  assert.equal(modelWindow.inputTokens, 100);
  assert.equal(modelWindow.outputTokens, 20);
  assert.equal(modelWindow.cacheReadTokens, 50);
  assert.equal(modelWindow.totalTokens, 170);
  assert.equal(modelWindow.costUSD, 0.12);
});
```

- [ ] **Step 2: Add trend idempotency test**

Append this test to `scripts/usage-ledger-usage.test.mjs`:

```js
test('ledger trend query remains idempotent after replacing the Antigravity provider slice twice', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const aggregate = agg(170, 0.12, 1, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    totalTokens: 170,
  });
  const slice = {
    provider: 'antigravity',
    minuteRecent: {},
    recentRequestIndex: {},
    hourlyActivity: {},
    dailyModel: {
      [dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')]: aggregate,
    },
    monthlyModel: {
      [monthModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')]: aggregate,
    },
    sourceCheckpoints: {
      'ag-cache-source': {
        provider: 'antigravity',
        sourceHash: 'ag-cache-source',
        sourceKey: 'antigravity:usage-cache',
        lastImportedAt: now,
        hasUsage: true,
      },
    },
    sourceRepairRollup: {},
  };

  const afterFirst = replaceProviderUsageSliceInSnapshot(emptyUsageLedgerSnapshot(), slice, now);
  const afterSecond = replaceProviderUsageSliceInSnapshot(afterFirst, slice, now);
  const trend = buildTrendDataFromLedger(afterSecond, now);

  assert.equal(trend.daily.at(-1).tokens, 170);
  assert.equal(trend.daily.at(-1).requestCount, 1);
});
```

- [ ] **Step 3: Run usage tests**

Run:

```powershell
npm.cmd run build:main
node --test scripts/usage-ledger-usage.test.mjs scripts/antigravity-provider-integration.test.mjs
```

Expected: usage windows, Trend, and provider integration tests pass.

- [ ] **Step 4: Commit**

```powershell
git add scripts/usage-ledger-usage.test.mjs scripts/antigravity-provider-integration.test.mjs
git commit -m "Cover cached Antigravity stats in usage windows"
```

## Task 8: Full Verification and Packaging

**Files:**
- No production file changes expected.

- [ ] **Step 1: Run full test suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass.

- [ ] **Step 2: Check formatting-sensitive whitespace**

Run:

```powershell
git diff --check
```

Expected: exit code `0`. CRLF warnings from Git are acceptable; whitespace errors are not.

- [ ] **Step 3: Build package**

Run:

```powershell
npm.cmd run dist
```

Expected: `release\WhereMyTokens Setup 1.16.1.exe` and `release\WhereMyTokens 1.16.1.exe` are produced. If `release\win-unpacked\WhereMyTokens.exe` is running and locks files, stop only that process and rerun `npm.cmd run dist`.

- [ ] **Step 4: Inspect final diff**

Run:

```powershell
git status --short --branch
git diff --stat
```

Expected:

- Modified/created files match this plan.
- No unrelated zip artifacts are staged.
- The old broad generic-provider long-budget experiment is absent.

- [ ] **Step 5: Commit final verification-only changes if any**

If Task 8 found only code/test changes already committed, do not create an empty commit. If small test or package-script fixes were needed, commit them:

```powershell
git add package.json scripts src/main
git commit -m "Finalize Antigravity usage cache integration"
```

## Self-Review

- Spec coverage: The plan addresses RPC volatility, earlier persistence, ACWM-style enrichment, persistent cache, idempotent ledger import, and stats/trend usage.
- Placeholder scan: The plan contains no open implementation placeholders; tests and code snippets specify concrete file paths, function names, commands, and expected results.
- Type consistency: New `UsageLedgerProviderSlice` is consumed by `AntigravityUsageCacheStore.buildLedgerSlice()` and imported by `usage.ts` through `replaceProviderUsageSliceInSnapshot()`. Parser helper names are defined before tracker and usage rewiring tasks reference them.
- Scope check: This plan only changes Antigravity usage collection and its ledger/stats path. Quota UI Rich/Simple layout, Settings display modes, and session visual design remain outside this implementation plan.
