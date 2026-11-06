import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const stores = new Map();
const calls = [];
const failures = new Map();
let active = 0;
let peak = 0;
let now = Date.now();
const originalNow = Date.now;
Date.now = () => now;
test.after(() => { Date.now = originalNow; });

class Store {
  constructor({ name, defaults = {} }) {
    this.data = stores.get(name) ?? structuredClone(defaults);
    stores.set(name, this.data);
  }
  get(key) { return this.data[key]; }
  set(key, value) { this.data[key] = value; }
}

function output(args, cwd) {
  if (args[0] === 'config') return 'test@example.invalid';
  if (args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? 'main' : args.includes('--show-toplevel') ? cwd : '.git';
  if (args[0] === 'rev-list') return '1';
  if (args.some(arg => arg.includes('__WMT_DAY__'))) {
    const date = new Date().toLocaleDateString('en-CA');
    return `__WMT_DAY__${date}\n3\t1\tsrc/main.ts\n`;
  }
  return args.includes('--numstat') ? '3\t1\tsrc/main.ts\n' : 'commit\n';
}

function command(args, options, callback) {
  const failure = failures.get(options.cwd);
  if (failure === 'throw') throw new Error('spawn threw');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const call = { args, cwd: options.cwd, timeout: options.timeout, closed: false };
  calls.push(call);
  active++;
  peak = Math.max(peak, active);
  let timer;
  const close = (error, signal) => {
    if (call.closed) return;
    call.closed = true;
    clearTimeout(timer);
    child.stdout.end();
    child.stderr.end();
    active--;
    child.emit('close', error ? 1 : 0, signal);
    callback?.(error, error ? '' : output(args, options.cwd));
  };
  child.kill = () => { setTimeout(() => close(new Error('killed'), 'SIGTERM'), 5); return true; };
  if (failure === 'timeout') timer = setTimeout(() => close(new Error('timed out'), 'SIGTERM'), options.timeout);
  else timer = setTimeout(() => {
    const error = failure ? new Error(failure) : null;
    if (!callback && error) child.emit('error', error);
    if (!callback && !error) child.stdout.write(output(args, options.cwd));
    if (!callback && error) setTimeout(() => close(error), 5);
    else close(error);
  }, 2);
  return child;
}

Module._load = function(id, parent, isMain) {
  if (id === 'electron-store') return Store;
  if (id === 'child_process' || id === 'node:child_process') return {
    execFile: (_file, args, options, callback) => command(args, options, callback),
    spawn: (_file, args, options) => command(args, options),
  };
  return originalLoad.call(this, id, parent, isMain);
};
const collector = require('../dist/main/gitStatsCollector.js');
Module._load = originalLoad;

function cwd(name) { return path.resolve('git-concurrency-fixtures', name); }
function resetPeak() { assert.equal(active, 0); peak = 0; }
function assertLimit() { assert.ok(peak <= 2, `peak Git command concurrency was ${peak}`); assert.equal(active, 0); }

test('many repositories and overlapping refresh callers share the same command limit', async () => {
  resetPeak();
  const cwds = Array.from({ length: 32 }, (_, i) => cwd(`repo-${i}`));
  const start = calls.length;
  const first = cwds.map(dir => collector.getGitStatsAsync(dir));
  const repeated = [...cwds].reverse().map(dir => collector.getGitStatsAsync(path.join(dir, '.')));
  const direct = collector.execGitLines(['log'], cwd('direct-refresh'), () => {});
  const [results, duplicates] = await Promise.all([Promise.all(first), Promise.all(repeated), direct]);
  assert.equal(results.length, cwds.length);
  for (let i = 0; i < cwds.length; i++) {
    const stats = results[i];
    assert.ok(stats, cwds[i]);
    assert.equal(stats, duplicates[cwds.length - i - 1]);
    assert.equal(stats.commitsToday, 1);
    assert.equal(stats.commits7d, 1);
    assert.equal(stats.commits30d, 1);
    assert.equal(stats.totalCommits, 1);
    assert.equal(stats.linesAdded, 3);
    assert.equal(stats.linesRemoved, 1);
    assert.equal(stats.linesAdded7d, 3);
    assert.equal(stats.linesRemoved7d, 1);
    assert.equal(stats.linesAdded30d, 3);
    assert.equal(stats.linesRemoved30d, 1);
    assert.equal(stats.totalLinesAdded, 3);
    assert.equal(stats.totalLinesRemoved, 1);
    assert.equal(stats.daily7d.reduce((sum, day) => sum + day.added, 0), 3);
    assert.equal(stats.dailyAll.length, 1);
    assert.equal(calls.slice(start).filter(call => call.cwd === cwds[i]).length, 13);
  }
  const ledger = stores.get('git-output-ledger').ledger;
  assert.equal(Object.keys(ledger.repositories).length, cwds.length);
  const after = calls.length;
  await Promise.all(cwds.map(dir => collector.getGitStatsAsync(dir)));
  assert.equal(calls.length, after, 'repeat refresh should reuse fresh statistics');
  assertLimit();
});

test('failed collection retains complete statistics and does not stall later repositories', async () => {
  resetPeak();
  now += 120_001;
  const dir = cwd('repo-0');
  const previous = structuredClone(Object.values(stores.get('gitStatsCache').cache)[0]);
  const before = JSON.stringify(stores.get('git-output-ledger').ledger);
  failures.set(dir, 'git failed');
  const result = await collector.getGitStatsAsync(dir);
  assert.deepEqual(result, previous);
  assert.equal(JSON.stringify(stores.get('git-output-ledger').ledger), before);
  failures.delete(dir);
  const results = await Promise.all([collector.getGitStatsAsync(dir), collector.getGitStatsAsync(cwd('after-failure'))]);
  assert.ok(results.every(Boolean));
  assertLimit();
});

test('queue wait does not consume the Git execution timeout', async () => {
  resetPeak();
  const dirs = Array.from({ length: 32 }, (_, i) => cwd(`queued-${i}`));
  const started = performance.now();
  await Promise.all(dirs.map(dir => collector.execGitLines(['log'], dir, () => {}, 20)));
  for (const dir of dirs) assert.equal(calls.find(call => call.cwd === dir).timeout, 20);
  assert.ok(performance.now() - started > 20, 'queued work outlasts a single command timeout');
  assertLimit();
});

test('timeouts, parser errors, and spawn failures release slots after close', async () => {
  resetPeak();
  failures.set(cwd('timeout'), 'timeout');
  failures.set(cwd('error'), 'spawn error');
  failures.set(cwd('throw'), 'throw');
  const results = await Promise.allSettled([
    collector.execGitLines(['log'], cwd('timeout'), () => {}, 10),
    collector.execGitLines(['log'], cwd('error'), () => {}),
    collector.execGitLines(['log'], cwd('parser'), () => { throw new Error('parser failed'); }),
    collector.execGitLines(['log'], cwd('throw'), () => {}),
    collector.execGitLines(['log'], cwd('after-errors'), () => {}),
  ]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected', 'rejected', 'rejected', 'fulfilled']);
  assert.match(results[0].reason.message, /SIGTERM/);
  assert.match(results[1].reason.message, /spawn error/);
  assert.match(results[2].reason.message, /parser failed/);
  assert.match(results[3].reason.message, /spawn threw/);
  assertLimit();
});
