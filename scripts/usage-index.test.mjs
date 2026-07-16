import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import usageIndexModule from '../dist/main/usageIndex/index.js';
import usageIndexPresentationModule from '../dist/main/usageIndexPresentation.js';
import claudeScannerModule from '../dist/main/providers/claude/usageIndexScanner.js';
import codexScannerModule from '../dist/main/providers/codex/usageIndexScanner.js';
import claudeSourcesModule from '../dist/main/providers/claude/sources.js';
import codexSourcesModule from '../dist/main/providers/codex/sources.js';
import sessionMetadataModule from '../dist/main/sessionMetadata.js';

const {
  DefaultUsageIndex,
  InMemoryUsageIndexStorage,
  SqliteUsageIndexStorage,
  openUsageIndex,
  USAGE_COMPACTION_INTERVAL_MS,
  usageIndexSchemaVersion,
} = usageIndexModule;
const { createCodexUsageIndexScanner } = codexScannerModule;
const { createClaudeUsageIndexScanner } = claudeScannerModule;
const { buildClaudeUsageIndexSource } = claudeSourcesModule;
const { buildCodexUsageIndexSource } = codexSourcesModule;
const { clearSessionMetadataCache, getSessionMetadataCacheStats } = sessionMetadataModule;
const {
  buildTrendDataFromUsageIndex,
  computeUsageFromUsageIndex,
  loadUsageIndexProjection,
} = usageIndexPresentationModule;

function source(sourceId, token, size, projectKeys = ['project-a']) {
  return {
    sourceId,
    provider: 'codex',
    kind: 'file',
    parserVersion: 1,
    version: { token, size, mtimeMs: size },
    projectKeys,
  };
}

function claudeSource(sourceId, token, size, projectKeys = ['project-a']) {
  return {
    sourceId,
    provider: 'claude',
    kind: 'file',
    parserVersion: 1,
    version: { token, size, mtimeMs: size },
    projectKeys,
  };
}

function entry(requestId, timestampMs, totalTokens = 10, overrides = {}) {
  return {
    requestId,
    timestampMs,
    provider: 'codex',
    model: 'gpt-5-codex',
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0,
    cacheSavingsUSD: 0,
    ...overrides,
  };
}

function batch(byteOffset, entries, rebuildCoverage = { kind: 'full' }) {
  return { checkpoint: { byteOffset }, entries, rebuildCoverage };
}

function codexLine(type, timestamp, payload) {
  return JSON.stringify({ type, timestamp, payload });
}

function codexTokenLine(timestamp, input, cached, output, options = {}) {
  return codexLine('event_msg', timestamp, {
    type: 'token_count',
    info: {
      model_context_window: options.contextMax ?? 200_000,
      last_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: options.reasoning ?? 0,
      },
    },
    rate_limits: {
      primary: {
        window_minutes: 300,
        used_percent: options.usedPercent ?? 12,
        resets_at: 1_800_000_000,
      },
    },
  });
}

function claudeUsageLine(id, timestamp, outputTokens, content) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      id,
      model: 'claude-sonnet-4',
      usage: {
        input_tokens: 10,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
      },
      content,
    },
  });
}

test('unchanged source does not invoke scanner or write duplicate usage', async () => {
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  let scans = 0;
  const scanner = {
    scan: async plan => {
      scans += 1;
      assert.equal(plan.mode, 'rebuild');
      return batch(10, [entry('r1', Date.parse('2026-07-16T01:00:00Z'))]);
    },
  };

  assert.equal((await index.refreshSource(source('codex:one', 'v1', 10), scanner)).status, 'rebuilt');
  assert.equal((await index.refreshSource(source('codex:one', 'v1', 10), scanner)).status, 'unchanged');
  assert.equal(scans, 1);
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 1);
});

test('file source descriptors compare versions without reading payload and scanners publish project attribution', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-usage-index-attribution-'));
  const cwd = path.join(tempDir, 'project-a');
  fs.mkdirSync(cwd);
  const claudePath = path.join(tempDir, 'claude.jsonl');
  const codexPath = path.join(tempDir, 'rollout-2026-07-16T00-00-00-12345678-1234-1234-1234-123456789abc.jsonl');
  fs.writeFileSync(claudePath, `${JSON.stringify({ cwd })}\n`);
  fs.writeFileSync(codexPath, `${JSON.stringify({ type: 'session_meta', payload: { cwd } })}\n`);
  const ctx = {
    settings: {},
    nowMs: Date.now(),
    scanBudgetMs: null,
    prioritySourceIds: new Set(),
    includeFullHistory: false,
    force: false,
  };

  clearSessionMetadataCache();
  const claude = buildClaudeUsageIndexSource(ctx, {
    provider: 'claude',
    sourceId: 'claude:test',
    filePath: claudePath,
  });
  const codex = buildCodexUsageIndexSource(ctx, {
    provider: 'codex',
    sourceId: 'codex:test',
    filePath: codexPath,
  });
  assert.equal(getSessionMetadataCacheStats().bodyReads, 0);
  assert.equal(claude.descriptor.projectKeys, undefined);
  assert.equal(codex.descriptor.projectKeys, undefined);

  const claudeBatch = await claude.scanner.scan({
    mode: 'rebuild',
    source: claude.descriptor,
    checkpoint: null,
    previousSessionProjection: null,
  });
  const codexBatch = await codex.scanner.scan({
    mode: 'rebuild',
    source: codex.descriptor,
    checkpoint: null,
    previousSessionProjection: null,
  });
  assert.ok(claudeBatch.projectKeys.includes('project-a'));
  assert.ok(codexBatch.projectKeys.includes('project-a'));
});

test('scanner-discovered project attribution is durable when later descriptors stay payload-free', async () => {
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage(), () => 10_000);
  const descriptor = {
    sourceId: 'codex:deferred-projects',
    provider: 'codex',
    kind: 'file',
    parserVersion: 1,
    version: { token: 'v1', size: 1, mtimeMs: 1 },
  };
  index.declareSources('codex', [descriptor], true);
  await index.refreshSource(descriptor, {
    scan: async () => ({
      checkpoint: { byteOffset: 1 },
      entries: [entry('deferred-project-entry', 1_000)],
      projectKeys: ['project-a'],
      rebuildCoverage: { kind: 'full' },
    }),
  });

  const excludedAfterBuild = await index.queryUsage({ grain: 'month', excludedProjectKeys: ['project-a'] });
  assert.equal(excludedAfterBuild.aggregate.requestCount, 0);

  const nextDescriptor = { ...descriptor, version: { token: 'v2', size: 2, mtimeMs: 2 } };
  index.declareSources('codex', [nextDescriptor], true);
  await index.refreshSource(nextDescriptor, {
    scan: async () => ({
      checkpoint: { byteOffset: 2 },
      entries: [entry('deferred-project-entry-2', 2_000)],
    }),
  });
  const excludedAfterTail = await index.queryUsage({ grain: 'month', excludedProjectKeys: ['project-a'] });
  assert.equal(excludedAfterTail.aggregate.requestCount, 0);
});

test('query coverage stays incomplete for queued or failed discovered sources and completes atomically', async () => {
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const first = source('codex:coverage-one', 'v1', 10);
  const second = source('codex:coverage-two', 'v1', 10);
  index.declareSources('codex', [first, second], true);

  assert.deepEqual((await index.queryUsage({ grain: 'month', providers: new Set(['codex']) })).coverage, {
    state: 'incomplete',
    requiredSourceCount: 2,
    indexedSourceCount: 0,
    pendingSourceCount: 2,
    failedSourceCount: 0,
  });
  await index.refreshSource(first, {
    scan: async () => batch(10, [entry('coverage-one', Date.parse('2026-07-16T01:00:00Z'))]),
  });
  await assert.rejects(index.refreshSource(second, {
    scan: async () => { throw new Error('coverage failure'); },
  }), /coverage failure/);
  assert.deepEqual((await index.queryUsage({ grain: 'month', providers: new Set(['codex']) })).coverage, {
    state: 'incomplete',
    requiredSourceCount: 2,
    indexedSourceCount: 1,
    pendingSourceCount: 0,
    failedSourceCount: 1,
  });

  await index.refreshSource(second, {
    scan: async () => batch(10, [entry('coverage-two', Date.parse('2026-07-16T02:00:00Z'))]),
  });
  assert.deepEqual((await index.queryUsage({ grain: 'month', providers: new Set(['codex']) })).coverage, {
    state: 'complete',
    requiredSourceCount: 2,
    indexedSourceCount: 2,
    pendingSourceCount: 0,
    failedSourceCount: 0,
  });
});

test('reset discards indexed history and checkpoints before current-source reindex', async () => {
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const descriptor = source('codex:reset', 'v1', 10);
  const timestamp = Date.parse('2026-07-16T01:00:00Z');

  await index.refreshSource(descriptor, {
    scan: async () => batch(10, [entry('before-reset', timestamp, 19)]),
  });
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 19);

  await index.reset();
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 0);
  assert.deepEqual(await index.readSessionProjections(), []);

  let mode = null;
  const refreshed = await index.refreshSource(descriptor, {
    scan: async plan => {
      mode = plan.mode;
      return batch(10, [entry('after-reset', timestamp, 7)]);
    },
  });
  assert.equal(mode, 'rebuild');
  assert.equal(refreshed.status, 'rebuilt');
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 7);
});

test('reset invalidates an in-flight tail scan before it can recreate stale partial history', async () => {
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const now = Date.parse('2026-07-16T12:00:00Z');
  const initial = source('codex:reset-race', 'v1', 10);
  await index.refreshSource(initial, {
    scan: async () => batch(10, [entry('before-reset', now, 10)]),
  });

  let releaseScan;
  const scanStarted = new Promise(resolve => {
    releaseScan = resolve;
  });
  let scanEntered;
  const entered = new Promise(resolve => {
    scanEntered = resolve;
  });
  const current = source(initial.sourceId, 'v2', 20);
  const staleRefresh = index.refreshSource(current, {
    scan: async plan => {
      assert.equal(plan.mode, 'tail');
      scanEntered();
      await scanStarted;
      return batch(20, [entry('stale-tail', now + 1, 5)]);
    },
  });
  await entered;

  await index.reset();
  releaseScan();
  await assert.rejects(staleRefresh, /invalidated by UsageIndex reset/);
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 0);

  await index.refreshSource(current, {
    scan: async plan => {
      assert.equal(plan.mode, 'rebuild');
      return batch(20, [entry('current-rebuild', now + 2, 7)]);
    },
  });
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 1);
  await index.close();
});

test('compaction seals aggregate history so repairing old sources cannot double count it', async () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  const dayMs = 24 * 60 * 60 * 1_000;
  const historicalEntries = [200, 100, 40, 10, 1]
    .map(daysAgo => entry(`retention-${daysAgo}`, now - daysAgo * dayMs, 1));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-usage-index-retention-'));
  const adapters = [
    {
      name: 'memory',
      storage: new InMemoryUsageIndexStorage(),
    },
    {
      name: 'sqlite',
      storage: new SqliteUsageIndexStorage(path.join(tempDir, 'usage-index.sqlite')),
    },
  ];

  try {
    for (const adapter of adapters) {
      const index = new DefaultUsageIndex(adapter.storage, () => now);
      try {
        const descriptor = source(`codex:retention-${adapter.name}`, 'v1', 10);
        await index.refreshSource(descriptor, {
          scan: async () => batch(10, historicalEntries),
        });

        assert.deepEqual(await adapter.storage.compact(now), {
          deletedRequestRows: 4,
          deletedHourBuckets: 3,
          deletedDayBuckets: 1,
        }, `${adapter.name} compaction result`);
        assert.equal((await index.readProjectionEntries({})).length, 1, `${adapter.name} request detail`);
        assert.equal((await index.queryUsage({ grain: 'hour' })).aggregate.requestCount, 2, `${adapter.name} hourly history`);
        assert.equal((await index.queryUsage({ grain: 'day' })).aggregate.requestCount, 4, `${adapter.name} daily history`);
        assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 5, `${adapter.name} monthly history`);

        await index.refreshSource(source(descriptor.sourceId, 'v2', 10), {
          scan: async plan => {
            assert.equal(plan.mode, 'rebuild');
            return batch(10, historicalEntries);
          },
        });
        assert.equal(
          (await index.queryUsage({ grain: 'month' })).aggregate.requestCount,
          5,
          `${adapter.name} repair must not duplicate sealed history`,
        );
        assert.equal((await adapter.storage.getSource(descriptor.sourceId)).sealedBeforeMs, now - 8 * dayMs);
      } finally {
        await index.close();
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('canonical projection preserves totals while exposing only retained temporal precision', async () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  const dayMs = 24 * 60 * 60 * 1_000;
  const storage = new InMemoryUsageIndexStorage();
  const index = new DefaultUsageIndex(storage, () => now);
  await index.refreshSource(source('codex:projection', 'v1', 10), {
    scan: async () => batch(10, [200, 100, 40, 10, 1]
      .map(daysAgo => entry(`projection-${daysAgo}`, now - daysAgo * dayMs, 1))),
  });

  const projection = await loadUsageIndexProjection(index, 'codex', [], now);
  assert.equal(projection.recentEntries.length, 1);
  assert.equal(projection.hourly.aggregate.requestCount, 2);
  assert.equal(projection.daily.aggregate.requestCount, 4);
  assert.equal(projection.monthly.aggregate.requestCount, 5);

  const usage = computeUsageFromUsageIndex([projection], {}, now);
  assert.equal(usage.allTimeRequestCount, 5);
  assert.equal(usage.weeklyTimeline.reduce((sum, row) => sum + row.tokens, 0), 4);
  assert.equal(usage.heatmap90.reduce((sum, row) => sum + row.tokens, 0), 4);

  const trend = buildTrendDataFromUsageIndex([projection]);
  assert.equal(trend.daily.reduce((sum, row) => sum + row.requestCount, 0), 4);
  assert.equal(trend.monthly.reduce((sum, row) => sum + row.requestCount, 0), 5);
  await index.close();
});

test('append selects tail and rewrite replaces only the affected source', async () => {
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const now = Date.parse('2026-07-16T01:00:00Z');

  await index.refreshSource(source('codex:one', 'v1', 10), {
    scan: async plan => {
      assert.equal(plan.mode, 'rebuild');
      assert.equal(plan.checkpoint, null);
      return batch(10, [entry('r1', now, 10)]);
    },
  });
  await index.refreshSource(source('codex:other', 'v1', 8, ['project-b']), {
    scan: async () => batch(8, [entry('other', now, 7)]),
  });

  await index.refreshSource(source('codex:one', 'v2', 20), {
    scan: async plan => {
      assert.equal(plan.mode, 'tail');
      assert.equal(plan.checkpoint.byteOffset, 10);
      return batch(20, [entry('r2', now + 1, 5)]);
    },
  });
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 22);

  await index.refreshSource(source('codex:one', 'v3', 6), {
    scan: async plan => {
      assert.equal(plan.mode, 'rebuild');
      assert.equal(plan.checkpoint, null);
      return batch(6, [entry('replacement', now + 2, 3)]);
    },
  });

  const usage = await index.queryUsage({ grain: 'month' });
  assert.equal(usage.aggregate.requestCount, 2);
  assert.equal(usage.aggregate.totalTokens, 10);
});

test('a live file may grow past its discovery stat without rejecting the committed checkpoint', async () => {
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const now = Date.parse('2026-07-16T01:00:00Z');
  const liveSource = source('codex:live-growth', 'v1-size-10', 10);

  await index.refreshSource(liveSource, {
    scan: async plan => {
      assert.equal(plan.mode, 'rebuild');
      return batch(15, [entry('grew-during-scan', now, 10)]);
    },
  });

  await index.refreshSource(source(liveSource.sourceId, 'v2-size-15', 15), {
    scan: async plan => {
      assert.equal(plan.mode, 'tail');
      assert.equal(plan.checkpoint.byteOffset, 15);
      return batch(15, []);
    },
  });
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 1);
  await index.close();
});

test('range rebuild preserves sealed history outside reconstructible coverage', async () => {
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const sealedTimestamp = Date.parse('2025-01-01T00:00:00Z');
  const rebuildTimestamp = Date.parse('2026-07-16T01:00:00Z');

  await index.refreshSource(source('codex:repair', 'v1', 20), {
    scan: async () => batch(20, [
      entry('sealed', sealedTimestamp, 11),
      entry('replace-me', rebuildTimestamp, 13),
    ]),
  });

  await index.refreshSource(source('codex:repair', 'v2', 10), {
    scan: async plan => {
      assert.equal(plan.mode, 'rebuild');
      return batch(10, [entry('replacement', rebuildTimestamp, 3)], {
        kind: 'range',
        fromMs: rebuildTimestamp,
        toMs: rebuildTimestamp + 1,
      });
    },
  });

  const usage = await index.queryUsage({ grain: 'month' });
  assert.equal(usage.aggregate.requestCount, 2);
  assert.equal(usage.aggregate.totalTokens, 14);
});

test('project exclusion filters sources before reduction without multi-project double counting', async () => {
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const now = Date.parse('2026-07-16T01:00:00Z');
  let scans = 0;
  const scanner = {
    scan: async () => {
      scans += 1;
      return batch(10, [entry('r1', now, 11)]);
    },
  };

  await index.refreshSource(source('codex:one', 'v1', 10, ['Project-A', 'Project-Alias']), scanner);
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 11);
  assert.equal((await index.queryUsage({ grain: 'month', excludedProjectKeys: ['PROJECT-ALIAS'] })).aggregate.totalTokens, 0);

  await index.refreshSource(source('codex:one', 'v1', 10, ['Project-Renamed']), scanner);
  assert.equal(scans, 1, 'project metadata updates must not rescan the payload');
  assert.equal((await index.queryUsage({ grain: 'month', excludedProjectKeys: ['project-alias'] })).aggregate.totalTokens, 11);
  assert.equal((await index.queryUsage({ grain: 'month', excludedProjectKeys: ['PROJECT-RENAMED'] })).aggregate.totalTokens, 0);
});

test('failed or invalid scans leave the previous source state unchanged', async () => {
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const now = Date.parse('2026-07-16T01:00:00Z');
  await index.refreshSource(source('codex:one', 'v1', 10), {
    scan: async () => batch(10, [entry('r1', now, 13)]),
  });

  await assert.rejects(
    index.refreshSource(source('codex:one', 'v2', 20), {
      scan: async () => { throw new Error('scanner failed'); },
    }),
    /scanner failed/,
  );
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 13);

  await assert.rejects(
    index.refreshSource(source('codex:one', 'v2', 20), {
      scan: async () => batch(20, [entry('bad', now + 1, 1, { provider: 'claude' })]),
    }),
    /expected codex/,
  );
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 13);
});

test('usage and breakdown filters share source attribution and time bounds', async () => {
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const first = Date.parse('2026-07-15T23:00:00Z');
  const second = Date.parse('2026-07-16T01:00:00Z');
  const breakdown = {
    thinking: 1,
    response: 2,
    toolOutputRead: 0,
    toolOutputEditWrite: 0,
    toolOutputSearch: 0,
    toolOutputGit: 0,
    toolOutputBuildTest: 0,
    toolOutputTerminal: 0,
    toolOutputSubagents: 0,
    toolOutputWeb: 0,
    read: 1,
    editWrite: 0,
    search: 0,
    git: 0,
    buildTest: 0,
    terminal: 0,
    subagents: 0,
    web: 0,
  };

  await index.refreshSource(source('codex:one', 'v1', 10), {
    scan: async () => batch(10, [
      entry('r1', first, 4, { breakdown }),
      entry('r2', second, 6, { breakdown }),
    ]),
  });

  const query = { grain: 'hour', fromMs: second, excludedProjectKeys: [] };
  assert.equal((await index.queryUsage(query)).aggregate.totalTokens, 6);
  const result = await index.queryBreakdown(query);
  assert.equal(result.aggregate.thinking, 1);
  assert.equal(result.aggregate.read, 1);
  assert.equal(result.buckets.length, 1);
});

test('Codex scanner reads one payload stream and commits usage plus session projection at complete-turn boundaries', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-codex-scanner-'));
  const filePath = path.join(tempDir, 'session.jsonl');
  const firstTimestamp = '2026-07-16T01:00:00.000Z';
  const initialLines = [
    codexLine('session_meta', '2026-07-16T00:59:00.000Z', { id: 'session-one', model: 'gpt-5-codex' }),
    codexLine('response_item', '2026-07-16T00:59:10.000Z', {
      type: 'function_call',
      name: 'shell_command',
      arguments: JSON.stringify({ command: 'npm test' }),
    }),
    codexLine('response_item', '2026-07-16T00:59:20.000Z', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }],
    }),
    codexTokenLine(firstTimestamp, 100, 40, 20, { reasoning: 5, usedPercent: 25 }),
  ];
  fs.writeFileSync(filePath, `${initialLines.join('\n')}\n`, 'utf8');

  let bytesRead = 0;
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const scanner = createCodexUsageIndexScanner(filePath, {
    now: () => Date.parse(firstTimestamp),
    onPayloadBytesRead: count => { bytesRead += count; },
  });
  let stat = fs.statSync(filePath);
  const descriptor = source('codex:session-one', `v1:${stat.size}`, stat.size);
  const first = await index.refreshSource(descriptor, scanner);
  assert.equal(first.status, 'rebuilt');
  assert.equal(bytesRead, stat.size);

  const usage = await index.queryUsage({ grain: 'month' });
  assert.equal(usage.aggregate.requestCount, 1);
  assert.equal(usage.aggregate.inputTokens, 60);
  assert.equal(usage.aggregate.cacheReadTokens, 40);
  assert.equal(usage.aggregate.outputTokens, 20);
  const breakdown = await index.queryBreakdown({ grain: 'month' });
  assert.equal(breakdown.aggregate.buildTest, 1);

  const [projection] = await index.readSessionProjections();
  assert.equal(projection.payload.sessionSnapshot.rawModel, 'gpt-5-codex');
  assert.equal(projection.payload.sessionSnapshot.latestInputTokens, 60);
  assert.equal(projection.payload.sessionSnapshot.toolCounts.shell_command, 1);
  assert.equal(projection.payload.sessionSnapshot.activityBreakdown.buildTest, 1);
  assert.equal(projection.payload.sessionSnapshot.codexRateLimits.h5.pct, 25);

  const bytesAfterFirst = bytesRead;
  const unchanged = await index.refreshSource(descriptor, scanner);
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(bytesRead, bytesAfterFirst, 'unchanged refresh must read zero JSONL payload bytes');

  const incompleteTurn = codexLine('response_item', '2026-07-16T01:01:00.000Z', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'pending response' }],
  });
  fs.appendFileSync(filePath, `${incompleteTurn}\n`, 'utf8');
  stat = fs.statSync(filePath);
  const incomplete = await index.refreshSource(source('codex:session-one', `v2:${stat.size}`, stat.size), scanner);
  assert.equal(incomplete.status, 'tailed');
  assert.equal(incomplete.scannedEntries, 0);
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 1);

  const secondTimestamp = '2026-07-16T01:02:00.000Z';
  fs.appendFileSync(filePath, `${codexTokenLine(secondTimestamp, 80, 10, 12)}\n`, 'utf8');
  stat = fs.statSync(filePath);
  const completed = await index.refreshSource(source('codex:session-one', `v3:${stat.size}`, stat.size), scanner);
  assert.equal(completed.status, 'tailed');
  assert.equal(completed.scannedEntries, 1);
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 2);
  const [updatedProjection] = await index.readSessionProjections();
  assert.equal(updatedProjection.payload.sessionSnapshot.toolCounts.shell_command, 1);
  assert.equal(updatedProjection.payload.sessionSnapshot.latestInputTokens, 70);

  await index.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Codex scanner deduplicates repeated usage rows with collision-resistant request IDs', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-codex-duplicate-'));
  const filePath = path.join(tempDir, 'session.jsonl');
  const timestamp = '2026-07-16T01:00:00.000Z';
  const usageLine = codexTokenLine(timestamp, 100, 40, 20);
  fs.writeFileSync(filePath, `${[
    codexLine('session_meta', '2026-07-16T00:59:00.000Z', { id: 'session-duplicate', model: 'gpt-5-codex' }),
    usageLine,
    usageLine,
  ].join('\n')}\n`, 'utf8');

  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const stat = fs.statSync(filePath);
  const result = await index.refreshSource(
    { ...source('codex:duplicate', `v1:${stat.size}`, stat.size), parserVersion: 2 },
    createCodexUsageIndexScanner(filePath, { now: () => Date.parse(timestamp) }),
  );

  assert.equal(result.scannedEntries, 1);
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 1);
  await index.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Claude scanner tails once and replaces streamed request snapshots without double counting', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-claude-scanner-'));
  const filePath = path.join(tempDir, 'session.jsonl');
  const firstTimestamp = '2026-07-16T01:00:00.000Z';
  fs.writeFileSync(filePath, `${claudeUsageLine('msg-1', firstTimestamp, 5, [
    { type: 'tool_use', name: 'Read', input: { file_path: 'one.ts' } },
    { type: 'text', text: 'first' },
  ])}\n`, 'utf8');

  let bytesRead = 0;
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const scanner = createClaudeUsageIndexScanner(filePath, {
    now: () => Date.parse(firstTimestamp),
    onPayloadBytesRead: count => { bytesRead += count; },
  });
  let stat = fs.statSync(filePath);
  await index.refreshSource(claudeSource('claude:session-one', `v1:${stat.size}`, stat.size), scanner);
  assert.equal(bytesRead, stat.size);
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 1);

  const bytesAfterFirst = bytesRead;
  fs.appendFileSync(filePath, `${claudeUsageLine('msg-1', '2026-07-16T01:00:01.000Z', 8, [
    { type: 'tool_use', name: 'Read', input: { file_path: 'one.ts' } },
    { type: 'text', text: 'updated' },
  ])}\n`, 'utf8');
  stat = fs.statSync(filePath);
  const replaced = await index.refreshSource(claudeSource('claude:session-one', `v2:${stat.size}`, stat.size), scanner);
  assert.equal(replaced.status, 'tailed');
  assert.equal(bytesRead - bytesAfterFirst, stat.size - bytesAfterFirst);
  let usage = await index.queryUsage({ grain: 'month' });
  assert.equal(usage.aggregate.requestCount, 1);
  assert.equal(usage.aggregate.outputTokens, 8);
  let [projection] = await index.readSessionProjections();
  assert.equal(projection.payload.sessionSnapshot.toolCounts.Read, 1);

  fs.appendFileSync(filePath, `${claudeUsageLine('msg-2', '2026-07-16T01:01:00.000Z', 4, [
    { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
  ])}\n`, 'utf8');
  stat = fs.statSync(filePath);
  await index.refreshSource(claudeSource('claude:session-one', `v3:${stat.size}`, stat.size), scanner);
  usage = await index.queryUsage({ grain: 'month' });
  assert.equal(usage.aggregate.requestCount, 2);
  assert.equal(usage.aggregate.outputTokens, 12);
  [projection] = await index.readSessionProjections();
  assert.equal(projection.payload.sessionSnapshot.toolCounts.Read, 1);
  assert.equal(projection.payload.sessionSnapshot.toolCounts.Bash, 1);

  await index.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Claude scanner accepts plaintext thinking outside the encrypted-signature calibration band', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-claude-calib-'));
  const filePath = path.join(tempDir, 'session.jsonl');
  const timestamp = '2026-07-16T01:00:00.000Z';
  fs.writeFileSync(filePath, `${claudeUsageLine('msg-calib', timestamp, 20, [
    { type: 'thinking', thinking: 't'.repeat(100), signature: 's'.repeat(514) },
  ])}\n`, 'utf8');

  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const stat = fs.statSync(filePath);
  await index.refreshSource(
    claudeSource('claude:calib-drift', `v1:${stat.size}`, stat.size),
    createClaudeUsageIndexScanner(filePath, { now: () => Date.parse(timestamp) }),
  );

  const usage = await index.queryUsage({ grain: 'month' });
  const breakdown = await index.queryBreakdown({ grain: 'month' });
  assert.equal(usage.aggregate.requestCount, 1);
  assert.equal(usage.aggregate.outputTokens, 20);
  assert.equal(breakdown.aggregate.thinking, 20);

  await index.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Claude classifier errors preserve canonical usage while omitting only unavailable breakdown detail', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-claude-contained-error-'));
  const filePath = path.join(tempDir, 'session.jsonl');
  const timestamp = '2026-07-16T01:00:00.000Z';
  fs.writeFileSync(filePath, `${claudeUsageLine('msg-dirty', timestamp, 5, [
    { type: 'tool_use', input: { file_path: 'missing-name.ts' } },
  ])}\n`, 'utf8');

  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const stat = fs.statSync(filePath);
  const descriptor = claudeSource('claude:contained-error', `v1:${stat.size}`, stat.size);
  index.declareSources('claude', [descriptor], true);

  await index.refreshSource(descriptor, createClaudeUsageIndexScanner(filePath, { now: () => Date.parse(timestamp) }));
  const usage = await index.queryUsage({ grain: 'month' });
  const breakdown = await index.queryBreakdown({ grain: 'month' });
  assert.equal(usage.aggregate.requestCount, 1);
  assert.equal(usage.aggregate.outputTokens, 5);
  assert.equal(usage.coverage.state, 'complete');
  assert.equal(breakdown.aggregate.response, 0);

  await index.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('JSONL stream callback errors reject the scan and remain inside UsageIndex coverage', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-claude-contained-error-'));
  const filePath = path.join(tempDir, 'session.jsonl');
  const timestamp = '2026-07-16T01:00:00.000Z';
  fs.writeFileSync(filePath, `${claudeUsageLine('msg-observer', timestamp, 5, [
    { type: 'text', text: 'valid' },
  ])}\n`, 'utf8');

  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage());
  const stat = fs.statSync(filePath);
  const descriptor = claudeSource('claude:contained-error', `v1:${stat.size}`, stat.size);
  index.declareSources('claude', [descriptor], true);
  await assert.rejects(
    index.refreshSource(descriptor, createClaudeUsageIndexScanner(filePath, {
      now: () => Date.parse(timestamp),
      onPayloadBytesRead: () => { throw new Error('observer failed'); },
    })),
    /observer failed/,
  );
  const coverage = (await index.queryUsage({ grain: 'month' })).coverage;
  assert.equal(coverage.state, 'incomplete');
  assert.equal(coverage.failedSourceCount, 1);

  await index.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('file scanner rebuilds fully remove usage deleted by truncation or an empty rewrite', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-file-rebuild-replacement-'));
  const now = Date.parse('2026-07-16T02:00:00.000Z');
  const providers = [
    {
      id: 'claude',
      initialLines: [
        claudeUsageLine('claude-old', '2026-07-16T01:00:00.000Z', 5, [{ type: 'text', text: 'old' }]),
        claudeUsageLine('claude-keep', '2026-07-16T01:01:00.000Z', 7, [{ type: 'text', text: 'keep' }]),
      ],
      rewrittenLines: [
        claudeUsageLine('claude-keep', '2026-07-16T01:01:00.000Z', 7, [{ type: 'text', text: 'keep' }]),
      ],
      descriptor: (token, size) => claudeSource('claude:rewrite', token, size),
      scanner: filePath => createClaudeUsageIndexScanner(filePath, { now: () => now }),
    },
    {
      id: 'codex',
      initialLines: [
        codexLine('session_meta', '2026-07-16T00:59:00.000Z', { id: 'rewrite', model: 'gpt-5-codex' }),
        codexTokenLine('2026-07-16T01:00:00.000Z', 10, 0, 5),
        codexTokenLine('2026-07-16T01:01:00.000Z', 10, 0, 7),
      ],
      rewrittenLines: [
        codexLine('session_meta', '2026-07-16T00:59:00.000Z', { id: 'rewrite', model: 'gpt-5-codex' }),
        codexTokenLine('2026-07-16T01:01:00.000Z', 10, 0, 7),
      ],
      descriptor: (token, size) => source('codex:rewrite', token, size),
      scanner: filePath => createCodexUsageIndexScanner(filePath, { now: () => now }),
    },
  ];

  try {
    for (const provider of providers) {
      for (const adapter of ['memory', 'sqlite']) {
        const filePath = path.join(tempDir, `${provider.id}-${adapter}.jsonl`);
        const storage = adapter === 'memory'
          ? new InMemoryUsageIndexStorage()
          : new SqliteUsageIndexStorage(path.join(tempDir, `${provider.id}-${adapter}.sqlite`));
        const index = new DefaultUsageIndex(storage, () => now);
        const scanner = provider.scanner(filePath);

        fs.writeFileSync(filePath, `${provider.initialLines.join('\n')}\n`, 'utf8');
        let stat = fs.statSync(filePath);
        await index.refreshSource(provider.descriptor('v1', stat.size), scanner);
        assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 2, `${provider.id}/${adapter} initial`);

        fs.writeFileSync(filePath, `${provider.rewrittenLines.join('\n')}\n`, 'utf8');
        stat = fs.statSync(filePath);
        await index.refreshSource(provider.descriptor('v2', stat.size), scanner);
        assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 1, `${provider.id}/${adapter} truncated`);

        fs.writeFileSync(filePath, '', 'utf8');
        stat = fs.statSync(filePath);
        await index.refreshSource(provider.descriptor('v3', stat.size), scanner);
        assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 0, `${provider.id}/${adapter} emptied`);
        await index.close();
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('canonical queries compact at most once per wall-clock interval regardless of source commit rate', async () => {
  class CountingStorage extends InMemoryUsageIndexStorage {
    compactCalls = 0;
    async compact(nowMs) {
      this.compactCalls += 1;
      return super.compact(nowMs);
    }
  }

  let now = Date.parse('2026-07-16T02:00:00.000Z');
  const storage = new CountingStorage();
  const index = new DefaultUsageIndex(storage, () => now);
  await index.refreshSource(source('codex:compaction-rate', 'v1', 10), {
    scan: async () => batch(10, [entry('first', now, 1)]),
  });
  await index.queryUsage({ grain: 'month' });
  assert.equal(storage.compactCalls, 1);

  for (let i = 1; i <= 5; i += 1) {
    now += 1_000;
    await index.refreshSource(source('codex:compaction-rate', `v${i + 1}`, 10 + i), {
      scan: async () => batch(10 + i, [entry(`tail-${i}`, now, 1)]),
    });
    await index.queryUsage({ grain: 'month' });
  }
  assert.equal(storage.compactCalls, 1, 'rapid commits must not re-arm compaction');

  now += USAGE_COMPACTION_INTERVAL_MS;
  await index.queryUsage({ grain: 'month' });
  assert.equal(storage.compactCalls, 2, 'retention still advances on the wall-clock schedule');
  await index.close();
});

test('SQLite adapter preserves checkpoints and usage across restart', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-usage-index-'));
  const dbPath = path.join(tempDir, 'usage-index.sqlite');
  const now = Date.parse('2026-07-16T01:00:00Z');
  let scans = 0;

  let index = new DefaultUsageIndex(new SqliteUsageIndexStorage(dbPath));
  await index.refreshSource(source('codex:sqlite', 'v1', 10, ['project-a', 'project-alias']), {
    scan: async plan => {
      scans += 1;
      assert.equal(plan.mode, 'rebuild');
      return batch(10, [entry('sqlite-r1', now, 17)]);
    },
  });
  await index.close();

  index = new DefaultUsageIndex(new SqliteUsageIndexStorage(dbPath));
  const result = await index.refreshSource(source('codex:sqlite', 'v1', 10, ['project-a', 'project-alias']), {
    scan: async () => {
      scans += 1;
      throw new Error('unchanged persisted source must not scan');
    },
  });
  assert.equal(result.status, 'unchanged');
  assert.equal(scans, 1);
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 17);
  assert.equal((await index.queryUsage({ grain: 'month', excludedProjectKeys: ['project-alias'] })).aggregate.totalTokens, 0);
  await index.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('SQLite reset cascades all canonical rows and remains empty after restart', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-usage-index-reset-'));
  const dbPath = path.join(tempDir, 'usage-index.sqlite');
  const descriptor = source('codex:sqlite-reset', 'v1', 10);
  const timestamp = Date.parse('2026-07-16T01:00:00Z');

  let index = new DefaultUsageIndex(new SqliteUsageIndexStorage(dbPath));
  await index.refreshSource(descriptor, {
    scan: async () => batch(10, [entry('sqlite-reset-row', timestamp, 23)]),
  });
  await index.reset();
  await index.close();

  index = new DefaultUsageIndex(new SqliteUsageIndexStorage(dbPath));
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 0);
  let mode = null;
  await index.refreshSource(descriptor, {
    scan: async plan => {
      mode = plan.mode;
      return batch(10, [entry('sqlite-reindexed-row', timestamp, 5)]);
    },
  });
  assert.equal(mode, 'rebuild');
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 5);
  await index.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('corrupt SQLite remains preserved and requires explicit reset before clean reindex', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-usage-index-corrupt-'));
  const dbPath = path.join(tempDir, 'usage-index.sqlite');
  const damagedBytes = Buffer.from('this is not a sqlite database', 'utf8');
  fs.writeFileSync(dbPath, damagedBytes);

  const index = await openUsageIndex(dbPath);
  assert.equal(index.getHealth().state, 'unavailable');
  assert.deepEqual(fs.readFileSync(dbPath), damagedBytes);
  assert.equal((await index.queryUsage({ grain: 'month', providers: new Set(['codex']) })).coverage.state, 'incomplete');

  await index.reset();
  const health = index.getHealth();
  assert.equal(health.state, 'ready');
  assert.ok(health.preservedPath);
  assert.deepEqual(fs.readFileSync(health.preservedPath), damagedBytes);
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 0);
  await index.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('SQLite schema v4 maintains source-attributed hour/day/month buckets without duplicate updates', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-usage-index-buckets-'));
  const dbPath = path.join(tempDir, 'usage-index.sqlite');
  const timestamp = Date.parse('2026-07-16T01:10:00Z');
  const descriptor = source('codex:bucket-source', 'v1', 10);

  const index = new DefaultUsageIndex(new SqliteUsageIndexStorage(dbPath));
  await index.refreshSource(descriptor, {
    scan: async () => batch(10, [
      entry('bucket-r1', timestamp, 10),
      entry('bucket-r2', timestamp + 1_000, 4),
    ]),
  });
  await index.refreshSource(source('codex:bucket-source', 'v2', 20), {
    scan: async plan => {
      assert.equal(plan.mode, 'tail');
      return batch(20, [entry('bucket-r1', timestamp, 6)]);
    },
  });
  await index.close();

  const database = new DatabaseSync(dbPath);
  const version = database.prepare('PRAGMA user_version').get().user_version;
  const rows = database.prepare(`
    SELECT bucket_kind, request_count, total_tokens
    FROM usage_bucket
    WHERE source_id = ?
    ORDER BY bucket_kind
  `).all('codex:bucket-source');
  assert.equal(version, usageIndexSchemaVersion());
  assert.deepEqual(rows.map(row => ({ ...row })), [
    { bucket_kind: 'day', request_count: 2, total_tokens: 10 },
    { bucket_kind: 'hour', request_count: 2, total_tokens: 10 },
    { bucket_kind: 'month', request_count: 2, total_tokens: 10 },
  ]);
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('SQLite schema v1 migrates in place and backfills aggregate buckets', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-usage-index-v1-'));
  const dbPath = path.join(tempDir, 'usage-index.sqlite');
  const database = new DatabaseSync(dbPath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE usage_source (
      source_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      parser_version INTEGER NOT NULL,
      version_token TEXT NOT NULL,
      source_size INTEGER,
      mtime_ms REAL,
      checkpoint_json TEXT NOT NULL,
      provider_metadata_json TEXT
    ) STRICT;
    CREATE TABLE usage_source_project (
      source_id TEXT NOT NULL REFERENCES usage_source(source_id) ON DELETE CASCADE,
      project_key TEXT NOT NULL,
      PRIMARY KEY (source_id, project_key)
    ) STRICT;
    CREATE TABLE usage_entry (
      source_id TEXT NOT NULL REFERENCES usage_source(source_id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      cache_savings_usd REAL NOT NULL,
      breakdown_json TEXT,
      PRIMARY KEY (source_id, request_id)
    ) STRICT;
    CREATE INDEX usage_entry_time_provider_model ON usage_entry(timestamp_ms, provider, model);
    CREATE TABLE usage_session_hot (
      source_id TEXT PRIMARY KEY REFERENCES usage_source(source_id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      byte_size INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  database.prepare(`
    INSERT INTO usage_source (
      source_id, provider, source_kind, parser_version, version_token,
      source_size, mtime_ms, checkpoint_json, provider_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('codex:v1', 'codex', 'file', 1, 'v1', 10, 10, '{"byteOffset":10}', null);
  database.prepare(`
    INSERT INTO usage_entry (
      source_id, request_id, timestamp_ms, provider, model,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cost_usd, cache_savings_usd, breakdown_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'codex:v1',
    'v1-row',
    Date.parse('2026-07-16T01:10:00Z'),
    'codex',
    'gpt-5-codex',
    9,
    0,
    0,
    0,
    0,
    0,
    null,
  );
  database.close();

  const storage = new SqliteUsageIndexStorage(dbPath);
  assert.equal(usageIndexSchemaVersion(), 4);
  storage.close();

  const migrated = new DatabaseSync(dbPath);
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 4);
  const providerTables = migrated.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name IN ('usage_source', 'usage_entry', 'usage_bucket', 'usage_session_hot')
  `).all();
  assert.equal(providerTables.length, 4);
  for (const table of providerTables) assert.doesNotMatch(table.sql, /provider\s+IN/i);
  const rows = migrated.prepare(`
    SELECT bucket_kind, request_count, total_tokens FROM usage_bucket ORDER BY bucket_kind
  `).all();
  assert.deepEqual(rows.map(row => ({ ...row })), [
    { bucket_kind: 'day', request_count: 1, total_tokens: 9 },
    { bucket_kind: 'hour', request_count: 1, total_tokens: 9 },
    { bucket_kind: 'month', request_count: 1, total_tokens: 9 },
  ]);
  migrated.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('SQLite source commit rolls back checkpoint when an entry write fails', async () => {
  const storage = new SqliteUsageIndexStorage(':memory:');
  const descriptor = source('codex:rollback', 'v1', 10);
  await assert.rejects(
    storage.commitSource({
      mode: 'rebuild',
      source: descriptor,
      batch: {
        checkpoint: { byteOffset: 10 },
        entries: [{ ...entry('bad', Date.now()), model: null }],
      },
    }),
  );
  assert.equal(await storage.getSource(descriptor.sourceId), null);
  await storage.close();
});

test('Electron runtime loads the built-in SQLite adapter without native modules', {
  skip: process.platform !== 'win32',
}, () => {
  const electronPath = path.resolve('node_modules/electron/dist/electron.exe');
  const probePath = path.resolve('scripts/usage-index-electron-smoke.cjs');
  const result = spawnSync(electronPath, [probePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
});
