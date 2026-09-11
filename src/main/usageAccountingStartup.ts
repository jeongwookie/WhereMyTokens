import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { reconcileUsageAccounting } from './usageIndex/accountingRevisions';
import type { AccountingRevisionReport } from '../shared/accountingRevision';

export interface UsageAccountingWorkerOptions {
  databasePath: string;
  backupDirectory: string;
  retryPreserved?: boolean;
}

export function reconcileUsageAccountingInWorker(options: UsageAccountingWorkerOptions,
  onProgress: (checkedSources: number, totalSources: number) => void): Promise<AccountingRevisionReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { kind: 'usage-accounting-revision', ...options } });
    let received = false;
    worker.on('message', message => {
      if (message.kind === 'progress') onProgress(message.checkedSources, message.totalSources);
      else if (message.kind === 'complete') { received = true; resolve(message.report); }
    });
    worker.once('error', reject);
    worker.once('exit', code => { if (!received) reject(new Error(`Accounting worker exited without a result (${code})`)); });
  });
}

if (!isMainThread && workerData?.kind === 'usage-accounting-revision') {
  let lastProgressAt = 0;
  void reconcileUsageAccounting({ ...workerData, onProgress: progress => {
    const now = Date.now();
    if (now - lastProgressAt >= 250 || progress.checkedSources === progress.totalSources) {
      lastProgressAt = now; parentPort!.postMessage({ kind: 'progress', ...progress });
    }
  } }).then(report => parentPort!.postMessage({ kind: 'complete', report }));
}
