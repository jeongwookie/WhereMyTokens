# Persistent Usage Ledger And Trend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent aggregate usage ledger, a Trend card, card hiding controls, and a lightweight Git daily output snapshot while preserving the current WhereMyTokens UI semantics.

**Architecture:** Start from the latest `upstream/main` in an isolated worktree. Keep JSONL as the import source, but make persisted aggregate ledger data the historical reporting source. Preserve current live/session behavior, store short-retention minute/source repair data for accuracy, and store long-retention hourly/daily/monthly aggregates for UI queries.

**Tech Stack:** Electron main process, TypeScript, React renderer, electron-store persistence, existing Node test runner, existing `jsonlParser`/`usageWindows`/`gitStatsCollector` patterns.

---

## Current Baseline

- Current local worktree: `D:\Git\wheremytokens`
- Current branch observed during planning: `codex-refresh-pipeline`
- Current upstream remote: `upstream https://github.com/jeongwookie/WhereMyTokens`
- `git fetch upstream main` was run before this plan; observed `upstream/main` at `e81e533`.
- Repository scan found `README*.md` and `RELEASE.md`, but no PRD file. No PRD update is required unless a PRD is added before implementation starts.
- Current `docs/` is untracked in this checkout. Do not delete or reset it.

## File Structure

Create focused main-process modules:

- `src/main/usageLedgerTypes.ts` - persisted schema, key formats, aggregate field interfaces, retention constants.
- `src/main/usageLedgerAggregates.ts` - pure aggregate helpers, key builders, add/subtract/compact functions.
- `src/main/usageLedgerStore.ts` - electron-store wrapper for the ledger snapshot and schema migration.
- `src/main/jsonlUsageExtractor.ts` - reusable JSONL usage extraction shared by summary scanning and ledger import.
- `src/main/usageLedgerImporter.ts` - source checkpoint handling, append import, source repair replacement, backfill orchestration helpers.
- `src/main/usageLedgerUsage.ts` - converts ledger snapshots into `UsageData` and Trend data.
- `src/main/gitOutputLedger.ts` - daily Git output snapshot persistence and query helpers.
- `src/renderer/components/TrendCard.tsx` - new Trend card UI.

Modify existing integration points:

- `src/main/jsonlParser.ts` - delegate line extraction to `jsonlUsageExtractor` while preserving current summary behavior.
- `src/main/stateManager.ts` - own ledger stores, import during refresh, compute historical usage from ledger when ready, build Trend data.
- `src/main/ipc.ts` and `src/renderer/types.ts` - add settings/state types in lockstep.
- `src/renderer/mainSections.ts` - add `trend` and hidden-section normalization.
- `src/renderer/views/MainView.tsx` - render Trend, pass state, hide configured sections.
- `src/renderer/views/SettingsView.tsx` - enhance main layout settings from ordering-only to ordering plus hide/show.
- `src/main/gitStatsCollector.ts` - feed `gitOutputLedger` after successful Git stats collection.
- `package.json` - add new test scripts to the existing `npm test` command.
- `README.md` and `README.zh-CN.md` - document persisted ledger behavior and what survives JSONL/cache cleanup.

## Data Model Decisions

Usage is persisted as aggregates, not long-term request detail.

Retention layers:

| Layer | Key | Retention |
|---|---|---:|
| `usage_minute_recent` | `minuteStartMs|provider|model` | 8 days |
| `usage_recent_request_index` | `sourceHash|requestId` | 8 days |
| `usage_hourly_activity` | `hourStartMs|provider` | 180 days |
| `usage_daily_model` | `YYYY-MM-DD|provider|model` | 365 days |
| `usage_monthly_model` | `YYYY-MM|provider|model` | forever |
| `source_checkpoints` | `sourceHash` | forever |
| `source_repair_rollup` | `sourceHash|hourStartMs|provider|model` | 30 days |

`usage_recent_request_index` is short-retention importer state, not a reporting table. It exists to preserve current Claude duplicate request semantics without keeping long-term request detail.

Each usage aggregate stores:

```ts
requestCount: number;
inputTokens: number;
outputTokens: number;
cacheCreationTokens: number;
cacheReadTokens: number;
totalTokens: number;
costUSD: number;
cacheSavingsUSD: number;
```

Git is persisted as daily snapshots:

| Layer | Key | Retention |
|---|---|---:|
| `git_daily_output` | `YYYY-MM-DD|repoKey` | forever |

Each Git daily aggregate stores:

```ts
commits: number;
added: number;
removed: number;
netLines: number;
```

---

### Task 0: Start From Latest Upstream Main

**Files:**
- No code files changed.

- [ ] **Step 1: Confirm no user work will be overwritten**

Run:

```powershell
rtk git status --short --branch
```

Expected:

```text
## <current branch>
```

Untracked files are allowed. Do not run `git reset`, `git checkout --`, or branch switching inside the dirty checkout.

- [ ] **Step 2: Fetch the latest upstream main**

Run:

```powershell
rtk git fetch upstream main
rtk git rev-parse --short upstream/main
```

Expected: a short commit hash is printed. During planning this was `e81e533`; use the live value printed during implementation.

- [ ] **Step 3: Create an isolated worktree from upstream/main**

Run from `D:\Git\wheremytokens`:

```powershell
rtk git worktree add ..\wheremytokens-ledger upstream/main -b codex-persistent-usage-ledger-trend
```

Expected:

```text
Preparing worktree (new branch 'codex-persistent-usage-ledger-trend')
HEAD is now at <hash> <message>
```

- [ ] **Step 4: Install dependencies in the worktree**

Run:

```powershell
cd ..\wheremytokens-ledger
rtk npm.cmd install
```

Expected: install completes without modifying source files other than package lock metadata already present in upstream. If `package-lock.json` changes only because npm version changed, inspect the diff before keeping it.

- [ ] **Step 5: Commit boundary**

Do not commit Task 0. It only prepares the isolated branch.

---

### Task 1: Add Ledger Types And Pure Aggregate Helpers

**Files:**
- Create: `src/main/usageLedgerTypes.ts`
- Create: `src/main/usageLedgerAggregates.ts`
- Create: `scripts/usage-ledger-aggregates.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing aggregate helper test**

Create `scripts/usage-ledger-aggregates.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import aggregates from '../dist/main/usageLedgerAggregates.js';

const {
  addUsageAggregate,
  subtractUsageAggregate,
  emptyUsageAggregate,
  minuteKey,
  hourProviderKey,
  dayModelKey,
  monthModelKey,
  compactUsageLedgerSnapshot,
} = aggregates;

test('usage aggregate add and subtract preserve all token fields', () => {
  const target = emptyUsageAggregate();
  addUsageAggregate(target, {
    requestCount: 2,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 30,
    cacheReadTokens: 40,
    totalTokens: 100,
    costUSD: 1.25,
    cacheSavingsUSD: 0.75,
  });
  subtractUsageAggregate(target, {
    requestCount: 1,
    inputTokens: 4,
    outputTokens: 5,
    cacheCreationTokens: 6,
    cacheReadTokens: 7,
    totalTokens: 22,
    costUSD: 0.25,
    cacheSavingsUSD: 0.10,
  });
  assert.deepEqual(target, {
    requestCount: 1,
    inputTokens: 6,
    outputTokens: 15,
    cacheCreationTokens: 24,
    cacheReadTokens: 33,
    totalTokens: 78,
    costUSD: 1.0,
    cacheSavingsUSD: 0.65,
  });
});

test('usage ledger key builders are stable strings', () => {
  assert.equal(minuteKey(1710000061000, 'claude', 'claude-sonnet-4'), '1710000060000|claude|claude-sonnet-4');
  assert.equal(hourProviderKey(1710003661000, 'codex'), '1710000000000|codex');
  assert.equal(dayModelKey('2026-05-25', 'codex', 'GPT-5-CODEX'), '2026-05-25|codex|GPT-5-CODEX');
  assert.equal(monthModelKey('2026-05-25', 'claude', 'claude-sonnet-4'), '2026-05|claude|claude-sonnet-4');
});

test('compaction removes expired minute, request index, hourly, daily, and source repair rows', () => {
  const now = Date.parse('2026-05-25T12:00:00Z');
  const snapshot = {
    schemaVersion: 1,
    minuteRecent: {
      [minuteKey(now - 9 * 24 * 60 * 60 * 1000, 'claude', 'old')]: emptyUsageAggregate(),
      [minuteKey(now - 60_000, 'claude', 'new')]: emptyUsageAggregate(),
    },
    recentRequestIndex: {
      'source|old': { minuteKey: minuteKey(now - 9 * 24 * 60 * 60 * 1000, 'claude', 'old'), aggregate: emptyUsageAggregate(), lastSeenMs: now - 9 * 24 * 60 * 60 * 1000 },
      'source|new': { minuteKey: minuteKey(now - 60_000, 'claude', 'new'), aggregate: emptyUsageAggregate(), lastSeenMs: now - 60_000 },
    },
    hourlyActivity: {
      [hourProviderKey(now - 181 * 24 * 60 * 60 * 1000, 'claude')]: emptyUsageAggregate(),
      [hourProviderKey(now - 60 * 60 * 1000, 'claude')]: emptyUsageAggregate(),
    },
    dailyModel: {
      '2025-05-24|claude|old': emptyUsageAggregate(),
      '2026-05-25|claude|new': emptyUsageAggregate(),
    },
    monthlyModel: {},
    sourceCheckpoints: {},
    sourceRepairRollup: {
      [`source|${hourProviderKey(now - 31 * 24 * 60 * 60 * 1000, 'claude')}|model`]: emptyUsageAggregate(),
      [`source|${hourProviderKey(now - 60 * 60 * 1000, 'claude')}|model`]: emptyUsageAggregate(),
    },
    lastCompactedAt: 0,
  };
  const compacted = compactUsageLedgerSnapshot(snapshot, now);
  assert.equal(Object.keys(compacted.minuteRecent).length, 1);
  assert.equal(Object.keys(compacted.recentRequestIndex).length, 1);
  assert.equal(Object.keys(compacted.hourlyActivity).length, 1);
  assert.equal(Object.keys(compacted.dailyModel).length, 1);
  assert.equal(Object.keys(compacted.sourceRepairRollup).length, 1);
  assert.equal(compacted.lastCompactedAt, now);
});
```

- [ ] **Step 2: Add the test command**

Modify `package.json` and append `scripts/usage-ledger-aggregates.test.mjs` to the `test` script after `scripts/jsonl-summary.test.mjs`.

- [ ] **Step 3: Run the failing test**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/usage-ledger-aggregates.test.mjs
```

Expected: fail with a module-not-found error for `dist/main/usageLedgerAggregates.js`.

- [ ] **Step 4: Implement `usageLedgerTypes.ts`**

Create `src/main/usageLedgerTypes.ts`:

```ts
import { UsageProvider } from './jsonlTypes';

export const USAGE_LEDGER_SCHEMA_VERSION = 1;
export const MINUTE_RECENT_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
export const RECENT_REQUEST_INDEX_RETENTION_MS = MINUTE_RECENT_RETENTION_MS;
export const HOURLY_ACTIVITY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const DAILY_MODEL_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const SOURCE_REPAIR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface UsageAggregate {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
}

export interface RecentRequestIndexEntry {
  minuteKey: string;
  aggregate: UsageAggregate;
  lastSeenMs: number;
}

export interface SourceCheckpoint {
  provider: 'claude' | 'codex';
  sourceHash: string;
  normalizedPath: string;
  size: number;
  mtimeMs: number;
  byteOffset: number;
  lastImportedAt: number;
  needsRebuild?: boolean;
  rebuildReason?: string;
}

export interface UsageLedgerSnapshot {
  schemaVersion: number;
  minuteRecent: Record<string, UsageAggregate>;
  recentRequestIndex: Record<string, RecentRequestIndexEntry>;
  hourlyActivity: Record<string, UsageAggregate>;
  dailyModel: Record<string, UsageAggregate>;
  monthlyModel: Record<string, UsageAggregate>;
  sourceCheckpoints: Record<string, SourceCheckpoint>;
  sourceRepairRollup: Record<string, UsageAggregate>;
  lastCompactedAt: number;
}

export interface UsageLedgerStoreShape {
  ledger: UsageLedgerSnapshot;
}

export type UsageLedgerProvider = UsageProvider;
```

- [ ] **Step 5: Implement `usageLedgerAggregates.ts`**

Create `src/main/usageLedgerAggregates.ts` with these exported functions:

```ts
import {
  DAILY_MODEL_RETENTION_MS,
  HOURLY_ACTIVITY_RETENTION_MS,
  MINUTE_RECENT_RETENTION_MS,
  RECENT_REQUEST_INDEX_RETENTION_MS,
  SOURCE_REPAIR_RETENTION_MS,
  USAGE_LEDGER_SCHEMA_VERSION,
  UsageAggregate,
  UsageLedgerSnapshot,
  UsageLedgerProvider,
} from './usageLedgerTypes';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function emptyUsageAggregate(): UsageAggregate {
  return {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    cacheSavingsUSD: 0,
  };
}

export function emptyUsageLedgerSnapshot(): UsageLedgerSnapshot {
  return {
    schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
    minuteRecent: {},
    recentRequestIndex: {},
    hourlyActivity: {},
    dailyModel: {},
    monthlyModel: {},
    sourceCheckpoints: {},
    sourceRepairRollup: {},
    lastCompactedAt: 0,
  };
}

export function addUsageAggregate(target: UsageAggregate, delta: UsageAggregate): void {
  target.requestCount += delta.requestCount;
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheCreationTokens += delta.cacheCreationTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.totalTokens += delta.totalTokens;
  target.costUSD += delta.costUSD;
  target.cacheSavingsUSD += delta.cacheSavingsUSD;
}

export function subtractUsageAggregate(target: UsageAggregate, delta: UsageAggregate): void {
  target.requestCount -= delta.requestCount;
  target.inputTokens -= delta.inputTokens;
  target.outputTokens -= delta.outputTokens;
  target.cacheCreationTokens -= delta.cacheCreationTokens;
  target.cacheReadTokens -= delta.cacheReadTokens;
  target.totalTokens -= delta.totalTokens;
  target.costUSD -= delta.costUSD;
  target.cacheSavingsUSD -= delta.cacheSavingsUSD;
}

export function aggregateFromParts(parts: Omit<UsageAggregate, 'requestCount' | 'totalTokens'>): UsageAggregate {
  return {
    requestCount: 1,
    inputTokens: parts.inputTokens,
    outputTokens: parts.outputTokens,
    cacheCreationTokens: parts.cacheCreationTokens,
    cacheReadTokens: parts.cacheReadTokens,
    totalTokens: parts.inputTokens + parts.outputTokens + parts.cacheCreationTokens + parts.cacheReadTokens,
    costUSD: parts.costUSD,
    cacheSavingsUSD: parts.cacheSavingsUSD,
  };
}

export function minuteKey(timestampMs: number, provider: UsageLedgerProvider, model: string): string {
  return `${timestampMs - (timestampMs % MINUTE_MS)}|${provider}|${model}`;
}

export function hourProviderKey(timestampMs: number, provider: UsageLedgerProvider): string {
  return `${timestampMs - (timestampMs % HOUR_MS)}|${provider}`;
}

export function hourSourceModelKey(sourceHash: string, timestampMs: number, provider: UsageLedgerProvider, model: string): string {
  return `${sourceHash}|${timestampMs - (timestampMs % HOUR_MS)}|${provider}|${model}`;
}

export function dayModelKey(dateOrTimestamp: string | number, provider: UsageLedgerProvider, model: string): string {
  const date = typeof dateOrTimestamp === 'number' ? localDateKey(dateOrTimestamp) : dateOrTimestamp;
  return `${date}|${provider}|${model}`;
}

export function monthModelKey(dateOrTimestamp: string | number, provider: UsageLedgerProvider, model: string): string {
  const date = typeof dateOrTimestamp === 'number' ? localDateKey(dateOrTimestamp) : dateOrTimestamp;
  return `${date.slice(0, 7)}|${provider}|${model}`;
}

export function localDateKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function parseLeadingTimestamp(key: string): number {
  const first = key.split('|', 1)[0];
  const numeric = Number(first);
  return Number.isFinite(numeric) ? numeric : Date.parse(`${first}T00:00:00`);
}

function keepByTimestamp<T>(entries: Record<string, T>, cutoffMs: number): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(entries)) {
    const timestampMs = parseLeadingTimestamp(key);
    if (Number.isFinite(timestampMs) && timestampMs >= cutoffMs) next[key] = value;
  }
  return next;
}

export function compactUsageLedgerSnapshot(snapshot: UsageLedgerSnapshot, nowMs = Date.now()): UsageLedgerSnapshot {
  const sourceRepair: Record<string, UsageAggregate> = {};
  const sourceRepairCutoff = nowMs - SOURCE_REPAIR_RETENTION_MS;
  for (const [key, value] of Object.entries(snapshot.sourceRepairRollup)) {
    const [, hourStart] = key.split('|');
    if (Number(hourStart) >= sourceRepairCutoff) sourceRepair[key] = value;
  }

  const recentIndex: UsageLedgerSnapshot['recentRequestIndex'] = {};
  const indexCutoff = nowMs - RECENT_REQUEST_INDEX_RETENTION_MS;
  for (const [key, value] of Object.entries(snapshot.recentRequestIndex)) {
    if (value.lastSeenMs >= indexCutoff) recentIndex[key] = value;
  }

  return {
    ...snapshot,
    schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
    minuteRecent: keepByTimestamp(snapshot.minuteRecent, nowMs - MINUTE_RECENT_RETENTION_MS),
    recentRequestIndex: recentIndex,
    hourlyActivity: keepByTimestamp(snapshot.hourlyActivity, nowMs - HOURLY_ACTIVITY_RETENTION_MS),
    dailyModel: keepByTimestamp(snapshot.dailyModel, nowMs - DAILY_MODEL_RETENTION_MS),
    sourceRepairRollup: sourceRepair,
    lastCompactedAt: nowMs,
  };
}
```

- [ ] **Step 6: Run the aggregate test**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/usage-ledger-aggregates.test.mjs
```

Expected: all tests pass.

- [ ] **Step 7: Commit Task 1**

Run:

```powershell
rtk git add package.json src/main/usageLedgerTypes.ts src/main/usageLedgerAggregates.ts scripts/usage-ledger-aggregates.test.mjs
rtk git commit -m "feat: add usage ledger aggregate primitives"
```

Expected: commit succeeds.

---

### Task 2: Add Persistent Usage Ledger Store

**Files:**
- Create: `src/main/usageLedgerStore.ts`
- Create: `scripts/usage-ledger-store.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing store test**

Create `scripts/usage-ledger-store.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import storeModule from '../dist/main/usageLedgerStore.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { UsageLedgerStore } = storeModule;
const { emptyUsageLedgerSnapshot, emptyUsageAggregate, minuteKey } = aggregates;

class FakeStore {
  constructor() {
    this.state = {};
  }
  get(key) {
    return this.state[key];
  }
  set(key, value) {
    this.state[key] = value;
  }
}

test('usage ledger store returns an initialized snapshot', () => {
  const store = new UsageLedgerStore(new FakeStore());
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.minuteRecent, {});
});

test('usage ledger store persists replaced snapshots', () => {
  const fake = new FakeStore();
  const store = new UsageLedgerStore(fake);
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(Date.parse('2026-05-25T10:00:00Z'), 'claude', 'sonnet')] = emptyUsageAggregate();
  store.replaceSnapshot(snapshot);
  const reloaded = new UsageLedgerStore(fake).getSnapshot();
  assert.equal(Object.keys(reloaded.minuteRecent).length, 1);
});

test('usage ledger store reset clears persisted ledger', () => {
  const fake = new FakeStore();
  const store = new UsageLedgerStore(fake);
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(Date.now(), 'codex', 'GPT-5-CODEX')] = emptyUsageAggregate();
  store.replaceSnapshot(snapshot);
  store.reset();
  assert.deepEqual(store.getSnapshot().minuteRecent, {});
});
```

- [ ] **Step 2: Add the test command**

Modify `package.json` and append `scripts/usage-ledger-store.test.mjs` to the `test` script after `scripts/usage-ledger-aggregates.test.mjs`.

- [ ] **Step 3: Run the failing test**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/usage-ledger-store.test.mjs
```

Expected: fail with module-not-found for `usageLedgerStore.js`.

- [ ] **Step 4: Implement the store wrapper**

Create `src/main/usageLedgerStore.ts`:

```ts
import Store from 'electron-store';
import { emptyUsageLedgerSnapshot, compactUsageLedgerSnapshot } from './usageLedgerAggregates';
import { USAGE_LEDGER_SCHEMA_VERSION, UsageLedgerSnapshot, UsageLedgerStoreShape } from './usageLedgerTypes';

interface StoreLike {
  get(key: 'ledger'): UsageLedgerSnapshot | undefined;
  set(key: 'ledger', value: UsageLedgerSnapshot): void;
}

function normalizeSnapshot(value: unknown): UsageLedgerSnapshot {
  if (!value || typeof value !== 'object') return emptyUsageLedgerSnapshot();
  const raw = value as Partial<UsageLedgerSnapshot>;
  if (raw.schemaVersion !== USAGE_LEDGER_SCHEMA_VERSION) return emptyUsageLedgerSnapshot();
  return {
    schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
    minuteRecent: raw.minuteRecent && typeof raw.minuteRecent === 'object' ? raw.minuteRecent : {},
    recentRequestIndex: raw.recentRequestIndex && typeof raw.recentRequestIndex === 'object' ? raw.recentRequestIndex : {},
    hourlyActivity: raw.hourlyActivity && typeof raw.hourlyActivity === 'object' ? raw.hourlyActivity : {},
    dailyModel: raw.dailyModel && typeof raw.dailyModel === 'object' ? raw.dailyModel : {},
    monthlyModel: raw.monthlyModel && typeof raw.monthlyModel === 'object' ? raw.monthlyModel : {},
    sourceCheckpoints: raw.sourceCheckpoints && typeof raw.sourceCheckpoints === 'object' ? raw.sourceCheckpoints : {},
    sourceRepairRollup: raw.sourceRepairRollup && typeof raw.sourceRepairRollup === 'object' ? raw.sourceRepairRollup : {},
    lastCompactedAt: typeof raw.lastCompactedAt === 'number' ? raw.lastCompactedAt : 0,
  };
}

export class UsageLedgerStore {
  private readonly store: StoreLike;

  constructor(store?: StoreLike) {
    this.store = store ?? new Store<UsageLedgerStoreShape>({
      name: 'usage-ledger',
      defaults: { ledger: emptyUsageLedgerSnapshot() },
    }) as unknown as StoreLike;
  }

  getSnapshot(): UsageLedgerSnapshot {
    return normalizeSnapshot(this.store.get('ledger'));
  }

  replaceSnapshot(snapshot: UsageLedgerSnapshot): void {
    this.store.set('ledger', normalizeSnapshot(snapshot));
  }

  compact(nowMs = Date.now()): UsageLedgerSnapshot {
    const next = compactUsageLedgerSnapshot(this.getSnapshot(), nowMs);
    this.replaceSnapshot(next);
    return next;
  }

  reset(): void {
    this.replaceSnapshot(emptyUsageLedgerSnapshot());
  }
}
```

- [ ] **Step 5: Run the store test**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/usage-ledger-store.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit Task 2**

Run:

```powershell
rtk git add package.json src/main/usageLedgerStore.ts scripts/usage-ledger-store.test.mjs
rtk git commit -m "feat: persist aggregate usage ledger"
```

Expected: commit succeeds.

---

### Task 3: Extract Reusable JSONL Usage Events

**Files:**
- Create: `src/main/jsonlUsageExtractor.ts`
- Modify: `src/main/jsonlParser.ts`
- Modify: `scripts/jsonl-summary.test.mjs`

- [ ] **Step 1: Add extractor regression tests to `scripts/jsonl-summary.test.mjs`**

Append this test near the existing Claude duplicate test:

```js
test('ledger extractor emits compact usage entries for Claude and Codex lines', async () => {
  const extractor = await import('../dist/main/jsonlUsageExtractor.js');
  const claudeLine = claudeAssistantLine({
    id: 'extract-claude',
    model: 'claude-sonnet-4',
    input: 11,
    output: 22,
    cacheCreation: 3,
    cacheRead: 4,
  });
  const claude = extractor.extractClaudeUsageLine(claudeLine, Date.now());
  assert.equal(claude.entry.requestId, 'extract-claude');
  assert.equal(claude.entry.provider, 'claude');
  assert.equal(claude.entry.inputTokens, 11);
  assert.equal(claude.entry.outputTokens, 22);

  const codexLine = JSON.stringify({
    type: 'response_item',
    timestamp: recentIso(),
    payload: {
      type: 'usage',
      model: 'gpt-5-codex',
      input_tokens: 7,
      output_tokens: 8,
      cached_input_tokens: 9,
    },
  });
  const codex = extractor.extractCodexUsageLine('C:/tmp/session.jsonl', codexLine, Date.now());
  assert.equal(codex.entry.provider, 'codex');
  assert.equal(codex.entry.inputTokens, 7);
  assert.equal(codex.entry.outputTokens, 8);
  assert.equal(codex.entry.cacheReadTokens, 9);
});
```

- [ ] **Step 2: Run the failing extractor test**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/jsonl-summary.test.mjs
```

Expected: fail with module-not-found for `jsonlUsageExtractor.js`.

- [ ] **Step 3: Implement `jsonlUsageExtractor.ts`**

Create `src/main/jsonlUsageExtractor.ts` by moving these responsibilities out of `jsonlParser.ts` without changing behavior:

```ts
import * as path from 'path';
import { CompactRecentEntry, UsageProvider } from './jsonlTypes';

export interface ExtractedUsageLine {
  entry: CompactRecentEntry;
  rawModel: string;
  contextMax?: number;
  toolNames: string[];
  textActivity?: Array<{ cat: string; chars: number }>;
}

export function normalizeModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('sonnet')) return 'claude-sonnet-4';
  if (lower.includes('opus')) return 'claude-opus-4';
  if (lower.includes('gpt-5-codex')) return 'GPT-5-CODEX';
  return model || 'unknown';
}

export function getProvider(model: string): UsageProvider {
  const lower = model.toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('codex') || lower.includes('gpt')) return 'codex';
  return 'other';
}

export function codexEntryId(filePath: string, line: string, timestampMs: number): string {
  return `${path.basename(filePath)}:${timestampMs}:${line.length}`;
}

export function extractClaudeUsageLine(line: string, now: number): ExtractedUsageLine | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== 'assistant') return null;
  const msg = obj.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as Record<string, unknown> | undefined;
  if (!msg || !usage) return null;
  const timestamp = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : now;
  const rawModel = typeof msg.model === 'string' ? msg.model : 'unknown';
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? 0);
  const cacheReadTokens = Number(usage.cache_read_input_tokens ?? 0);
  if (!Number.isFinite(timestamp) || inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens <= 0) return null;
  return {
    rawModel,
    entry: {
      requestId: typeof msg.id === 'string' ? msg.id : `${rawModel}-${timestamp}-${inputTokens}-${outputTokens}`,
      timestampMs: timestamp,
      model: normalizeModel(rawModel),
      provider: getProvider(rawModel),
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      costUSD: 0,
      cacheSavingsUSD: 0,
    },
    toolNames: [],
  };
}

export function extractCodexUsageLine(filePath: string, line: string, now: number): ExtractedUsageLine | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const payload = obj.payload as Record<string, unknown> | undefined;
  const usage = (payload?.usage ?? payload) as Record<string, unknown> | undefined;
  const timestamp = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : now;
  const rawModel = String(usage?.model ?? payload?.model ?? 'gpt-5-codex');
  const inputTokens = Number(usage?.input_tokens ?? usage?.inputTokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? usage?.outputTokens ?? 0);
  const cacheReadTokens = Number(usage?.cached_input_tokens ?? usage?.cacheReadTokens ?? 0);
  if (!Number.isFinite(timestamp) || inputTokens + outputTokens + cacheReadTokens <= 0) return null;
  return {
    rawModel,
    entry: {
      requestId: codexEntryId(filePath, line, timestamp),
      timestampMs: timestamp,
      model: normalizeModel(rawModel),
      provider: 'codex',
      inputTokens,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens,
      costUSD: 0,
      cacheSavingsUSD: 0,
    },
    toolNames: [],
  };
}
```

After creating the extractor, move the existing exact `calcCost`, `calcCacheSavings`, model normalization, Codex usage field detection, tool extraction, and context extraction behavior from `jsonlParser.ts` into this file. Keep exported function names stable. The simplified code block above defines the public surface; the moved implementation must preserve all existing `scripts/jsonl-summary.test.mjs` behavior.

- [ ] **Step 4: Refactor `jsonlParser.ts` to use the extractor**

Modify `processClaudeLine` and `processCodexLine` so they call `extractClaudeUsageLine` and `extractCodexUsageLine`. Keep `replaceClaudeEntry`, `addSummaryEntry`, `sessionSnapshot`, activity breakdown, and rate-limit merging behavior unchanged.

- [ ] **Step 5: Run parser tests**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/jsonl-summary.test.mjs
```

Expected: all JSONL summary tests pass, including duplicate request behavior.

- [ ] **Step 6: Commit Task 3**

Run:

```powershell
rtk git add src/main/jsonlUsageExtractor.ts src/main/jsonlParser.ts scripts/jsonl-summary.test.mjs
rtk git commit -m "refactor: share jsonl usage extraction"
```

Expected: commit succeeds.

---

### Task 4: Add Usage Ledger Importer

**Files:**
- Create: `src/main/usageLedgerImporter.ts`
- Create: `scripts/usage-ledger-importer.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing importer test**

Create `scripts/usage-ledger-importer.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import importerModule from '../dist/main/usageLedgerImporter.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { importUsageJsonlIntoSnapshot, sourceHashForPath } = importerModule;
const { emptyUsageLedgerSnapshot, dayModelKey, monthModelKey } = aggregates;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-usage-ledger-importer-'));
}

function claudeLine({ id, timestamp, input = 10, output = 20 }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      id,
      model: 'claude-sonnet-4',
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [{ type: 'text', text: 'done' }],
    },
  });
}

test('usage importer writes minute, hourly, daily, monthly, and checkpoint aggregates', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'claude.jsonl');
  fs.writeFileSync(filePath, `${claudeLine({ id: 'one', timestamp: '2026-05-25T10:15:00.000Z' })}\n`, 'utf8');
  const snapshot = emptyUsageLedgerSnapshot();
  const next = await importUsageJsonlIntoSnapshot(snapshot, filePath, 'claude', Date.parse('2026-05-25T12:00:00.000Z'));
  assert.equal(Object.keys(next.minuteRecent).length, 1);
  assert.equal(Object.keys(next.hourlyActivity).length, 1);
  assert.equal(next.dailyModel[dayModelKey('2026-05-25', 'claude', 'claude-sonnet-4')].requestCount, 1);
  assert.equal(next.monthlyModel[monthModelKey('2026-05-25', 'claude', 'claude-sonnet-4')].requestCount, 1);
  assert.ok(next.sourceCheckpoints[sourceHashForPath(filePath)]);
});

test('usage importer does not double count unchanged source', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'stable.jsonl');
  fs.writeFileSync(filePath, `${claudeLine({ id: 'one', timestamp: '2026-05-25T10:15:00.000Z' })}\n`, 'utf8');
  const first = await importUsageJsonlIntoSnapshot(emptyUsageLedgerSnapshot(), filePath, 'claude', Date.parse('2026-05-25T12:00:00.000Z'));
  const second = await importUsageJsonlIntoSnapshot(first, filePath, 'claude', Date.parse('2026-05-25T12:01:00.000Z'));
  assert.equal(second.dailyModel[dayModelKey('2026-05-25', 'claude', 'claude-sonnet-4')].requestCount, 1);
});

test('usage importer replaces duplicate recent Claude request with larger output', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'duplicate.jsonl');
  fs.writeFileSync(filePath, [
    claudeLine({ id: 'dup', timestamp: '2026-05-25T10:15:00.000Z', output: 10 }),
    claudeLine({ id: 'dup', timestamp: '2026-05-25T10:16:00.000Z', output: 25 }),
    '',
  ].join('\n'), 'utf8');
  const next = await importUsageJsonlIntoSnapshot(emptyUsageLedgerSnapshot(), filePath, 'claude', Date.parse('2026-05-25T12:00:00.000Z'));
  assert.equal(next.dailyModel[dayModelKey('2026-05-25', 'claude', 'claude-sonnet-4')].requestCount, 1);
  assert.equal(next.dailyModel[dayModelKey('2026-05-25', 'claude', 'claude-sonnet-4')].outputTokens, 25);
});
```

- [ ] **Step 2: Add the test command**

Modify `package.json` and append `scripts/usage-ledger-importer.test.mjs` to the `test` script after `scripts/usage-ledger-store.test.mjs`.

- [ ] **Step 3: Run the failing importer test**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/usage-ledger-importer.test.mjs
```

Expected: fail with module-not-found for `usageLedgerImporter.js`.

- [ ] **Step 4: Implement source hashing and source import**

Create `src/main/usageLedgerImporter.ts` with these public exports:

```ts
export function sourceHashForPath(filePath: string): string;
export async function importUsageJsonlIntoSnapshot(
  snapshot: UsageLedgerSnapshot,
  filePath: string,
  provider: 'claude' | 'codex',
  nowMs?: number,
): Promise<UsageLedgerSnapshot>;
```

Implementation requirements:

- Normalize paths with `path.resolve`; lowercase on Windows.
- Use SHA-256 base64url for `sourceHash`.
- If checkpoint `size` and `mtimeMs` match, return the input snapshot unchanged.
- For full-source import, parse all JSONL lines using `jsonlUsageExtractor`.
- Within a single source scan, dedupe Claude entries by `requestId`; keep the entry with the larger `outputTokens`.
- Update all materialized aggregates on import:
  - `minuteRecent` for entries within 8 days.
  - `recentRequestIndex` for entries within 8 days.
  - `hourlyActivity` for entries within 180 days.
  - `dailyModel` for entries within 365 days.
  - `monthlyModel` for every entry.
  - `sourceRepairRollup` for entries within 30 days.
- For existing source repair rows, subtract previous repair aggregates before adding replacement repair rows.
- If a source shrinks or mtime changes and the affected old source rows are older than 30 days, set `sourceCheckpoints[sourceHash].needsRebuild = true` and `rebuildReason = 'source changed outside repair window'`; do not subtract long-term global history.

- [ ] **Step 5: Run importer tests**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/usage-ledger-importer.test.mjs
```

Expected: all importer tests pass.

- [ ] **Step 6: Commit Task 4**

Run:

```powershell
rtk git add package.json src/main/usageLedgerImporter.ts scripts/usage-ledger-importer.test.mjs
rtk git commit -m "feat: import jsonl usage into aggregate ledger"
```

Expected: commit succeeds.

---

### Task 5: Query Ledger Into Current UsageData And Trend Data

**Files:**
- Create: `src/main/usageLedgerUsage.ts`
- Create: `scripts/usage-ledger-usage.test.mjs`
- Modify: `src/main/stateManager.ts`
- Modify: `src/renderer/types.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing usage query test**

Create `scripts/usage-ledger-usage.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import queryModule from '../dist/main/usageLedgerUsage.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { computeUsageFromLedger, buildTrendDataFromLedger } = queryModule;
const { emptyUsageLedgerSnapshot, dayModelKey, hourProviderKey, minuteKey, emptyUsageAggregate } = aggregates;

function agg(tokens, cost, calls = 1) {
  return {
    requestCount: calls,
    inputTokens: tokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: tokens,
    costUSD: cost,
    cacheSavingsUSD: 0,
  };
}

test('ledger usage query preserves current today, all-time, model, and hourly dimensions', () => {
  const now = Date.parse('2026-05-25T12:30:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.minuteRecent[minuteKey(now - 60_000, 'claude', 'claude-sonnet-4')] = agg(100, 1.5);
  snapshot.hourlyActivity[hourProviderKey(now - 60_000, 'claude')] = agg(100, 1.5);
  snapshot.dailyModel[dayModelKey('2026-05-25', 'claude', 'claude-sonnet-4')] = agg(100, 1.5);
  snapshot.monthlyModel['2026-04|codex|GPT-5-CODEX'] = agg(200, 2.5);

  const usage = computeUsageFromLedger(snapshot, { h5: 200_000, week: 1_000_000, sonnetWeek: 1_000_000 }, {}, now);
  assert.equal(usage.todayTokens, 100);
  assert.equal(usage.todayCost, 1.5);
  assert.equal(usage.allTimeCost, 4.0);
  assert.equal(usage.models.length, 2);
  assert.equal(usage.heatmap.length, 1);
});

test('ledger trend query returns daily weekly and monthly rows', () => {
  const now = Date.parse('2026-05-25T12:30:00.000Z');
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.dailyModel[dayModelKey('2026-05-25', 'claude', 'claude-sonnet-4')] = agg(100, 1.5);
  snapshot.dailyModel[dayModelKey('2026-05-24', 'codex', 'GPT-5-CODEX')] = agg(200, 2.5);
  snapshot.monthlyModel['2026-04|codex|GPT-5-CODEX'] = agg(300, 3.5);

  const trend = buildTrendDataFromLedger(snapshot, now);
  assert.ok(trend.daily.some(row => row.date === '2026-05-25' && row.tokens === 100));
  assert.ok(trend.weekly.length > 0);
  assert.ok(trend.monthly.some(row => row.month === '2026-04' && row.costUSD === 3.5));
});
```

- [ ] **Step 2: Add renderer trend types**

Modify `src/renderer/types.ts`:

```ts
export interface UsageTrendPoint {
  date?: string;
  weekStart?: string;
  month?: string;
  tokens: number;
  costUSD: number;
  requestCount: number;
}

export interface UsageTrendData {
  daily: UsageTrendPoint[];
  weekly: UsageTrendPoint[];
  monthly: UsageTrendPoint[];
}
```

Add to `AppState`:

```ts
usageTrend: UsageTrendData;
```

- [ ] **Step 3: Add the test command**

Modify `package.json` and append `scripts/usage-ledger-usage.test.mjs` to the `test` script after `scripts/usage-ledger-importer.test.mjs`.

- [ ] **Step 4: Run the failing usage query test**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/usage-ledger-usage.test.mjs
```

Expected: fail with module-not-found for `usageLedgerUsage.js`.

- [ ] **Step 5: Implement `usageLedgerUsage.ts`**

Create `src/main/usageLedgerUsage.ts` with:

```ts
export function computeUsageFromLedger(
  snapshot: UsageLedgerSnapshot,
  userLimits: { h5: number; week: number; sonnetWeek: number },
  resets?: {
    claude?: { weekResetMs?: number | null; h5ResetMs?: number | null };
    codex?: { weekResetMs?: number | null; h5ResetMs?: number | null };
  },
  now?: number,
): UsageData;

export function buildTrendDataFromLedger(snapshot: UsageLedgerSnapshot, now?: number): UsageTrendData;
```

Implementation requirements:

- Use `minuteRecent` for 5h, 1w, today, and Sonnet 1w usage windows. Plan Usage quota ETA is not derived from local token activity.
- Use `hourlyActivity` for heatmap 7d, 30d, 150d, Hourly, and Rhythm calculations.
- Use `dailyModel` for recent all-time totals, model usage, and daily/weekly Trend.
- Use `monthlyModel` for all-time totals older than daily retention and monthly Trend.
- Avoid double counting by querying `dailyModel` for the last 365 days and `monthlyModel` for months older than the oldest retained daily date.
- Keep cache-efficiency formulas identical to `usageWindows.ts`: Codex denominator is `inputTokens + cacheReadTokens`; Claude denominator is `cacheReadTokens + cacheCreationTokens`.
- Preserve current `UsageData` shape exactly.

- [ ] **Step 6: Integrate state defaults**

Modify `src/main/stateManager.ts` empty state to include:

```ts
usageTrend: { daily: [], weekly: [], monthly: [] },
```

Modify `src/renderer/App.tsx` default and normalizer to keep `usageTrend.daily`, `usageTrend.weekly`, and `usageTrend.monthly` as arrays.

- [ ] **Step 7: Run usage query tests**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/usage-ledger-usage.test.mjs
```

Expected: all tests pass.

- [ ] **Step 8: Commit Task 5**

Run:

```powershell
rtk git add package.json src/main/usageLedgerUsage.ts src/main/stateManager.ts src/renderer/types.ts src/renderer/App.tsx scripts/usage-ledger-usage.test.mjs
rtk git commit -m "feat: query usage ledger for dashboard stats"
```

Expected: commit succeeds.

---

### Task 6: Integrate Ledger Import Into Refresh

**Files:**
- Modify: `src/main/stateManager.ts`
- Modify: `src/main/usageLedgerStore.ts`
- Create: `scripts/usage-ledger-state.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the state integration guard**

Create `scripts/usage-ledger-state.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('state manager owns usage ledger import and query paths', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  assert.match(src, /UsageLedgerStore/);
  assert.match(src, /importUsageJsonlIntoSnapshot/);
  assert.match(src, /computeUsageFromLedger/);
  assert.match(src, /buildTrendDataFromLedger/);
});

test('manual refresh does not clear persisted usage ledger', () => {
  const src = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  const forceRefresh = src.slice(src.indexOf('async forceRefresh'), src.indexOf('private startTimers'));
  assert.doesNotMatch(forceRefresh, /usageLedgerStore\.reset/);
});
```

- [ ] **Step 2: Add the test command**

Modify `package.json` and append `scripts/usage-ledger-state.test.mjs` to the `test` script after `scripts/usage-ledger-usage.test.mjs`.

- [ ] **Step 3: Run the failing state test**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/usage-ledger-state.test.mjs
```

Expected: fail because `StateManager` does not yet reference the ledger.

- [ ] **Step 4: Add ledger members to `StateManager`**

Modify `src/main/stateManager.ts` imports:

```ts
import { UsageLedgerStore } from './usageLedgerStore';
import { importUsageJsonlIntoSnapshot } from './usageLedgerImporter';
import { buildTrendDataFromLedger, computeUsageFromLedger } from './usageLedgerUsage';
```

Add private fields:

```ts
private usageLedgerStore = new UsageLedgerStore();
private usageLedgerBackfillComplete = false;
```

- [ ] **Step 5: Import ledger during heavy refresh**

Add a private method in `StateManager`:

```ts
private async refreshUsageLedgerFromFiles(files: Array<{ filePath: string; provider: 'claude' | 'codex' }>): Promise<void> {
  let snapshot = this.usageLedgerStore.getSnapshot();
  for (const file of files) {
    snapshot = await importUsageJsonlIntoSnapshot(snapshot, file.filePath, file.provider);
  }
  snapshot = this.usageLedgerStore.compact();
  this.usageLedgerStore.replaceSnapshot(snapshot);
}
```

Call it after `loadProviderSummaries(...)` in `heavyRefresh`, using the same JSONL files that were discovered for summaries. The first implementation may import from `loaded.summaries` keys mapped back to provider by `providerForJsonlPath`; changed-file fast refresh should import only changed files.

- [ ] **Step 6: Compute usage from ledger after import**

In `computeDerivedUsage`, read the ledger snapshot and use `computeUsageFromLedger(...)` once the snapshot has any `dailyModel` or `monthlyModel` rows. Fall back to existing `computeUsage(this.getVisibleSummaries(...))` when the ledger is empty.

- [ ] **Step 7: Build Trend data in state updates**

Where state is assigned after usage calculation, include:

```ts
usageTrend: buildTrendDataFromLedger(this.usageLedgerStore.getSnapshot()),
```

Keep existing `historyWarmupPending` behavior. JSONL cleanup must not decrease ledger totals.

- [ ] **Step 8: Run state integration tests**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/usage-ledger-state.test.mjs
```

Expected: all tests pass.

- [ ] **Step 9: Run current refresh regression tests**

Run:

```powershell
rtk node --test scripts/refresh-scheduler.test.mjs scripts/state-readiness.test.mjs scripts/jsonl-summary.test.mjs
```

Expected: all tests pass.

- [ ] **Step 10: Commit Task 6**

Run:

```powershell
rtk git add package.json src/main/stateManager.ts src/main/usageLedgerStore.ts scripts/usage-ledger-state.test.mjs
rtk git commit -m "feat: use persisted ledger for usage refresh"
```

Expected: commit succeeds.

---

### Task 7: Add Git Daily Output Snapshot

**Files:**
- Create: `src/main/gitOutputLedger.ts`
- Create: `scripts/git-output-ledger.test.mjs`
- Modify: `src/main/gitStatsCollector.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing Git output ledger test**

Create `scripts/git-output-ledger.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import gitOutput from '../dist/main/gitOutputLedger.js';

const { mergeGitDailyOutput, buildCodeOutputFromGitLedger } = gitOutput;

test('git daily output merge uses repo and date as stable dimensions', () => {
  const snapshot = { schemaVersion: 1, dailyOutput: {} };
  mergeGitDailyOutput(snapshot, 'repo-a', [
    { date: '2026-05-25', commits: 2, added: 10, removed: 3 },
  ]);
  mergeGitDailyOutput(snapshot, 'repo-a', [
    { date: '2026-05-25', commits: 3, added: 11, removed: 4 },
  ]);
  assert.deepEqual(snapshot.dailyOutput['2026-05-25|repo-a'], {
    date: '2026-05-25',
    repoKey: 'repo-a',
    commits: 3,
    added: 11,
    removed: 4,
    netLines: 7,
  });
});

test('git daily output builds today all and daily7d code output stats', () => {
  const snapshot = { schemaVersion: 1, dailyOutput: {} };
  mergeGitDailyOutput(snapshot, 'repo-a', [
    { date: '2026-05-24', commits: 1, added: 5, removed: 1 },
    { date: '2026-05-25', commits: 2, added: 10, removed: 3 },
  ]);
  const stats = buildCodeOutputFromGitLedger(snapshot, ['repo-a'], '2026-05-25');
  assert.equal(stats.today.commits, 2);
  assert.equal(stats.today.added, 10);
  assert.equal(stats.all.commits, 3);
  assert.equal(stats.all.added, 15);
  assert.equal(stats.daily7d.length, 7);
});
```

- [ ] **Step 2: Add the test command**

Modify `package.json` and append `scripts/git-output-ledger.test.mjs` to the `test` script after `scripts/git-stats-daily.test.mjs`.

- [ ] **Step 3: Run the failing Git output test**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/git-output-ledger.test.mjs
```

Expected: fail with module-not-found for `gitOutputLedger.js`.

- [ ] **Step 4: Implement `gitOutputLedger.ts`**

Create `src/main/gitOutputLedger.ts` with:

```ts
export interface GitOutputLedgerSnapshot {
  schemaVersion: number;
  dailyOutput: Record<string, { date: string; repoKey: string; commits: number; added: number; removed: number; netLines: number }>;
}

export function mergeGitDailyOutput(snapshot: GitOutputLedgerSnapshot, repoKey: string, days: Array<{ date: string; commits: number; added: number; removed: number }>): void;
export function buildCodeOutputFromGitLedger(snapshot: GitOutputLedgerSnapshot, repoKeys: string[], today: string): CodeOutputStats;
```

Use `electron-store` name `git-output-ledger` for persisted storage. `mergeGitDailyOutput` replaces the `date|repoKey` row, not adds to it, so repeated Git scans do not double count.

- [ ] **Step 5: Feed the Git ledger after successful Git stats collection**

Modify `src/main/gitStatsCollector.ts` after `dailyAll` is computed:

```ts
// after stats are built and normalized
// mergeGitDailyOutput(gitOutputSnapshot, stats.gitCommonDir ?? stats.toplevel ?? cwd, stats.dailyAll)
```

Wire through the real store wrapper from `gitOutputLedger.ts`. Keep existing `gitStatsCache` behavior as fallback.

- [ ] **Step 6: Prefer Git ledger for Code Output when available**

Modify `StateManager.buildCodeOutputStats` to use `buildCodeOutputFromGitLedger` when the ledger has rows for scoped repo keys. Fall back to current `repoGitStats` aggregation when ledger rows are empty.

- [ ] **Step 7: Run Git tests**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/git-output-ledger.test.mjs scripts/git-stats-daily.test.mjs scripts/git-stats-keys.test.mjs
```

Expected: all tests pass.

- [ ] **Step 8: Commit Task 7**

Run:

```powershell
rtk git add package.json src/main/gitOutputLedger.ts src/main/gitStatsCollector.ts src/main/stateManager.ts scripts/git-output-ledger.test.mjs
rtk git commit -m "feat: persist daily git output snapshots"
```

Expected: commit succeeds.

---

### Task 8: Add Trend Card

**Files:**
- Create: `src/renderer/components/TrendCard.tsx`
- Modify: `src/renderer/mainSections.ts`
- Modify: `src/renderer/views/MainView.tsx`
- Modify: `src/renderer/types.ts`
- Create: `scripts/trend-section.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing Trend section guard**

Create `scripts/trend-section.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Trend is a normalized main section between Code Output and Sessions', () => {
  const sections = fs.readFileSync('src/renderer/mainSections.ts', 'utf8');
  assert.match(sections, /'trend'/);
  assert.match(sections, /trend: 'Trend'/);
  const orderMatch = sections.match(/MAIN_SECTION_IDS = \[(.*?)\]/s);
  assert.ok(orderMatch);
  const order = orderMatch[1];
  assert.ok(order.indexOf("'codeOutput'") < order.indexOf("'trend'"));
  assert.ok(order.indexOf("'trend'") < order.indexOf("'sessions'"));
});

test('MainView renders TrendCard with usage and code output data', () => {
  const mainView = fs.readFileSync('src/renderer/views/MainView.tsx', 'utf8');
  assert.match(mainView, /TrendCard/);
  assert.match(mainView, /usageTrend/);
  assert.match(mainView, /codeOutputStats/);
});
```

- [ ] **Step 2: Add the test command**

Modify `package.json` and append `scripts/trend-section.test.mjs` to the `test` script after `scripts/state-readiness.test.mjs`.

- [ ] **Step 3: Run the failing Trend test**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/trend-section.test.mjs
```

Expected: fail because `trend` is not defined.

- [ ] **Step 4: Add `trend` to main sections**

Modify `src/renderer/mainSections.ts`:

```ts
export const MAIN_SECTION_IDS = ['planUsage', 'codeOutput', 'trend', 'sessions', 'activity', 'modelUsage'] as const;
```

Add:

```ts
trend: 'Trend',
```

Keep normalization so old configs automatically gain `trend` in the default location.

- [ ] **Step 5: Implement `TrendCard.tsx`**

Create `src/renderer/components/TrendCard.tsx`:

```tsx
import React, { useMemo, useState } from 'react';
import { LineChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CodeOutputStats, UsageTrendData } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtCost, fmtTokens } from '../theme';

type Grain = 'day' | 'week' | 'month';
type Metric = 'cost' | 'tokens';

interface Props {
  usageTrend: UsageTrendData;
  codeOutputStats: CodeOutputStats;
  currency: string;
  usdToKrw: number;
}

function TrendCard({ usageTrend, codeOutputStats, currency, usdToKrw }: Props) {
  const C = useTheme();
  const [grain, setGrain] = useState<Grain>('day');
  const [metric, setMetric] = useState<Metric>('cost');
  const rows = useMemo(() => {
    const usageRows = grain === 'day' ? usageTrend.daily : grain === 'week' ? usageTrend.weekly : usageTrend.monthly;
    return usageRows.map(row => {
      const key = row.date ?? row.weekStart ?? row.month ?? '';
      const git = codeOutputStats.dailyAll.find(day => day.date === key);
      const netLines = git ? git.added - git.removed : 0;
      return {
        label: key,
        costUSD: row.costUSD,
        tokens: row.tokens,
        requestCount: row.requestCount,
        netLines,
        added: git?.added ?? 0,
        removed: git?.removed ?? 0,
        commits: git?.commits ?? 0,
      };
    });
  }, [codeOutputStats.dailyAll, grain, usageTrend]);

  if (rows.length === 0) return null;

  return (
    <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px 5px 12px', background: C.bgRow, borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Trend</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['day', 'week', 'month'] as Grain[]).map(item => <button key={item} onClick={() => setGrain(item)}>{item}</button>)}
          {(['cost', 'tokens'] as Metric[]).map(item => <button key={item} onClick={() => setMetric(item)}>{item}</button>)}
        </div>
      </div>
      <div style={{ height: 190, padding: '8px 12px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows}>
            <XAxis dataKey="label" tick={{ fontSize: 9, fill: C.textMuted }} />
            <YAxis yAxisId="usage" tick={{ fontSize: 9, fill: C.textMuted }} />
            <YAxis yAxisId="output" orientation="right" tick={{ fontSize: 9, fill: C.textMuted }} />
            <Tooltip
              formatter={(value, name) => {
                if (name === 'costUSD') return [fmtCost(Number(value), currency, usdToKrw), 'Cost'];
                if (name === 'tokens') return [fmtTokens(Number(value)), 'Tokens'];
                if (name === 'netLines') return [String(value), 'Net lines'];
                return [String(value), String(name)];
              }}
            />
            <Line yAxisId="usage" type="monotone" dataKey={metric === 'cost' ? 'costUSD' : 'tokens'} stroke={C.accent} dot={false} strokeWidth={2} />
            <Line yAxisId="output" type="monotone" dataKey="netLines" stroke={C.active} dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default React.memo(TrendCard);
```

After this minimal version passes build, restyle buttons to match existing segmented controls in `CodeOutputCard` and `ActivityChart`. Keep the final card visually aligned with Code Output.

- [ ] **Step 6: Render Trend in `MainView.tsx`**

Import:

```ts
import TrendCard from '../components/TrendCard';
```

Add `case 'trend'` between Code Output and Sessions:

```tsx
case 'trend':
  return (
    <LazySection key={sectionId} minHeight={230}>
      <RenderErrorBoundary label="Trend Section">
        <TrendCard usageTrend={state.usageTrend} codeOutputStats={state.codeOutputStats} currency={currency} usdToKrw={usdToKrw} />
      </RenderErrorBoundary>
    </LazySection>
  );
```

- [ ] **Step 7: Run Trend tests and build**

Run:

```powershell
rtk npm.cmd run build
rtk node --test scripts/trend-section.test.mjs
```

Expected: build succeeds and Trend tests pass.

- [ ] **Step 8: Commit Task 8**

Run:

```powershell
rtk git add package.json src/renderer/components/TrendCard.tsx src/renderer/mainSections.ts src/renderer/views/MainView.tsx src/renderer/types.ts scripts/trend-section.test.mjs
rtk git commit -m "feat: add trend card"
```

Expected: commit succeeds.

---

### Task 9: Add Main Card Hide Controls In Settings

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/renderer/types.ts`
- Modify: `src/renderer/mainSections.ts`
- Modify: `src/renderer/views/MainView.tsx`
- Modify: `src/renderer/views/SettingsView.tsx`
- Create: `scripts/main-section-visibility.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing visibility test**

Create `scripts/main-section-visibility.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('settings schema includes hidden main sections in main and renderer types', () => {
  const ipc = fs.readFileSync('src/main/ipc.ts', 'utf8');
  const types = fs.readFileSync('src/renderer/types.ts', 'utf8');
  assert.match(ipc, /hiddenMainSections/);
  assert.match(types, /hiddenMainSections/);
});

test('main section normalization keeps at least one visible section', () => {
  const sections = fs.readFileSync('src/renderer/mainSections.ts', 'utf8');
  assert.match(sections, /normalizeHiddenMainSections/);
  assert.match(sections, /visibleSections\.length === 0/);
});

test('settings view exposes hide controls for main layout rows', () => {
  const settings = fs.readFileSync('src/renderer/views/SettingsView.tsx', 'utf8');
  assert.match(settings, /Hide/);
  assert.match(settings, /hiddenMainSections/);
});
```

- [ ] **Step 2: Add the test command**

Modify `package.json` and append `scripts/main-section-visibility.test.mjs` to the `test` script after `scripts/trend-section.test.mjs`.

- [ ] **Step 3: Run the failing visibility test**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/main-section-visibility.test.mjs
```

Expected: fail because `hiddenMainSections` is not present.

- [ ] **Step 4: Add settings field in lockstep**

Modify `src/main/ipc.ts` `AppSettings` and defaults:

```ts
hiddenMainSections: string[];
```

Default:

```ts
hiddenMainSections: [],
```

Modify `src/renderer/types.ts` `AppSettings` the same way.

- [ ] **Step 5: Add section visibility normalizer**

Modify `src/renderer/mainSections.ts`:

```ts
export function normalizeHiddenMainSections(hidden: readonly string[] | undefined, ordered = DEFAULT_MAIN_SECTION_ORDER): MainSectionId[] {
  const allowed = new Set<MainSectionId>(MAIN_SECTION_IDS);
  const normalized = [...new Set(hidden ?? [])].filter((id): id is MainSectionId => allowed.has(id as MainSectionId));
  const visibleSections = ordered.filter(id => !normalized.includes(id));
  return visibleSections.length === 0 ? normalized.filter(id => id !== ordered[0]) : normalized;
}
```

- [ ] **Step 6: Filter visible sections in `MainView.tsx`**

After `mainSectionOrder` is computed:

```ts
const hiddenMainSections = useMemo(
  () => normalizeHiddenMainSections(settings.hiddenMainSections, mainSectionOrder),
  [settings.hiddenMainSections, mainSectionOrder],
);
const visibleMainSections = useMemo(
  () => mainSectionOrder.filter(section => !hiddenMainSections.includes(section)),
  [mainSectionOrder, hiddenMainSections],
);
```

Render `visibleMainSections.map(renderMainSection)`.

- [ ] **Step 7: Add hide/show controls in Settings**

Modify the existing Main Layout row in `SettingsView.tsx`. Keep up/down buttons and add one button per row:

```tsx
<button
  type="button"
  onClick={() => toggleHiddenMainSection(sectionId)}
  disabled={!isHidden && visibleSectionCount <= 1}
>
  {isHidden ? 'Show' : 'Hide'}
</button>
```

Add helper:

```ts
const toggleHiddenMainSection = (sectionId: MainSectionId) => {
  const hidden = normalizeHiddenMainSections(settings.hiddenMainSections, mainSectionOrder);
  const isHidden = hidden.includes(sectionId);
  const nextHidden = isHidden ? hidden.filter(id => id !== sectionId) : [...hidden, sectionId];
  onChange({ hiddenMainSections: normalizeHiddenMainSections(nextHidden, mainSectionOrder) });
};
```

- [ ] **Step 8: Run visibility tests**

Run:

```powershell
rtk npm.cmd run build
rtk node --test scripts/main-section-visibility.test.mjs scripts/state-readiness.test.mjs
```

Expected: all tests pass.

- [ ] **Step 9: Commit Task 9**

Run:

```powershell
rtk git add package.json src/main/ipc.ts src/renderer/types.ts src/renderer/mainSections.ts src/renderer/views/MainView.tsx src/renderer/views/SettingsView.tsx scripts/main-section-visibility.test.mjs
rtk git commit -m "feat: allow hiding dashboard cards"
```

Expected: commit succeeds.

---

### Task 10: Add Rebuild Ledger Action And Docs

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types.ts`
- Modify: `src/renderer/views/SettingsView.tsx`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Create: `scripts/usage-ledger-rebuild-ui.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing rebuild UI test**

Create `scripts/usage-ledger-rebuild-ui.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('ledger rebuild IPC is exposed through preload and settings', () => {
  const ipc = fs.readFileSync('src/main/ipc.ts', 'utf8');
  const preload = fs.readFileSync('src/main/preload.ts', 'utf8');
  const settings = fs.readFileSync('src/renderer/views/SettingsView.tsx', 'utf8');
  assert.match(ipc, /ledger:rebuild/);
  assert.match(preload, /rebuildLedger/);
  assert.match(settings, /Rebuild ledger/);
});

test('README documents persisted ledger and JSONL cleanup behavior in English and Chinese', () => {
  const en = fs.readFileSync('README.md', 'utf8');
  const zh = fs.readFileSync('README.zh-CN.md', 'utf8');
  assert.match(en, /persisted usage ledger/i);
  assert.match(en, /JSONL cleanup/i);
  assert.match(zh, /持久化账本/);
  assert.match(zh, /JSONL/);
});
```

- [ ] **Step 2: Add the test command**

Modify `package.json` and append `scripts/usage-ledger-rebuild-ui.test.mjs` to the `test` script after `scripts/usage-ledger-state.test.mjs`.

- [ ] **Step 3: Run the failing rebuild UI test**

Run:

```powershell
rtk npm.cmd run build:main
rtk node --test scripts/usage-ledger-rebuild-ui.test.mjs
```

Expected: fail because rebuild IPC and docs do not exist.

- [ ] **Step 4: Add rebuild IPC**

Modify `src/main/ipc.ts` to register:

```ts
ipcMain.handle('ledger:rebuild', async () => {
  await rebuildUsageLedger();
  return getState();
});
```

Pass `rebuildUsageLedger` from `src/main/index.ts` using a `StateManager` method:

```ts
async rebuildUsageLedger(): Promise<void> {
  this.usageLedgerStore.reset();
  await this.requestRefresh({ mode: 'heavy', reason: 'manual', force: true });
}
```

This action intentionally rebuilds from currently available JSONL and should be user-triggered only.

- [ ] **Step 5: Expose preload API**

Modify `src/main/preload.ts`:

```ts
rebuildLedger: () => ipcRenderer.invoke('ledger:rebuild'),
```

Modify `src/renderer/types.ts` window API declaration accordingly.

- [ ] **Step 6: Add Settings action**

In `SettingsView.tsx`, add a button in the settings area near cache/history controls:

```tsx
<button type="button" onClick={() => window.wmt.rebuildLedger().catch(() => {})}>
  Rebuild ledger
</button>
```

Add visible explanatory text:

```text
Rebuilds persisted usage totals from the JSONL files that still exist on disk.
```

- [ ] **Step 7: Update README files**

In `README.md`, add a concise section:

```md
### Persisted usage ledger

WhereMyTokens keeps a persisted usage ledger built from Claude and Codex JSONL logs. JSONL files remain the import source, but historical totals, model usage, activity, and trend data read from aggregate ledger rows once imported. Deleting old JSONL files or clearing `jsonl-summary-cache` does not reduce imported historical totals. Use **Rebuild ledger** in Settings only when you want to rebuild totals from the JSONL files that still exist on disk.
```

In `README.zh-CN.md`, add the matching Chinese section:

```md
### 持久化用量账本

WhereMyTokens 会从 Claude 和 Codex 的 JSONL 日志导入持久化用量账本。JSONL 仍然是导入来源，但历史累计、模型用量、Activity 和 Trend 会优先读取聚合账本。删除旧 JSONL 或清理 `jsonl-summary-cache` 不会扣减已经导入的历史累计。只有在 Settings 中手动执行 **Rebuild ledger** 时，才会基于当前仍存在的 JSONL 重新生成账本。
```

- [ ] **Step 8: Run rebuild UI and docs tests**

Run:

```powershell
rtk npm.cmd run build
rtk node --test scripts/usage-ledger-rebuild-ui.test.mjs
```

Expected: all tests pass.

- [ ] **Step 9: Commit Task 10**

Run:

```powershell
rtk git add package.json src/main/ipc.ts src/main/index.ts src/main/preload.ts src/renderer/types.ts src/renderer/views/SettingsView.tsx README.md README.zh-CN.md scripts/usage-ledger-rebuild-ui.test.mjs
rtk git commit -m "feat: expose usage ledger rebuild"
```

Expected: commit succeeds.

---

### Task 11: End-To-End Verification

**Files:**
- No planned source changes unless verification reveals defects.

- [ ] **Step 1: Run full test suite**

Run:

```powershell
rtk npm.cmd test
```

Expected: all tests pass.

- [ ] **Step 2: Run production build**

Run:

```powershell
rtk npm.cmd run build
```

Expected: `dist/main` and renderer build succeed.

- [ ] **Step 3: Run local app smoke test**

Run:

```powershell
rtk npm.cmd start
```

Expected:

- App opens.
- Header totals do not drop after refresh.
- `Trend` appears between `Code Output` and `Sessions`.
- Trend `day/week/month` and `cost/tokens` controls switch without layout overlap.
- Code Output still reports `Net Lines = added - removed`.
- Settings Main Layout can reorder and hide cards.
- Hiding all cards is prevented.
- Rebuild ledger button is visible and clearly describes that it rebuilds from existing JSONL.

- [ ] **Step 4: Verify ledger files**

Run:

```powershell
rtk powershell -NoProfile -Command "Get-ChildItem -LiteralPath $env:APPDATA\\wheremytokens-win -Filter '*ledger*.json' -ErrorAction SilentlyContinue | Select-Object Name,Length,LastWriteTime | Format-Table -AutoSize"
```

Expected: ledger files are present after app launch and remain much smaller than raw JSONL volume.

- [ ] **Step 5: Verify JSONL cleanup semantics manually**

Use a temporary copy of a small JSONL fixture, not the user's real logs:

```powershell
rtk node --test scripts/usage-ledger-importer.test.mjs
```

Expected: unchanged sources do not double count; source repair replacement works inside the retention window.

- [ ] **Step 6: Commit verification fixes**

If verification required source changes, inspect the exact diff before staging:

```powershell
rtk git status --short
rtk git diff
```

Stage only the files that were changed to fix verification failures. For the expected verification-fix surface in this feature, the command is:

```powershell
rtk git add src/main/stateManager.ts src/main/usageLedgerUsage.ts src/main/usageLedgerImporter.ts src/main/gitOutputLedger.ts src/renderer/components/TrendCard.tsx src/renderer/views/MainView.tsx src/renderer/views/SettingsView.tsx scripts/usage-ledger-state.test.mjs scripts/trend-section.test.mjs scripts/main-section-visibility.test.mjs
rtk git commit -m "fix: stabilize usage ledger dashboard"
```

Expected: commit succeeds. Skip this step if there were no changes.

---

## Self-Review

- Spec coverage: The plan covers persistent aggregate usage ledger, aging, current UI dimensions, Trend card, Settings hide controls, Git daily output snapshot, JSONL-to-ledger handoff, manual rebuild, and documentation.
- Placeholder scan: The plan contains no unresolved placeholder tasks. Implementation details are explicit at module and API level; code blocks define the public contracts and critical behaviors.
- Type consistency: `UsageAggregate`, `UsageLedgerSnapshot`, `UsageTrendData`, `CodeOutputStats`, and main section IDs are used consistently across tasks.
- Scope check: This is a large feature but still one coherent subsystem: persisted reporting data plus the Trend consumer. The Git snapshot is isolated and can be deferred after Task 6 if usage ledger risk needs to be reduced first.

## Execution Handoff

Plan complete. Recommended execution order is Task 0 through Task 11. Use frequent commits exactly as listed so regressions can be isolated by subsystem.
