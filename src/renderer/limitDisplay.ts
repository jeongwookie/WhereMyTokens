import type { ProviderId, ProviderQuotaSource, QuotaEntry } from '../shared/quotaTypes';
import i18n from './i18n';

export type LimitDataState = 'ready' | 'syncing' | 'waiting';
export type LimitSourceTone = 'good' | 'neutral' | 'warning';

export interface LimitSourceDisplay {
  label?: string;
  title?: string;
  tone: LimitSourceTone;
}

export function hasLimitData(entry: QuotaEntry | null | undefined): boolean {
  return entry != null;
}

export function limitDataState(entry: QuotaEntry | null | undefined, syncing = false): LimitDataState {
  if (syncing) return 'syncing';
  return entry ? 'ready' : 'waiting';
}

export function limitSourceDisplay(source: ProviderQuotaSource | undefined): LimitSourceDisplay {
  switch (source) {
    case 'api':
      return { label: 'API', title: i18n.t('common.limitSource.api.title'), tone: 'good' };
    case 'statusLine':
      return { label: 'Bridge', title: i18n.t('common.limitSource.bridge.title'), tone: 'neutral' };
    case 'cache':
      return { label: 'Cache', title: i18n.t('common.limitSource.cache.title'), tone: 'neutral' };
    case 'localLog':
      return { label: 'Log', title: i18n.t('common.limitSource.localLog.title'), tone: 'warning' };
    case 'localRpc':
      return { label: 'RPC', title: i18n.t('common.limitSource.localRpc.title'), tone: 'neutral' };
    default:
      return { tone: 'neutral' };
  }
}

export function providerDisplayName(provider: ProviderId): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return 'Antigravity';
}
