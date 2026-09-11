import path from 'node:path';
import fs from 'node:fs';
import revision from '../dist/main/usageIndex/accountingRevisions.js';

const args = process.argv.slice(2);
const value = key => args.find(a => a.startsWith(key + '='))?.slice(key.length + 1);
for (const arg of args) if (!['--apply','--retry-preserved'].includes(arg)
  && !['--database=','--backup-directory=','--report='].some(prefix => arg.startsWith(prefix))) throw new Error('Unknown argument: '+arg);
const databasePath = value('--database');
if (!databasePath) throw new Error('Use --database=<usage-index.sqlite>; preview is the default, --apply writes certified corrections.');
const report = await revision.reconcileUsageAccounting({ databasePath: path.resolve(databasePath),
  backupDirectory: path.resolve(value('--backup-directory') ?? path.join(path.dirname(databasePath),'usage-accounting-backups')),
  dryRun: !args.includes('--apply'), retryPreserved: args.includes('--retry-preserved') });
if (value('--report')) fs.writeFileSync(path.resolve(value('--report')), JSON.stringify(report,null,2));
const { sources, ...summary } = report;
console.log(JSON.stringify({ applied:args.includes('--apply'), ...summary },null,2));
