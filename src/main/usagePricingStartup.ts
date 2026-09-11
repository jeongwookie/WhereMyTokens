import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { applyUsagePricingRevisions, type PricingRevisionReport } from './usageIndex/pricingRevisions';

interface StartupPricingOptions {
  databasePath: string;
  backupDirectory: string;
}

/** Must complete before StateManager starts collection or restores cached cost totals. */
export function reconcileUsagePricingAtStartup(options: StartupPricingOptions): Promise<PricingRevisionReport[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { kind: 'usage-pricing-startup', ...options } });
    let received = false;
    worker.once('message', (reports: PricingRevisionReport[]) => { received = true; resolve(reports); });
    worker.once('error', reject);
    worker.once('exit', code => { if (!received) reject(new Error(`Pricing worker exited without a result (${code})`)); });
  });
}

if (!isMainThread && workerData?.kind === 'usage-pricing-startup') {
  parentPort!.postMessage(applyUsagePricingRevisions(workerData as StartupPricingOptions));
}
