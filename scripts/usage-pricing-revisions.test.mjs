import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import indexModule from '../dist/main/usageIndex/index.js';
import pricing from '../dist/main/modelPricing.js';
import revisions from '../dist/main/usageIndex/pricingRevisions.js';
import startup from '../dist/main/usagePricingStartup.js';
import safety from '../dist/main/usageIndex/losslessCostReprice.js';

const { applyUsagePricingRevisions } = revisions;
const rule = pricing.USAGE_PRICE_REVISIONS[0];
const start = rule.effectiveFromMs;
const request = (id, timestampMs, extra = {}) => ({
  requestId: id, identityKey: `codex:request:${id}`, identityOrigin: `fixture:${id}`,
  timestampMs, provider: 'codex', model: 'gpt-6-astra',
  inputTokens: 1000, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 1000,
  costUSD: 0.00425, cacheSavingsUSD: 0.00225, ...extra,
});

async function fixture(t, records = [request('r1', start)]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-price-revision-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'usage.sqlite');
  const storage = new indexModule.SqliteUsageIndexStorage(databasePath);
  const source = { sourceId: 'codex:fixture', provider: 'codex', kind: 'file', parserVersion: 5,
    version: { token: 'fixture-v1', size: 100, mtimeMs: start } };
  await storage.commitSource({ source, mode: 'rebuild', batch: {
    checkpoint: { byteOffset: 100 }, entries: records, rebuildCoverage: { kind: 'full' },
    sessionProjection: { sourceId: source.sourceId, provider: 'codex', updatedAt: start,
      byteSize: 1, payload: { sessionSnapshot: { rawModel: rule.model, toolCounts: { read: 1 } } } },
  } });
  await storage.close();
  const options = { databasePath, backupDirectory: path.join(dir, 'backups') };
  const read = fn => { const db = new DatabaseSync(databasePath); try { return fn(db); } finally { db.close(); } };
  return { dir, options, read, source };
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('revision start date controls both new pricing and historical selection, including shared month buckets', async t => {
  const before = request('before', start - 1), at = request('at', start), other = request('other', start, { model: 'gpt-5.4' });
  const f = await fixture(t, [before, at, other]);
  const facts = f.read(safety.hashNonCostState);
  const oldMonth = f.read(db => db.prepare("SELECT cost_usd FROM usage_bucket WHERE model=? AND bucket_kind='month'").get(rule.model).cost_usd);
  const [report] = applyUsagePricingRevisions(f.options);
  assert.equal(report.updatedEntries, 1);
  assert.equal(report.updatedBuckets, 3);
  assert.equal(report.preservedSources, 0);
  const rows = f.read(db => db.prepare('SELECT * FROM usage_entry ORDER BY request_id').all());
  close(rows.find(r => r.request_id === 'at').cost_usd, 0.016);
  assert.equal(rows.find(r => r.request_id === 'before').cost_usd, before.costUSD);
  assert.equal(rows.find(r => r.request_id === 'other').cost_usd, other.costUSD);
  close(f.read(db => db.prepare("SELECT cost_usd FROM usage_bucket WHERE model=? AND bucket_kind='month'").get(rule.model).cost_usd), oldMonth + 0.016 - at.costUSD);
  assert.equal(f.read(safety.hashNonCostState), facts);
  const backup = new DatabaseSync(report.backupPath, { readOnly: true });
  assert.equal(safety.hashNonCostState(backup), facts);
  close(backup.prepare('SELECT cost_usd FROM usage_entry WHERE request_id=?').get('at').cost_usd, at.costUSD);
  backup.close();
  close(pricing.estimateUsageCost({ ...before, model: rule.model }).costUSD, before.costUSD);
});

test('long-context pricing is applied per request rather than to a daily token sum', async t => {
  const long = request('long', start + 1, { inputTokens: 272001, outputTokens: 1000, cacheReadTokens: 0 });
  const f = await fixture(t, [request('short', start), long]);
  applyUsagePricingRevisions(f.options);
  const rows = f.read(db => db.prepare('SELECT request_id,cost_usd FROM usage_entry ORDER BY request_id').all());
  close(rows[0].cost_usd, 272001 * 20 / 1e6 + 0.075);
  close(rows[1].cost_usd, 0.016);
});

test('missing or inconsistent detail preserves source costs and records the skipped range once', async t => {
  const f = await fixture(t, [request('kept', start), request('missing', start + 1)]);
  f.read(db => db.exec("DELETE FROM usage_entry WHERE request_id='missing'"));
  const before = f.read(safety.hashFullState);
  const [report] = applyUsagePricingRevisions(f.options);
  assert.equal(report.preservedSources, 1);
  assert.equal(report.updatedEntries, 0);
  assert.equal(f.read(safety.hashFullState), before);
  assert.deepEqual(applyUsagePricingRevisions(f.options), [report]);
  assert.equal(fs.readdirSync(f.options.backupDirectory).length, 1);
});

test('dry run rolls back both prices and completion receipt without making a backup', async t => {
  const f = await fixture(t);
  const before = f.read(safety.hashFullState);
  const [preview] = applyUsagePricingRevisions({ ...f.options, dryRun: true });
  assert.equal(preview.updatedEntries, 1);
  assert.equal(f.read(safety.hashFullState), before);
  assert.equal(f.read(db => db.prepare("SELECT name FROM sqlite_master WHERE name='usage_pricing_revision'").get()), undefined);
  assert.equal(fs.existsSync(f.options.backupDirectory), false);
});

test('completed revisions are no-op on restart and cannot silently change their meaning', async t => {
  const f = await fixture(t);
  const first = await startup.reconcileUsagePricingAtStartup(f.options);
  const state = f.read(safety.hashFullState);
  assert.deepEqual(await startup.reconcileUsagePricingAtStartup(f.options), first);
  assert.equal(f.read(safety.hashFullState), state);
  assert.equal(fs.readdirSync(f.options.backupDirectory).length, 1);
  assert.throws(() => applyUsagePricingRevisions({ ...f.options, revisions: [{ ...rule, rates: { ...rule.rates, input: 11 } }] }), /Completed pricing revision changed/);
});

test('database rollback leaves no completion receipt and a later retry updates exactly once', async t => {
  const f = await fixture(t);
  f.read(db => db.exec("CREATE TRIGGER fail_price BEFORE UPDATE OF cost_usd ON usage_bucket BEGIN SELECT RAISE(ABORT,'test failure'); END"));
  const before = f.read(safety.hashFullState);
  assert.throws(() => applyUsagePricingRevisions(f.options), /test failure/);
  assert.equal(f.read(safety.hashFullState), before);
  assert.equal(f.read(db => db.prepare("SELECT name FROM sqlite_master WHERE name='usage_pricing_revision'").get()), undefined);
  f.read(db => db.exec('DROP TRIGGER fail_price'));
  assert.equal(applyUsagePricingRevisions(f.options)[0].updatedEntries, 1);
});

test('subsequent price revisions affect only their own effective interval and leave completed receipts intact', async t => {
  const end = start + 86400000;
  const f = await fixture(t, [request('old', start), request('new', end)]);
  applyUsagePricingRevisions(f.options);
  const next = { ...rule, id: 'test-next-revision', effectiveFromMs: end, effectiveUntilMs: end + 86400000,
    rates: { input: 20, output: 100, cacheWrite: 25, cacheRead: 2 } };
  const reports = applyUsagePricingRevisions({ ...f.options, revisions: [rule, next] });
  assert.equal(reports[1].updatedEntries, 1);
  const rows = f.read(db => db.prepare('SELECT request_id,cost_usd FROM usage_entry ORDER BY request_id').all());
  close(rows[0].cost_usd, 0.032);
  close(rows[1].cost_usd, 0.016);
});

test('different models in the same source are untouched even when their details are incomplete', async t => {
  const f = await fixture(t, [request('target', start), request('other', start, { model: 'gpt-5.4' })]);
  f.read(db => db.exec("DELETE FROM usage_entry WHERE request_id='other'"));
  const other = f.read(db => db.prepare("SELECT * FROM usage_bucket WHERE model='gpt-5.4'").all());
  assert.equal(applyUsagePricingRevisions(f.options)[0].updatedEntries, 1);
  assert.deepEqual(f.read(db => db.prepare("SELECT * FROM usage_bucket WHERE model='gpt-5.4'").all()), other);
});

test('non-cost validation includes rows beyond the first hash page', async t => {
  const f = await fixture(t, Array.from({ length: 1201 }, (_, i) => request(`r${String(i).padStart(4, '0')}`, start + i)));
  const before = f.read(safety.hashNonCostState);
  f.read(db => db.exec("UPDATE usage_entry SET breakdown_json='{}' WHERE request_id='r1200'"));
  assert.notEqual(f.read(safety.hashNonCostState), before);
  assert.equal(applyUsagePricingRevisions(f.options)[0].updatedEntries, 1201);
});

test('repricing refreshes the derived execution digest so an unchanged replay remains a duplicate', async t => {
  const f = await fixture(t);
  const ownership = f.read(db => db.prepare('SELECT provider,identity_key,source_id,request_id,timestamp_ms,origin_id FROM usage_identity').all());
  assert.equal(applyUsagePricingRevisions(f.options)[0].updatedIdentityRows, 1);
  const storage = new indexModule.SqliteUsageIndexStorage(f.options.databasePath);
  try {
    await storage.commitSource({ source: { ...f.source, version: { ...f.source.version, token: 'v2', size: 101 } }, mode: 'tail', batch: {
      checkpoint: { byteOffset: 101 }, entries: [request('r1', start, { costUSD: 0.016, cacheSavingsUSD: 0.009 })],
    } });
  } finally { await storage.close(); }
  assert.deepEqual(f.read(db => db.prepare('SELECT provider,identity_key,source_id,request_id,timestamp_ms,origin_id FROM usage_identity').all()), ownership);
  const metadata = f.read(db => db.prepare('SELECT provider_metadata_json FROM usage_source').get());
  assert.deepEqual(JSON.parse(metadata.provider_metadata_json ?? '{}').accountingIssues ?? [], []);
  assert.equal(f.read(db => db.prepare("SELECT request_count FROM usage_bucket WHERE bucket_kind='month'").get()).request_count, 1);
});
