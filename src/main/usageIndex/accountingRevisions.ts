import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listAllCodexSources } from '../providers/codex/sources';
import { createCodexUsageIndexScanner } from '../providers/codex/usageIndexScanner';
import { readCounterRevisionEvidence } from '../providers/codex/counterRevisionEvidence';
import { checkpointFingerprint } from '../providers/shared/fileCheckpoint';
import { createBackup, sameNumber } from './losslessCostReprice';
import { executionFingerprint } from './executionIdentity';
import { applyUsageBucketDeltas, usageIndexSchemaVersion } from './sqliteUsageIndexStorage';
import { collectUsageBucketDeltas, type UsageBucketDelta } from './usageBucketAggregation';
import { BREAKDOWN_KEYS } from '../../shared/breakdownTypes';
import type { AccountingRevisionReport, AccountingSourceReport, AccountingPreserveReason } from '../../shared/accountingRevision';
import type { UsageEntry, UsageSourceCheckpoint } from './types';
import type { TokenVector } from '../providers/codex/accounting';

export const CODEX_COUNTER_REVISION_ID = 'codex-counter-origins-v1';
const SIGNATURE = 'explicit-counter-equations-and-repeated-notifications-v1';
const ENTRY_QUERY = `SELECT request_id AS requestId, timestamp_ms AS timestampMs, provider, model,
  input_tokens AS inputTokens, output_tokens AS outputTokens, cache_creation_tokens AS cacheCreationTokens,
  cache_read_tokens AS cacheReadTokens, cost_usd AS costUSD, cache_savings_usd AS cacheSavingsUSD,
  breakdown_json AS breakdownJson FROM usage_entry WHERE source_id=? ORDER BY timestamp_ms,request_id`;
const TABLES = `CREATE TABLE IF NOT EXISTS usage_accounting_revision (
  revision_id TEXT PRIMARY KEY, signature TEXT NOT NULL, started_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS usage_accounting_revision_source (
  revision_id TEXT NOT NULL REFERENCES usage_accounting_revision(revision_id),
  source_id TEXT NOT NULL REFERENCES usage_source(source_id) ON DELETE CASCADE,
  report_json TEXT, backup_path TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(revision_id,source_id)
) STRICT;`;

interface SourceRow {
  source_id: string; provider: string; source_kind: string; parser_version: number;
  version_token: string; source_size: number | null; mtime_ms: number | null; checkpoint_json: string;
}
interface Correction { before: UsageEntry; after: UsageEntry | null; owner: UsageEntry; responseKey: string; aliases: string[] }
interface Plan { corrections: Correction[]; deltas: Map<string, UsageBucketDelta>; unverified: boolean }
export interface AccountingRevisionOptions {
  databasePath: string;
  backupDirectory: string;
  dryRun?: boolean;
  retryPreserved?: boolean;
  /** Uses the same discovered source identities as normal collection. */
  sourceFiles?: () => ReadonlyMap<string, string>;
  onProgress?: (progress: { checkedSources: number; totalSources: number; phase: 'checking' | 'committing' }) => void;
}

const label = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 12);
const tokens = (e: UsageEntry) => e.inputTokens + e.cacheReadTokens + e.cacheCreationTokens + e.outputTokens;
const sameTokens = (a: UsageEntry, b: UsageEntry) => a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens
  && a.cacheCreationTokens === b.cacheCreationTokens && a.cacheReadTokens === b.cacheReadTokens;
const matches = (e: UsageEntry, v: TokenVector) => e.inputTokens === v[0] - v[1]
  && e.cacheReadTokens === v[1] && e.outputTokens === v[2] && e.cacheCreationTokens === 0;
function entries(db: DatabaseSync, id: string): UsageEntry[] {
  return (db.prepare(ENTRY_QUERY).all(id) as unknown as Array<UsageEntry & { breakdownJson: string | null }>)
    .map(({ breakdownJson, ...e }) => ({ ...e, ...(breakdownJson ? { breakdown: JSON.parse(breakdownJson) } : {}) }));
}
function uniqueAt(rows: readonly UsageEntry[]): Map<number, UsageEntry> {
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.timestampMs, (counts.get(row.timestampMs) ?? 0) + 1);
  return new Map(rows.filter(e => counts.get(e.timestampMs) === 1).map(e => [e.timestampMs, e]));
}
function blank(id: string, rows: readonly UsageEntry[]): AccountingSourceReport {
  return { source: label(id), outcome: 'unchanged', correctedEntries: 0, removedDuplicates: 0,
    savedCostUSD: 0, savedTokens: 0, fromMs: rows.length ? rows[0]!.timestampMs : null,
    toMs: rows.length ? rows[rows.length - 1]!.timestampMs : null };
}
function preserve(report: AccountingSourceReport, reason: AccountingPreserveReason): AccountingSourceReport {
  return { ...report, outcome: 'preserved', reason };
}

async function makePlan(db: DatabaseSync, source: SourceRow, file: string, checkpoint: UsageSourceCheckpoint, old: UsageEntry[]): Promise<Plan> {
  const sourceId = source.source_id;
  const batch = await createCodexUsageIndexScanner(file, { endOffsetExclusive: checkpoint.byteOffset }).scan({
    source: { sourceId, provider: 'codex', kind: 'file', parserVersion: 7,
      version: { token: source.version_token, size: checkpoint.byteOffset, mtimeMs: source.mtime_ms ?? 0 } },
    mode: 'rebuild', checkpoint: null, previousSessionProjection: null,
  });
  const evidence = await readCounterRevisionEvidence(file, checkpoint.byteOffset!, sourceId);
  const freshAt = uniqueAt(batch.entries), oldAt = uniqueAt(old);
  const corrections: Correction[] = [];
  let unverified = false;
  for (const before of old) {
    const fresh = freshAt.get(before.timestampMs);
    if (fresh && before.provider === fresh.provider && before.model === fresh.model && sameTokens(before, fresh)) continue;
    const proof = evidence.get(before.timestampMs);
    if (!proof || oldAt.get(before.timestampMs) !== before || !matches(before, proof.faulty)) { unverified = true; continue; }
    const owner = oldAt.get(proof.ownerTimestampMs);
    const canonical = freshAt.get(proof.ownerTimestampMs);
    const identity = db.prepare('SELECT source_id,request_id FROM usage_identity WHERE provider=? AND identity_key=?').get('codex', proof.responseKey);
    if (!owner || !canonical || identity?.source_id !== sourceId || identity.request_id !== owner.requestId
      || before.model !== canonical.model || !canonical.identityAliases?.includes(proof.responseKey)) { unverified = true; continue; }
    if (proof.kind === 'mixed-origin') {
      if (!fresh || !matches(fresh, proof.correct) || tokens(fresh) >= tokens(before) || fresh.costUSD > before.costUSD) {
        unverified = true; continue;
      }
      corrections.push({ before, after: { ...fresh, requestId: before.requestId }, owner: before, responseKey: proof.responseKey,
        aliases: [fresh.identityKey!, ...(fresh.identityAliases ?? [])] });
    } else {
      if (fresh || owner.requestId === before.requestId || !sameTokens(owner, canonical)) { unverified = true; continue; }
      corrections.push({ before, after: null, owner, responseKey: proof.responseKey, aliases: [] });
    }
  }
  const deltas = new Map<string, UsageBucketDelta>();
  for (const c of corrections) {
    collectUsageBucketDeltas(deltas, sourceId, [c.before], -1);
    if (c.after) collectUsageBucketDeltas(deltas, sourceId, [c.after], 1);
  }
  return { corrections, deltas, unverified };
}

function bucketsReconcile(db: DatabaseSync, id: string, old: UsageEntry[], deltas: Map<string, UsageBucketDelta>): boolean {
  const all = new Map<string, UsageBucketDelta>(); collectUsageBucketDeltas(all, id, old, 1);
  const columns = { requestCount: 'request_count', inputTokens: 'input_tokens', outputTokens: 'output_tokens',
    cacheCreationTokens: 'cache_creation_tokens', cacheReadTokens: 'cache_read_tokens', totalTokens: 'total_tokens',
    costUSD: 'cost_usd', cacheSavingsUSD: 'cache_savings_usd' } as const;
  for (const [key, delta] of deltas) {
    const row = db.prepare('SELECT * FROM usage_bucket WHERE source_id=? AND provider=? AND model=? AND bucket_kind=? AND bucket_start_ms=?')
      .get(id, delta.provider, delta.model, delta.kind, delta.bucketStartMs);
    const expected = all.get(key);
    if (!row || !expected || !Object.entries(columns).every(([k, col]) => sameNumber(Number(row[col]), expected.metrics[k as keyof typeof columns]))) return false;
    const breakdown = JSON.parse(String(row.breakdown_json));
    if (!BREAKDOWN_KEYS.every(k => sameNumber(Number(breakdown[k] ?? 0), expected.breakdown[k]))) return false;
  }
  return true;
}

function identitiesReconcile(db: DatabaseSync, id: string, corrections: Correction[]): boolean {
  for (const c of corrections) {
    const proofOwner = db.prepare('SELECT source_id,request_id FROM usage_identity WHERE provider=? AND identity_key=?').get('codex', c.responseKey);
    if (!proofOwner || proofOwner.source_id !== id || proofOwner.request_id !== c.owner.requestId) return false;
  }
  for (const c of corrections) for (const alias of c.aliases) {
    const row = db.prepare('SELECT * FROM usage_identity WHERE provider=? AND identity_key=?').get('codex', alias);
    const protectedSeed = row && c.after && row.source_id === id && row.request_id === `protected:${c.after.identityKey}`
      && row.timestamp_ms === c.before.timestampMs && row.fingerprint === ''
      && !db.prepare('SELECT 1 FROM usage_entry WHERE source_id=? AND request_id=?').get(id, String(row.request_id));
    if (row && (row.source_id !== id || row.request_id !== c.owner.requestId) && !protectedSeed) return false;
  }
  return true;
}

function applyPlan(db: DatabaseSync, id: string, plan: Plan): void {
  applyUsageBucketDeltas(db, plan.deltas.values());
  for (const c of plan.corrections) {
    if (c.after) {
      const e = c.after, fingerprint = executionFingerprint(e);
      db.prepare(`UPDATE usage_entry SET input_tokens=?,output_tokens=?,cache_creation_tokens=?,cache_read_tokens=?,
        cost_usd=?,cache_savings_usd=?,breakdown_json=? WHERE source_id=? AND request_id=?`)
        .run(e.inputTokens, e.outputTokens, e.cacheCreationTokens, e.cacheReadTokens, e.costUSD, e.cacheSavingsUSD,
          JSON.stringify(e.breakdown ?? null), id, e.requestId);
      db.prepare('UPDATE usage_identity SET fingerprint=? WHERE provider=? AND source_id=? AND request_id=?').run(fingerprint, 'codex', id, e.requestId);
      // A protected replay seed has no quantity. The raw response identity above
      // proves which retained execution it belongs to; promote the entire alias group.
      db.prepare('UPDATE usage_identity SET request_id=?,timestamp_ms=?,origin_id=?,fingerprint=? WHERE provider=? AND source_id=? AND request_id=? AND fingerprint=?')
        .run(e.requestId, e.timestampMs, e.identityOrigin ?? '', fingerprint, 'codex', id, `protected:${e.identityKey}`, '');
      for (const alias of c.aliases) db.prepare(`INSERT INTO usage_identity VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(provider,identity_key) DO NOTHING`).run('codex', alias, id, e.requestId, e.timestampMs, e.identityOrigin ?? '', fingerprint);
    } else {
      const revisedOwner = plan.corrections.find(r => r.before.requestId === c.owner.requestId)?.after ?? c.owner;
      db.prepare('DELETE FROM usage_entry WHERE source_id=? AND request_id=?').run(id, c.before.requestId);
      db.prepare('UPDATE usage_identity SET request_id=?,timestamp_ms=?,fingerprint=? WHERE provider=? AND source_id=? AND request_id=?')
        .run(c.owner.requestId, c.owner.timestampMs, executionFingerprint(revisedOwner), 'codex', id, c.before.requestId);
    }
  }
}

function summarize(reports: AccountingSourceReport[]): AccountingRevisionReport {
  reports.sort((a, b) => a.source.localeCompare(b.source));
  return { revisionId: CODEX_COUNTER_REVISION_ID,
    resultKey: createHash('sha256').update(JSON.stringify(reports)).digest('hex'), completedAt: new Date().toISOString(),
    checkedSources: reports.length, correctedSources: reports.filter(r => r.correctedEntries > 0).length,
    preservedSources: reports.filter(r => r.outcome === 'preserved' || r.outcome === 'partial').length,
    unchangedSources: reports.filter(r => r.outcome === 'unchanged').length,
    correctedEntries: reports.reduce((n, r) => n + r.correctedEntries, 0), removedDuplicates: reports.reduce((n, r) => n + r.removedDuplicates, 0),
    savedCostUSD: reports.reduce((n, r) => n + r.savedCostUSD, 0), savedTokens: reports.reduce((n, r) => n + r.savedTokens, 0), sources: reports };
}

/** One immutable defect revision; no old parser, fixed personal dates, or destructive replay. */
export async function reconcileUsageAccounting(options: AccountingRevisionOptions): Promise<AccountingRevisionReport> {
  const db = new DatabaseSync(options.databasePath, { readOnly: options.dryRun === true, timeout: 5000 });
  let transaction = false;
  try {
    db.exec('PRAGMA foreign_keys=ON');
    if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== usageIndexSchemaVersion()) throw new Error('Open UsageIndex before accounting revision');
    const exists = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_accounting_revision'").get();
    const revision = exists ? db.prepare('SELECT * FROM usage_accounting_revision WHERE revision_id=?').get(CODEX_COUNTER_REVISION_ID) : undefined;
    if (revision && revision.signature !== SIGNATURE) throw new Error('Completed accounting revision signature changed');
    let manifest: Array<{ source_id: string; report_json: string | null }>;
    if (revision) manifest = db.prepare('SELECT source_id,report_json FROM usage_accounting_revision_source WHERE revision_id=? ORDER BY source_id')
      .all(CODEX_COUNTER_REVISION_ID) as unknown as typeof manifest;
    else {
      manifest = db.prepare("SELECT source_id,NULL AS report_json FROM usage_source WHERE provider='codex' ORDER BY source_id").all() as unknown as typeof manifest;
      if (!options.dryRun) {
        db.exec('BEGIN IMMEDIATE'); transaction = true; db.exec(TABLES);
        db.prepare('INSERT INTO usage_accounting_revision VALUES (?,?,?)').run(CODEX_COUNTER_REVISION_ID, SIGNATURE, new Date().toISOString());
        const insert = db.prepare('INSERT INTO usage_accounting_revision_source(revision_id,source_id) VALUES (?,?)');
        for (const row of manifest) insert.run(CODEX_COUNTER_REVISION_ID, row.source_id);
        db.exec('COMMIT'); transaction = false;
      }
    }
    let files: ReadonlyMap<string, string> | undefined;
    const sourceFiles = () => files ??= options.sourceFiles?.() ?? new Map(listAllCodexSources().sources.map(s => [s.sourceId, s.filePath]));
    let backupPath = '';
    const reports: AccountingSourceReport[] = [];
    for (const job of manifest) {
      const previous: AccountingSourceReport | null = job.report_json ? JSON.parse(job.report_json) : null;
      const retry = previous && (previous.outcome === 'preserved' || previous.outcome === 'partial')
        && (options.retryPreserved || previous.reason === 'invalid-source'
          || previous.reason === 'missing-file' && sourceFiles().has(job.source_id));
      if (previous && !retry) { reports.push(previous); continue; }
      const row = db.prepare('SELECT * FROM usage_source WHERE source_id=?').get(job.source_id) as unknown as SourceRow | undefined;
      if (!row) continue;
      const old = entries(db, row.source_id);
      let report = blank(row.source_id, old), plan: Plan | undefined, checkpoint: UsageSourceCheckpoint | undefined, file: string | undefined;
      if (!old.length) report = preserve(report, 'no-detail');
      else {
        try { checkpoint = JSON.parse(row.checkpoint_json); } catch { /* invalid source remains untouched */ }
        if (!checkpoint || !Number.isSafeInteger(checkpoint.byteOffset) || !checkpoint.fingerprint) report = preserve(report, 'invalid-source');
        else if (checkpoint.generation !== 0) report = preserve(report, 'rewritten-source');
        else if (!(file = sourceFiles().get(row.source_id))) report = preserve(report, 'missing-file');
        else {
          let intact = false;
          try { intact = checkpointFingerprint(file, checkpoint.byteOffset!) === checkpoint.fingerprint; } catch { /* unavailable or shortened */ }
          if (!intact) report = preserve(report, 'changed-source');
          else {
            plan = await makePlan(db, row, file, checkpoint, old);
            if (!plan.corrections.length) report = plan.unverified ? preserve(report, 'unverified-records') : report;
            else if (!bucketsReconcile(db, row.source_id, old, plan.deltas)) { report = preserve(report, 'incomplete-buckets'); plan = undefined; }
            else if (!identitiesReconcile(db, row.source_id, plan.corrections)) { report = preserve(report, 'identity-conflict'); plan = undefined; }
            else report = { ...report, outcome: plan.unverified ? 'partial' : 'corrected',
              ...(plan.unverified ? { reason: 'unverified-records' as const } : {}),
              correctedEntries: plan.corrections.length, removedDuplicates: plan.corrections.filter(c => !c.after).length,
              savedCostUSD: plan.corrections.reduce((n, c) => n + c.before.costUSD - (c.after?.costUSD ?? 0), 0),
              savedTokens: plan.corrections.reduce((n, c) => n + tokens(c.before) - (c.after ? tokens(c.after) : 0), 0) };
          }
        }
      }
      if (plan?.corrections.length && !options.dryRun && !backupPath) {
        backupPath = path.join(options.backupDirectory, `usage-accounting-${Date.now()}-${process.pid}.sqlite`);
        createBackup(db, options.databasePath, backupPath);
      }
      options.onProgress?.({ checkedSources: reports.length, totalSources: manifest.length, phase: plan?.corrections.length ? 'committing' : 'checking' });
      if (!options.dryRun) { db.exec('BEGIN IMMEDIATE'); transaction = true; }
      try {
        if (!options.dryRun) {
          const receipt = db.prepare('SELECT report_json FROM usage_accounting_revision_source WHERE revision_id=? AND source_id=?')
            .get(CODEX_COUNTER_REVISION_ID, row.source_id);
          // Another instance may have committed this source while raw evidence was read.
          // Its durable result wins; never overwrite it with our stale analysis.
          if (!receipt || receipt.report_json !== job.report_json) {
            if (receipt?.report_json) reports.push(JSON.parse(String(receipt.report_json)));
            db.exec('COMMIT'); transaction = false;
            continue;
          }
        }
        if (plan?.corrections.length) {
          const current = db.prepare('SELECT * FROM usage_source WHERE source_id=?').get(row.source_id);
          let intact = false;
          try { intact = checkpointFingerprint(file!, checkpoint!.byteOffset!) === checkpoint!.fingerprint; } catch { /* preserve changed evidence */ }
          if (JSON.stringify(current) !== JSON.stringify(row) || JSON.stringify(entries(db, row.source_id)) !== JSON.stringify(old) || !intact) {
            report = preserve(blank(row.source_id, old), 'changed-source'); plan = undefined;
          } else if (!bucketsReconcile(db, row.source_id, old, plan.deltas)) {
            report = preserve(blank(row.source_id, old), 'incomplete-buckets'); plan = undefined;
          } else if (!identitiesReconcile(db, row.source_id, plan.corrections)) {
            report = preserve(blank(row.source_id, old), 'identity-conflict'); plan = undefined;
          } else if (!options.dryRun) applyPlan(db, row.source_id, plan);
        }
        if (previous?.correctedEntries) report = { ...report,
          outcome: report.outcome === 'preserved' || report.outcome === 'partial' ? 'partial' : 'corrected',
          correctedEntries: report.correctedEntries + previous.correctedEntries,
          removedDuplicates: report.removedDuplicates + previous.removedDuplicates,
          savedCostUSD: report.savedCostUSD + previous.savedCostUSD, savedTokens: report.savedTokens + previous.savedTokens };
        if (!options.dryRun) {
          const sourceBackup = plan?.corrections.length ? backupPath : '';
          db.prepare(`UPDATE usage_accounting_revision_source SET report_json=?,
            backup_path=CASE WHEN ?='' THEN backup_path ELSE ? END WHERE revision_id=? AND source_id=?`)
            .run(JSON.stringify(report), sourceBackup, sourceBackup, CODEX_COUNTER_REVISION_ID, row.source_id);
          db.exec('COMMIT'); transaction = false;
        }
        reports.push(report);
      } catch (error) { if (transaction) { db.exec('ROLLBACK'); transaction = false; } throw error; }
      options.onProgress?.({ checkedSources: reports.length, totalSources: manifest.length, phase: 'checking' });
    }
    if (backupPath && db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') throw new Error('Accounting revision integrity check failed');
    return summarize(reports);
  } finally { if (transaction) db.exec('ROLLBACK'); db.close(); }
}
