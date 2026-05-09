import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import jsonlParser from '../dist/main/jsonlParser.js';
import jsonlCache from '../dist/main/jsonlCache.js';

const { scanCodexRateLimitsOnly, scanJsonlSummaryCached } = jsonlParser;
const { JsonlCache } = jsonlCache;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-jsonl-summary-'));
}

function recentIso(offsetMs = 0) {
  return new Date(Date.now() - 60_000 + offsetMs).toISOString();
}

function claudeAssistantLine({ id, timestamp = recentIso(), model = 'claude-sonnet-4', input = 10, output = 20, cacheCreation = 0, cacheRead = 0 }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
      },
      content: [
        { type: 'text', text: 'done' },
      ],
    },
  });
}

test('streaming summary scan does not use full readFileSync for JSONL bodies', async () => {
  const cache = new JsonlCache();
  cache.clearAll();
  const dir = tempDir();
  const filePath = path.join(dir, 'claude.jsonl');
  fs.writeFileSync(filePath, `${claudeAssistantLine({ id: 'a' })}\n`, 'utf8');

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(target, ...args) {
    if (path.resolve(String(target)) === path.resolve(filePath)) {
      throw new Error('scan should not full-read JSONL');
    }
    return originalReadFileSync.call(this, target, ...args);
  };

  try {
    const summary = await scanJsonlSummaryCached(filePath, 'claude', cache, true);
    assert.equal(summary.recentEntries.length, 1);
    assert.equal(summary.sessionSnapshot.modelName, 'Sonnet');
  } finally {
    fs.readFileSync = originalReadFileSync;
    cache.clearAll();
  }
});

test('unchanged file reuses cached summary without reopening the stream', async () => {
  const cache = new JsonlCache();
  cache.clearAll();
  const dir = tempDir();
  const filePath = path.join(dir, 'cached.jsonl');
  fs.writeFileSync(filePath, `${claudeAssistantLine({ id: 'cache-hit' })}\n`, 'utf8');

  await scanJsonlSummaryCached(filePath, 'claude', cache, true);

  const originalCreateReadStream = fs.createReadStream;
  fs.createReadStream = function patchedCreateReadStream(target, ...args) {
    if (path.resolve(String(target)) === path.resolve(filePath)) {
      throw new Error('cached scan should not reopen the file');
    }
    return originalCreateReadStream.call(this, target, ...args);
  };

  try {
    const summary = await scanJsonlSummaryCached(filePath, 'claude', cache, false);
    assert.equal(summary.recentEntries.length, 1);
  } finally {
    fs.createReadStream = originalCreateReadStream;
    cache.clearAll();
  }
});

test('Claude duplicate request updates output delta without double counting', async () => {
  const cache = new JsonlCache();
  cache.clearAll();
  const dir = tempDir();
  const filePath = path.join(dir, 'duplicate.jsonl');
  fs.writeFileSync(filePath, `${claudeAssistantLine({ id: 'dup-1', output: 10 })}\n`, 'utf8');

  await scanJsonlSummaryCached(filePath, 'claude', cache, true);
  fs.appendFileSync(filePath, `${claudeAssistantLine({ id: 'dup-1', timestamp: recentIso(1_000), output: 25 })}\n`, 'utf8');

  const summary = await scanJsonlSummaryCached(filePath, 'claude', cache, false);

  assert.equal(summary.recentEntries.length, 1);
  assert.equal(summary.recentEntries[0].outputTokens, 25);
});

test('Codex rate-limit-only scan reads account windows without usage data', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'codex-limits.jsonl');
  const nowSec = Math.floor(Date.now() / 1000);
  fs.writeFileSync(filePath, `${JSON.stringify({
    type: 'event_msg',
    timestamp: recentIso(),
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 11, window_minutes: 300, resets_at: nowSec + 3 * 60 * 60 },
        secondary: { used_percent: 3, window_minutes: 10080, resets_at: nowSec + 6 * 24 * 60 * 60 },
      },
    },
  })}\n`, 'utf8');

  const limits = await scanCodexRateLimitsOnly(filePath);

  assert.equal(limits.h5.pct, 11);
  assert.equal(limits.week.pct, 3);
});

test('Codex rate-limit-only scan keeps millisecond event ordering', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'codex-limits-order.jsonl');
  const nowSec = Math.floor(Date.now() / 1000);
  const base = Date.now() - 60_000;
  const older = new Date(base).toISOString();
  const newer = new Date(base + 350).toISOString();
  const line = (timestamp, pct) => JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: pct, window_minutes: 300, resets_at: nowSec + 3 * 60 * 60 },
        secondary: { used_percent: 2, window_minutes: 10080, resets_at: nowSec + 6 * 24 * 60 * 60 },
      },
    },
  });
  fs.writeFileSync(filePath, `${line(newer, 14)}\n${line(older, 5)}\n`, 'utf8');

  const limits = await scanCodexRateLimitsOnly(filePath);

  assert.equal(limits.h5.pct, 14);
});

test('malformed trailing JSONL text is recovered on append', async () => {
  const cache = new JsonlCache();
  cache.clearAll();
  const dir = tempDir();
  const filePath = path.join(dir, 'trailing.jsonl');

  const first = claudeAssistantLine({ id: 'first', output: 10 });
  const partialPrefix = `{"type":"assistant","timestamp":"${recentIso(1_000)}","message":{"id":"second","model":"claude-sonnet-4","usage":{"input_tokens":10`;
  fs.writeFileSync(filePath, `${first}\n${partialPrefix}`, 'utf8');

  const firstSummary = await scanJsonlSummaryCached(filePath, 'claude', cache, true);
  assert.equal(firstSummary.recentEntries.length, 1);

  fs.appendFileSync(filePath, ',"output_tokens":30,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"content":[{"type":"text","text":"done"}]}}\n', 'utf8');
  const secondSummary = await scanJsonlSummaryCached(filePath, 'claude', cache, false);

  assert.equal(secondSummary.recentEntries.length, 2);
  assert.equal(secondSummary.recentEntries[1].outputTokens, 30);
});
