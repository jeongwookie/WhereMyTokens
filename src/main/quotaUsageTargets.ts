import type { ProviderId, ProviderQuotaSnapshot, QuotaEntry, QuotaUsageBinding } from '../shared/quotaTypes';
import { FIVE_HOURS_MS } from '../shared/quotaDomain';

export interface ProviderFixedPeriodTarget {
  provider: ProviderId;
  period: '5h';
  startMs: number;
}

export interface EntryUsageTarget {
  provider: ProviderId;
  entryKey: string;
  startMs: number;
  binding: QuotaUsageBinding;
}

function entryStart(entry: QuotaEntry): number | null {
  if (!entry.usageBinding || entry.resetsAt == null || entry.durationMs == null) return null;
  return entry.resetsAt - entry.durationMs;
}

export function buildQuotaUsageTargets(
  providers: Iterable<ProviderId>,
  snapshots: Partial<Record<ProviderId, ProviderQuotaSnapshot>>,
  nowMs: number,
): { fixed: ProviderFixedPeriodTarget[]; entries: EntryUsageTarget[] } {
  const fixed: ProviderFixedPeriodTarget[] = [];
  const entries: EntryUsageTarget[] = [];
  for (const provider of providers) {
    const snapshot = snapshots[provider];
    const account5h = snapshot?.entries.find(entry => entry.scope.kind === 'account' && entry.period === '5h');
    const accountStart = account5h?.resetsAt != null && account5h.durationMs === FIVE_HOURS_MS
      ? account5h.resetsAt - FIVE_HOURS_MS
      : nowMs - FIVE_HOURS_MS;
    fixed.push({ provider, period: '5h', startMs: accountStart });
    for (const entry of snapshot?.entries ?? []) {
      const startMs = entryStart(entry);
      if (startMs == null || !entry.usageBinding) continue;
      entries.push({ provider, entryKey: entry.key, startMs, binding: entry.usageBinding });
    }
  }
  return { fixed, entries };
}

export function usageBindingAcceptsModel(binding: QuotaUsageBinding, model: string): boolean {
  if (binding.kind === 'all-provider-models') return true;
  const normalized = model.toLowerCase();
  return binding.matchers.some(matcher => matcher.kind === 'exact'
    ? normalized === matcher.value.toLowerCase()
    : normalized.includes(matcher.value.toLowerCase()));
}
