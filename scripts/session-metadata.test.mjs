import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as sessionMetadata from '../dist/main/sessionMetadata.js';

const {
  clearSessionMetadataCache,
  getSessionMetadataCacheStats,
  invalidateSessionMetadataCache,
  readJsonlCwd,
} = sessionMetadata;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-session-metadata-'));
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.join('\n')}\n`, 'utf8');
}

function fillerRows(count) {
  return Array.from({ length: count }, (_, index) => JSON.stringify({
    type: 'event',
    payload: { index, message: 'x'.repeat(300) },
  }));
}

test('Codex cwd is found after the old 4KB / 12 line window', () => {
  clearSessionMetadataCache();
  const dir = tempDir();
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const filePath = path.join(dir, 'codex-late.jsonl');

  writeJsonl(filePath, [
    '{ malformed',
    ...fillerRows(20),
    JSON.stringify({ type: 'session_meta', timestamp: '2026-04-22T00:00:00.000Z', payload: { id: 's1', cwd } }),
  ]);

  assert.equal(readJsonlCwd(filePath, 'codex'), cwd);
});

test('Codex cwd falls back to turn_context when session_meta is absent', () => {
  clearSessionMetadataCache();
  const dir = tempDir();
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const filePath = path.join(dir, 'codex-turn-context.jsonl');

  writeJsonl(filePath, [
    JSON.stringify({ type: 'turn_context', timestamp: '2026-04-22T00:00:00.000Z', payload: { cwd } }),
  ]);

  assert.equal(readJsonlCwd(filePath, 'codex'), cwd);
});

test('Codex cwd falls back when session_meta has no valid cwd', () => {
  clearSessionMetadataCache();
  const dir = tempDir();
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const filePath = path.join(dir, 'codex-invalid-session-meta.jsonl');

  writeJsonl(filePath, [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-04-22T00:00:00.000Z', payload: { id: 's1' } }),
    JSON.stringify({ type: 'turn_context', timestamp: '2026-04-22T00:00:01.000Z', payload: { cwd } }),
  ]);

  assert.equal(readJsonlCwd(filePath, 'codex'), cwd);
});

test('Malformed lines and unsafe cwd values are ignored', () => {
  clearSessionMetadataCache();
  const dir = tempDir();
  const invalidFile = path.join(dir, 'invalid.jsonl');
  const relativeFile = path.join(dir, 'relative.jsonl');
  const uncFile = path.join(dir, 'unc.jsonl');

  writeJsonl(invalidFile, ['{ nope', JSON.stringify({ type: 'session_meta', payload: { cwd: '' } })]);
  writeJsonl(relativeFile, [JSON.stringify({ type: 'session_meta', payload: { cwd: 'relative\\repo' } })]);
  writeJsonl(uncFile, [JSON.stringify({ type: 'session_meta', payload: { cwd: '\\\\server\\share\\repo' } })]);

  assert.equal(readJsonlCwd(invalidFile, 'codex'), null);
  assert.equal(readJsonlCwd(relativeFile, 'codex'), null);
  assert.equal(readJsonlCwd(uncFile, 'codex'), null);
});

test('Claude cwd is read from top-level cwd field', () => {
  clearSessionMetadataCache();
  const dir = tempDir();
  const cwd = path.join(dir, 'claude-repo');
  fs.mkdirSync(cwd);
  const filePath = path.join(dir, 'claude.jsonl');

  writeJsonl(filePath, [
    '{ malformed',
    JSON.stringify({ cwd, message: { usage: {} } }),
  ]);

  assert.equal(readJsonlCwd(filePath, 'claude'), cwd);
});

test('Cwd cache reuses unchanged files and refreshes after stat changes', () => {
  clearSessionMetadataCache();
  const dir = tempDir();
  const cwdA = path.join(dir, 'repo-a');
  const cwdB = path.join(dir, 'repo-b');
  fs.mkdirSync(cwdA);
  fs.mkdirSync(cwdB);
  const filePath = path.join(dir, 'cache.jsonl');

  writeJsonl(filePath, [
    JSON.stringify({ type: 'session_meta', payload: { cwd: cwdA } }),
  ]);

  assert.equal(readJsonlCwd(filePath, 'codex'), cwdA);
  const afterFirst = getSessionMetadataCacheStats();
  assert.equal(readJsonlCwd(filePath, 'codex'), cwdA);
  const afterSecond = getSessionMetadataCacheStats();

  assert.equal(afterSecond.bodyReads, afterFirst.bodyReads);
  assert.ok(afterSecond.cacheHits > afterFirst.cacheHits);

  writeJsonl(filePath, [
    JSON.stringify({ type: 'session_meta', payload: { cwd: cwdB } }),
    JSON.stringify({ type: 'event', payload: { changed: true } }),
  ]);

  assert.equal(readJsonlCwd(filePath, 'codex'), cwdB);
  const afterThird = getSessionMetadataCacheStats();
  assert.ok(afterThird.bodyReads > afterSecond.bodyReads);
});

test('Metadata cache can invalidate deleted or unlinked files by path', () => {
  clearSessionMetadataCache();
  const dir = tempDir();
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const filePath = path.join(dir, 'invalidate.jsonl');

  writeJsonl(filePath, [
    JSON.stringify({ type: 'session_meta', payload: { cwd } }),
  ]);

  assert.equal(readJsonlCwd(filePath, 'codex'), cwd);
  const afterFirst = getSessionMetadataCacheStats();
  invalidateSessionMetadataCache(filePath);
  assert.equal(readJsonlCwd(filePath, 'codex'), cwd);
  const afterSecond = getSessionMetadataCacheStats();

  assert.ok(afterSecond.bodyReads > afterFirst.bodyReads);
});

test('Transient prefix read failures are not cached as null cwd', () => {
  clearSessionMetadataCache();
  const dir = tempDir();
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const filePath = path.join(dir, 'transient-read-failure.jsonl');

  writeJsonl(filePath, [
    JSON.stringify({ type: 'session_meta', payload: { cwd } }),
  ]);

  const originalOpenSync = fs.openSync;
  let failNextOpen = true;
  fs.openSync = function patchedOpenSync(target, ...args) {
    if (failNextOpen && path.resolve(String(target)) === path.resolve(filePath)) {
      failNextOpen = false;
      throw new Error('simulated transient read failure');
    }
    return originalOpenSync.call(this, target, ...args);
  };

  try {
    assert.equal(readJsonlCwd(filePath, 'codex'), null);
  } finally {
    fs.openSync = originalOpenSync;
  }

  assert.equal(readJsonlCwd(filePath, 'codex'), cwd);
});
