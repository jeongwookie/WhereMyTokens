import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import helperModule from '../dist/main/taskbarQuotaHelper.js';

const {
  createTaskbarQuotaHelperManager,
} = helperModule;

function settings(overrides = {}) {
  return {
    enabledProviders: ['claude'],
    quotaTargetModes: {},
    quotaTargetOrder: [],
    quotaTargetAbbreviations: {},
    taskbarQuotaEnabled: true,
    ...overrides,
  };
}

function state(settingsOverrides = {}) {
  return {
    lastUpdated: 1,
    settings: settings(settingsOverrides),
    providerQuotas: {},
  };
}

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
    this.failWrites = false;
  }

  write(value) {
    if (this.failWrites) return false;
    this.writes.push(value);
    return true;
  }

  end() {
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new FakeStream();
    this.stdout = new FakeStream();
    this.killed = false;
  }

  kill() {
    this.killed = true;
  }
}

function manager(options = {}) {
  const children = [];
  const opened = [];
  const builtSnapshots = [];
  const instance = createTaskbarQuotaHelperManager({
    platform: options.platform ?? 'win32',
    resolveHelperPath: () => options.helperPath ?? 'helper.exe',
    helperExists: () => options.helperExists ?? true,
    spawnHelper: command => {
      if (options.throwOnSpawn) throw new Error('spawn failed');
      const child = new FakeChild();
      child.command = command;
      children.push(child);
      return child;
    },
    buildSnapshot: appState => {
      builtSnapshots.push(appState);
      return { updatedAt: 1, rows: [{ period: '5h', blocks: [], hiddenCount: 0 }, { period: '1w', blocks: [], hiddenCount: 0 }] };
    },
    openDashboard: () => opened.push('main'),
  });
  return { instance, children, opened, builtSnapshots };
}

test('does not spawn helper when setting is disabled or platform is not Windows', () => {
  const disabled = manager();
  disabled.instance.syncTaskbarQuotaHelper(state({ taskbarQuotaEnabled: false }));
  assert.equal(disabled.children.length, 0);

  const nonWindows = manager({ platform: 'darwin' });
  nonWindows.instance.syncTaskbarQuotaHelper(state());
  assert.equal(nonWindows.children.length, 0);
});

test('spawns on Windows when enabled and writes snapshot JSON to stdin', () => {
  const { instance, children, builtSnapshots } = manager();
  instance.syncTaskbarQuotaHelper(state());

  assert.equal(children.length, 1);
  assert.equal(children[0].command, 'helper.exe');
  assert.equal(builtSnapshots.length, 1);
  assert.match(children[0].stdin.writes[0], /"period":"5h"/);
  assert.match(children[0].stdin.writes[0], /\n$/);
});

test('open-dashboard helper event invokes only the dashboard callback', () => {
  const { instance, children, opened } = manager();
  instance.syncTaskbarQuotaHelper(state());
  children[0].stdout.emit('data', Buffer.from('{"type":"open-dashboard"}\n'));

  assert.deepEqual(opened, ['main']);
});

test('invalid stdout, crash, spawn failure, and write failure are retried on later sync without mutating settings', () => {
  const invalid = manager();
  const appState = state();
  invalid.instance.syncTaskbarQuotaHelper(appState);
  invalid.children[0].stdout.emit('data', Buffer.from('not json\n'));
  assert.equal(invalid.children[0].killed, true);
  assert.equal(invalid.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
  assert.equal(appState.settings.taskbarQuotaEnabled, true);
  invalid.instance.syncTaskbarQuotaHelper(state());
  assert.equal(invalid.children.length, 2);

  const crashed = manager();
  crashed.instance.syncTaskbarQuotaHelper(state());
  crashed.children[0].emit('exit', 1);
  assert.equal(crashed.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
  crashed.instance.syncTaskbarQuotaHelper(state());
  assert.equal(crashed.children.length, 2);

  const spawnFailed = manager({ throwOnSpawn: true });
  spawnFailed.instance.syncTaskbarQuotaHelper(state());
  assert.equal(spawnFailed.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
  spawnFailed.instance.syncTaskbarQuotaHelper(state());
  assert.equal(spawnFailed.children.length, 0);

  const writeFailed = manager();
  writeFailed.instance.syncTaskbarQuotaHelper(state());
  writeFailed.children[0].stdin.failWrites = true;
  writeFailed.instance.syncTaskbarQuotaHelper(state());
  assert.equal(writeFailed.children[0].killed, true);
  assert.equal(writeFailed.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
  writeFailed.instance.syncTaskbarQuotaHelper(state());
  assert.equal(writeFailed.children.length, 2);
});

test('stop closes the helper without disabling the runtime path', () => {
  const { instance, children } = manager();
  instance.syncTaskbarQuotaHelper(state());
  instance.stopTaskbarQuotaHelper();

  assert.equal(children[0].stdin.ended, true);
  assert.equal(children[0].killed, true);
  assert.equal(instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
});

test('settings changes immediately resync the taskbar helper with latest state', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'index.ts'), 'utf8');
  const match = source.match(/applySettingsChange:\s*\(\)\s*=>\s*\{([\s\S]*?)\n    \},/);
  assert.ok(match);
  const body = match[1];

  const runtimeIndex = body.indexOf('applyRuntimeSettings();');
  const syncIndex = body.indexOf('taskbarQuotaHelper.syncTaskbarQuotaHelper(manager.getState());');
  assert.notEqual(runtimeIndex, -1);
  assert.notEqual(syncIndex, -1);
  assert.ok(syncIndex > runtimeIndex);
});
