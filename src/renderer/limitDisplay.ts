import type { ProviderId, ProviderQuotaWindow } from './types';

export type LimitWindow = ProviderQuotaWindow;
export type LimitDataState = 'ready' | 'syncing' | 'waiting';
export type LimitSourceTone = 'good' | 'neutral' | 'warning';

export interface LimitSourceDisplay {
  label?: string;
  title?: string;
  tone: LimitSourceTone;
}

export function hasLimitData(limit: LimitWindow): boolean {
  return limit.pct > 0
    || limit.resetMs != null
    || !!limit.resetLabel;
}

export function limitDataState(limit: LimitWindow, syncing = false): LimitDataState {
  if (hasLimitData(limit)) return 'ready';
  return syncing ? 'syncing' : 'waiting';
}

export function limitSourceDisplay(limit: LimitWindow): LimitSourceDisplay {
  switch (limit.source) {
    case 'api':
      return {
        label: 'API',
        title: 'Account usage snapshot. Refreshed every few minutes.',
        tone: 'good',
      };
    case 'statusLine':
      return {
        label: 'Bridge',
        title: 'Local status-line fallback while the API is unavailable.',
        tone: 'neutral',
      };
    case 'cache':
      return {
        label: hasLimitData(limit) ? 'Cache' : undefined,
        title: 'Last trusted usage snapshot. It ages out automatically.',
        tone: 'neutral',
      };
    case 'localLog':
      return {
        label: 'Log',
        title: 'Local session-log estimate. It can lag account-level limits.',
        tone: 'warning',
      };
    case 'localRpc':
      return {
        label: 'RPC',
        title: 'Local provider runtime snapshot.',
        tone: 'neutral',
      };
    default:
      return { tone: 'neutral' };
  }
}

export function providerDisplayName(provider: ProviderId): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  if (provider === 'antigravity') return 'Antigravity';
  return provider;
}

export function quotaWindowLabel(windowKey: string): string {
  if (windowKey === 'h5') return '5h';
  if (windowKey === 'week') return '1w';
  if (windowKey === 'sonnetWeek') return 'Sonnet';
  return windowKey;
}
