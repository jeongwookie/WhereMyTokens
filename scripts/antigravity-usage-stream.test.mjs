import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RpcArrayReader, GENERATOR_SELECTION } from '../dist/main/providers/antigravity/rpcStream.js';
import { createAntigravityUsageIndexScanner } from '../dist/main/providers/antigravity/usageIndexScanner.js';
import { parseAntigravityGmEntry } from '../dist/main/providers/antigravity/gmParser.js';
import { antigravityUsageEntryFromCall } from '../dist/main/providers/antigravity/summary.js';
import { AntigravityLsClient } from '../dist/main/providers/antigravity/lsClient.js';
import usage from '../dist/main/usageIndex/index.js';
const { DefaultUsageIndex, InMemoryUsageIndexStorage, SqliteUsageIndexStorage } = usage;
const TODAY = Date.parse('2026-11-11T00:00:00+08:00');
const FALLBACK = TODAY - 3600000;

function gm(i, output = 2) {
  return { executionId: `e${i}`, stepIndices: [i], chatModel: {
    model: 'gemini-3.1-pro', responseModel: 'gemini-3.1-pro',
    usage: { inputTokens: 10, outputTokens: output }, tools: [{ name: 'read_file' }],
  } };
}
function step(i) {
  return { status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: new Date(TODAY + (i ? i : -1) * 1000).toISOString() } };
}
function descriptor(token = 'v1', parserVersion = 4) {
  return { sourceId: 'antigravity:account:cascade:sample', provider: 'antigravity', kind: 'remote', parserVersion,
    version: { token, mtimeMs: TODAY + 100000 } };
}
function scanner(server, count, budget = 8000) {
  return createAntigravityUsageIndexScanner({ server, cascadeId: 'sample', stepCount: count,
    lastModifiedMs: FALLBACK, modelLabels: new Map(), stopAt: Date.now() + budget });
}
async function refresh(index, server, count, token = 'v1') {
  const source = descriptor(token);
  index.declareSources('antigravity', [source], true);
  return index.refreshSource(source, scanner(server, count));
}
async function fixture(t, metadata, steps) {
  const requests = [];
  const data = { metadata, steps, stepFailure: false, truncate: false };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const method = req.url.split('/').at(-1);
    requests.push({ method, body });
    if (method === 'GetCascadeTrajectorySteps' && data.stepFailure) {
      res.writeHead(503); res.end('{}'); return;
    }
    if (method === 'GetCascadeTrajectory') { res.writeHead(500); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      const rows = data.metadata.slice(body.generatorMetadataOffset ?? 0);
      if (data.truncate) {
        res.write('{"generatorMetadata":[' + rows.slice(0, 150).map(JSON.stringify).join(',') + ',');
        setTimeout(() => res.destroy(), 100);
      } else res.end(JSON.stringify({ generatorMetadata: rows }));
    } else if (method === 'GetCascadeTrajectorySteps') {
      res.end(JSON.stringify({ steps: data.steps.slice(body.stepOffset ?? 0) }));
    } else res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { data, requests, server: { pid: 1, port: server.address().port, protocol: 'http', csrfToken: 'test' } };
}

test('selective RPC parser preserves fields and raw positions across chunk and escape boundaries', () => {
  const payload = { generatorMetadata: [null, { ...gm(1), executionId: '中文\\"\n', ignored: 'x'.repeat(200000) }, gm(2)] };
  const raw = JSON.stringify(payload);
  for (const size of [1, 7, 65536]) {
    const reader = new RpcArrayReader('generatorMetadata', GENERATOR_SELECTION), records = [];
    for (let i = 0; i < raw.length; i += size) { reader.write(raw.slice(i, i + size)); records.push(...reader.takeRecords()); }
    reader.end(); records.push(...reader.takeRecords());
    assert.deepEqual(records.map(r => r.index), [0, 1, 2]);
    assert.equal(records[1].value.executionId, payload.generatorMetadata[1].executionId);
    assert.equal(records[1].value.ignored, undefined);
    assert.deepEqual(records[2].value.chatModel.usage, gm(2).chatModel.usage);
  }
  for (const raw of ['{"steps":[{}', '{"steps":[{},]}', '{"steps":[{"x":"\\q"}]}']) {
    const reader = new RpcArrayReader('steps', { metadata: { createdAt: true } });
    assert.throws(() => { reader.write(raw); reader.end(); });
  }
});

test('cross-midnight calls use step times and incremental reads revise the last call once', async t => {
  const f = await fixture(t, [gm(0), gm(1)], [step(0), step(1)]);
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage(), () => TODAY + 100000);
  t.after(() => index.close());
  await refresh(index, f.server, 2);
  assert.equal((await index.queryUsage({ grain: 'day', fromMs: TODAY })).aggregate.totalTokens, 12);
  f.data.metadata[1] = gm(1, 5); f.data.metadata.push(gm(2)); f.data.steps.push(step(2));
  await refresh(index, f.server, 3, 'v2');
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 39);
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 3);
  assert.equal(f.requests.filter(r => r.method === 'GetCascadeTrajectoryGeneratorMetadata').at(-1).body.generatorMetadataOffset, 1);
  assert.equal(f.requests.filter(r => r.method === 'GetCascadeTrajectorySteps').at(-1).body.stepOffset, 1);
  const [projection] = await index.readSessionProjections();
  assert.equal(projection.payload.sessionSnapshot.toolCounts.read_file, 3);
  const count = f.requests.length;
  assert.equal((await refresh(index, f.server, 3, 'v2')).status, 'unchanged');
  assert.equal(f.requests.length, count);
  assert.ok(f.requests.every(r => r.method !== 'GetCascadeTrajectory'));
});

for (const sqlite of [false, true]) {
  test(`estimated dates move buckets and identity aliases without changing costs (${sqlite ? 'SQLite' : 'memory'})`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-ag-date-'));
    const database = path.join(dir, 'usage.sqlite');
    let index = new DefaultUsageIndex(sqlite ? new SqliteUsageIndexStorage(database) : new InMemoryUsageIndexStorage(), () => TODAY + 100000);
    t.after(async () => { await index.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const old = descriptor('old', 3);
    const call = parseAntigravityGmEntry('sample', gm(1), FALLBACK);
    const e = { ...antigravityUsageEntryFromCall(call), costUSD: 3.25, cacheSavingsUSD: 1,
      identityKey: `${old.sourceId}:${antigravityUsageEntryFromCall(call).requestId}`,
      identityAliases: ['alias'], identityOrigin: 'antigravity:observation:' + antigravityUsageEntryFromCall(call).requestId };
    index.declareSources('antigravity', [old], true);
    await index.refreshSource(old, { scan: async () => ({ checkpoint: { fallbackTimestampMs: FALLBACK }, entries: [e], rebuildCoverage: { kind: 'full' } }) });
    const f = await fixture(t, [gm(1)], [step(0), step(1)]);
    await refresh(index, f.server, 2);
    const total = await index.queryUsage({ grain: 'month' });
    assert.equal(total.aggregate.totalTokens, 12); assert.equal(total.aggregate.costUSD, 3.25);
    assert.equal(total.aggregate.cacheSavingsUSD, 1);
    assert.equal((await index.queryUsage({ grain: 'day', fromMs: TODAY })).aggregate.totalTokens, 12);
    if (sqlite) { await index.close(); index = new DefaultUsageIndex(new SqliteUsageIndexStorage(database), () => TODAY + 100000); }
    await refresh(index, f.server, 2, 'v2');
    assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 12);
    if (sqlite) {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        assert.deepEqual(db.prepare('SELECT DISTINCT timestamp_ms FROM usage_identity').all().map(r => r.timestamp_ms), [TODAY + 1000]);
      } finally { db.close(); }
    }
  });
}

test('time lookup failure retains quantities and retries dates without duplicates', async t => {
  const f = await fixture(t, [gm(0), gm(1)], [step(0), step(1)]);
  f.data.stepFailure = true;
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage(), () => TODAY + 100000);
  t.after(() => index.close());
  assert.equal((await refresh(index, f.server, 2)).status, 'partial');
  const before = await index.queryUsage({ grain: 'month' });
  assert.equal(before.aggregate.totalTokens, 24); assert.equal(before.coverage.failedSourceCount, 1);
  f.data.stepFailure = false;
  await refresh(index, f.server, 2);
  const after = await index.queryUsage({ grain: 'month' });
  assert.equal(after.aggregate.totalTokens, 24); assert.equal(after.coverage.state, 'complete');
  assert.equal((await index.queryUsage({ grain: 'day', fromMs: TODAY })).aggregate.totalTokens, 12);
});

test('raw metadata offsets include failed rows and unfinished calls replay their suffix', async t => {
  const f = await fixture(t, [gm(0), { executionId: 'failed', error: 'failed' }, gm(2, 0), gm(3)],
    [step(0), step(1), { ...step(2), status: 'CORTEX_STEP_STATUS_RUNNING' }, step(3)]);
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage(), () => TODAY + 100000);
  t.after(() => index.close());
  await refresh(index, f.server, 4);
  f.data.metadata[2] = gm(2, 7); f.data.steps[2] = step(2);
  await refresh(index, f.server, 4, 'v2');
  assert.equal(f.requests.filter(r => r.method === 'GetCascadeTrajectoryGeneratorMetadata').at(-1).body.generatorMetadataOffset, 2);
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 41);
  assert.equal((await index.readSessionProjections())[0].payload.sessionSnapshot.toolCounts.read_file, 3);
});

test('calls spanning more than the step cache retain the first associated timestamp', async t => {
  const f = await fixture(t, [{ ...gm(0), stepIndices: [2048, 0] }], Array.from({ length: 2049 }, (_, i) => step(i)));
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage(), () => TODAY + 100000);
  t.after(() => index.close());
  await refresh(index, f.server, 2049);
  assert.equal((await index.queryUsage({ grain: 'day', fromMs: TODAY })).aggregate.totalTokens, 0);
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.totalTokens, 12);
});

test('a response larger than 8 MiB streams past discarded conversation content', async t => {
  const f = await fixture(t, [gm(1)], [step(0), { ...step(1), generic: { text: 'x'.repeat(9 * 1024 * 1024) } }]);
  const index = new DefaultUsageIndex(new InMemoryUsageIndexStorage(), () => TODAY + 100000);
  t.after(() => index.close());
  await refresh(index, f.server, 2);
  assert.equal((await index.queryUsage({ grain: 'day', fromMs: TODAY })).aggregate.totalTokens, 12);
  assert.equal((await index.queryUsage({ grain: 'month' })).coverage.state, 'complete');
});

test('interrupted multi-batch scans resume from the committed raw offset after SQLite restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-ag-resume-'));
  const database = path.join(dir, 'usage.sqlite');
  const f = await fixture(t, Array.from({ length: 200 }, (_, i) => gm(i)), Array.from({ length: 200 }, (_, i) => step(i)));
  f.data.truncate = true;
  let index = new DefaultUsageIndex(new SqliteUsageIndexStorage(database), () => TODAY + 100000);
  t.after(async () => { await index.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(refresh(index, f.server, 200));
  assert.equal((await index.queryUsage({ grain: 'month' })).aggregate.requestCount, 128);
  await index.close();
  index = new DefaultUsageIndex(new SqliteUsageIndexStorage(database), () => TODAY + 100000);
  f.data.truncate = false;
  await refresh(index, f.server, 200);
  assert.equal(f.requests.filter(r => r.method === 'GetCascadeTrajectoryGeneratorMetadata').at(-1).body.generatorMetadataOffset, 128);
  const result = await index.queryUsage({ grain: 'month' });
  assert.equal(result.aggregate.requestCount, 200); assert.equal(result.aggregate.totalTokens, 2400);
  assert.equal(result.coverage.state, 'complete');
  const [projection] = await index.readSessionProjections();
  assert.equal(projection.payload.sessionSnapshot.toolCounts.read_file, 200);
});

test('ordinary RPC size and HTTP errors preserve the original cause', async t => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    if (req.url.endsWith('/large')) res.end(JSON.stringify({ text: 'x'.repeat(9 * 1024 * 1024) }));
    else { res.writeHead(503); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = new AntigravityLsClient({ pid: 1, port: server.address().port, protocol: 'http', csrfToken: 'test' });
  await assert.rejects(client.call('large'), /response too large/);
  await assert.rejects(client.call('unavailable'), /HTTP 503/);
  assert.equal(requests, 2);
});
