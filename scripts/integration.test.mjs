import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import integration from '../dist/main/integration.js';

const {
  buildBridgeCommand,
  disableIntegration,
  getIntegrationStatus,
  resolveBridgeScriptPath,
  setupIntegration,
} = integration;

function tempSettingsPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-integration-'));
  return path.join(dir, '.claude', 'settings.json');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function tempBridgePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-integration-bridge-'));
  const bridgeJs = path.join(dir, 'bridge.js');
  fs.writeFileSync(bridgeJs, "process.stdout.write('');\n", 'utf8');
  return bridgeJs;
}

test('bridge path resolves inside dist for development and resources when packaged', () => {
  const appPath = path.join('C:', 'dev', 'WhereMyTokens');
  const resourcesPath = path.join('C:', 'Program Files', 'WhereMyTokens', 'resources');
  assert.equal(
    resolveBridgeScriptPath(appPath, resourcesPath, false),
    path.join(appPath, 'dist', 'bridge', 'bridge.js'),
  );
  assert.equal(
    resolveBridgeScriptPath(appPath, resourcesPath, true),
    path.join(resourcesPath, 'bridge', 'bridge.js'),
  );
});

test('setup preserves existing non-statusLine settings', () => {
  const settingsPath = tempSettingsPath();
  const bridgeJs = tempBridgePath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    permissions: { allow: ['Read'] },
    env: { EXAMPLE: '1' },
  }, null, 2), 'utf8');

  const result = setupIntegration(settingsPath, bridgeJs);
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.equal(result.owner, 'wmt');

  const settings = readJson(settingsPath);
  assert.deepEqual(settings.permissions, { allow: ['Read'] });
  assert.deepEqual(settings.env, { EXAMPLE: '1' });
  assert.deepEqual(settings.statusLine, {
    type: 'command',
    command: buildBridgeCommand(bridgeJs),
  });
});

test('setup refuses a missing bridge without modifying settings', () => {
  const settingsPath = tempSettingsPath();
  const bridgeJs = path.join(os.tmpdir(), 'missing-wmt-bridge', 'bridge.js');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: false }), 'utf8');

  const result = setupIntegration(settingsPath, bridgeJs);
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be validated/);
  assert.deepEqual(readJson(settingsPath), { includeCoAuthoredBy: false });
});

test('custom statusLine is not overwritten or deleted', () => {
  const settingsPath = tempSettingsPath();
  const bridgeJs = path.join(os.tmpdir(), 'WhereMyTokens', 'bridge', 'bridge.js');
  const original = {
    statusLine: { type: 'command', command: 'node "C:\\Tools\\custom-status.js"' },
    includeCoAuthoredBy: false,
  };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf8');

  const setupResult = setupIntegration(settingsPath, bridgeJs);
  assert.equal(setupResult.ok, false);
  assert.equal(setupResult.owner, 'other');
  assert.deepEqual(readJson(settingsPath), original);

  const disableResult = disableIntegration(settingsPath, bridgeJs);
  assert.equal(disableResult.ok, false);
  assert.equal(disableResult.owner, 'other');
  assert.deepEqual(readJson(settingsPath), original);
});

test('disable removes only a WhereMyTokens statusLine', () => {
  const settingsPath = tempSettingsPath();
  const bridgeJs = path.join(os.tmpdir(), 'WhereMyTokens', 'bridge', 'bridge.js');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    statusLine: { type: 'command', command: buildBridgeCommand(bridgeJs) },
    cleanupPeriodDays: 30,
  }, null, 2), 'utf8');

  const before = getIntegrationStatus(settingsPath, bridgeJs);
  assert.equal(before.configured, true);
  assert.equal(before.owner, 'wmt');

  const result = disableIntegration(settingsPath, bridgeJs);
  assert.equal(result.ok, true);
  assert.equal(result.configured, false);
  assert.equal(result.owner, 'none');

  const settings = readJson(settingsPath);
  assert.equal(Object.prototype.hasOwnProperty.call(settings, 'statusLine'), false);
  assert.equal(settings.cleanupPeriodDays, 30);
});

test('disable is a safe no-op without statusLine or settings file', () => {
  const missingPath = tempSettingsPath();
  const bridgeJs = path.join(os.tmpdir(), 'WhereMyTokens', 'bridge', 'bridge.js');

  const missingResult = disableIntegration(missingPath, bridgeJs);
  assert.equal(missingResult.ok, true);
  assert.equal(missingResult.owner, 'none');
  assert.equal(fs.existsSync(missingPath), false);

  fs.mkdirSync(path.dirname(missingPath), { recursive: true });
  fs.writeFileSync(missingPath, JSON.stringify({ permissions: { deny: ['Bash'] } }, null, 2), 'utf8');
  const noStatusLineResult = disableIntegration(missingPath, bridgeJs);
  assert.equal(noStatusLineResult.ok, true);
  assert.equal(noStatusLineResult.owner, 'none');
  assert.deepEqual(readJson(missingPath), { permissions: { deny: ['Bash'] } });
});
