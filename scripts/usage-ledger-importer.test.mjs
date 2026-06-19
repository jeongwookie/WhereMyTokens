import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import importerModule from '../dist/main/usageLedgerImporter.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { importUsageJsonlIntoSnapshot, sourceHashForIdentity, sourceHashForPath } = importerModule;
const { emptyUsageLedgerSnapshot, dayModelKey, monthModelKey } = aggregates;
const MODEL = 'Sonnet';

function wslSource(rootDir) {
  const homeDir = `${rootDir}\\home\\example`;
  const codexHomeDir = `${homeDir}\\.codex`;
  const codexSessionsDir = `${codexHomeDir}\\sessions`;
  const codexArchivedSessionsDir = `${codexHomeDir}\\archived_sessions`;
  const codexSessionCleanupArchiveDir = `${codexHomeDir}\\session-cleanup-archive`;
  return {
    id: 'wsl:Ubuntu',
    label: 'WSL Ubuntu',
    kind: 'wsl',
    rootDir,
    homeDir,
    distro: 'Ubuntu',
    linuxHome: '/home/example',
    claudeSessionsDir: `${homeDir}\\.claude\\sessions`,
    claudeProjectsDir: `${homeDir}\\.claude\\projects`,
    codexHomeDir,
    codexSessionsDir,
    codexArchivedSessionsDir,
    codexSessionCleanupArchiveDir,
    codexUsageDirs: [codexSessionsDir, codexArchivedSessionsDir, codexSessionCleanupArchiveDir],
  };
}

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

function codexMetaLine({ id = 'codex-session-a', model = 'gpt-5-codex' } = {}) {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-05-25T10:00:00.000Z',
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

function toolOutputSum(row) {
  return row.toolOutputRead + row.toolOutputEditWrite + row.toolOutputSearch + row.toolOutputGit
    + row.toolOutputBuildTest + row.toolOutputTerminal + row.toolOutputSubagents + row.toolOutputWeb;
}

test('usage importer writes minute, hourly, daily, monthly, and checkpoint aggregates', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'claude.jsonl');
  fs.writeFileSync(filePath, `${claudeLine({ id: 'one', timestamp: '2026-05-25T10:15:00.000Z' })}\n`, 'utf8');
  const snapshot = emptyUsageLedgerSnapshot();
  const next = await importUsageJsonlIntoSnapshot(snapshot, filePath, 'claude', Date.parse('2026-05-25T12:00:00.000Z'));
  assert.equal(Object.keys(next.minuteRecent).length, 1);
  assert.equal(Object.keys(next.hourlyActivity).length, 1);
  assert.equal(next.dailyModel[dayModelKey('2026-05-25', 'claude', MODEL)].requestCount, 1);
  assert.equal(next.monthlyModel[monthModelKey('2026-05-25', 'claude', MODEL)].requestCount, 1);
  const checkpoint = next.sourceCheckpoints[sourceHashForPath(filePath)];
  assert.ok(checkpoint);
  assert.equal('sourceIdentity' in checkpoint, false);
  assert.equal('normalizedPath' in checkpoint, false);
});

test('usage importer does not double count unchanged source', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'stable.jsonl');
  fs.writeFileSync(filePath, `${claudeLine({ id: 'one', timestamp: '2026-05-25T10:15:00.000Z' })}\n`, 'utf8');
  const first = await importUsageJsonlIntoSnapshot(emptyUsageLedgerSnapshot(), filePath, 'claude', Date.parse('2026-05-25T12:00:00.000Z'));
  const second = await importUsageJsonlIntoSnapshot(first, filePath, 'claude', Date.parse('2026-05-25T12:01:00.000Z'));
  assert.equal(second.dailyModel[dayModelKey('2026-05-25', 'claude', MODEL)].requestCount, 1);
});

test('usage importer marks built-in JSONL checkpoints without byte offsets for rebuild', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'missing-offset.jsonl');
  fs.writeFileSync(filePath, `${claudeLine({ id: 'one', timestamp: '2026-05-25T10:15:00.000Z' })}\n`, 'utf8');
  const first = await importUsageJsonlIntoSnapshot(emptyUsageLedgerSnapshot(), filePath, 'claude', Date.parse('2026-05-25T12:00:00.000Z'));
  const sourceHash = sourceHashForPath(filePath);
  const brokenCheckpoint = { ...first.sourceCheckpoints[sourceHash] };
  delete brokenCheckpoint.byteOffset;
  const broken = {
    ...first,
    sourceCheckpoints: {
      ...first.sourceCheckpoints,
      [sourceHash]: brokenCheckpoint,
    },
  };

  const second = await importUsageJsonlIntoSnapshot(broken, filePath, 'claude', Date.parse('2026-05-25T12:01:00.000Z'));

  assert.equal(second.sourceCheckpoints[sourceHash].needsRebuild, true);
  assert.equal(second.sourceCheckpoints[sourceHash].rebuildReason, 'jsonl checkpoint missing byte offset');
  assert.equal(second.dailyModel[dayModelKey('2026-05-25', 'claude', MODEL)].requestCount, 1);

  const third = await importUsageJsonlIntoSnapshot(second, filePath, 'claude', Date.parse('2026-05-25T12:02:00.000Z'));
  assert.equal(third, second);
});

test('usage importer marks checkpoints without usage entries', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(filePath, `${JSON.stringify({ type: 'summary', timestamp: '2026-05-25T10:00:00.000Z' })}\n`, 'utf8');

  const next = await importUsageJsonlIntoSnapshot(emptyUsageLedgerSnapshot(), filePath, 'claude', Date.parse('2026-05-25T12:00:00.000Z'));
  const checkpoint = next.sourceCheckpoints[sourceHashForPath(filePath)];

  assert.ok(checkpoint);
  assert.equal(checkpoint.hasUsage, false);
});

test('usage importer appends without duplicating old records outside repair window', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'append.jsonl');
  const oldLine = claudeLine({ id: 'old', timestamp: '2026-03-01T10:00:00.000Z', input: 5, output: 10 });
  const newLine = claudeLine({ id: 'new', timestamp: '2026-05-25T10:15:00.000Z', input: 7, output: 11 });
  fs.writeFileSync(filePath, `${oldLine}\n`, 'utf8');

  const first = await importUsageJsonlIntoSnapshot(emptyUsageLedgerSnapshot(), filePath, 'claude', Date.parse('2026-05-25T12:00:00.000Z'));
  fs.appendFileSync(filePath, `${newLine}\n`, 'utf8');
  const second = await importUsageJsonlIntoSnapshot(first, filePath, 'claude', Date.parse('2026-05-25T12:01:00.000Z'));

  assert.equal(second.dailyModel[dayModelKey('2026-03-01', 'claude', MODEL)].requestCount, 1);
  assert.equal(second.dailyModel[dayModelKey('2026-05-25', 'claude', MODEL)].requestCount, 1);
  assert.notEqual(second.sourceCheckpoints[sourceHashForPath(filePath)].needsRebuild, true);
});

test('usage importer replaces appended duplicate recent Claude request', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'append-duplicate.jsonl');
  fs.writeFileSync(filePath, `${claudeLine({ id: 'dup', timestamp: '2026-05-25T10:15:00.000Z', output: 10 })}\n`, 'utf8');

  const first = await importUsageJsonlIntoSnapshot(emptyUsageLedgerSnapshot(), filePath, 'claude', Date.parse('2026-05-25T12:00:00.000Z'));
  fs.appendFileSync(filePath, `${claudeLine({ id: 'dup', timestamp: '2026-05-25T10:16:00.000Z', output: 25 })}\n`, 'utf8');
  const second = await importUsageJsonlIntoSnapshot(first, filePath, 'claude', Date.parse('2026-05-25T12:01:00.000Z'));

  assert.equal(second.dailyModel[dayModelKey('2026-05-25', 'claude', MODEL)].requestCount, 1);
  assert.equal(second.dailyModel[dayModelKey('2026-05-25', 'claude', MODEL)].outputTokens, 25);
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
  assert.equal(next.dailyModel[dayModelKey('2026-05-25', 'claude', MODEL)].requestCount, 1);
  assert.equal(next.dailyModel[dayModelKey('2026-05-25', 'claude', MODEL)].outputTokens, 25);
});

test('usage importer keeps Codex raw model across incremental appends', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'codex.jsonl');
  fs.writeFileSync(filePath, [
    codexMetaLine(),
    codexTokenLine({ timestamp: '2026-05-25T10:15:00.000Z', output: 20 }),
    '',
  ].join('\n'), 'utf8');

  const first = await importUsageJsonlIntoSnapshot(emptyUsageLedgerSnapshot(), filePath, 'codex', Date.parse('2026-05-25T12:00:00.000Z'));
  fs.appendFileSync(filePath, `${codexTokenLine({ timestamp: '2026-05-25T10:16:00.000Z', output: 30 })}\n`, 'utf8');
  const second = await importUsageJsonlIntoSnapshot(first, filePath, 'codex', Date.parse('2026-05-25T12:01:00.000Z'));

  const row = second.dailyModel[dayModelKey('2026-05-25', 'codex', 'GPT-5-CODEX')];
  assert.equal(row.requestCount, 2);
  assert.equal(row.outputTokens, 50);
  assert.equal(second.sourceCheckpoints[sourceHashForPath(filePath, 'codex')].rawModel, 'gpt-5-codex');
});

test('Codex open turn is re-read on next import and attributed to closing token_count', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'codex-open-turn.jsonl');
  fs.writeFileSync(filePath, [
    codexMetaLine(),
    codexFunctionCallLine({
      timestamp: '2026-05-25T10:15:01.000Z',
      name: 'apply_patch',
      args: '*** Begin Patch\n*** Update File: app.ts\n+const x = 1;\n*** End Patch',
    }),
    codexAssistantMessageLine({
      timestamp: '2026-05-25T10:15:02.000Z',
      text: 'patched',
    }),
    '',
  ].join('\n'), 'utf8');

  const seed = emptyUsageLedgerSnapshot();
  seed.breakdownStartedDate = '2026-05-25';
  const first = await importUsageJsonlIntoSnapshot(seed, filePath, 'codex', Date.parse('2026-05-25T12:00:00.000Z'));
  const sourceHash = sourceHashForPath(filePath, 'codex');
  assert.equal(Object.keys(first.dailyBreakdown).length, 0);
  assert.equal(Object.keys(first.dailyModel).length, 0);
  assert.equal(first.sourceCheckpoints[sourceHash].byteOffset, 0);

  fs.appendFileSync(filePath, `${codexTokenLine({
    timestamp: '2026-05-25T10:15:03.000Z',
    input: 1000,
    cached: 0,
    output: 347,
    reasoning: 208,
  })}\n`, 'utf8');

  const second = await importUsageJsonlIntoSnapshot(first, filePath, 'codex', Date.parse('2026-05-25T12:01:00.000Z'));
  const row = second.dailyBreakdown['2026-05-25|codex'];
  assert.ok(row);
  assert.equal(row.thinking, 208);
  assert.equal(row.editWrite, 1);
  assert.ok(row.toolOutputEditWrite > 0);
  assert.equal(row.thinking + row.response + toolOutputSum(row), 347);
  assert.equal(second.dailyModel[dayModelKey('2026-05-25', 'codex', 'GPT-5-CODEX')].outputTokens, 347);
  assert.ok(second.sourceCheckpoints[sourceHash].byteOffset > 0);
});

test('Codex breakdown parser errors reject without advancing checkpoint', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'codex-breakdown-error.jsonl');
  fs.writeFileSync(filePath, [
    codexMetaLine(),
    codexTokenLine({
      timestamp: '2026-05-25T10:15:00.000Z',
      output: 5,
      reasoning: 10,
    }),
  ].join('\n'), 'utf8');

  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.breakdownStartedDate = '2026-05-25';

  await assert.rejects(
    () => importUsageJsonlIntoSnapshot(snapshot, filePath, 'codex', Date.parse('2026-05-25T12:00:00.000Z')),
    /exactThinkingTokens/,
  );
  assert.deepEqual(snapshot.sourceCheckpoints, {});
});

test('usage importer dedupes a Codex session imported from active and archive paths', async () => {
  const dir = tempDir();
  const activePath = path.join(dir, 'sessions', 'session.jsonl');
  const archivePath = path.join(dir, 'archived_sessions', 'session.jsonl');
  fs.mkdirSync(path.dirname(activePath), { recursive: true });
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  const body = [
    codexMetaLine({ id: 'same-codex-session' }),
    codexTokenLine({ timestamp: '2026-05-25T10:15:00.000Z', output: 20 }),
    '',
  ].join('\n');
  fs.writeFileSync(activePath, body, 'utf8');
  fs.writeFileSync(archivePath, body, 'utf8');

  const first = await importUsageJsonlIntoSnapshot(emptyUsageLedgerSnapshot(), activePath, 'codex', Date.parse('2026-05-25T12:00:00.000Z'));
  const second = await importUsageJsonlIntoSnapshot(first, archivePath, 'codex', Date.parse('2026-05-25T12:01:00.000Z'));

  const row = second.dailyModel[dayModelKey('2026-05-25', 'codex', 'GPT-5-CODEX')];
  assert.equal(row.requestCount, 1);
  assert.equal(Object.keys(second.sourceCheckpoints).length, 1);
});

test('WSL Claude source hash is stable across UNC aliases', () => {
  const localhostSource = wslSource('\\\\wsl.localhost\\Ubuntu');
  const legacySource = wslSource('\\\\wsl$\\Ubuntu');
  const localhostPath = '\\\\wsl.localhost\\Ubuntu\\home\\example\\.claude\\projects\\repo\\session.jsonl';
  const legacyPath = '\\\\wsl$\\Ubuntu\\home\\example\\.claude\\projects\\repo\\session.jsonl';

  assert.equal(sourceHashForPath(localhostPath, 'claude', localhostSource), sourceHashForPath(legacyPath, 'claude', legacySource));
});

test('WSL Claude import reuses legacy path-based checkpoints', async () => {
  const dir = tempDir();
  const rootDir = path.join(dir, 'wsl-root');
  const filePath = path.join(rootDir, 'home', 'example', '.claude', 'projects', 'repo', 'session.jsonl');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    claudeLine({ id: 'legacy-wsl', timestamp: '2026-05-25T10:15:00.000Z', output: 20 }),
    '',
  ].join('\n'), 'utf8');

  const source = wslSource(rootDir);
  const legacyHash = sourceHashForIdentity(`claude:${path.resolve(filePath)}`);
  const seed = emptyUsageLedgerSnapshot();
  seed.sourceCheckpoints[legacyHash] = {
    provider: 'claude',
    sourceHash: legacyHash,
    lastImportedAt: Date.parse('2026-05-25T09:00:00.000Z'),
    byteOffset: 0,
    size: 0,
    mtimeMs: 0,
  };

  const next = await importUsageJsonlIntoSnapshot(seed, filePath, 'claude', Date.parse('2026-05-25T12:00:00.000Z'), source);

  assert.ok(next.sourceCheckpoints[legacyHash]);
  assert.equal(Object.keys(next.sourceCheckpoints).length, 1);
});

test('usage importer marks shrunken sources for rebuild instead of partially subtracting old rows', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'shrink.jsonl');
  fs.writeFileSync(filePath, [
    claudeLine({ id: 'one', timestamp: '2026-05-25T10:15:00.000Z', output: 20 }),
    claudeLine({ id: 'two', timestamp: '2026-05-25T10:16:00.000Z', output: 30 }),
    '',
  ].join('\n'), 'utf8');
  const first = await importUsageJsonlIntoSnapshot(emptyUsageLedgerSnapshot(), filePath, 'claude', Date.parse('2026-05-25T12:00:00.000Z'));

  fs.writeFileSync(filePath, `${claudeLine({ id: 'one', timestamp: '2026-05-25T10:15:00.000Z', output: 20 })}\n`, 'utf8');
  const second = await importUsageJsonlIntoSnapshot(first, filePath, 'claude', Date.parse('2026-05-25T12:01:00.000Z'));

  const row = second.dailyModel[dayModelKey('2026-05-25', 'claude', MODEL)];
  assert.equal(row.requestCount, 2);
  assert.equal(row.outputTokens, 50);
  assert.equal(second.sourceCheckpoints[sourceHashForPath(filePath)].needsRebuild, true);
});

test('usage importer yields during large source aggregation', () => {
  const source = fs.readFileSync('src/main/usageLedgerIngest.ts', 'utf8');
  assert.match(source, /export const LEDGER_IMPORT_YIELD_EVERY = 250/);
  assert.match(source, /function cooperativeYield\(\): Promise<void>/);
  assert.match(source, /setImmediate\(resolve\)/);
  assert.match(source, /await cooperativeYield\(\)/);
});
