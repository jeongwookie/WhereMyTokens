import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-claude-discovery-'));
}

function encodeCwd(cwd) {
  return cwd.replace(/:/g, '-').replace(/[\\/]/g, '-');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

test('Claude fallback assigns distinct JSONL files for same-cwd sessions', async () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const home = tempDir();
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    const cwd = path.join(home, 'repo');
    const sessionsDir = path.join(home, '.claude', 'sessions');
    const projectDir = path.join(home, '.claude', 'projects', encodeCwd(cwd));
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    writeJson(path.join(sessionsDir, 'older.json'), {
      pid: process.pid,
      sessionId: 'older-session',
      cwd,
      startedAt: '2026-04-22T10:00:00.000Z',
      entrypoint: 'cli',
    });
    writeJson(path.join(sessionsDir, 'newer.json'), {
      pid: process.pid,
      sessionId: 'newer-session',
      cwd,
      startedAt: '2026-04-22T10:10:00.000Z',
      entrypoint: 'cli',
    });

    const olderJsonl = path.join(projectDir, 'claude-old.jsonl');
    const newerJsonl = path.join(projectDir, 'claude-new.jsonl');
    writeJson(olderJsonl, { cwd, message: { usage: {} } });
    writeJson(newerJsonl, { cwd, message: { usage: {} } });
    fs.utimesSync(olderJsonl, new Date('2026-04-22T10:01:00.000Z'), new Date('2026-04-22T10:01:00.000Z'));
    fs.utimesSync(newerJsonl, new Date('2026-04-22T10:11:00.000Z'), new Date('2026-04-22T10:11:00.000Z'));

    const { discoverClaudeSessions } = await import('../dist/main/providers/claude/discovery.js');
    const sessions = discoverClaudeSessions({
      settings: { enableWslTracking: false },
      includeFullHistory: true,
      prioritySourceIds: new Set(),
    });

    assert.equal(sessions.length, 2);
    assert.deepEqual(
      sessions.map(session => path.basename(session.jsonlPath)).sort(),
      ['claude-new.jsonl', 'claude-old.jsonl'],
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
});
