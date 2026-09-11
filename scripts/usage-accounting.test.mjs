import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import indexModule from '../dist/main/usageIndex/index.js';
import codexModule from '../dist/main/providers/codex/usageIndexScanner.js';
import claudeModule from '../dist/main/providers/claude/usageIndexScanner.js';
import accounting from '../dist/main/providers/codex/accounting.js';
import gm from '../dist/main/providers/antigravity/gmParser.js';
import agPricing from '../dist/main/providers/antigravity/pricing.js';
import agIdentity from '../dist/main/providers/antigravity/serverIdentity.js';

const { DefaultUsageIndex, InMemoryUsageIndexStorage, SqliteUsageIndexStorage } = indexModule;
const T = Date.UTC(2026, 8, 7, 0);
const stamp = n => new Date(T + n * 1000).toISOString();
const vector = (input, cache = 0, output = 0, reasoning = 0) => ({ input_tokens: input, cached_input_tokens: cache, output_tokens: output, reasoning_output_tokens: reasoning });
const meta = (extra = {}) => ({ type: 'session_meta', timestamp: stamp(0), payload: { id: 'sample', timestamp: stamp(0), model: 'gpt-5.4', ...extra } });
const total = (n, last = n, at = n, extra = {}) => ({ type: 'event_msg', timestamp: stamp(at), payload: { type: 'token_count', info: {
  total_token_usage: vector(n), ...(last === null ? {} : { last_token_usage: vector(last) }), ...extra,
} } });
const detail = (id, n, cumulative, at = n) => ({ type: 'token_usage_record', timestamp: stamp(at), payload: {
  ...(id ? { response_id: id } : {}), thread_id: 'sample', usage: vector(n), ...(cumulative === undefined ? {} : { thread_token_usage: vector(cumulative) }),
} });

test('Turn-local notifications never rewind thread totals, including repeated notifications and restart cuts', async t => {
  const d = (id, usage, thread, turn, at) => ({ type: 'token_usage_record', timestamp: stamp(at),
    payload: { response_id: id, turn_id: 'turn-a', usage, thread_token_usage: thread, turn_token_usage: turn } });
  const a = vector(299517,298880,126,31), b = vector(300553,292224,879,856);
  const notice = total(0,0,3,{ total_token_usage: vector(10824910,10718592,20096,9510), last_token_usage:a });
  const records = [meta({model:'gpt-6-astra'}),
    {type:'event_msg',timestamp:stamp(0),payload:{type:'task_started',turn_id:'turn-a'}},
    d('a',a,vector(336109005,328446336,1397754,591381),vector(10824910,10718592,20096,9510),1),
    notice, {type:'response_item',timestamp:stamp(4),payload:{type:'function_call',name:'exec',arguments:'{}'}},
    {...notice,timestamp:stamp(5)},
    d('b',b,vector(336409558,328738560,1398633,592237),vector(11125463,11010816,20975,10366),6)];
  for (let cut=1;cut<records.length;cut++) {
    const f=fixture(t,'codex',true);f.write(records.slice(0,cut));await f.refresh();await f.restart();
    f.append(records.slice(cut));await f.refresh();
    assert.deepEqual((await f.entries()).map(e=>[e.inputTokens,e.cacheReadTokens,e.outputTokens]),[[637,298880,126],[8329,292224,879]],'cut '+cut);
    assert.ok(Math.abs((await f.metrics()).costUSD - (0.61995+0.816953))<1e-9);
  }
});

test('Notification origin survives a new turn unless the notification actually resets', async t => {
  for (const reset of [false,true]) {
    const f=fixture(t,'codex',true);
    const d=(id,n,thread,turn,at)=>({...detail(id,n,thread,at),payload:{...detail(id+'-'+at,n,thread,at).payload,turn_id:id,turn_token_usage:vector(turn)}});
    f.write([meta(),{type:'event_msg',timestamp:stamp(0),payload:{type:'task_started',turn_id:'a'}},d('a',100,1100,100,1),total(100,100,2)]);await f.refresh();await f.restart();
    f.append([{type:'event_msg',timestamp:stamp(3),payload:{type:'task_started',turn_id:'b'}},
      d('b',50,1150,50,4),total(reset?50:150,50,5),
      {type:'response_item',timestamp:stamp(6),payload:{type:'function_call',name:'exec'}},
      total(reset?50:150,50,7), d('b',25,1175,75,8),total(reset?75:175,25,9)]);
    await f.refresh();assert.equal((await f.metrics()).totalTokens,175,'reset='+reset);
  }
});

test('A turn notification arriving before its detailed counterpart establishes the same origin', async t => {
  const f=fixture(t,'codex',true);
  f.write([meta(),{type:'event_msg',timestamp:stamp(0),payload:{type:'task_started',turn_id:'turn'}},total(100,100,1)]);await f.refresh();await f.restart();
  const row=detail('first',100,1100,2);row.payload.turn_token_usage=vector(100);row.payload.turn_id='turn';
  const next=detail('next',50,1150,4);next.payload.turn_token_usage=vector(150);next.payload.turn_id='turn';
  f.append([row,total(150,50,3),next]);await f.refresh();
  assert.equal((await f.metrics()).totalTokens,150);
});
const claude = (id, n, extra = {}) => ({ type: 'assistant', timestamp: stamp(1), uuid: id ? 'origin-' + id : undefined,
  message: { ...(id ? { id } : {}), model: 'claude-sonnet-4', usage: { input_tokens: n, output_tokens: 0 }, content: [] }, ...extra });

function fixture(t, provider = 'codex', sqlite = false) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, 'wmt-generic-'));
  const file = path.join(dir, 'source.jsonl');
  const dbFile = path.join(dir, 'usage.sqlite');
  fs.writeFileSync(file, '');
  let storage = sqlite ? new SqliteUsageIndexStorage(dbFile) : new InMemoryUsageIndexStorage();
  let index = new DefaultUsageIndex(storage, () => T + 10_000_000);
  const sourceId = provider + ':sample';
  const scanner = provider === 'codex' ? codexModule.createCodexUsageIndexScanner : claudeModule.createClaudeUsageIndexScanner;
  const descriptor = () => {
    const s = fs.statSync(file);
    return { sourceId, provider, kind: 'file', parserVersion: provider === 'codex' ? 7 : 5, version: { token: s.size + ':' + s.mtimeMs, size: s.size, mtimeMs: s.mtimeMs } };
  };
  t.after(async () => {
    await index.close();
    assert.ok(fs.realpathSync(dir).startsWith(tempRoot + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, file, dbFile, sourceId, descriptor,
    get index() { return index; }, get storage() { return storage; },
    write(records) { fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')); fs.utimesSync(file, new Date(T), new Date(T)); },
    append(records) { fs.appendFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n'); },
    async refresh(options = {}) {
      const d = descriptor(); index.declareSources(provider, [d], true);
      return index.refreshSource(d, scanner(file, { now: () => T, ...options }));
    },
    async metrics() { return (await index.queryUsage({ grain: 'month' })).aggregate; },
    async entries() { return storage.queryEntries({}); },
    async restart() { assert.ok(sqlite); await index.close(); storage = new SqliteUsageIndexStorage(dbFile); index = new DefaultUsageIndex(storage, () => T + 10_000_000); },
  };
}

test('Codex adopts cumulative differences for quantities and pricing, including missing/zero last usage', async t => {
  const f = fixture(t);
  f.write([meta(), total(100), total(250, 20), total(300, null), total(330, 0)]);
  await f.refresh();
  const entries = await f.entries();
  assert.deepEqual(entries.map(e => e.inputTokens), [100, 150, 50, 30]);
  assert.equal((await f.metrics()).totalTokens, 330);
  assert.ok(Math.abs((await f.metrics()).costUSD - 330 * 2.5 / 1e6) < 1e-12);
});

test('Codex GPT-6 Astra usage keeps explicit pricing and cached-input separation across SQLite restart', async t => {
  const f = fixture(t, 'codex', true);
  const first = vector(100_000, 50_000, 10_000, 2000);
  f.write([meta({ model: 'gpt-6-astra' }), total(100_000, 100_000, 1, {
    total_token_usage: first, last_token_usage: first,
  })]);
  await f.refresh();
  assert.ok(Math.abs((await f.metrics()).costUSD - 1.05) < 1e-12);
  await f.restart();
  assert.ok(Math.abs((await f.metrics()).costUSD - 1.05) < 1e-12);
  f.append([total(200_000, 100_000, 2, {
    total_token_usage: vector(200_000, 100_000, 20_000, 4000), last_token_usage: first,
  })]);
  await f.refresh();
  const metrics = await f.metrics();
  assert.equal(metrics.totalTokens, 220_000);
  assert.ok(Math.abs(metrics.costUSD - 2.10) < 1e-12);
  assert.ok(Math.abs(metrics.cacheSavingsUSD - 0.90) < 1e-12);
});

test('Codex cache and reasoning are contained subcategories and cannot inflate or reset totals', () => {
  assert.deepEqual(accounting.usageVector(vector(100, 40, 20, 10)), [100, 40, 20, 10]);
  const state = accounting.newCodexAccountingState();
  accounting.codexUsageDecision(state, meta(), 'codex:sample', 'meta');
  accounting.codexUsageDecision(state, total(100, 100, 1, { total_token_usage: vector(100, 90), last_token_usage: vector(100, 90) }), 'codex:sample', 'a');
  const next = accounting.codexUsageDecision(state, total(150, 50, 2, { total_token_usage: vector(150, 20) }), 'codex:sample', 'b');
  assert.deepEqual(next.usage, [50, 0, 0, 0]);
});

test('Unknown first cumulative baseline is not treated as a new historical charge', async t => {
  const f = fixture(t);
  f.write([meta(), total(10_000, 20, 1), total(10_150, null, 2)]);
  await f.refresh();
  assert.equal((await f.metrics()).totalTokens, 150);
});

test('Fork prefixes remain excluded without parent lookup; new own turns continue from baseline', async t => {
  const f = fixture(t);
  f.write([meta({ forked_from_id: 'missing-parent', timestamp: stamp(10) }),
    total(10_000, 20, 1),
    { type: 'event_msg', timestamp: stamp(2), payload: { type: 'task_started', turn_id: 'inherited', started_at: (T + 2000) / 1000 } },
    total(10_100, 100, 3),
    { type: 'event_msg', timestamp: stamp(11), payload: { type: 'task_started', turn_id: 'own', started_at: (T + 11000) / 1000 } },
    total(10_150, 50, 12)]);
  await f.refresh();
  assert.equal((await f.metrics()).totalTokens, 50);
});

test('Unknown regression rebases without subtracting earlier consumption', async t => {
  const f = fixture(t);
  f.write([meta(), total(100, 100, 1), total(200, 100, 2), total(30, 10, 3), total(80, 50, 4)]);
  await f.refresh();
  assert.equal((await f.metrics()).totalTokens, 250);
});

test('A known replay cannot rewind a cumulative baseline after database restart', async t => {
  const f = fixture(t, 'codex', true);
  const old = total(100, 100, 1);
  f.write([meta(), old, total(200, 100, 2)]); await f.refresh(); await f.restart();
  f.append([old, total(250, 50, 3)]); await f.refresh();
  assert.equal((await f.metrics()).totalTokens, 250);
  await f.refresh(); assert.equal((await f.metrics()).totalTokens, 250);
});

test('New output evidence can confirm reset use across turn/settings/abort boundaries', async t => {
  const f = fixture(t);
  f.write([meta(), total(100, 100, 1),
    { type: 'event_msg', timestamp: stamp(2), payload: { type: 'turn_aborted' } },
    { type: 'turn_context', timestamp: stamp(3), payload: { model: 'gpt-5.4' } },
    { type: 'event_msg', timestamp: stamp(4), payload: { type: 'task_started', turn_id: 'next' } },
    { type: 'response_item', timestamp: stamp(5), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'new output' }] } },
    total(20, 20, 6), total(50, 30, 7)]);
  await f.refresh(); assert.equal((await f.metrics()).totalTokens, 150);
});

test('Mixed cumulative/detail observations stay single-counted at every restart cut', async t => {
  const records = [meta(), detail('a', 100, 100, 1), total(100, 100, 1), total(200, 100, 2),
    detail('b', 100, 200, 2), detail('a', 100, 100, 1), detail('a', 100, undefined, 1), total(250, 50, 3)];
  for (let cut = 1; cut < records.length; cut++) {
    const f = fixture(t, 'codex', true);
    f.write(records.slice(0, cut)); await f.refresh(); await f.restart();
    f.append(records.slice(cut)); await f.refresh();
    assert.equal((await f.metrics()).totalTokens, 250, 'restart cut ' + cut);
  }
});

test('Switch from single usage to cumulative establishes a baseline; late detail cannot switch it back', async t => {
  const f = fixture(t, 'codex', true);
  f.write([meta(), detail('single', 10, undefined, 1)]); await f.refresh();
  f.append([total(50, 40, 2)]); await f.refresh(); await f.restart();
  f.append([detail('late', 40, undefined, 2), total(80, 30, 3)]); await f.refresh();
  assert.equal((await f.metrics()).totalTokens, 40);
});

for (const provider of ['codex', 'claude']) {
  test(provider + ' missing IDs/model/time use physical observations and fixed estimates', async t => {
    const f = fixture(t, provider, true);
    const row = provider === 'codex'
      ? { type: 'token_usage_record', payload: { usage: vector(2000) } }
      : { type: 'assistant', message: { usage: { input_tokens: 2000, output_tokens: 0 }, content: [] } };
    f.write([row, row]); await f.refresh();
    assert.equal((await f.metrics()).totalTokens, 4000);
    assert.ok((await f.metrics()).costUSD > 0);
    assert.deepEqual((await f.entries()).map(e => e.timestampMs), [T, T]);
    await f.restart(); f.append([row]); await f.refresh();
    assert.equal((await f.metrics()).totalTokens, 6000);
    assert.deepEqual((await f.entries()).map(e => e.timestampMs), [T, T, T]);
  });
  test(provider + ' truncation/empty rewrite preserve historical totals and then resume', async t => {
    const f = fixture(t, provider, true);
    f.write(provider === 'codex' ? [meta(), total(100), total(300, 200)] : [claude('one', 100), claude('two', 200)]);
    await f.refresh(); assert.equal((await f.metrics()).totalTokens, 300);
    f.write(provider === 'codex' ? [meta(), total(20)] : [claude('one', 100)]);
    await f.refresh(); assert.equal((await f.metrics()).totalTokens, 300);
    f.append(provider === 'codex' ? [total(50, 30)] : [claude('three', 30)]);
    await f.refresh(); assert.equal((await f.metrics()).totalTokens, 330);
    f.write([]); await f.refresh(); assert.equal((await f.metrics()).totalTokens, 330);
    await f.restart();
    f.append(provider === 'codex' ? [meta(), total(7)] : [claude('four', 7)]);
    await f.refresh(); assert.equal((await f.metrics()).totalTokens, 337);
  });
}

test('Claude valid revisions replace one record; conflicting model changes keep the established record', async t => {
  for (const sqlite of [false, true]) {
    const f = fixture(t, 'claude', sqlite);
    f.write([claude('r', 100)]); await f.refresh();
    f.append([claude('r', 150)]); await f.refresh();
    assert.equal((await f.metrics()).totalTokens, 150);
    f.append([claude('r', 200, { message: { id: 'r', model: 'different-model', usage: { input_tokens: 200 }, content: [] } }), claude('next', 10)]);
    await f.refresh(); assert.equal((await f.metrics()).totalTokens, 160);
  }
});

test('Codex and Claude serialized parsing state remain bounded across long streams', async t => {
  for (const provider of ['codex', 'claude']) {
    const f = fixture(t, provider);
    const rows = Array.from({ length: 600 }, (_, i) => provider === 'codex' ? total(i + 1, 1, i + 1) : claude('r' + i, 1));
    f.write(provider === 'codex' ? [meta(), ...rows] : rows); await f.refresh();
    const firstSize = (await f.storage.getSource(f.sourceId)).checkpoint.resumeState.length;
    f.append(Array.from({ length: 600 }, (_, i) => provider === 'codex' ? total(601 + i, 1, 601 + i) : claude('r' + (601 + i), 1)));
    await f.refresh();
    const nextSize = (await f.storage.getSource(f.sourceId)).checkpoint.resumeState.length;
    assert.equal((await f.metrics()).totalTokens, 1200);
    assert.ok(nextSize <= firstSize * 1.1 + 256, provider + ' state grew with history: ' + firstSize + ' -> ' + nextSize);
    assert.ok(nextSize < 100_000, provider + ' unexpectedly large parser state');
  }
});

test('Antigravity missing IDs stay distinct by position and unlisted models receive reference prices', () => {
  const row = { chatModel: { usage: { inputTokens: 100, outputTokens: 20 } } };
  const calls = gm.parseAntigravityGmEntries('sample', [row, row], T);
  assert.equal(calls.length, 2);
  assert.notEqual(gm.antigravityCallRequestId(calls[0]), gm.antigravityCallRequestId(calls[1]));
  assert.ok(agPricing.estimateAntigravityCostUSD(calls[0]) > 0);
  assert.equal(agIdentity.antigravityUsageOwnerKey(undefined), 'unknown');
  assert.equal(agIdentity.antigravityUsageOwnerKey('A@example.test'), agIdentity.antigravityUsageOwnerKey('a@example.test'));
  assert.notEqual(agIdentity.antigravityUsageOwnerKey('a@example.test'), agIdentity.antigravityUsageOwnerKey('b@example.test'));
});

test('Unknown to known Antigravity account transition does not import historical calls twice', async t => {
  const f = fixture(t, 'codex', true);
  const e = (id, n) => ({ requestId: id, identityKey: id, identityOrigin: 'antigravity:observation:' + id.split(':').at(-1),
    provider: 'antigravity', model: 'reference', timestampMs: T, inputTokens: n, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 1, cacheSavingsUSD: 0 });
  const save = async (scope, version, rows) => f.storage.commitSource({ mode: 'tail',
    source: { sourceId: 'antigravity:' + scope + ':cascade:sample', provider: 'antigravity', kind: 'remote', parserVersion: 3, version: { token: version } },
    batch: { checkpoint: { cursor: version }, entries: rows } });
  await save('unknown', 'one', [e('unknown:a', 100)]);
  await save('known', 'one', [e('known:a', 100)]);
  await save('known', 'two', [e('known:a', 100), e('known:b', 20)]);
  assert.equal((await f.metrics()).totalTokens, 120);
  await save('second-known', 'one', [e('second:a', 100)]);
  assert.equal((await f.metrics()).totalTokens, 220, 'different known accounts must remain distinct');
  await save('second-known', 'two', [e('second:a', 100), e('second:c', 30)]);
  assert.equal((await f.metrics()).totalTokens, 250);
});

test('Codex same-batch stable-ID revisions replace usage and foreign thread labels do not discard it', async t => {
  const f = fixture(t);
  const first = detail('revision', 100, undefined, 1);
  const next = detail('revision', 150, undefined, 2);
  first.payload.thread_id = next.payload.thread_id = 'different-thread-label';
  f.write([meta(), first, next]); await f.refresh();
  assert.equal((await f.metrics()).totalTokens, 150);
  assert.equal((await f.metrics()).requestCount, 1);
});

test('Codex copied stable responses remain single-counted across files without fork metadata', async t => {
  const f = fixture(t, 'codex', true);
  f.write([meta(), detail('shared-a', 100, 100, 1), detail('shared-b', 100, 200, 2)]);
  await f.refresh();
  const copy = path.join(f.dir, 'copy.jsonl');
  fs.writeFileSync(copy, [meta({ id: 'copy' }), detail('shared-a', 100, 100, 1), detail('shared-b', 100, 200, 2), detail('fresh', 50, 250, 3)].map(r => JSON.stringify(r)).join('\n') + '\n');
  const s = fs.statSync(copy);
  await f.index.refreshSource({ ...f.descriptor(), sourceId: 'codex:copy', version: { token: 'copy-1', size: s.size, mtimeMs: s.mtimeMs } }, codexModule.createCodexUsageIndexScanner(copy));
  assert.equal((await f.metrics()).totalTokens, 250);
});

test('Schema 4 and 5 upgrade preserve history and bootstrap independently of repair receipts', async t => {
  for (const version of [4, 5]) {
    const f = fixture(t, 'codex', true);
    f.write([meta(), total(100, 100, 1)]); await f.refresh();
    await f.index.close();
    const db = new DatabaseSync(f.dbFile);
    if (version === 4) db.exec('DROP TABLE usage_identity');
    else db.exec('CREATE TABLE usage_history_guard (provider TEXT PRIMARY KEY, before_ms INTEGER); CREATE TABLE usage_repair_receipt (repair_id TEXT PRIMARY KEY, report_json TEXT);');
    db.prepare('UPDATE usage_source SET parser_version=1, checkpoint_json=?').run(JSON.stringify({ byteOffset: fs.statSync(f.file).size }));
    db.exec('PRAGMA user_version=' + version); db.close();
    await f.restart();
    assert.equal((await f.metrics()).totalTokens, 100);
    await f.refresh(); assert.equal((await f.metrics()).totalTokens, 100);
    f.append([total(150, 50, 2)]); await f.refresh(); assert.equal((await f.metrics()).totalTokens, 150);
  }
});

test('Internal approximation diagnostics do not keep completed indexing incomplete', async t => {
  const f = fixture(t);
  f.write([meta(), total(10_000, 20, 1)]); await f.refresh();
  const result = await f.index.queryUsage({ grain: 'month' });
  assert.equal(result.coverage.state, 'complete');
  assert.equal('accountingIssueSourceCount' in result.coverage, false);
});

test('Late detailed identities link to counted cumulative observations before cross-file replay', async t => {
  for (const restartBeforeDetail of [false, true]) {
    const f = fixture(t, 'codex', true);
    f.write([meta(), total(100, 100, 1)]); await f.refresh();
    if (restartBeforeDetail) await f.restart();
    f.append([detail('late-shared', 100, 100, 1)]); await f.refresh();
    const copy = path.join(f.dir, 'late-copy.jsonl');
    fs.writeFileSync(copy, [meta({ id: 'late-copy' }), detail('late-shared', 100, 100, 1), detail('copy-new', 50, 150, 2)]
      .map(r => JSON.stringify(r)).join('\n') + '\n');
    const stat = fs.statSync(copy);
    await f.index.refreshSource({ ...f.descriptor(), sourceId: 'codex:late-copy',
      version: { token: 'late-copy', size: stat.size, mtimeMs: stat.mtimeMs } }, codexModule.createCodexUsageIndexScanner(copy));
    assert.equal((await f.metrics()).totalTokens, 150);
  }
});

test('File generations keep genuine post-rebase increments distinct from old counter values', async t => {
  const f = fixture(t, 'codex', true);
  f.write([meta(), total(100, 100, 1), total(200, 100, 2)]); await f.refresh();
  f.write([meta(), total(10, 10, 3)]); await f.refresh();
  f.append([total(100, 90, 4)]); await f.refresh();
  assert.equal((await f.metrics()).totalTokens, 290);
});

test('Late detailed records with new recording times do not reset notification accounting', async t => {
  const f = fixture(t, 'codex', true);
  f.write([meta(), total(100, 100, 1), total(200, 100, 2)]); await f.refresh(); await f.restart();
  f.append([detail('late-a', 100, 100, 3), detail('late-middle', 50, 150, 3.5), detail('late-b', 50, 200, 4), total(250, 50, 5)]);
  await f.refresh(); assert.equal((await f.metrics()).totalTokens, 250);
});

test('Notification progress inside an already counted detailed interval cannot rewind it', async t => {
  const f = fixture(t, 'codex', true);
  f.write([meta(), total(100, 100, 1), total(200, 100, 2), detail('ahead', 50, 250, 3)]);
  await f.refresh(); await f.restart();
  f.append([total(225, 25, 4), total(300, 75, 5)]); await f.refresh();
  assert.equal((await f.metrics()).totalTokens, 300);
});

test('A primary notification reset still resumes when a detailed interval preceded it', async t => {
  const f = fixture(t);
  f.write([meta(), total(100, 100, 1), total(200, 100, 2), detail('ahead', 50, 250, 3), total(30, 10, 4), total(80, 50, 5)]);
  await f.refresh(); assert.equal((await f.metrics()).totalTokens, 300);
});

test('Explicit child execution ends a fork prefix without task_started records', async t => {
  const f = fixture(t);
  f.write([meta({ forked_from_id: 'parent-not-present', timestamp: stamp(10) }), detail('own-a', 20, 10020, 11), detail('own-b', 30, 10050, 12)]);
  await f.refresh(); assert.equal((await f.metrics()).totalTokens, 50);
});

test('Explicit models override preceding model context in both Codex record formats', async t => {
  for (const row of [detail('model-change', 1_000_000, undefined, 1), total(1_000_000, 1_000_000, 1)]) {
    const f = fixture(t);
    row.payload.model = 'gpt-5.4-mini';
    f.write([meta(), row]); await f.refresh();
    assert.equal((await f.entries())[0].model, 'GPT-5.4-MINI');
    assert.ok(Math.abs((await f.metrics()).costUSD - 0.75) < 1e-12);
  }
});

test('An unknown account refresh retains its resolved scope before another known account appears', async t => {
  for (const sqlite of [false, true]) {
    const f = fixture(t, 'codex', sqlite);
    const row = scope => ({ requestId: scope + ':a', identityKey: scope + ':a', identityOrigin: 'antigravity:observation:a',
      provider: 'antigravity', model: 'reference', timestampMs: T, inputTokens: 100, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 1, cacheSavingsUSD: 0 });
    const save = (scope, token) => f.storage.commitSource({ mode: 'tail',
      source: { sourceId: 'antigravity:' + scope + ':cascade:sample', provider: 'antigravity', kind: 'remote', parserVersion: 3, version: { token } },
      batch: { checkpoint: { cursor: token }, entries: [row(scope)] } });
    await save('unknown', 'one'); await save('known-a', 'one'); await save('unknown', 'two'); await save('known-b', 'one');
    assert.equal((await f.metrics()).totalTokens, 200, sqlite ? 'sqlite' : 'memory');
  }
});

test('Bootstrap binds retained old requests so confirmed subsequent revisions remain possible', async t => {
  for (const sqlite of [false, true]) {
    const f = fixture(t, 'claude', sqlite);
    f.write([claude('legacy', 100)]);
    await f.storage.commitSource({ mode: 'rebuild', source: { ...f.descriptor(), parserVersion: 1 },
      batch: { checkpoint: { byteOffset: fs.statSync(f.file).size }, rebuildCoverage: { kind: 'full' }, entries: [{
        requestId: 'legacy', provider: 'claude', model: 'Sonnet', timestampMs: T + 1000,
        inputTokens: 100, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 0.0003, cacheSavingsUSD: 0,
      }] } });
    await f.refresh(); assert.equal((await f.metrics()).totalTokens, 100);
    f.append([claude('legacy', 150)]); await f.refresh();
    assert.equal((await f.metrics()).totalTokens, 150, sqlite ? 'sqlite' : 'memory');
  }
});

test('Antigravity same-batch identity conflicts preserve the first valid model and token components', () => {
  const row = (model, input, output, at) => ({ executionId: 'same', stepIndices: [1], createdAt: stamp(at),
    chatModel: { model, usage: { inputTokens: input, outputTokens: output } } });
  const first = row('gemini-3.1-pro', 100, 0, 1);
  const modelConflict = gm.parseAntigravityGmEntries('sample', [first, row('claude-opus-4.6', 150, 0, 2)], T);
  assert.equal(modelConflict[0].inputTokens, 100);
  const componentConflict = gm.parseAntigravityGmEntries('sample', [first, row('gemini-3.1-pro', 90, 20, 2)], T);
  assert.equal(componentConflict[0].inputTokens, 100);
  const revision = gm.parseAntigravityGmEntries('sample', [first, row('gemini-3.1-pro', 100, 20, 2)], T);
  assert.equal(revision[0].outputTokens, 20);
  assert.equal(revision[0].timestampMs, T + 1000);
});

test('Antigravity zero dates use the available fallback instead of failing a source transaction', () => {
  const call = gm.parseAntigravityGmEntry('sample', { executionId: 'zero-date', stepIndices: [0], createdAt: '0001-01-01T00:00:00Z',
    chatModel: { usage: { inputTokens: 100, outputTokens: 10 } } }, T);
  assert.equal(call.timestampMs, T);
});

test('Unrelated new assistant output cannot turn covered late details into a counter reset', async t => {
  const f = fixture(t, 'codex', true);
  f.write([meta(), total(100, 100, 1), total(200, 100, 2)]); await f.refresh(); await f.restart();
  f.append([{ type: 'response_item', timestamp: stamp(3), payload: { role: 'assistant', type: 'message', content: [] } },
    detail('late-with-output-a', 100, 100, 4), detail('late-with-output-b', 100, 200, 5), total(250, 50, 6)]);
  await f.refresh(); assert.equal((await f.metrics()).totalTokens, 250);
});

test('A matching repeated primary observation still establishes primary progress', async t => {
  const f = fixture(t, 'codex', true);
  f.write([meta(), detail('a', 100, 100, 1), detail('b', 100, 200, 2)]); await f.refresh();
  f.append([total(200, 100, 2)]); await f.refresh(); await f.restart();
  f.append([detail('middle', 50, 150, 3), total(250, 50, 4)]); await f.refresh();
  assert.equal((await f.metrics()).totalTokens, 250);
});

test('Bootstrap promotes a same-source protected identity only when its original request is retained', async t => {
  for (const sqlite of [false, true]) {
    const f = fixture(t, 'claude', sqlite);
    f.write([claude('retained', 100)]);
    await f.storage.commitSource({ mode: 'rebuild', source: { ...f.descriptor(), parserVersion: 1 },
      batch: { checkpoint: { byteOffset: fs.statSync(f.file).size }, rebuildCoverage: { kind: 'full' },
        identitySeeds: [{ key: 'claude:message:retained', requestId: 'retained', timestampMs: T + 1000 }], entries: [{
          requestId: 'retained', provider: 'claude', model: 'Sonnet', timestampMs: T + 1000,
          inputTokens: 100, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 0.0003, cacheSavingsUSD: 0,
        }] } });
    await f.refresh(); f.append([claude('retained', 150)]); await f.refresh();
    assert.equal((await f.metrics()).totalTokens, 150, sqlite ? 'sqlite' : 'memory');
  }
});

test('Fractional file modification times remain valid for empty projections and undated usage', async t => {
  for (const [provider, rows] of [['codex', [meta()]], ['codex', [{type:'token_usage_record',payload:{usage:vector(100)}}]], ['claude', [claude(undefined,100,{timestamp:undefined})]]]) {
    const f=fixture(t,provider,true);f.write(rows);
    const d=f.descriptor();d.version.mtimeMs=T+0.5;
    const scanner=provider==='codex'?codexModule.createCodexUsageIndexScanner:claudeModule.createClaudeUsageIndexScanner;
    await f.index.refreshSource(d,scanner(f.file));
    const stored=await f.storage.getSource(f.sourceId);
    assert.equal(stored.checkpoint.fallbackTimestampMs,T);
    for(const e of await f.entries()) assert.ok(Number.isInteger(e.timestampMs));
  }
});

test('Obsolete Codex resume state bootstraps at the protected checkpoint before new usage', async t => {
  const f=fixture(t,'codex',true);
  f.write([meta(),total(100,100,1)]);await f.refresh();await f.index.close();
  const db=new DatabaseSync(f.dbFile);
  const checkpoint=JSON.parse(db.prepare('SELECT checkpoint_json FROM usage_source WHERE source_id=?').get(f.sourceId).checkpoint_json);
  const resume=JSON.parse(checkpoint.resumeState);resume.accounting.version=2;resume.accounting.total=[99999999,0,0,0];
  checkpoint.resumeState=JSON.stringify(resume);db.prepare('UPDATE usage_source SET checkpoint_json=? WHERE source_id=?').run(JSON.stringify(checkpoint),f.sourceId);db.close();
  await f.restart();f.append([total(150,50,2)]);await f.refresh();
  assert.equal((await f.metrics()).totalTokens,150);
  assert.equal(JSON.parse((await f.storage.getSource(f.sourceId)).checkpoint.resumeState).accounting.version,4);
});

test('Equal-sized independent turns are not mistaken for a notification/detail pair', async t => {
  const f=fixture(t,'codex',true);
  const records=[meta()];
  for(let i=1;i<=2;i++){
    records.push({type:'event_msg',timestamp:stamp(i*10),payload:{type:'task_started',turn_id:'turn-'+i}});
    const row=detail('response-'+i,100,1000+i*100,i*10+1);row.payload.turn_id='turn-'+i;row.payload.turn_token_usage=vector(100);
    records.push(row,total(100,100,i*10+2));
  }
  f.write(records);await f.refresh();assert.equal((await f.metrics()).totalTokens,200);
});

test('Unpaired notifications cannot replace an established thread baseline', async t => {
  const f=fixture(t,'codex',true);
  const d=(id,n,thread,turn,at)=>({...detail(id,n,thread,at),payload:{...detail(id,n,thread,at).payload,turn_id:'a',turn_token_usage:vector(turn)}});
  f.write([meta(),{type:'event_msg',timestamp:stamp(0),payload:{type:'task_started',turn_id:'a'}},
    d('first',100,1100,100,1),{type:'response_item',timestamp:stamp(2),payload:{type:'function_call',name:'exec'}},total(150,50,3)]);
  await f.refresh();await f.restart();f.append([d('third',50,1200,200,4)]);await f.refresh();
  assert.equal((await f.metrics()).totalTokens,200);
});

test('Known detailed replay cannot change counter origin before identity deduplication', async t => {
  const f=fixture(t,'codex',true);
  const d=(id,n,thread,turn,at)=>({...detail(id,n,thread,at),payload:{...detail(id,n,thread,at).payload,turn_id:'a',turn_token_usage:vector(turn)}});
  const first=d('first',100,1100,100,1);
  f.write([meta(),{type:'event_msg',timestamp:stamp(0),payload:{type:'task_started',turn_id:'a'}},first,total(100,100,2),d('second',1000,2100,1100,3),total(1100,1000,4)]);
  await f.refresh();await f.restart();f.append([first,d('third',100,2200,1200,5)]);await f.refresh();
  assert.equal((await f.metrics()).totalTokens,1200);
});

test('Previously unseen delayed details cannot rebase an already covered thread interval', async t => {
  const f=fixture(t,'codex',true);
  const d=(id,n,thread,turn,at)=>({...detail(id,n,thread,at),payload:{...detail(id,n,thread,at).payload,turn_id:'a',turn_token_usage:vector(turn)}});
  f.write([meta(),{type:'event_msg',timestamp:stamp(0),payload:{type:'task_started',turn_id:'a'}},d('first',100,1100,100,1),total(100,100,2),d('second',1000,2100,1100,3),total(1100,1000,4)]);
  await f.refresh();await f.restart();f.append([d('late-unseen',50,1100,100,5),d('third',100,2200,1200,6)]);await f.refresh();
  assert.equal((await f.metrics()).totalTokens,1200);
});
