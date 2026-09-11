export type AccountingSourceOutcome = 'corrected' | 'unchanged' | 'preserved' | 'partial';
export type AccountingPreserveReason = 'no-detail' | 'missing-file' | 'rewritten-source' | 'changed-source'
  | 'unverified-records' | 'incomplete-buckets' | 'identity-conflict' | 'invalid-source';

export interface AccountingSourceReport {
  source: string;
  outcome: AccountingSourceOutcome;
  reason?: AccountingPreserveReason;
  correctedEntries: number;
  removedDuplicates: number;
  savedCostUSD: number;
  savedTokens: number;
  fromMs: number | null;
  toMs: number | null;
}

export interface AccountingRevisionReport {
  revisionId: string;
  resultKey: string;
  completedAt: string;
  checkedSources: number;
  correctedSources: number;
  preservedSources: number;
  unchangedSources: number;
  correctedEntries: number;
  removedDuplicates: number;
  savedCostUSD: number;
  savedTokens: number;
  sources: AccountingSourceReport[];
}

export interface AccountingRevisionStatus {
  state: 'idle' | 'running' | 'complete' | 'failed';
  checkedSources: number;
  totalSources: number;
  notice: boolean;
  report: AccountingRevisionReport | null;
}
