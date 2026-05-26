import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import importerModule from '../dist/main/usageLedgerImporter.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { importUsageJsonlIntoSnapshot, sourceHashForPath } = importerModule;
const { emptyUsageLedgerSnapshot, dayModelKey, monthModelKey } = aggregates;
const MODEL = 'Sonnet';

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
  assert.equal(next.dailyModel[dayModelKey('2026-05-25', 'claude', MODEL)].requestCount, 1);
  assert.equal(next.monthlyModel[monthModelKey('2026-05-25', 'claude', MODEL)].requestCount, 1);
  assert.ok(next.sourceCheckpoints[sourceHashForPath(filePath)]);
});

test('usage importer does not double count unchanged source', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'stable.jsonl');
  fs.writeFileSync(filePath, `${claudeLine({ id: 'one', timestamp: '2026-05-25T10:15:00.000Z' })}\n`, 'utf8');
  const first = await importUsageJsonlIntoSnapshot(emptyUsageLedgerSnapshot(), filePath, 'claude', Date.parse('2026-05-25T12:00:00.000Z'));
  const second = await importUsageJsonlIntoSnapshot(first, filePath, 'claude', Date.parse('2026-05-25T12:01:00.000Z'));
  assert.equal(second.dailyModel[dayModelKey('2026-05-25', 'claude', MODEL)].requestCount, 1);
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
