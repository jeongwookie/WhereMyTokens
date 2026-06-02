import type { AppSettings } from '../ipc';
import type { ProviderId } from './types';

export const BUILTIN_PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex'];
export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex', 'antigravity'];

export function normalizeEnabledProviders(value: unknown): ProviderId[] {
  const allowed = new Set<ProviderId>(PROVIDER_IDS);
  if (Array.isArray(value)) {
    const normalized = value.filter((item): item is ProviderId =>
      typeof item === 'string' && allowed.has(item as ProviderId)
    );
    const deduped = [...new Set(normalized)];
    if (deduped.length > 0) return deduped;
  }
  return [...BUILTIN_PROVIDER_IDS];
}

export function isProviderEnabled(
  settings: Pick<AppSettings, 'enabledProviders'> | { enabledProviders?: readonly ProviderId[] },
  id: ProviderId,
): boolean {
  const enabled = normalizeEnabledProviders(settings.enabledProviders);
  return enabled.includes(id);
}
