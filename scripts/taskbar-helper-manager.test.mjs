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
    this.backpressureWrites = false;
    this.throwWrites = false;
  }

  write(value) {
    if (this.throwWrites) throw new Error('write failed');
    this.writes.push(value);
    return !this.backpressureWrites;
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
  const runtimeDisabled = [];
  const instance = createTaskbarQuotaHelperManager({
    platform: options.platform ?? 'win32',
    resolveHelperPath: () => options.helperPath ?? 'helper.exe',
    helperExists: () => options.helperExists ?? true,
    spawnHelper: command => {
      if (options.throwOnSpawn) throw new Error('spawn failed');
      const child = new FakeChild();
      child.command = command;
      child.stdin.backpressureWrites = options.backpressureOnSpawn === true;
      children.push(child);
      return child;
    },
    buildSnapshot: appState => {
      builtSnapshots.push(appState);
      return { updatedAt: 1, rows: [{ period: '5h', blocks: [] }, { period: '1w', blocks: [] }] };
    },
    openDashboard: () => opened.push('main'),
    onRuntimeDisabled: () => runtimeDisabled.push('disabled'),
    backpressureTimeoutMs: options.backpressureTimeoutMs,
    renderAckTimeoutMs: options.renderAckTimeoutMs,
  });
  return { instance, children, opened, builtSnapshots, runtimeDisabled };
}

function emitRendered(child) {
  child.stdout.emit('data', Buffer.from('{"type":"snapshot-rendered"}\n'));
}

function emitRejected(child) {
  child.stdout.emit('data', Buffer.from('{"type":"snapshot-rejected"}\n'));
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

test('invalid stdout, crash, spawn failure, and write exception are retried before runtime disable', () => {
  const invalid = manager();
  const appState = state();
  invalid.instance.syncTaskbarQuotaHelper(appState);
  invalid.children[0].stdout.emit('data', Buffer.from('not json\n'));
  assert.equal(invalid.children[0].killed, true);
  assert.equal(invalid.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
  assert.equal(appState.settings.taskbarQuotaEnabled, true);
  invalid.instance.syncTaskbarQuotaHelper(state());
  assert.equal(invalid.children.length, 2);
  invalid.children[1].stdout.emit('data', Buffer.from('not json\n'));
  invalid.instance.syncTaskbarQuotaHelper(state());
  invalid.children[2].stdout.emit('data', Buffer.from('not json\n'));
  assert.equal(invalid.instance.isTaskbarQuotaHelperDisabledForRuntime(), true);
  assert.deepEqual(invalid.runtimeDisabled, ['disabled']);
  invalid.instance.syncTaskbarQuotaHelper(state());
  assert.equal(invalid.children.length, 3);

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
  assert.equal(spawnFailed.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
  spawnFailed.instance.syncTaskbarQuotaHelper(state());
  assert.equal(spawnFailed.instance.isTaskbarQuotaHelperDisabledForRuntime(), true);
  assert.deepEqual(spawnFailed.runtimeDisabled, ['disabled']);
  assert.equal(spawnFailed.children.length, 0);

  const writeFailed = manager();
  writeFailed.instance.syncTaskbarQuotaHelper(state());
  emitRendered(writeFailed.children[0]);
  writeFailed.children[0].stdin.throwWrites = true;
  writeFailed.instance.syncTaskbarQuotaHelper(state());
  assert.equal(writeFailed.children[0].killed, true);
  assert.equal(writeFailed.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
  writeFailed.instance.syncTaskbarQuotaHelper(state());
  assert.equal(writeFailed.children.length, 2);
});

test('stdin backpressure coalesces snapshots until the helper drains', () => {
  const { instance, children, runtimeDisabled } = manager({ backpressureOnSpawn: true });
  instance.syncTaskbarQuotaHelper(state());
  instance.syncTaskbarQuotaHelper(state());

  assert.equal(children.length, 1);
  assert.equal(children[0].killed, false);
  assert.equal(children[0].stdin.writes.length, 1);
  assert.equal(instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
  assert.deepEqual(runtimeDisabled, []);

  children[0].stdin.backpressureWrites = false;
  children[0].stdin.emit('drain');

  assert.equal(children[0].killed, false);
  assert.equal(children[0].stdin.writes.length, 1);
  emitRendered(children[0]);

  assert.equal(children[0].killed, false);
  assert.equal(children[0].stdin.writes.length, 2);
  assert.equal(instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
  assert.deepEqual(runtimeDisabled, []);
});

test('non-draining helper backpressure is retried before runtime disable', async () => {
  const stalled = manager({ backpressureOnSpawn: true, backpressureTimeoutMs: 1 });

  stalled.instance.syncTaskbarQuotaHelper(state());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stalled.children[0].killed, true);
  assert.equal(stalled.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);

  stalled.instance.syncTaskbarQuotaHelper(state());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stalled.children[1].killed, true);
  assert.equal(stalled.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);

  stalled.instance.syncTaskbarQuotaHelper(state());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stalled.children[2].killed, true);
  assert.equal(stalled.instance.isTaskbarQuotaHelperDisabledForRuntime(), true);
  assert.deepEqual(stalled.runtimeDisabled, ['disabled']);
});

test('helper failure count resets after a healthy snapshot write', () => {
  const { instance, children, runtimeDisabled } = manager();
  instance.syncTaskbarQuotaHelper(state());
  children[0].stdout.emit('data', Buffer.from('not json\n'));
  instance.syncTaskbarQuotaHelper(state());
  emitRendered(children[1]);
  children[1].stdout.emit('data', Buffer.from('not json\n'));
  instance.syncTaskbarQuotaHelper(state());
  emitRendered(children[2]);
  children[2].stdout.emit('data', Buffer.from('not json\n'));

  assert.equal(instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
  assert.deepEqual(runtimeDisabled, []);
  instance.syncTaskbarQuotaHelper(state());
  assert.equal(children.length, 4);
});

test('first write to a new helper does not clear crash failures before render proves stable', () => {
  const { instance, children, runtimeDisabled } = manager();
  instance.syncTaskbarQuotaHelper(state());
  children[0].emit('exit', 3);
  instance.syncTaskbarQuotaHelper(state());
  children[1].emit('exit', 3);
  instance.syncTaskbarQuotaHelper(state());
  children[2].emit('exit', 3);

  assert.equal(instance.isTaskbarQuotaHelperDisabledForRuntime(), true);
  assert.deepEqual(runtimeDisabled, ['disabled']);
});

test('render acknowledgement timeout is retried before runtime disable', async () => {
  const stalled = manager({ renderAckTimeoutMs: 1 });

  stalled.instance.syncTaskbarQuotaHelper(state());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stalled.children[0].killed, true);
  assert.equal(stalled.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);

  stalled.instance.syncTaskbarQuotaHelper(state());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stalled.children[1].killed, true);
  assert.equal(stalled.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);

  stalled.instance.syncTaskbarQuotaHelper(state());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stalled.children[2].killed, true);
  assert.equal(stalled.instance.isTaskbarQuotaHelperDisabledForRuntime(), true);
  assert.deepEqual(stalled.runtimeDisabled, ['disabled']);
});

test('helper snapshot rejection is retried before runtime disable', () => {
  const rejected = manager();

  rejected.instance.syncTaskbarQuotaHelper(state());
  emitRejected(rejected.children[0]);
  assert.equal(rejected.children[0].killed, true);
  assert.equal(rejected.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);

  rejected.instance.syncTaskbarQuotaHelper(state());
  emitRejected(rejected.children[1]);
  assert.equal(rejected.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);

  rejected.instance.syncTaskbarQuotaHelper(state());
  emitRejected(rejected.children[2]);
  assert.equal(rejected.instance.isTaskbarQuotaHelperDisabledForRuntime(), true);
  assert.deepEqual(rejected.runtimeDisabled, ['disabled']);
});

test('runtime disable callback exceptions do not escape helper manager', () => {
  const instance = createTaskbarQuotaHelperManager({
    platform: 'win32',
    resolveHelperPath: () => 'helper.exe',
    helperExists: () => false,
    spawnHelper: () => new FakeChild(),
    onRuntimeDisabled: () => {
      throw new Error('notification store failed');
    },
  });

  assert.doesNotThrow(() => {
    instance.syncTaskbarQuotaHelper(state());
    instance.syncTaskbarQuotaHelper(state());
    instance.syncTaskbarQuotaHelper(state());
  });
  assert.equal(instance.isTaskbarQuotaHelperDisabledForRuntime(), true);
});

test('missing packaged helper disables after repeated failed syncs and resets when setting turns off', () => {
  const missing = manager({ helperExists: false });
  missing.instance.syncTaskbarQuotaHelper(state());
  missing.instance.syncTaskbarQuotaHelper(state());
  assert.equal(missing.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
  missing.instance.syncTaskbarQuotaHelper(state());
  assert.equal(missing.instance.isTaskbarQuotaHelperDisabledForRuntime(), true);
  assert.deepEqual(missing.runtimeDisabled, ['disabled']);

  missing.instance.syncTaskbarQuotaHelper(state({ taskbarQuotaEnabled: false }));
  assert.equal(missing.instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
});

test('stale exit from an old helper does not detach the current helper', () => {
  const { instance, children } = manager();
  instance.syncTaskbarQuotaHelper(state());
  children[0].stdout.emit('data', Buffer.from('not json\n'));
  assert.equal(children[0].killed, true);

  instance.syncTaskbarQuotaHelper(state());
  assert.equal(children.length, 2);
  children[0].emit('exit', 1);
  emitRendered(children[1]);
  instance.syncTaskbarQuotaHelper(state());

  assert.equal(children.length, 2);
  assert.equal(children[1].stdin.writes.length, 2);
});

test('stale stream and process errors from an old helper do not stop the current helper', () => {
  const { instance, children, runtimeDisabled } = manager();
  instance.syncTaskbarQuotaHelper(state());
  children[0].stdout.emit('data', Buffer.from('not json\n'));
  assert.equal(children[0].killed, true);

  instance.syncTaskbarQuotaHelper(state());
  assert.equal(children.length, 2);
  children[0].stdout.emit('data', Buffer.from('not json\n'));
  children[0].stdout.emit('error', new Error('old stdout'));
  children[0].stdin.emit('error', new Error('old stdin'));
  children[0].emit('error', new Error('old child'));
  emitRendered(children[1]);
  instance.syncTaskbarQuotaHelper(state());

  assert.equal(children.length, 2);
  assert.equal(children[1].killed, false);
  assert.equal(children[1].stdin.writes.length, 2);
  assert.equal(instance.isTaskbarQuotaHelperDisabledForRuntime(), false);
  assert.deepEqual(runtimeDisabled, []);
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

test('taskbar helper runtime disable turns the setting off through main state', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'index.ts'), 'utf8');
  const match = source.match(/onRuntimeDisabled:\s*\(\)\s*=>\s*\{([\s\S]*?)\n  \},/);
  assert.ok(match);
  const body = match[1];
  assert.match(body, /try\s*\{\s*store\.set\('taskbarQuotaEnabled',\s*false\)/);
  assert.match(body, /addNotification\(\s*'alert',\s*TASKBAR_MINI_DISABLED_TITLE/);
  assert.match(body, /new Notification\(\{\s*title:\s*`WhereMyTokens \$\{TASKBAR_MINI_DISABLED_TITLE\}`/);
  assert.match(body, /stateManager\?\.applySettingsChange\(\)/);
  assert.match(body, /rebuildTrayMenu\(\)/);
});

test('system theme changes resync the taskbar helper when app theme is auto', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'index.ts'), 'utf8');
  const match = source.match(/nativeTheme\.on\('updated',\s*\(\)\s*=>\s*\{([\s\S]*?)\n  \}\);/);
  assert.ok(match);
  const body = match[1];

  assert.match(body, /s\.theme === 'auto'/);
  assert.match(body, /stateManager\?\.getState\(\)/);
  assert.match(body, /nextState\?\.settings\.taskbarQuotaEnabled === true/);
  assert.match(body, /taskbarQuotaHelper\.syncTaskbarQuotaHelper\(nextState\)/);
});

test('packaged helper resolution does not fall back to the current working directory', () => {
  const source = fs.readFileSync(path.resolve('src', 'main', 'taskbarQuotaHelper.ts'), 'utf8');
  assert.match(source, /shouldAllowDevHelperFallback/);
  assert.match(source, /if \(!allowDevHelperFallback\) return null/);
});
