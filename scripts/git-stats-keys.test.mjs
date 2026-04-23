import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import gitStatsKeys from '../dist/main/gitStatsKeys.js';

const {
  isStaleGitStats,
  normalizeGitCwdKey,
  normalizeGitPathKey,
  preferGitStats,
  repoKeyFromGitStats,
} = gitStatsKeys;

function expectedPathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function stats(overrides = {}) {
  const repoRoot = process.platform === 'win32' ? 'C:\\dev\\example-repo' : '/tmp/example-repo';
  return {
    gitCommonDir: expectedPathKey(path.join(repoRoot, '.git')),
    toplevel: expectedPathKey(repoRoot),
    commitsToday: 2,
    linesAdded: 20,
    linesRemoved: 5,
    totalCommits: 10,
    totalLinesAdded: 200,
    totalLinesRemoved: 50,
    ...overrides,
  };
}

test('git cwd cache keys are normalized consistently', () => {
  const input = process.platform === 'win32' ? 'C:\\Dev\\Example-Repo' : '/tmp/Example-Repo';
  assert.equal(normalizeGitCwdKey(input), expectedPathKey(input));
  assert.equal(normalizeGitPathKey(input), expectedPathKey(input));
});

test('repo key prefers gitCommonDir and normalizes it', () => {
  const gitCommonDir = process.platform === 'win32' ? 'C:\\Dev\\Example-Repo\\.git' : '/tmp/Example-Repo/.git';
  const toplevel = process.platform === 'win32' ? 'C:\\Other\\Path' : '/other/path';

  assert.equal(repoKeyFromGitStats(stats({ gitCommonDir, toplevel })), expectedPathKey(gitCommonDir));
});

test('line-only zero-commit stats are treated as stale', () => {
  assert.equal(isStaleGitStats(stats({ commitsToday: 0, linesAdded: 1 })), true);
  assert.equal(isStaleGitStats(stats({ totalCommits: 0, totalLinesAdded: 1 })), true);
  assert.equal(isStaleGitStats(stats({ commitsToday: 4, linesAdded: 0, linesRemoved: 0 })), true);
  assert.equal(isStaleGitStats(stats({ totalCommits: 4, totalLinesAdded: 0, totalLinesRemoved: 0 })), true);
  assert.equal(isStaleGitStats(stats({ commitsToday: 4, totalCommits: 0 })), true);
  assert.equal(isStaleGitStats(stats({ linesAdded: 20, totalLinesAdded: 10 })), true);
  assert.equal(isStaleGitStats(stats({ commitsToday: 0, linesAdded: 0, linesRemoved: 0 })), false);
});

test('fresh stats win over stale duplicate cache entries', () => {
  const stale = stats({
    commitsToday: 0,
    linesAdded: 476,
    linesRemoved: 150,
    totalCommits: 0,
    totalLinesAdded: 24643,
    totalLinesRemoved: 5390,
  });
  const fresh = stats({
    commitsToday: 4,
    linesAdded: 476,
    linesRemoved: 150,
    totalCommits: 162,
    totalLinesAdded: 24643,
    totalLinesRemoved: 5390,
  });

  assert.equal(preferGitStats(stale, fresh), fresh);
  assert.equal(preferGitStats(fresh, stale), fresh);
});
