import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const stores = new Map();
let fail = false;
class Store {
  constructor({ name, defaults = {} }) {
    this.data = stores.get(name) ?? structuredClone(defaults);
    stores.set(name, this.data);
  }
  get(key) { return this.data[key]; }
  set(key, value) { this.data[key] = value; }
}
const row = '3\t1\tsrc/' + 'x'.repeat(110) + '.ts\n';
const n = 12000;
assert.ok(Buffer.byteLength(row) * n > 1024 * 1024);
function script(args) {
  if (args[0] === 'hang') return 'process.stdout.write("partial\\n"); setInterval(() => {}, 1000);';
  const full = args[0] === 'log' && !args.some(x => x.startsWith('--since='));
  let output = '';
  if (args[0] === 'config') output = 'test@example.invalid';
  else if (args[0] === 'rev-parse') output = args.includes('--abbrev-ref') ? 'main' : args.includes('--show-toplevel') ? process.cwd() : '.git';
  else if (args[0] === 'rev-list') output = '2';
  if (full) {
    const dated = args.some(x => x.includes('__WMT_DAY__'));
    return `process.stdout.write(${JSON.stringify(dated ? '__WMT_DAY__2026-09-08\n' : '')} + ${JSON.stringify(row)}.repeat(${n}) + ${JSON.stringify((dated ? '__WMT_DAY__2026-09-09\n' : '') + '5\t2\tsrc/last.ts')}); process.exitCode=${fail ? 1 : 0};`;
  }
  return `process.stdout.write(${JSON.stringify(output)});`;
}
Module._load = function(id, parent, isMain) {
  if (id === 'electron-store') return Store;
  if (id === 'child_process' || id === 'node:child_process') return {
    execFile: (_file, args, options, cb) => execFile(process.execPath, ['-e', script(args)], options, cb),
    spawn: (_file, args, options) => spawn(process.execPath, ['-e', script(args)], options),
  };
  return originalLoad.call(this, id, parent, isMain);
};
const collector = require('../dist/main/gitStatsCollector.js');
Module._load = originalLoad;

test('full collector persists complete Git history larger than 1 MiB', async () => {
  const result = await collector.getGitStatsAsync(process.cwd());
  assert.ok(result, 'large history must not fall back to a missing cache');
  assert.equal(result.totalLinesAdded, n * 3 + 5);
  assert.equal(result.totalLinesRemoved, n + 2);
  assert.deepEqual(result.dailyAll.map(({date, commits, added, removed}) => ({date, commits, added, removed})), [
    {date:'2026-09-08', commits:1, added:n*3, removed:n},
    {date:'2026-09-09', commits:1, added:5, removed:2},
  ]);
  assert.equal(Object.values(stores.get('git-output-ledger').ledger.dailyOutput).length, 2);
});

test('failed full scan does not publish partial history', async () => {
  fail = true;
  const cwd = process.cwd() + '/src';
  const path = require('node:path');
  const key = path.resolve(cwd);
  const cache = stores.get('gitStatsCache').cache;
  const previous = structuredClone(Object.values(cache)[0]);
  cache[process.platform === 'win32' ? key.toLowerCase() : key] = previous;
  const before = JSON.stringify([...stores]);
  assert.deepEqual(await collector.getGitStatsAsync(cwd), previous);
  assert.equal(JSON.stringify([...stores]), before);
});

test('stream timeout rejects after partial output', async () => {
  await assert.rejects(collector.execGitLines(['hang'], process.cwd(), () => {}, 300), /failed/);
});

test('stream parser failure rejects instead of publishing partial results', async () => {
  await assert.rejects(collector.execGitLines(['config'], process.cwd(), () => {
    throw new Error('parser failure');
  }), /parser failure/);
});

test('stream spawn failure rejects', async () => {
  await assert.rejects(collector.execGitLines(['config'], process.cwd() + '/missing-git-stream-test-directory', () => {}), /ENOENT/);
});
