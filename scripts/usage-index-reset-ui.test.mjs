import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('StateManager resets only the canonical UsageIndex before current-source reindex', () => {
  const stateManager = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  assert.match(stateManager, /async resetUsageIndex\(\): Promise<void>/);
  assert.match(stateManager, /await this\.usageIndex\.reset\(\)/);
  assert.match(stateManager, /includeFullHistory: true/);
  assert.doesNotMatch(stateManager, /usageLedgerStore|jsonlCache|antigravity-usage-cache/);
});

test('IPC and preload expose only the UsageIndex reset contract', () => {
  const ipc = fs.readFileSync('src/main/ipc.ts', 'utf8');
  const preload = fs.readFileSync('src/main/preload.ts', 'utf8');
  const index = fs.readFileSync('src/main/index.ts', 'utf8');
  const types = fs.readFileSync('src/renderer/types.ts', 'utf8');

  assert.match(ipc, /usage-index:reset/);
  assert.match(ipc, /resetUsageIndex/);
  assert.doesNotMatch(ipc, /ledger:rebuild|rebuildUsageLedger/);
  assert.match(preload, /resetIndex/);
  assert.doesNotMatch(preload, /rebuildLedger/);
  assert.match(index, /manager\.resetUsageIndex\(\)/);
  assert.match(types, /resetIndex:\s+\(\) => Promise<AppState>/);
});

test('SettingsView labels reset as destructive and requires confirmation', () => {
  const settingsView = fs.readFileSync('src/renderer/views/SettingsView.tsx', 'utf8');
  assert.match(settingsView, /handleResetIndex/);
  assert.match(settingsView, /window\.confirm/);
  assert.match(settingsView, /window\.wmt\.resetIndex/);
  assert.match(settingsView, /Reset index/);
  assert.match(settingsView, /Unavailable history will be lost/);
  assert.doesNotMatch(settingsView, /Rebuild ledger/);
});

test('readmes describe SQLite history and the destructive reset control', () => {
  const en = fs.readFileSync('README.md', 'utf8');
  const zh = fs.readFileSync('README.zh-CN.md', 'utf8');
  assert.match(en, /usage-index\.sqlite/);
  assert.match(en, /Reset index/);
  assert.match(zh, /usage-index\.sqlite/);
  assert.match(zh, /Reset index/);
});
