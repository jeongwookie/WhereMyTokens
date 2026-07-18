import type { AppState, ExtraUsage, WindowStats } from './types';
import type {
  ProviderCreditBalance,
  ProviderId,
  ProviderQuotaDisplayBadge,
  ProviderQuotaSource,
  ProviderQuotaStatus,
  ProviderResetCreditsData,
  QuotaDisplayMode,
  QuotaEntry,
  QuotaPeriod,
} from '../shared/quotaTypes';

export interface QuotaDisplayRowViewModel {
  key: string;
  groupId: string;
  provider: ProviderId;
  label: string;
  entry: QuotaEntry;
  source: ProviderQuotaSource;
  stats: WindowStats;
  hasLocalStats: boolean;
  apiConnected: boolean;
  pending: boolean;
  pendingTitle?: string;
  cacheMetricTitle?: string;
  hideCost?: boolean;
  badges: ProviderQuotaDisplayBadge[];
}

export interface QuotaDisplayGroupViewModel {
  id: string;
  provider: ProviderId;
  label: string;
  mode: QuotaDisplayMode;
  defaultMode: QuotaDisplayMode;
  accentColor: string;
  rows: QuotaDisplayRowViewModel[];
  badges: ProviderQuotaDisplayBadge[];
  sortOrder: number;
}

export interface QuotaDisplayRichCardViewModel {
  key: string;
  provider: ProviderId;
  group: QuotaDisplayGroupViewModel;
  row: QuotaDisplayRowViewModel;
}

export interface QuotaDisplayRichRowViewModel {
  key: string;
  provider: ProviderId;
  cards: QuotaDisplayRichCardViewModel[];
}

export interface QuotaDisplayModels {
  targets: QuotaDisplayGroupViewModel[];
  richGroups: QuotaDisplayGroupViewModel[];
  simpleGroups: QuotaDisplayGroupViewModel[];
  widgetGroups: QuotaDisplayGroupViewModel[];
  settingsTargets: QuotaDisplayGroupViewModel[];
  extraUsage: ExtraUsage | null;
  resetCredits: ResetCreditsViewModel | null;
}

export interface QuotaTargetSettingsOption {
  id: string;
  provider: ProviderId;
  label: string;
  period: string;
  taskbarEligible: boolean;
  mode: QuotaDisplayMode;
  defaultMode: QuotaDisplayMode;
  badges: ProviderQuotaDisplayBadge[];
  rowCount: number;
}

export interface BuildQuotaDisplayModelsOptions {
  usage: AppState['usage'];
  providerQuotas: AppState['providerQuotas'];
  settings: AppState['settings'];
  historyWarmupPending: boolean;
  historyWarmupStartsAt: number | null;
  formatWarmupEta: (startsAt: number | null) => string;
  simpleIncludesRich?: boolean;
}

const EMPTY_WINDOW_STATS: WindowStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  costUSD: 0,
  requestCount: 0,
  cacheEfficiency: 0,
  cacheSavingsUSD: 0,
};

const FALLBACK_ACCENTS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#4f46e5'];
const CREDIT_DAY_MS = 86_400_000;

export function quotaGroupId(provider: ProviderId, groupKey: string): string {
  return `${provider}.group.${encodeURIComponent(groupKey)}`;
}

export function modelQuotaGroupKey(model: string): string {
  return `model.${model}`;
}

export function formatCreditDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export type CreditUrgency = 'ok' | 'warn' | 'red' | 'muted';
export function creditUrgencyBucket(soonestRemainingMs: number | null): CreditUrgency {
  if (soonestRemainingMs == null || soonestRemainingMs <= 0) return 'muted';
  if (soonestRemainingMs < CREDIT_DAY_MS) return 'red';
  if (soonestRemainingMs <= 7 * CREDIT_DAY_MS) return 'warn';
  return 'ok';
}

export interface ResetCreditRowVM {
  idSuffix: string | null;
  status: string;
  expiresAtUtc: string | null;
  remainingMs: number | null;
}

export interface ResetCreditsViewModel {
  provider: ProviderId;
  mode: QuotaDisplayMode;
  source: 'api' | 'cache' | 'usage';
  availableCount: number;
  credits: ResetCreditRowVM[];
  nextExpiryMs: number | null;
  totalEarnedCount: number;
  urgency: CreditUrgency;
  countOnly: boolean;
  errored: boolean;
  stale: boolean;
  status: ProviderQuotaStatus;
  checkedAt: number;
}

export function buildResetCreditsViewModel(
  data: ProviderResetCreditsData | null | undefined,
  now: number,
  mode: QuotaDisplayMode,
): ResetCreditsViewModel | null {
  if (!data) return null;
  const errored = data.status.code !== 'ok'
    && data.status.connected === false
    && data.credits.length === 0
    && data.availableCount === 0
    && !data.countOnly;
  const credits = data.credits.map(credit => {
    const expiresAt = credit.expiresAtUtc == null ? null : Date.parse(credit.expiresAtUtc);
    if (credit.expiresAtUtc != null && !Number.isFinite(expiresAt)) return null;
    return {
      idSuffix: credit.idSuffix,
      status: credit.status,
      expiresAtUtc: credit.expiresAtUtc,
      remainingMs: expiresAt == null ? null : expiresAt - now,
    };
  }).filter((credit): credit is ResetCreditRowVM => credit !== null);
  const sourceAvailableCount = Math.max(0, Math.round(data.availableCount));
  const countOnly = data.countOnly || sourceAvailableCount !== credits.length;
  const displayCredits = countOnly ? [] : credits;
  const nextExpiryMs = displayCredits.length > 0 ? displayCredits[0].remainingMs : null;
  const availableCount = countOnly ? sourceAvailableCount : displayCredits.length;
  const source = data.source === 'cache' ? 'cache' : data.source === 'usage' ? 'usage' : 'api';
  const stale = source === 'cache' || data.status.code !== 'ok';
  return {
    provider: 'codex',
    mode,
    source,
    availableCount,
    credits: displayCredits,
    nextExpiryMs,
    totalEarnedCount: Math.max(0, Math.round(data.totalEarnedCount)),
    urgency: errored || availableCount === 0 ? 'muted' : creditUrgencyBucket(nextExpiryMs),
    countOnly,
    errored,
    stale,
    status: data.status,
    checkedAt: data.checkedAt,
  };
}

function stableColorFromId(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  }
  return FALLBACK_ACCENTS[Math.abs(hash) % FALLBACK_ACCENTS.length];
}

function targetMode(settings: AppState['settings'], targetId: string, fallback: QuotaDisplayMode): QuotaDisplayMode {
  return settings.quotaTargetModes?.[targetId] ?? fallback;
}

function periodLabel(period: QuotaPeriod | null): string {
  if (period === '5h') return '5h';
  if (period === '7d') return '1w';
  return 'Quota';
}

function pendingTitle(options: BuildQuotaDisplayModelsOptions): string {
  return `Full provider history is still scanning (${options.formatWarmupEta(options.historyWarmupStartsAt)}); local-log limits may update.`;
}

function sourceBadge(source: ProviderQuotaSource): ProviderQuotaDisplayBadge {
  const labels: Record<ProviderQuotaSource, string> = {
    api: 'API',
    statusLine: 'Bridge',
    cache: 'Cache',
    localLog: 'Log',
    localRpc: 'RPC',
  };
  return {
    key: `source.${source}`,
    label: labels[source],
    tone: source === 'api' ? 'good' : source === 'localLog' ? 'warning' : 'neutral',
  };
}

export function extraUsageFromCredit(credit: ProviderCreditBalance | undefined): ExtraUsage | null {
  if (!credit || typeof credit.total !== 'number' || typeof credit.used !== 'number') return null;
  const utilization = typeof credit.remainingPct === 'number'
    ? 100 - credit.remainingPct
    : credit.total > 0 ? (credit.used / credit.total) * 100 : 0;
  return {
    isEnabled: true,
    monthlyLimit: Math.max(0, credit.total),
    usedCredits: Math.max(0, credit.used),
    utilization: Math.max(0, Math.min(100, utilization)),
  };
}

function firstExtraUsage(settings: AppState['settings'], providerQuotas: AppState['providerQuotas']): ExtraUsage | null {
  for (const provider of settings.enabledProviders) {
    for (const credit of Object.values(providerQuotas[provider]?.credits ?? {})) {
      const extra = extraUsageFromCredit(credit);
      if (extra) return extra;
    }
  }
  return null;
}

export function buildQuotaDisplayGroups(options: BuildQuotaDisplayModelsOptions): QuotaDisplayGroupViewModel[] {
  const groups = new Map<string, QuotaDisplayGroupViewModel>();
  for (const provider of options.settings.enabledProviders) {
    const snapshot = options.providerQuotas[provider];
    if (!snapshot) continue;
    for (const entry of snapshot.entries) {
      const target = entry.target;
      let group = groups.get(target.id);
      if (!group) {
        group = {
          id: target.id,
          provider,
          label: target.label,
          mode: targetMode(options.settings, target.id, target.defaultMode),
          defaultMode: target.defaultMode,
          accentColor: target.accentColor ?? stableColorFromId(target.id),
          rows: [],
          badges: [...(target.badges ?? []), sourceBadge(snapshot.source)],
          sortOrder: target.defaultOrder,
        };
        groups.set(target.id, group);
      }
      const hasLocalStats = entry.usageBinding !== undefined;
      group.rows.push({
        key: entry.key,
        groupId: target.id,
        provider,
        label: periodLabel(entry.period),
        entry,
        source: snapshot.source,
        stats: hasLocalStats ? (options.usage.entryStats[entry.key] ?? { ...EMPTY_WINDOW_STATS }) : { ...EMPTY_WINDOW_STATS },
        hasLocalStats,
        apiConnected: snapshot.status?.connected ?? true,
        pending: entry.provisional === true,
        pendingTitle: entry.provisional ? pendingTitle(options) : undefined,
        cacheMetricTitle: target.cacheMetricTitle,
        hideCost: target.hideCost,
        badges: target.badges ?? [],
      });
    }
  }

  const configuredOrder = new Map(options.settings.quotaTargetOrder.map((id, index) => [id, index]));
  return [...groups.values()].sort((left, right) => {
    const leftConfigured = configuredOrder.get(left.id);
    const rightConfigured = configuredOrder.get(right.id);
    if (leftConfigured !== undefined || rightConfigured !== undefined) {
      if (leftConfigured === undefined) return 1;
      if (rightConfigured === undefined) return -1;
      if (leftConfigured !== rightConfigured) return leftConfigured - rightConfigured;
    }
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    if (left.provider !== right.provider) return left.provider.localeCompare(right.provider);
    return left.id.localeCompare(right.id);
  });
}

export function buildRichCardRows(richGroups: readonly QuotaDisplayGroupViewModel[]): QuotaDisplayRichRowViewModel[] {
  const rows: QuotaDisplayRichRowViewModel[] = [];
  let pending: QuotaDisplayRichCardViewModel[] = [];
  let currentProvider: ProviderId | null = null;
  const flush = () => {
    for (let index = 0; index < pending.length; index += 2) {
      const cards = pending.slice(index, index + 2);
      rows.push({ key: `${currentProvider}.${Math.floor(index / 2)}`, provider: currentProvider!, cards });
    }
    pending = [];
  };
  for (const group of richGroups) {
    if (currentProvider !== null && currentProvider !== group.provider) flush();
    currentProvider = group.provider;
    for (const row of group.rows) pending.push({ key: row.key, provider: group.provider, group, row });
  }
  if (pending.length > 0) flush();
  return rows;
}

export function buildQuotaTargetSettingsOptions(
  settings: AppState['settings'],
  providerQuotas: AppState['providerQuotas'] = {},
): QuotaTargetSettingsOption[] {
  const targets = buildQuotaDisplayGroups({
    usage: { entryStats: {} } as AppState['usage'],
    providerQuotas,
    settings,
    historyWarmupPending: false,
    historyWarmupStartsAt: null,
    formatWarmupEta: () => '',
  });
  return targets.map(group => ({
    id: group.id,
    provider: group.provider,
    label: group.label,
    period: group.rows.map(row => row.label).join(' / '),
    taskbarEligible: group.rows.some(row => row.entry.period === '5h' || row.entry.period === '7d'),
    mode: group.mode,
    defaultMode: group.defaultMode,
    badges: group.badges,
    rowCount: group.rows.length,
  }));
}

export function buildQuotaDisplayModels(options: BuildQuotaDisplayModelsOptions): QuotaDisplayModels {
  const targets = buildQuotaDisplayGroups(options);
  const visibleTargets = targets.filter(group => group.mode !== 'none');
  const richGroups = visibleTargets.filter(group => group.mode === 'rich');
  const simpleGroups = visibleTargets.filter(group => group.mode === 'simple');
  const widgetGroups = visibleTargets.filter(group => group.mode === 'simple' || options.simpleIncludesRich === true);
  const resetMode = targetMode(options.settings, quotaGroupId('codex', 'resets'), 'simple');
  const resetData = options.settings.enabledProviders.includes('codex')
    ? options.providerQuotas.codex?.resetCredits
    : null;
  return {
    targets,
    richGroups,
    simpleGroups,
    widgetGroups,
    settingsTargets: targets,
    extraUsage: firstExtraUsage(options.settings, options.providerQuotas),
    resetCredits: resetMode === 'none' ? null : buildResetCreditsViewModel(resetData, Date.now(), resetMode),
  };
}
