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

test('Claude recent usage sources include agent JSONL files without startup sessions', async () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const home = tempDir();
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    const cwd = path.join(home, 'repo');
    const projectDir = path.join(home, '.claude', 'projects', encodeCwd(cwd));
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    const mainJsonl = path.join(projectDir, 'main-session.jsonl');
    const agentJsonl = path.join(projectDir, 'agent-worker.jsonl');
    writeJson(mainJsonl, { cwd, message: { usage: {} } });
    writeJson(agentJsonl, { cwd, message: { usage: {} } });
    fs.utimesSync(mainJsonl, new Date('2026-04-22T10:01:00.000Z'), new Date('2026-04-22T10:01:00.000Z'));
    fs.utimesSync(agentJsonl, new Date('2026-04-22T10:02:00.000Z'), new Date('2026-04-22T10:02:00.000Z'));

    const { listRecentClaudeSources, buildStartupClaudeSession } = await import('../dist/main/providers/claude/sources.js');
    const result = listRecentClaudeSources({ settings: {} }, 10);
    const basenames = result.sources.map(source => path.basename(source.filePath)).sort();

    assert.deepEqual(basenames, ['agent-worker.jsonl', 'main-session.jsonl']);
    const agentSource = result.sources.find(source => path.basename(source.filePath) === 'agent-worker.jsonl');
    assert.ok(agentSource);
    assert.equal(buildStartupClaudeSession({ settings: {} }, agentSource), null);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
});

test('project discovery scans later Claude JSONL files when the first lacks cwd', async () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const home = tempDir();
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    const cwd = path.join(home, 'repo');
    const projectDir = path.join(home, '.claude', 'projects', encodeCwd(cwd));
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    writeJson(path.join(projectDir, 'aaa-empty.jsonl'), { message: { usage: {} } });
    writeJson(path.join(projectDir, 'bbb-cwd.jsonl'), { cwd, message: { usage: {} } });

    const { discoverAllProjectCwds } = await import('../dist/main/projectDiscovery.js');
    assert.deepEqual(discoverAllProjectCwds(['claude']), [cwd]);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
});
