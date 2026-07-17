import type { ProviderId, ProviderQuotaWindow } from './types';
// This is a plain (non-React) utility module, so it uses the i18next singleton's `.t()`
// directly instead of the `useTranslation()` hook. Callers that memoize results built from
// this (e.g. useMemo(() => buildQuotaDisplayModels(...), deps)) must include the active
// language (e.g. i18n.language from useTranslation()) in their dependency array, or the
// memoized title strings will go stale after a language switch.
import i18n from './i18n';

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
    || !!limit.resetLabel
    || limit.limitState === 'unlimited'
    || limit.limitState === 'unreported';
}

export function limitDataState(limit: LimitWindow, syncing = false): LimitDataState {
  if (hasLimitData(limit)) return 'ready';
  return syncing ? 'syncing' : 'waiting';
}

export function limitSourceDisplay(limit: LimitWindow): LimitSourceDisplay {
  // Source badge labels (API/Bridge/Cache/Log/RPC) stay in English: they're short technical
  // status tokens, not sentences — a JA-reading developer audience expects them as-is.
  switch (limit.source) {
    case 'api':
      return {
        label: 'API',
        title: i18n.t('common.limitSource.api.title'),
        tone: 'good',
      };
    case 'statusLine':
      return {
        label: 'Bridge',
        title: i18n.t('common.limitSource.bridge.title'),
        tone: 'neutral',
      };
    case 'cache':
      return {
        label: hasLimitData(limit) ? 'Cache' : undefined,
        title: i18n.t('common.limitSource.cache.title'),
        tone: 'neutral',
      };
    case 'localLog':
      return {
        label: 'Log',
        title: i18n.t('common.limitSource.localLog.title'),
        tone: 'warning',
      };
    case 'localRpc':
      return {
        label: 'RPC',
        title: i18n.t('common.limitSource.localRpc.title'),
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
