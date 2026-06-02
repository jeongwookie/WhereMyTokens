import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { fileUriToPath } from '../dist/main/providers/antigravity/pathUtils.js';
import {
  SESSION_DISCOVERY_LIMIT,
  rankAntigravitySummaries,
  trajectorySummaryToSession,
} from '../dist/main/providers/antigravity/sessions.js';

test('Antigravity file URI parser converts Windows file URIs to local paths', () => {
  const parsed = fileUriToPath('file:///C:/repo/app');

  assert.equal(parsed, `C:${path.sep}repo${path.sep}app`);
});

test('Antigravity session parser adds summaryKey and bounds ranked cascade summaries', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const summaries = {};
  for (let index = 0; index < 300; index += 1) {
    summaries[`cascade-${index}`] = {
      summary: `Task ${index}`,
      createdTime: new Date(now - index * 60_000).toISOString(),
      lastModifiedTime: new Date(now - index * 60_000).toISOString(),
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///C:/repo/app' }],
    };
  }

  const ranked = rankAntigravitySummaries(summaries, now, false);
  assert.equal(ranked.length, SESSION_DISCOVERY_LIMIT);
  assert.equal(ranked[0][0], 'cascade-0');

  const session = trajectorySummaryToSession('cascade-0', ranked[0][1], now);
  assert.equal(session.provider, 'antigravity');
  assert.equal(session.jsonlPath, null);
  assert.equal(session.summaryKey, 'antigravity:cascade:cascade-0');
  assert.equal(session.entrypoint, 'antigravity');
});

test('Antigravity session parser uses created time fallback and leaves unknown mtime idle', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const old = new Date(now - 60 * 60_000).toISOString();
  const cwd = 'file:///C:/repo/app';

  const fromCreated = trajectorySummaryToSession('created-only', {
    createdTime: old,
    workspaces: [{ workspaceFolderAbsoluteUri: cwd }],
  }, now);
  assert.equal(fromCreated.state, 'idle');
  assert.equal(fromCreated.lastModified.getTime(), Date.parse(old));

  const unknownTime = trajectorySummaryToSession('unknown-time', {
    workspaces: [{ workspaceFolderAbsoluteUri: cwd }],
  }, now);
  assert.equal(unknownTime.state, 'idle');
  assert.equal(unknownTime.lastModified, null);
});
