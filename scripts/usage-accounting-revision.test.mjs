import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import revision from '../dist/main/usageIndex/accountingRevisions.js';
import storageModule from '../dist/main/usageIndex/sqliteUsageIndexStorage.js';
import scanner from '../dist/main/providers/codex/usageIndexScanner.js';
import pricing from '../dist/main/modelPricing.js';

const T = Date.UTC(2026, 8, 7, 8);
const vector = (n, cache=n*0.4, output=n*0.1) => ({input_tokens:n,cached_input_tokens:cache,output_tokens:output,reasoning_output_tokens:0});
const stamp = n => new Date(T+n*1000).toISOString();
const detail = (id,n,thread,turn,at) => ({type:'token_usage_record',timestamp:stamp(at),payload:{
  thread_id:'sample',turn_id:'turn',response_id:id,model:'gpt-6-astra',usage:vector(n),thread_token_usage:vector(thread),turn_token_usage:vector(turn)}});
const notice = at => ({type:'event_msg',timestamp:stamp(at),payload:{type:'token_count',info:{total_token_usage:vector(100),last_token_usage:vector(100)}}});

async function fixture(t) {
  const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'wmt-counter-revision-'));
  const databasePath=path.join(dir,'usage.sqlite'),file=path.join(dir,'source.jsonl');
  const rows=[{type:'session_meta',timestamp:stamp(0),payload:{id:'sample',timestamp:stamp(0),model:'gpt-6-astra'}},
    {type:'event_msg',timestamp:stamp(0),payload:{type:'task_started',turn_id:'turn'}},
    detail('a',100,1100,100,1),notice(2),{type:'response_item',timestamp:stamp(3),payload:{type:'function_call',name:'exec'}},notice(4),detail('b',100,1200,200,5)];
  fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const stat=fs.statSync(file),source={sourceId:'codex:sample',provider:'codex',kind:'file',parserVersion:5,
    version:{token:stat.size+':'+stat.mtimeMs,size:stat.size,mtimeMs:stat.mtimeMs}};
  const batch=await scanner.createCodexUsageIndexScanner(file).scan({source,mode:'rebuild',checkpoint:null,previousSessionProjection:null});
  const first=batch.entries[0],last=batch.entries[1];
  assert.equal(batch.entries.length,2);
  const inflated={...last,requestId:'codex:counter:broken',identityKey:'codex:counter:broken',inputTokens:660,cacheReadTokens:440,outputTokens:110};
  Object.assign(inflated,pricing.estimateUsageCost(inflated));
  const duplicate={...first,requestId:'codex:counter:duplicate',identityKey:'codex:counter:duplicate',identityAliases:[],timestampMs:T+4000};
  const storage=new storageModule.SqliteUsageIndexStorage(databasePath);
  await storage.commitSource({mode:'rebuild',source,batch:{...batch,entries:[first,duplicate,inflated],identityLinks:[]}});await storage.close();
  const options={databasePath,backupDirectory:path.join(dir,'backups'),sourceFiles:()=>new Map([['codex:sample',file]])};
  t.after(()=>{assert.ok(fs.realpathSync(dir).startsWith(parent+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,file,databasePath,options,batch,source,first,last};
}
const open=f=>new DatabaseSync(f.databasePath);
const metrics=db=>db.prepare("SELECT SUM(total_tokens) tokens,SUM(cost_usd) cost,SUM(request_count) requests FROM usage_bucket WHERE bucket_kind='month'").get();

test('Legacy checkpoint receipt is automatically retried after bootstrap', async t => {
  const f = await fixture(t);
  let db = open(f);
  const checkpoint = db.prepare('SELECT checkpoint_json FROM usage_source').get().checkpoint_json;
  const legacy = JSON.parse(checkpoint);
  delete legacy.fingerprint;
  delete legacy.generation;
  delete legacy.resumeState;
  db.prepare('UPDATE usage_source SET checkpoint_json=?').run(JSON.stringify(legacy));
  const before = metrics(db);
  db.close();

  const first = await revision.reconcileUsageAccounting(f.options);
  assert.equal(first.sources[0].reason, 'invalid-source');
  assert.equal(first.correctedEntries, 0);

  // 정상 스캔이 검증 가능한 체크포인트를 복원한 이후를 재현한다.
  db = open(f);
  db.prepare('UPDATE usage_source SET checkpoint_json=?').run(checkpoint);
  db.close();
  const restarted = await revision.reconcileUsageAccounting(f.options);
  assert.equal(restarted.correctedEntries, 2);
  db = open(f);
  assert.ok(metrics(db).tokens < before.tokens);
  db.close();

  const explicitRetry = await revision.reconcileUsageAccounting({ ...f.options, retryPreserved: true });
  assert.equal(explicitRetry.correctedEntries, 2);
});

test('Schema 4 upgrade bootstraps real response ownership without changing protected quantities', async t => {
  const f = await fixture(t);
  let db = open(f);
  const cp = JSON.parse(db.prepare('SELECT checkpoint_json FROM usage_source').get().checkpoint_json);
  db.prepare('UPDATE usage_entry SET request_id=? WHERE request_id=?').run('codex:response:a', f.first.requestId);
  db.prepare('UPDATE usage_entry SET request_id=? WHERE request_id=?').run('codex:response:b', 'codex:counter:broken');
  db.prepare('UPDATE usage_source SET checkpoint_json=?').run(JSON.stringify({ byteOffset: cp.byteOffset, rawModel: 'gpt-6-astra' }));
  db.exec('DROP TABLE usage_identity; PRAGMA user_version=4');
  const before = metrics(db);
  db.close();

  const storage = new storageModule.SqliteUsageIndexStorage(f.databasePath);
  const first = await revision.reconcileUsageAccounting(f.options);
  assert.equal(first.sources[0].reason, 'invalid-source');
  db = open(f);
  const checkpoint = JSON.parse(db.prepare('SELECT checkpoint_json FROM usage_source').get().checkpoint_json);
  db.close();
  const source = { ...f.source, parserVersion: 7 };
  const batch = await scanner.createCodexUsageIndexScanner(f.file).scan({
    source, mode: 'tail', checkpoint, previousSessionProjection: null,
  });
  assert.equal(batch.entries.length, 0);
  await storage.commitSource({ mode: 'tail', source, batch });
  await storage.close();
  db = open(f);
  assert.deepEqual(metrics(db), before);
  assert.equal(db.prepare("SELECT request_id FROM usage_identity WHERE identity_key='codex:response:b'").get().request_id, 'codex:response:b');
  db.close();

  const result = await revision.reconcileUsageAccounting(f.options);
  assert.equal(result.correctedEntries, 2);
  db = open(f);
  assert.equal(metrics(db).tokens, 220);
  assert.ok(db.prepare("SELECT 1 FROM usage_entry WHERE request_id='codex:response:b'").get());
  db.close();
  assert.equal((await revision.reconcileUsageAccounting(f.options)).resultKey, result.resultKey);
});

test('Startup retries bootstrap once after complete coverage, never during scans or recursively', () => {
  const source = fs.readFileSync('src/main/index.ts', 'utf8');
  const start = source.indexOf('  let bootstrapRetryScheduled = false;');
  const end = source.indexOf('  registerIpcHandlers({', start);
  assert.ok(start > 0 && end > start);
  const queued = [];
  let runs = 0;
  const state = { initialRefreshComplete: false, usageIndexCoverage: { state: 'incomplete' } };
  const context = vm.createContext({ manager: { getState: () => state }, accountingRun: null,
    accountingStatus: { report: { sources: [{ reason: 'invalid-source' }] } },
    queueMicrotask: fn => queued.push(fn), runAccounting: () => { runs++; }, maybeRetryAccountingBootstrap: null });
  vm.runInContext(source.slice(start, end), context);
  context.maybeRetryAccountingBootstrap();
  assert.equal(queued.length, 0);
  state.initialRefreshComplete = true;
  state.usageIndexCoverage.state = 'complete';
  context.accountingRun = Promise.resolve();
  context.maybeRetryAccountingBootstrap();
  assert.equal(queued.length, 0);
  context.accountingRun = null;
  context.maybeRetryAccountingBootstrap();
  context.maybeRetryAccountingBootstrap();
  assert.equal(queued.length, 1);
  assert.equal(runs, 0);
  queued.shift()();
  context.maybeRetryAccountingBootstrap();
  assert.equal(runs, 1);
  assert.equal(queued.length, 0);
});

test('Automatic correction proves raw defect equations, updates buckets/identities, and is idempotent',async t=>{
  const f=await fixture(t);let db=open(f);const before=metrics(db);db.close();
  const preview=await revision.reconcileUsageAccounting({...f.options,dryRun:true});
  assert.equal(preview.correctedEntries,2);assert.equal(preview.removedDuplicates,1);
  db=open(f);assert.deepEqual(metrics(db),before);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='usage_accounting_revision'").get(),undefined);db.close();
  const result=await revision.reconcileUsageAccounting(f.options);
  assert.equal(result.correctedSources,1);assert.equal(result.correctedEntries,2);assert.equal(result.preservedSources,0);
  assert.equal(fs.readdirSync(f.options.backupDirectory).length,1);
  db=open(f);assert.equal(metrics(db).tokens,220);assert.equal(metrics(db).requests,2);
  assert.ok(Math.abs(metrics(db).cost-2*f.first.costUSD)<1e-10);
  assert.equal(db.prepare("SELECT request_id FROM usage_identity WHERE identity_key='codex:counter:duplicate'").get().request_id,f.first.requestId);
  assert.equal(db.prepare("SELECT request_id FROM usage_identity WHERE identity_key=?").get(f.last.identityKey).request_id,'codex:counter:broken');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
  const second=await revision.reconcileUsageAccounting({...f.options,sourceFiles:()=>{throw Error('must not re-read completed evidence');}});
  assert.equal(second.resultKey,result.resultKey);assert.equal(fs.readdirSync(f.options.backupDirectory).length,1);
});

test('Missing source is preserved and automatically rechecked when it returns',async t=>{
  const f=await fixture(t);const first=await revision.reconcileUsageAccounting({...f.options,sourceFiles:()=>new Map()});
  assert.equal(first.sources[0].reason,'missing-file');assert.equal(first.correctedEntries,0);
  const next=await revision.reconcileUsageAccounting(f.options);assert.equal(next.correctedEntries,2);
});

test('Rewritten source and incomplete aggregate history are preserved without subtraction',async t=>{
  for(const reason of ['rewrite','incomplete']){
    const f=await fixture(t);const db=open(f);
    if(reason==='rewrite'){const row=db.prepare('SELECT checkpoint_json FROM usage_source').get();const cp=JSON.parse(row.checkpoint_json);cp.generation=1;db.prepare('UPDATE usage_source SET checkpoint_json=?').run(JSON.stringify(cp));}
    else db.exec("UPDATE usage_bucket SET request_count=request_count+1,total_tokens=total_tokens+10,input_tokens=input_tokens+10 WHERE bucket_kind='month'");
    const before=metrics(db);db.close();const r=await revision.reconcileUsageAccounting(f.options);assert.equal(r.correctedEntries,0);assert.equal(r.preservedSources,1);
    const after=open(f);assert.deepEqual(metrics(after),before);after.close();assert.equal(fs.existsSync(f.options.backupDirectory),false);
  }
});

test('Database/source changes between analysis and commit preserve the source',async t=>{
  const f=await fixture(t);let fired=false;
  const r=await revision.reconcileUsageAccounting({...f.options,onProgress:p=>{
    if(p.phase==='committing'&&!fired){fired=true;const db=open(f);db.exec("UPDATE usage_source SET version_token='concurrent'");db.close();}
  }});
  assert.equal(r.correctedEntries,0);assert.equal(r.sources[0].reason,'changed-source');
  const retry=await revision.reconcileUsageAccounting({...f.options,retryPreserved:true});assert.equal(retry.correctedEntries,2);
});

test('An interrupted run resumes pending sources and does not reapply committed corrections',async t=>{
  const f=await fixture(t);let interrupted=false;
  await assert.rejects(revision.reconcileUsageAccounting({...f.options,onProgress:p=>{
    if(p.checkedSources===1&&!interrupted){interrupted=true;throw Error('interrupted after commit');}
  }}),/interrupted/);
  const r=await revision.reconcileUsageAccounting(f.options);assert.equal(r.correctedEntries,2);
  const db=open(f);assert.equal(metrics(db).tokens,220);db.close();
});

test('An unknown difference is reported but never silently repriced or replaced',async t=>{
  const f=await fixture(t);const db=open(f);db.exec("UPDATE usage_entry SET input_tokens=input_tokens+1 WHERE request_id='codex:counter:broken'");
  // Make the bucket facts consistent with the extra unknown token.
  db.exec('UPDATE usage_bucket SET input_tokens=input_tokens+1,total_tokens=total_tokens+1');db.close();
  const r=await revision.reconcileUsageAccounting(f.options);assert.equal(r.correctedEntries,1);assert.equal(r.sources[0].outcome,'partial');
  const check=open(f);assert.equal(check.prepare("SELECT input_tokens FROM usage_entry WHERE request_id='codex:counter:broken'").get().input_tokens,661);check.close();
});

test('Source rewrites during the evidence pass cannot be committed',async t=>{
  const f=await fixture(t);const r=await revision.reconcileUsageAccounting({...f.options,onProgress:p=>{
    if(p.phase==='committing')fs.writeFileSync(f.file,'{}\n');
  }});assert.equal(r.correctedEntries,0);assert.equal(r.sources[0].reason,'changed-source');
});

test('Certified execution promotes same-source protected seeds without altering real foreign owners',async t=>{
  for(const foreign of [false,true]){
    const f=await fixture(t);const db=open(f);
    db.prepare('INSERT OR REPLACE INTO usage_identity VALUES (?,?,?,?,?,?,?)').run('codex',f.last.identityKey,
      foreign?'codex:other':'codex:sample',foreign?'real-other':'protected:'+f.last.identityKey,f.last.timestampMs,'',foreign?'real-fingerprint':'');
    db.close();const r=await revision.reconcileUsageAccounting(f.options);
    assert.equal(r.correctedEntries,foreign?0:2);
    if(foreign)assert.equal(r.sources[0].reason,'identity-conflict');
    else {const check=open(f);assert.equal(check.prepare('SELECT request_id FROM usage_identity WHERE identity_key=?').get(f.last.identityKey).request_id,'codex:counter:broken');check.close();}
  }
});

test('A failed source transaction rolls back quantities and its completion receipt',async t=>{
  const f=await fixture(t);const db=open(f);const before=metrics(db);
  db.exec("CREATE TRIGGER fail_revision BEFORE UPDATE ON usage_entry BEGIN SELECT RAISE(ABORT,'forced transaction failure'); END");db.close();
  await assert.rejects(revision.reconcileUsageAccounting(f.options),/forced transaction failure/);
  const check=open(f);assert.deepEqual(metrics(check),before);
  assert.equal(check.prepare('SELECT report_json FROM usage_accounting_revision_source').get().report_json,null);
  check.exec('DROP TRIGGER fail_revision');check.close();
  const r=await revision.reconcileUsageAccounting(f.options);assert.equal(r.correctedEntries,2);
});

test('Partial recheck preserves the original backup association when no new correction is made',async t=>{
  const f=await fixture(t);let db=open(f);
  db.exec("UPDATE usage_entry SET input_tokens=input_tokens+1 WHERE request_id='codex:counter:broken'; UPDATE usage_bucket SET input_tokens=input_tokens+1,total_tokens=total_tokens+1");db.close();
  await revision.reconcileUsageAccounting(f.options);db=open(f);const before=db.prepare('SELECT backup_path FROM usage_accounting_revision_source').get().backup_path;db.close();assert.ok(before);
  const r=await revision.reconcileUsageAccounting({...f.options,retryPreserved:true});assert.equal(r.correctedEntries,1);
  db=open(f);assert.equal(db.prepare('SELECT backup_path FROM usage_accounting_revision_source').get().backup_path,before);db.close();
});

test('Concurrent revision completion cannot be overwritten by stale analysis',async t=>{
  const f=await fixture(t);let raced=false;
  const modulePath=path.resolve('dist/main/usageIndex/accountingRevisions.js');
  const result=await revision.reconcileUsageAccounting({...f.options,onProgress:p=>{
    if(p.phase==='committing'&&!raced){raced=true;
      const code=`const m=require(${JSON.stringify(modulePath)});m.reconcileUsageAccounting({databasePath:${JSON.stringify(f.databasePath)},backupDirectory:${JSON.stringify(f.options.backupDirectory)},sourceFiles:()=>new Map([['codex:sample',${JSON.stringify(f.file)}]])}).then(r=>console.log(r.correctedEntries));`;
      const child=spawnSync(process.execPath,['-e',code],{encoding:'utf8',timeout:15000});assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/2/);
    }
  }});
  assert.equal(result.correctedEntries,2);assert.equal(result.preservedSources,0);
  const db=open(f);assert.equal(JSON.parse(db.prepare('SELECT report_json FROM usage_accounting_revision_source').get().report_json).correctedEntries,2);assert.equal(metrics(db).tokens,220);db.close();
});

test('Duplicate proof ownership is revalidated inside the source transaction',async t=>{
  const f=await fixture(t);let changed=false;const r=await revision.reconcileUsageAccounting({...f.options,onProgress:p=>{
    if(p.phase==='committing'&&!changed){changed=true;const db=open(f);db.prepare('UPDATE usage_identity SET request_id=? WHERE identity_key=?').run('codex:counter:broken','codex:response:a');db.close();}
  }});assert.equal(r.correctedEntries,0);assert.equal(r.sources[0].reason,'identity-conflict');
  const db=open(f);assert.ok(db.prepare("SELECT 1 FROM usage_entry WHERE request_id='codex:counter:duplicate'").get());db.close();
});

test('Arithmetic resemblance without an explicitly witnessed counter origin is not repair evidence',async t=>{
  const f=await fixture(t);
  const lines=fs.readFileSync(f.file,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  for(const row of lines)if(row.type==='token_usage_record')delete row.payload.turn_token_usage;
  fs.writeFileSync(f.file,lines.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const evidence=await import('../dist/main/providers/codex/counterRevisionEvidence.js');
  const result=await evidence.default.readCounterRevisionEvidence(f.file,fs.statSync(f.file).size,'codex:sample');
  assert.equal(result.size,0);
});
