import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ingest from '../dist/main/usageLedgerIngest.js';
import importer from '../dist/main/usageLedgerImporter.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';
import classifier from '../dist/main/activityClassifier.js';

const { importUsageEntriesIntoSnapshot, aggregateFromUsageEntry } = ingest;
const { importUsageJsonlIntoSnapshot, collectSourceEntries } = importer;
const { emptyUsageLedgerSnapshot } = aggregates;
const { claudeLedgerBreakdown } = classifier;

function breakdownDelta(overrides = {}) {
  return {
    thinking: 120,
    response: 80,
    toolOutputRead: 0,
    toolOutputEditWrite: 0,
    toolOutputSearch: 0,
    toolOutputGit: 0,
    toolOutputBuildTest: 0,
    toolOutputTerminal: 0,
    toolOutputSubagents: 0,
    toolOutputWeb: 0,
    read: 1,
    editWrite: 1,
    search: 0,
    git: 0,
    buildTest: 0,
    terminal: 0,
    subagents: 0,
    web: 0,
    ...overrides,
  };
}

function localDate(timestampMs) {
  const d = new Date(timestampMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function entry(over = {}) {
  return {
    provider: 'claude',
    requestId: 'r1',
    timestampMs: Date.parse('2026-06-10T10:00:00Z'),
    model: 'Sonnet',
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0,
    cacheSavingsUSD: 0,
    breakdown: breakdownDelta(),
    ...over,
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-breakdown-ingest-'));
}

function claudeLine({ id, timestamp, input = 10, output = 20, content = [{ type: 'text', text: 'done' }] }) {
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
      content,
    },
  });
}

function codexMetaLine({ id = 'codex-session-a', model = 'gpt-5-codex' } = {}) {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-06-09T00:00:00.000Z',
    payload: { id, model },
  });
}

function codexTokenLine({ timestamp, input = 100, cached = 40, output = 20, reasoning = 0 }) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
        },
        model_context_window: 200000,
      },
    },
  });
}

function codexFunctionCallLine({ timestamp, name = 'shell_command', args = JSON.stringify({ command: 'npm test' }) }) {
  return JSON.stringify({
    type: 'response_item',
    timestamp,
    payload: {
      type: 'function_call',
      name,
      arguments: args,
    },
  });
}

function codexAssistantMessageLine({ timestamp, text = 'done', contentType = 'output_text' }) {
  return JSON.stringify({
    type: 'response_item',
    timestamp,
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: contentType, text }],
    },
  });
}

function writeTempJsonl(provider, lines) {
  const dir = tempDir();
  const filePath = path.join(dir, `${provider}.jsonl`);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

async function importLines(provider, lines, nowMs, seed = emptyUsageLedgerSnapshot()) {
  const filePath = writeTempJsonl(provider, lines);
  return importUsageJsonlIntoSnapshot(seed, filePath, provider, nowMs);
}

function toolOutputSum(row) {
  return row.toolOutputRead + row.toolOutputEditWrite + row.toolOutputSearch + row.toolOutputGit
    + row.toolOutputBuildTest + row.toolOutputTerminal + row.toolOutputSubagents + row.toolOutputWeb;
}

test('claudeLedgerBreakdown splits output 3 ways: thinking(proxy)/response/toolOutput, exact sum', () => {
  const content = [
    { type: 'thinking', thinking: '', signature: 'x'.repeat(240) },
    { type: 'text', text: 'y'.repeat(100) },
    { type: 'tool_use', name: 'Edit', input: { file_path: 'a', new_string: 'z'.repeat(100) } },
  ];
  const d = claudeLedgerBreakdown(content, 600);
  assert.equal(d.editWrite, 1);
  assert.ok(d.toolOutputEditWrite > 0);
  assert.ok(d.thinking > 0);
  const toolSum = d.toolOutputRead + d.toolOutputEditWrite + d.toolOutputSearch + d.toolOutputGit
    + d.toolOutputBuildTest + d.toolOutputTerminal + d.toolOutputSubagents + d.toolOutputWeb;
  assert.equal(d.thinking + d.response + toolSum, 600);
});

test('claudeLedgerBreakdown: redacted_thinking uses data length as proxy', () => {
  const content = [{ type: 'redacted_thinking', data: 'x'.repeat(240) }, { type: 'text', text: 'y'.repeat(100) }];
  const d = claudeLedgerBreakdown(content, 200);
  assert.ok(d.thinking > 0);
  const toolSum = d.toolOutputRead + d.toolOutputEditWrite + d.toolOutputSearch + d.toolOutputGit
    + d.toolOutputBuildTest + d.toolOutputTerminal + d.toolOutputSubagents + d.toolOutputWeb;
  assert.equal(d.thinking + d.response + toolSum, 200);
});

test('claudeLedgerBreakdown: tool_use with non-string name THROWS (fail-loud, no silent misrouting)', () => {
  assert.throws(() => claudeLedgerBreakdown([{ type: 'tool_use', name: 42, input: {} }], 100), /tool_use block without string name/);
  assert.throws(() => claudeLedgerBreakdown([{ type: 'tool_use', input: {} }], 100), /tool_use block without string name/);
});

test('claudeLedgerBreakdown: counts non-regression - pure tool turn still counts, all output attributable', () => {
  const content = [{ type: 'tool_use', name: 'Read', input: { file_path: 'a' } }];
  const d = claudeLedgerBreakdown(content, 50);
  assert.equal(d.read, 1);
  assert.equal(d.thinking, 0);
  assert.equal(d.toolOutputRead, 50);
});

test('ingest accumulates per date|provider output tokens + tool COUNTS', async () => {
  const e = entry();
  const nowMs = Date.parse('2026-06-11T00:00:00Z');
  const snap = await importUsageEntriesIntoSnapshot(
    emptyUsageLedgerSnapshot(),
    { provider: 'claude', sourceHash: 's1' },
    [{ entry: e, aggregate: aggregateFromUsageEntry(e) }],
    nowMs,
  );
  const row = snap.dailyBreakdown['2026-06-10|claude'];
  assert.equal(row.thinking, 120);
  assert.equal(row.response, 80);
  assert.equal(row.read, 1);
  assert.equal(row.editWrite, 1);
  assert.equal(row.firstSeenDate, '2026-06-10');
  assert.equal(snap.breakdownStartedDate, localDate(nowMs));
});

test('ingest sums two entries into the same date|provider bucket', async () => {
  const a = entry({ requestId: 'a' });
  const b = entry({
    requestId: 'b',
    breakdown: breakdownDelta({ thinking: 10, response: 5, read: 1, editWrite: 0 }),
  });
  const snap = await importUsageEntriesIntoSnapshot(
    emptyUsageLedgerSnapshot(),
    { provider: 'claude', sourceHash: 's1' },
    [{ entry: a, aggregate: aggregateFromUsageEntry(a) }, { entry: b, aggregate: aggregateFromUsageEntry(b) }],
    Date.parse('2026-06-11T00:00:00Z'),
  );
  assert.equal(snap.dailyBreakdown['2026-06-10|claude'].thinking, 130);
  assert.equal(snap.dailyBreakdown['2026-06-10|claude'].read, 2);
});

test('entry without a breakdown delta does not create a dailyBreakdown row', async () => {
  const e = entry({ breakdown: undefined });
  const snap = await importUsageEntriesIntoSnapshot(
    emptyUsageLedgerSnapshot(),
    { provider: 'claude', sourceHash: 's1' },
    [{ entry: e, aggregate: aggregateFromUsageEntry(e) }],
    Date.parse('2026-06-11T00:00:00Z'),
  );
  assert.equal(snap.dailyBreakdown['2026-06-10|claude'], undefined);
});

test('latest-wins: re-emitting the same requestId reconciles, not double-counts', async () => {
  const first = entry({
    requestId: 'dup',
    outputTokens: 200,
    breakdown: breakdownDelta({ thinking: 120, response: 80, read: 1, editWrite: 0 }),
  });
  const second = entry({
    requestId: 'dup',
    outputTokens: 400,
    breakdown: breakdownDelta({ thinking: 240, response: 160, read: 2, editWrite: 0 }),
  });
  let snap = await importUsageEntriesIntoSnapshot(
    emptyUsageLedgerSnapshot(),
    { provider: 'claude', sourceHash: 's1' },
    [{ entry: first, aggregate: aggregateFromUsageEntry(first) }],
    Date.parse('2026-06-11T00:00:00Z'),
  );
  snap = await importUsageEntriesIntoSnapshot(
    snap,
    { provider: 'claude', sourceHash: 's1' },
    [{ entry: second, aggregate: aggregateFromUsageEntry(second) }],
    Date.parse('2026-06-11T00:00:00Z'),
  );
  const row = snap.dailyBreakdown['2026-06-10|claude'];
  assert.equal(row.thinking, 240);
  assert.equal(row.response, 160);
  assert.equal(row.read, 2);
});

test('latest-wins holds for entries older than the minute window (breakdown subtract independent of recentRequestIndex)', async () => {
  // Entry dated 2026-06-10 ingested with nowMs on 2026-06-25 → older than MINUTE_RECENT_RETENTION_MS
  // (8 days), so recentRequestIndex is NOT written; the breakdown subtract must still fire on re-emit
  // or dailyBreakdown would double-count. (dailyModel has a pre-existing equivalent limitation here.)
  const nowMs = Date.parse('2026-06-25T00:00:00Z');
  const e = entry({
    requestId: 'old-dup',
    timestampMs: Date.parse('2026-06-10T10:00:00Z'),
    breakdown: breakdownDelta({ thinking: 50, response: 50, read: 1, editWrite: 0 }),
  });
  let snap = await importUsageEntriesIntoSnapshot(
    emptyUsageLedgerSnapshot(),
    { provider: 'claude', sourceHash: 's1' },
    [{ entry: e, aggregate: aggregateFromUsageEntry(e) }],
    nowMs,
  );
  snap = await importUsageEntriesIntoSnapshot(
    snap,
    { provider: 'claude', sourceHash: 's1' },
    [{ entry: e, aggregate: aggregateFromUsageEntry(e) }],
    nowMs,
  );
  const row = snap.dailyBreakdown['2026-06-10|claude'];
  assert.equal(row.thinking, 50); // not 100 — breakdown deduped despite no recentRequestIndex peer
  assert.equal(row.read, 1);      // not 2
  assert.equal(Object.keys(snap.recentRequestIndex).length, 0); // confirms the asymmetry path is exercised
});

test('latest-wins reversal carries tool output fields back to empty', async () => {
  const nowMs = Date.parse('2026-06-11T00:00:00Z');
  const first = entry({
    requestId: 'tool-output-dup',
    outputTokens: 200,
    breakdown: breakdownDelta({
      thinking: 100,
      response: 50,
      toolOutputEditWrite: 50,
      read: 0,
      editWrite: 1,
    }),
  });
  const second = entry({
    requestId: 'tool-output-dup',
    outputTokens: 201,
    breakdown: undefined,
  });
  let snap = await importUsageEntriesIntoSnapshot(
    emptyUsageLedgerSnapshot(),
    { provider: 'claude', sourceHash: 's1' },
    [{ entry: first, aggregate: aggregateFromUsageEntry(first) }],
    nowMs,
  );
  assert.equal(snap.dailyBreakdown['2026-06-10|claude'].toolOutputEditWrite, 50);

  snap = await importUsageEntriesIntoSnapshot(
    snap,
    { provider: 'claude', sourceHash: 's1' },
    [{ entry: second, aggregate: aggregateFromUsageEntry(second) }],
    nowMs,
  );

  assert.equal(snap.dailyBreakdown['2026-06-10|claude'], undefined);
});

test('Codex complete turn emits one token_count usage entry with exact thinking and real tool layer', async () => {
  const filePath = writeTempJsonl('codex', [
    codexMetaLine(),
    codexFunctionCallLine({
      timestamp: '2026-06-10T10:00:01.000Z',
      name: 'apply_patch',
      args: '*** Begin Patch\n*** Update File: app.ts\n+const x = 1;\n*** End Patch',
    }),
    codexAssistantMessageLine({
      timestamp: '2026-06-10T10:00:02.000Z',
      text: 'patched',
    }),
    codexTokenLine({
      timestamp: '2026-06-10T10:00:03.000Z',
      input: 1000,
      cached: 0,
      output: 347,
      reasoning: 208,
    }),
  ]);

  const result = await collectSourceEntries(
    filePath,
    'codex',
    Date.parse('2026-06-10T12:00:00.000Z'),
    0,
    '',
    'codex:test-complete-turn',
    '2026-06-09',
  );

  assert.equal(result.entries.length, 1);
  const [{ entry: usage }] = result.entries;
  assert.equal(usage.countsAsUsage, true);
  assert.equal(usage.outputTokens, 347);
  assert.equal(usage.breakdown.thinking, 208);
  assert.ok(usage.breakdown.toolOutputEditWrite > 0);
  assert.equal(usage.breakdown.editWrite, 1);
  assert.equal(usage.breakdown.thinking + usage.breakdown.response + toolOutputSum(usage.breakdown), 347);
});

test('Codex open turn without token_count emits no entry and does not advance byteOffset', async () => {
  const filePath = writeTempJsonl('codex', [
    codexMetaLine(),
    codexFunctionCallLine({
      timestamp: '2026-06-10T10:00:01.000Z',
      name: 'apply_patch',
      args: '*** Begin Patch\n*** Update File: app.ts\n+const x = 1;\n*** End Patch',
    }),
    codexAssistantMessageLine({
      timestamp: '2026-06-10T10:00:02.000Z',
      text: 'patched',
      contentType: 'text',
    }),
  ]);

  const result = await collectSourceEntries(
    filePath,
    'codex',
    Date.parse('2026-06-10T12:00:00.000Z'),
    0,
    '',
    'codex:test-open-turn',
    '2026-06-09',
  );

  assert.equal(result.entries.length, 0);
  assert.equal(result.byteOffset, 0);
});

test('R2-002 applier: an entry without breakdown rebuilds dailyModel but contributes NO dailyBreakdown', async () => {
  const nowMs = Date.parse('2026-06-20T12:00:00Z');
  const oldNoBreakdown = entry({
    requestId: 'old',
    timestampMs: Date.parse('2026-06-10T10:00:00Z'),
    breakdown: undefined,
  });
  const snap = await importUsageEntriesIntoSnapshot(
    emptyUsageLedgerSnapshot(),
    { provider: 'claude', sourceHash: 's1' },
    [{ entry: oldNoBreakdown, aggregate: aggregateFromUsageEntry(oldNoBreakdown) }],
    nowMs,
  );
  assert.ok(Object.keys(snap.dailyModel).some(k => k.startsWith('2026-06-10|claude|')));
  assert.equal(snap.dailyBreakdown['2026-06-10|claude'], undefined);
});

test('R2-002 importer gate: pre-boundary JSONL rebuilds dailyModel but not dailyBreakdown', async () => {
  const snap = await importLines('claude', [
    claudeLine({ id: 'old', timestamp: '2026-06-10T10:00:00.000Z', output: 20 }),
  ], Date.parse('2026-06-20T12:00:00.000Z'));
  assert.ok(Object.keys(snap.dailyModel).some(k => k.startsWith('2026-06-10|claude|Sonnet')));
  assert.equal(snap.dailyBreakdown['2026-06-10|claude'], undefined);
});

test('R2-002 importer gate: on-or-after-boundary JSONL populates dailyBreakdown', async () => {
  const snap = await importLines('claude', [
    claudeLine({
      id: 'new',
      timestamp: '2026-06-20T10:00:00.000Z',
      output: 20,
      content: [{ type: 'thinking', thinking: 'aa' }, { type: 'text', text: 'bb' }, { type: 'tool_use', name: 'Read', input: { file_path: 'x' } }],
    }),
  ], Date.parse('2026-06-20T12:00:00.000Z'));
  const row = snap.dailyBreakdown['2026-06-20|claude'];
  assert.ok(row.thinking > 0);
  assert.ok(row.response > 0);
  assert.ok(row.toolOutputRead > 0);
  assert.equal(row.thinking + row.response + row.toolOutputRead, 20);
  assert.equal(row.read, 1);
});

test('Codex function_call count rides on the closing token_count date', async () => {
  const seed = emptyUsageLedgerSnapshot();
  seed.breakdownStartedDate = '2026-06-09';
  const snap = await importLines('codex', [
    codexMetaLine(),
    codexFunctionCallLine({ timestamp: '2026-06-09T10:00:00.000Z', name: 'shell_command', args: JSON.stringify({ command: 'npm test' }) }),
    codexAssistantMessageLine({ timestamp: '2026-06-09T10:00:01.000Z', text: 'running tests' }),
    codexTokenLine({ timestamp: '2026-06-10T10:00:00.000Z', output: 33 }),
  ], Date.parse('2026-06-10T12:00:00.000Z'), seed);
  assert.equal(snap.dailyBreakdown['2026-06-09|codex'], undefined);
  const row = snap.dailyBreakdown['2026-06-10|codex'];
  assert.equal(row.buildTest, 1);
  assert.ok(row.toolOutputBuildTest > 0);
  assert.equal(row.thinking + row.response + toolOutputSum(row), 33);
});

test('Codex function_call after token_count remains an open turn with no standalone row', async () => {
  const seed = emptyUsageLedgerSnapshot();
  seed.breakdownStartedDate = '2026-06-09';
  const snap = await importLines('codex', [
    codexMetaLine(),
    codexTokenLine({ timestamp: '2026-06-10T10:00:00.000Z', output: 44 }),
    codexFunctionCallLine({ timestamp: '2026-06-10T10:01:00.000Z', name: 'shell_command', args: JSON.stringify({ command: 'npm test' }) }),
  ], Date.parse('2026-06-10T12:00:00.000Z'), seed);
  const row = snap.dailyBreakdown['2026-06-10|codex'];
  assert.equal(row.response, 44);
  assert.equal(row.buildTest, 0);
  assert.equal(row.toolOutputBuildTest, 0);
});

test('Codex end-of-file function_call without following token_count emits no usage or counts', async () => {
  const seed = emptyUsageLedgerSnapshot();
  seed.breakdownStartedDate = '2026-06-09';
  const snap = await importLines('codex', [
    codexMetaLine(),
    codexFunctionCallLine({ timestamp: '2026-06-09T10:00:00.000Z', name: 'shell_command', args: JSON.stringify({ command: 'npm test' }) }),
  ], Date.parse('2026-06-10T12:00:00.000Z'), seed);
  assert.equal(snap.dailyBreakdown['2026-06-09|codex'], undefined);
  assert.equal(Object.keys(snap.dailyModel).length, 0);
});
