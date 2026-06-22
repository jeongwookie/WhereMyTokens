import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-claude-discovery-'));
}

function encodeCwd(cwd) {
  return cwd.replace(/:/g, '-').replace(/[\\/]/g, '-');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function clearDistModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function loadClaudeSources() {
  clearDistModule('../dist/main/providers/claude/sources.js');
  clearDistModule('../dist/main/providers/claude/paths.js');
  return require('../dist/main/providers/claude/sources.js');
}

function loadProjectDiscovery() {
  clearDistModule('../dist/main/projectDiscovery.js');
  return require('../dist/main/projectDiscovery.js');
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

    const { listRecentClaudeSources, buildStartupClaudeSession } = loadClaudeSources();
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

test('Claude recent source budget keeps visible session candidates when agent logs are newer', async () => {
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
    writeJson(mainJsonl, { cwd, message: { usage: {} } });
    fs.utimesSync(mainJsonl, new Date('2026-04-22T10:00:00.000Z'), new Date('2026-04-22T10:00:00.000Z'));
    for (let index = 0; index < 48; index += 1) {
      const agentJsonl = path.join(projectDir, `agent-${String(index).padStart(2, '0')}.jsonl`);
      writeJson(agentJsonl, { cwd, message: { usage: {} } });
      const mtime = new Date(Date.parse('2026-04-22T10:01:00.000Z') + index * 1000);
      fs.utimesSync(agentJsonl, mtime, mtime);
    }

    const { listRecentClaudeSources, buildStartupClaudeSession } = loadClaudeSources();
    const result = listRecentClaudeSources({ settings: {} }, 48);
    const mainSource = result.sources.find(source => path.basename(source.filePath) === 'main-session.jsonl');
    const agentCount = result.sources.filter(source => path.basename(source.filePath).startsWith('agent-')).length;

    assert.ok(mainSource);
    assert.equal(agentCount, 48);
    assert.equal(buildStartupClaudeSession({ settings: {} }, mainSource).sessionId, 'main-session');
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
});

test('Claude recent source scan uses file mtimes across older project directories', async () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const home = tempDir();
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    const cwd = path.join(home, 'repo');
    const projectsDir = path.join(home, '.claude', 'projects');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });

    for (let index = 0; index < 14; index += 1) {
      const projectDir = path.join(projectsDir, `newer-dir-${index}`);
      fs.mkdirSync(projectDir, { recursive: true });
      const jsonl = path.join(projectDir, 'main-session.jsonl');
      writeJson(jsonl, { cwd, message: { usage: {} } });
      const oldFileTime = new Date('2026-04-21T10:00:00.000Z');
      const dirTime = new Date(Date.parse('2026-04-23T10:00:00.000Z') + index * 1000);
      fs.utimesSync(jsonl, oldFileTime, oldFileTime);
      fs.utimesSync(projectDir, dirTime, dirTime);
    }

    const oldProjectDir = path.join(projectsDir, 'older-dir-with-hot-agent');
    fs.mkdirSync(oldProjectDir, { recursive: true });
    const hotAgentJsonl = path.join(oldProjectDir, 'agent-hot.jsonl');
    writeJson(hotAgentJsonl, { cwd, message: { usage: {} } });
    fs.utimesSync(hotAgentJsonl, new Date('2026-04-24T10:00:00.000Z'), new Date('2026-04-24T10:00:00.000Z'));
    fs.utimesSync(oldProjectDir, new Date('2026-04-20T10:00:00.000Z'), new Date('2026-04-20T10:00:00.000Z'));

    const { listRecentClaudeSources } = loadClaudeSources();
    const basenames = listRecentClaudeSources({ settings: {} }, 10)
      .sources.map(source => path.basename(source.filePath));

    assert.ok(basenames.includes('agent-hot.jsonl'));
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

    const { discoverAllProjectCwds } = loadProjectDiscovery();
    assert.deepEqual(discoverAllProjectCwds(['claude']), [cwd]);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
});
