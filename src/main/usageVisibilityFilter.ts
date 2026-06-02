import type { AppSettings } from './ipc';
import type { ProviderId } from './providers/types';

export interface UsageVisibilityFilter {
  providerScopes: ReadonlySet<ProviderId>;
}

export function buildUsageVisibilityFilter(
  settings: Pick<AppSettings, 'enabledProviders'>,
): UsageVisibilityFilter {
  return { providerScopes: new Set(settings.enabledProviders) };
}

export function usageProviderVisible(filter: UsageVisibilityFilter | undefined, provider: ProviderId): boolean {
  return !filter || filter.providerScopes.has(provider);
}

export function emptyUsageVisibilityFilter(): UsageVisibilityFilter {
  return { providerScopes: new Set() };
}
