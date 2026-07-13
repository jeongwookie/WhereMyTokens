import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tCallRegex } from './test-support/i18n.mjs';

test('StateManager can reset and rebuild the usage ledger from full history', () => {
  const stateManager = fs.readFileSync('src/main/stateManager.ts', 'utf8');
  assert.match(stateManager, /async rebuildUsageLedger\(\): Promise<void>/);
  assert.match(stateManager, /usageLedgerStore\.reset\(\)/);
  assert.match(stateManager, /includeFullHistory: true/);
});

test('IPC and preload expose usage ledger rebuild', () => {
  const ipc = fs.readFileSync('src/main/ipc.ts', 'utf8');
  const preload = fs.readFileSync('src/main/preload.ts', 'utf8');
  const index = fs.readFileSync('src/main/index.ts', 'utf8');
  const types = fs.readFileSync('src/renderer/types.ts', 'utf8');

  assert.match(ipc, /ledger:rebuild/);
  assert.match(ipc, /rebuildUsageLedger/);
  assert.match(preload, /rebuildLedger/);
  assert.match(index, /manager\.rebuildUsageLedger\(\)/);
  assert.match(types, /rebuildLedger:\s+\(\) => Promise<AppState>/);
});

test('SettingsView has a rebuild ledger action', () => {
  const settingsView = fs.readFileSync('src/renderer/views/SettingsView.tsx', 'utf8');
  assert.match(settingsView, /handleRebuildLedger/);
  assert.match(settingsView, /window\.wmt\.rebuildLedger/);
  assert.match(settingsView, tCallRegex('settingsView.data.rebuildButton'));
});

test('readmes describe the persisted ledger and rebuild control', () => {
  const en = fs.readFileSync('README.md', 'utf8');
  const zh = fs.readFileSync('README.zh-CN.md', 'utf8');
  assert.match(en, /usage-ledger\.json/);
  assert.match(en, /Rebuild ledger/);
  assert.match(zh, /usage-ledger\.json/);
  assert.match(zh, /重建账本/);
});
