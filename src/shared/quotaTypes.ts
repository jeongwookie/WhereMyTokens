export type ProviderId = 'claude' | 'codex' | 'antigravity';

export type ProviderQuotaSource = 'api' | 'statusLine' | 'localLog' | 'localRpc' | 'cache';
export type QuotaDisplayMode = 'rich' | 'simple' | 'none';
export type QuotaPeriod = '5h' | '7d';

export interface ProviderQuotaStatus {
  connected: boolean;
  code: string;
  label?: string;
  detail?: string;
  severity?: 'ok' | 'warning' | 'danger';
}

export interface ProviderCreditBalance {
  available: number;
  used?: number;
  total?: number;
  remainingPct?: number;
  resetMs?: number | null;
}

export interface ProviderResetCredit {
  idSuffix: string | null;
  status: string;
  expiresAtUtc: string | null;
}

export interface ProviderResetCreditsData {
  credits: ProviderResetCredit[];
  availableCount: number;
  totalEarnedCount: number;
  checkedAt: number;
  countOnly: boolean;
  source: 'api' | 'cache' | 'usage';
  status: ProviderQuotaStatus;
}

export interface ProviderQuotaDisplayBadge {
  key: string;
  label: string;
  title?: string;
  tone?: 'good' | 'neutral' | 'warning';
}

export type QuotaScope =
  | { kind: 'account' }
  | { kind: 'model'; label: string };

export interface QuotaTarget {
  id: string;
  label: string;
  defaultMode: QuotaDisplayMode;
  defaultOrder: number;
  taskbarAbbreviation: string;
  accentColor?: string;
  badges?: ProviderQuotaDisplayBadge[];
  cacheMetricTitle?: string;
  hideCost?: boolean;
}

export type QuotaUsageBinding =
  | { kind: 'all-provider-models' }
  | {
      kind: 'models';
      matchers: Array<{ kind: 'exact' | 'contains'; value: string }>;
    };

interface QuotaEntryBase {
  key: string;
  target: QuotaTarget;
  scope: QuotaScope;
  resetsAt: number | null;
  durationMs: number | null;
  durationInferred: boolean;
  period: QuotaPeriod | null;
  usageBinding?: QuotaUsageBinding;
  provisional?: boolean;
}

export interface LimitedQuotaEntry extends QuotaEntryBase {
  state: 'limited';
  usedPct: number;
}

export interface UnlimitedQuotaEntry extends QuotaEntryBase {
  state: 'unlimited';
}

export type QuotaEntry = LimitedQuotaEntry | UnlimitedQuotaEntry;

export interface ProviderQuotaSnapshot {
  provider: ProviderId;
  source: ProviderQuotaSource;
  capturedAt: number;
  entries: QuotaEntry[];
  accountLabel?: string;
  accountTooltip?: string;
  planName?: string;
  credits?: Record<string, ProviderCreditBalance>;
  status?: ProviderQuotaStatus;
  resetCredits?: ProviderResetCreditsData | null;
}

export interface QuotaTargetGroup {
  target: QuotaTarget;
  scope: QuotaScope;
  entries: QuotaEntry[];
}

export type FixedPeriodQuotaSelection =
  | { state: 'absent'; usedPct: null }
  | { state: 'provisional'; usedPct: null }
  | { state: 'unlimited'; usedPct: null }
  | { state: 'limited'; usedPct: number };
