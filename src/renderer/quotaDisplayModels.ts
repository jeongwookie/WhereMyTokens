import {
  AppState,
  ExtraUsage,
  ProviderCreditBalance,
  ProviderId,
  ProviderModelQuota,
  ProviderQuotaDisplayBadge,
  ProviderQuotaGroupSpec,
  ProviderQuotaRowVisualKind,
  ProviderQuotaSnapshot,
  ProviderQuotaStatus,
  ProviderQuotaWindow,
  QuotaDisplayMode,
  WindowStats,
} from './types';
import { hasLimitData, limitSourceDisplay } from './limitDisplay';

export interface QuotaDisplayRowViewModel {
  key: string;
  groupId: string;
  provider: ProviderId;
  label: string;
  visualKind: ProviderQuotaRowVisualKind;
  quotaPct: number;
  resetMs: number | null;
  resetLabel?: string;
  quota: ProviderQuotaWindow;
  stats: WindowStats;
  apiConnected: boolean;
  pending: boolean;
  pendingTitle?: string;
  cacheMetricTitle?: string;
  durationMs?: number;
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
  resetCredits: ResetCreditsViewModel | null;   // Codex reset card, routed independently of row-driven groups
}

export interface QuotaTargetSettingsOption {
  id: string;
  provider: ProviderId;
  label: string;
  period: string;
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

const EMPTY_QUOTA_WINDOW: ProviderQuotaWindow = { pct: 0, resetMs: null };
const FALLBACK_ACCENTS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#4f46e5'];
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function quotaGroupId(provider: ProviderId, groupKey: string): string {
  return `${provider}.group.${encodeURIComponent(groupKey)}`;
}

export function modelQuotaGroupKey(model: string): string {
  return `model.${model}`;
}

// --- Codex reset credits: render-time view model -----------------------------
// Every human/relative/colored value is DERIVED HERE from raw ISO + counts + now.
// Nothing derived is persisted (spec §4). Input shape is the public source-fact
// contract carried on the snapshot (raw ISO expiry, counts, checkedAt, status).
// NOTE: the renderer `./types` mirror of these input shapes lands in Task 7b; this
// module is esbuild type-stripped and is not typechecked by `build:main`, so the
// local declarations below are the working contract until 7b re-points them.
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
  source: 'api' | 'cache';
  status: ProviderQuotaStatus;
}

const CREDIT_HOUR_MS = 3600000;
const CREDIT_DAY_MS = 86400000;

export function formatCreditDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
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

export interface ResetCreditRowVM { idSuffix: string | null; status: string; expiresAtUtc: string | null; remainingMs: number | null; }
export interface ResetCreditsViewModel {
  provider: ProviderId;
  mode: QuotaDisplayMode;         // resolved from quotaTargetModes for the 'resets' group ('rich'|'simple'|'none')
  source: 'api' | 'cache';        // explicit; 'cache' when serving stale data while disconnected (F3/F9)
  availableCount: number;         // credits.length for list data, availableCount for countOnly
  credits: ResetCreditRowVM[];
  nextExpiryMs: number | null;
  totalEarnedCount: number;
  urgency: CreditUrgency;
  countOnly: boolean;
  errored: boolean;
  stale: boolean;                 // true when showing a cached list because the latest fetch did not refresh it (F9)
  status: ProviderQuotaStatus;
  checkedAt: number;              // epoch ms of the last SUCCESSFUL fetch (tooltip "last successful update")
}

export function buildResetCreditsViewModel(
  data: ProviderResetCreditsData | null | undefined,
  now: number,
  mode: QuotaDisplayMode,
): ResetCreditsViewModel | null {
  if (!data) return null;
  const errored = data.status?.code !== 'ok' && data.status?.connected === false && data.credits.length === 0 && data.availableCount === 0 && !data.countOnly;
  const credits: ResetCreditRowVM[] = data.credits.map(c => {
    const ms = c.expiresAtUtc == null ? null : Date.parse(c.expiresAtUtc);
    return { idSuffix: c.idSuffix, status: c.status, expiresAtUtc: c.expiresAtUtc, remainingMs: ms == null || !Number.isFinite(ms) ? null : ms - now };
  });
  const nextExpiryMs = credits.length > 0 ? credits[0].remainingMs : null;
  const availableCount = data.countOnly ? data.availableCount : credits.length;
  const source: 'api' | 'cache' = data.source === 'cache' ? 'cache' : 'api';
  return {
    provider: 'codex',
    mode,
    source,
    availableCount,
    credits,
    nextExpiryMs,
    totalEarnedCount: data.totalEarnedCount,
    urgency: errored || availableCount === 0 ? 'muted' : creditUrgencyBucket(nextExpiryMs),
    countOnly: data.countOnly,
    errored,
    // Stale = we are rendering a cached list (source cache) rather than a fresh 'api' pull. The
    // tooltip shows checkedAt ("last successful update") so a transient error that keeps the cache
    // (per Task 4/Task 3) is still legible as "stale, last good at HH:MM" rather than silently fresh.
    stale: source === 'cache',
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

function targetMode(
  settings: AppState['settings'],
  groupId: string,
  defaultMode: QuotaDisplayMode,
): QuotaDisplayMode {
  return settings.quotaTargetModes?.[groupId] ?? defaultMode;
}

export function hasQuotaInput(window: ProviderQuotaWindow): boolean {
  return hasLimitData(window) || !!window.source;
}

function rowHasDisplaySignal(row: QuotaDisplayRowViewModel): boolean {
  return row.pending || row.apiConnected === false || hasQuotaInput(row.quota) || row.stats.totalTokens > 0;
}

export function extraUsageFromCredit(credit: ProviderCreditBalance | undefined): ExtraUsage | null {
  if (!credit || typeof credit.total !== 'number' || typeof credit.used !== 'number') return null;
  const total = credit.total;
  const used = credit.used;
  const utilization = typeof credit.remainingPct === 'number'
    ? 100 - credit.remainingPct
    : total > 0 ? (used / total) * 100 : 0;
  return {
    isEnabled: true,
    monthlyLimit: Math.max(0, total),
    usedCredits: Math.max(0, used),
    utilization: Math.max(0, Math.min(100, utilization)),
  };
}

function firstExtraUsage(
  settings: AppState['settings'],
  providerQuotas: AppState['providerQuotas'],
): ExtraUsage | null {
  // Extra usage is an account-credit balance. It is provider-scoped metadata, not token/cost usage,
  // so quota target visibility does not subtract it from the account card.
  for (const provider of settings.enabledProviders) {
    const credits = providerQuotas[provider]?.credits ?? {};
    for (const credit of Object.values(credits)) {
      const extra = extraUsageFromCredit(credit);
      if (extra) return extra;
    }
  }
  return null;
}

function modelQuotaWindow(model: ProviderModelQuota, source: ProviderQuotaSnapshot['source']): ProviderQuotaWindow {
  return {
    pct: Math.max(0, Math.min(100, 100 - model.remainingPct)),
    resetMs: model.resetMs ?? null,
    source,
  };
}

function pendingTitle(options: BuildQuotaDisplayModelsOptions): string {
  return `Full provider history is still scanning (${options.formatWarmupEta(options.historyWarmupStartsAt)}); local-log limits may update.`;
}

function isPendingQuotaWindow(
  quotaWindow: ProviderQuotaWindow,
  stats: WindowStats,
  options: BuildQuotaDisplayModelsOptions,
): boolean {
  if (!options.historyWarmupPending) return false;
  return quotaWindow.source === 'localLog' || (!hasLimitData(quotaWindow) && stats.totalTokens > 0);
}

function mergeBadges(...badgeLists: Array<readonly ProviderQuotaDisplayBadge[] | undefined>): ProviderQuotaDisplayBadge[] {
  const byKey = new Map<string, ProviderQuotaDisplayBadge>();
  for (const badges of badgeLists) {
    for (const badge of badges ?? []) byKey.set(badge.key, badge);
  }
  return [...byKey.values()];
}

function sourceBadges(rows: readonly QuotaDisplayRowViewModel[]): ProviderQuotaDisplayBadge[] {
  const badges: ProviderQuotaDisplayBadge[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const source = limitSourceDisplay(row.quota);
    if (!source.label || seen.has(source.label)) continue;
    seen.add(source.label);
    badges.push({
      key: `source.${source.label}`,
      label: source.label,
      title: source.title,
      tone: source.tone,
    });
  }
  return badges;
}

function rowStats(
  usage: AppState['usage'],
  provider: ProviderId,
  windowKey: string,
): WindowStats {
  return usage.byProvider[provider]?.windows?.[windowKey] ?? EMPTY_WINDOW_STATS;
}

function cacheEfficiencyWeight(stats: WindowStats): number {
  return Math.max(0, stats.inputTokens + stats.cacheCreationTokens + stats.cacheReadTokens);
}

function addStats(target: WindowStats, stats: WindowStats): void {
  const existingWeight = cacheEfficiencyWeight(target);
  const incomingWeight = cacheEfficiencyWeight(stats);
  const weightedEfficiency = target.cacheEfficiency * existingWeight + stats.cacheEfficiency * incomingWeight;
  target.inputTokens += stats.inputTokens;
  target.outputTokens += stats.outputTokens;
  target.cacheCreationTokens += stats.cacheCreationTokens;
  target.cacheReadTokens += stats.cacheReadTokens;
  target.totalTokens += stats.totalTokens;
  target.costUSD += stats.costUSD;
  target.requestCount += stats.requestCount;
  target.cacheSavingsUSD += stats.cacheSavingsUSD;
  target.cacheEfficiency = existingWeight + incomingWeight > 0
    ? weightedEfficiency / (existingWeight + incomingWeight)
    : 0;
}

function fallbackModelStatsWindowKeys(model: ProviderModelQuota): string[] {
  const keys: string[] = [];
  if (model.statsWindowKey) keys.push(model.statsWindowKey);
  if (model.durationMs === FIVE_HOURS_MS) keys.push('h5');
  else if (model.durationMs === WEEK_MS) keys.push('week');
  else if (model.resetMs != null) keys.push(model.resetMs <= FIVE_HOURS_MS ? 'h5' : 'week');
  return [...new Set(keys)];
}

function hasStatsSignal(stats: WindowStats): boolean {
  return stats.totalTokens > 0
    || stats.requestCount > 0
    || stats.inputTokens > 0
    || stats.outputTokens > 0
    || stats.cacheCreationTokens > 0
    || stats.cacheReadTokens > 0;
}

function modelStats(
  usage: AppState['usage'],
  provider: ProviderId,
  model: ProviderModelQuota,
): WindowStats {
  const candidateNames = new Set(
    [model.usageModel, model.label, model.model]
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  for (const windowKey of fallbackModelStatsWindowKeys(model)) {
    const windowModels = usage.modelWindows?.[provider]?.windows?.[windowKey];
    if (!windowModels) continue;
    const stats = { ...EMPTY_WINDOW_STATS };
    for (const candidate of candidateNames) {
      const candidateStats = windowModels[candidate];
      if (candidateStats) addStats(stats, candidateStats);
    }
    if (hasStatsSignal(stats)) return stats;
  }
  return EMPTY_WINDOW_STATS;
}

function buildGroupRows(
  provider: ProviderId,
  groupId: string,
  group: ProviderQuotaGroupSpec,
  quota: ProviderQuotaSnapshot,
  options: BuildQuotaDisplayModelsOptions,
): QuotaDisplayRowViewModel[] {
  return group.windowKeys.map(windowKey => {
    const display = quota.windowDisplay?.[windowKey];
    const quotaWindow = quota.windows?.[windowKey] ?? EMPTY_QUOTA_WINDOW;
    const stats = rowStats(options.usage, provider, windowKey);
    const pending = isPendingQuotaWindow(quotaWindow, stats, options);
    return {
      key: `${groupId}.${encodeURIComponent(windowKey)}`,
      groupId,
      provider,
      label: display?.label ?? windowKey,
      visualKind: display?.visualKind ?? 'pace',
      quotaPct: quotaWindow.pct,
      resetMs: quotaWindow.resetMs,
      resetLabel: quotaWindow.resetLabel,
      quota: quotaWindow,
      stats,
      apiConnected: quota.status?.connected ?? hasQuotaInput(quotaWindow),
      pending,
      pendingTitle: pending ? pendingTitle(options) : undefined,
      cacheMetricTitle: display?.cacheMetricTitle,
      durationMs: display?.durationMs,
      hideCost: display?.hideCost,
      badges: display?.badges ?? [],
    };
  });
}

function hasGroupSignal(
  groupId: string,
  group: ProviderQuotaGroupSpec,
  rows: readonly QuotaDisplayRowViewModel[],
  settings: AppState['settings'],
  hasResetCredits: boolean,
): boolean {
  const explicitMode = Object.prototype.hasOwnProperty.call(settings.quotaTargetModes ?? {}, groupId);
  return explicitMode
    || (group.key === 'resets' && hasResetCredits)
    || group.windowKeys.length > 0
    || rows.some(row => row.pending || hasQuotaInput(row.quota) || row.stats.totalTokens > 0);
}

function buildGroup(
  provider: ProviderId,
  group: ProviderQuotaGroupSpec,
  quota: ProviderQuotaSnapshot,
  options: BuildQuotaDisplayModelsOptions,
): QuotaDisplayGroupViewModel | null {
  const id = quotaGroupId(provider, group.key);
  const rows = buildGroupRows(provider, id, group, quota, options);
  if (!hasGroupSignal(id, group, rows, options.settings, quota.resetCredits != null)) return null;
  return {
    id,
    provider,
    label: group.label,
    mode: targetMode(options.settings, id, group.defaultMode),
    defaultMode: group.defaultMode,
    accentColor: group.accentColor ?? stableColorFromId(id),
    rows,
    badges: mergeBadges(group.badges, sourceBadges(rows)),
    sortOrder: group.sortOrder ?? 0,
  };
}

function buildModelGroup(
  provider: ProviderId,
  model: ProviderModelQuota,
  quota: ProviderQuotaSnapshot,
  options: BuildQuotaDisplayModelsOptions,
): QuotaDisplayGroupViewModel {
  const groupKey = model.groupKey ?? modelQuotaGroupKey(model.model);
  const id = quotaGroupId(provider, groupKey);
  const quotaWindow = modelQuotaWindow(model, quota.source);
  const stats = modelStats(options.usage, provider, model);
  const row: QuotaDisplayRowViewModel = {
    key: `${id}.model`,
    groupId: id,
    provider,
    label: 'Quota',
    visualKind: model.visualKind ?? 'percentOnly',
    quotaPct: quotaWindow.pct,
    resetMs: quotaWindow.resetMs,
    resetLabel: undefined,
    quota: quotaWindow,
    stats,
    apiConnected: quota.status?.connected ?? true,
    pending: false,
    cacheMetricTitle: model.cacheMetricTitle,
    durationMs: model.durationMs,
    hideCost: model.hideCost ?? true,
    badges: model.badges ?? [],
  };
  return {
    id,
    provider,
    label: model.label || model.model,
    mode: targetMode(options.settings, id, model.defaultMode ?? 'simple'),
    defaultMode: model.defaultMode ?? 'simple',
    accentColor: model.accentColor ?? stableColorFromId(id),
    rows: [row],
    badges: mergeBadges(model.badges, sourceBadges([row])),
    sortOrder: 100,
  };
}

export function buildQuotaDisplayGroups(options: BuildQuotaDisplayModelsOptions): QuotaDisplayGroupViewModel[] {
  const groups: QuotaDisplayGroupViewModel[] = [];
  for (const provider of options.settings.enabledProviders) {
    const quota = options.providerQuotas[provider];
    if (!quota) continue;
    const coveredModelGroups = new Set<string>();
    for (const group of quota.groups ?? []) {
      const built = buildGroup(provider, group, quota, options);
      if (built) groups.push(built);
      coveredModelGroups.add(group.key);
    }
    for (const model of quota.models ?? []) {
      const groupKey = model.groupKey ?? modelQuotaGroupKey(model.model);
      if (coveredModelGroups.has(groupKey)) continue;
      groups.push(buildModelGroup(provider, model, quota, options));
    }
  }
  const configuredOrder = new Map(
    (options.settings.quotaTargetOrder ?? []).map((targetId, index) => [targetId, index]),
  );
  return groups.sort((a, b) => {
    const aOrder = configuredOrder.get(a.id);
    const bOrder = configuredOrder.get(b.id);
    if (aOrder != null || bOrder != null) {
      if (aOrder == null) return 1;
      if (bOrder == null) return -1;
      if (aOrder !== bOrder) return aOrder - bOrder;
    }
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id.localeCompare(b.id);
  });
}

export function buildRichCardRows(
  richGroups: readonly QuotaDisplayGroupViewModel[],
): QuotaDisplayRichRowViewModel[] {
  const providerOrder: ProviderId[] = [];
  const cardsByProvider = new Map<ProviderId, QuotaDisplayRichCardViewModel[]>();

  for (const group of richGroups) {
    if (!cardsByProvider.has(group.provider)) {
      providerOrder.push(group.provider);
      cardsByProvider.set(group.provider, []);
    }

    const cards = cardsByProvider.get(group.provider)!;
    for (const row of group.rows) {
      cards.push({
        key: row.key,
        provider: group.provider,
        group,
        row,
      });
    }
  }

  const rows: QuotaDisplayRichRowViewModel[] = [];
  for (const provider of providerOrder) {
    const cards = cardsByProvider.get(provider) ?? [];
    for (let index = 0; index < cards.length; index += 2) {
      const rowCards = cards.slice(index, index + 2);
      if (rowCards.length === 0) continue;
      rows.push({
        key: `${provider}.${Math.floor(index / 2)}`,
        provider,
        cards: rowCards,
      });
    }
  }

  return rows;
}

export function buildQuotaTargetSettingsOptions(
  settings: AppState['settings'],
  providerQuotas: AppState['providerQuotas'] = {},
): QuotaTargetSettingsOption[] {
  const models = buildQuotaDisplayModels({
    usage: { byProvider: {}, modelWindows: {}, models: [], heatmap: [], heatmap30: [], heatmap90: [], weeklyTimeline: [], todBuckets: [] } as AppState['usage'],
    providerQuotas,
    settings,
    historyWarmupPending: false,
    historyWarmupStartsAt: null,
    formatWarmupEta: () => '',
    simpleIncludesRich: true,
  });
  return models.settingsTargets.map(group => ({
    id: group.id,
    provider: group.provider,
    label: group.label,
    period: group.rows.map(row => row.label).join(' / '),
    mode: group.mode,
    defaultMode: group.defaultMode,
    badges: group.badges,
    rowCount: group.rows.length,
  }));
}

export function buildQuotaDisplayModels(options: BuildQuotaDisplayModelsOptions): QuotaDisplayModels {
  const targets = buildQuotaDisplayGroups(options);
  const visibleTargets = targets
    .filter(group => group.mode !== 'none')
    .map(group => ({ ...group, rows: group.rows.filter(rowHasDisplaySignal) }))
    .filter(group => group.rows.length > 0);
  const richGroups = visibleTargets.filter(group => group.mode === 'rich');
  const simpleGroups = visibleTargets.filter(group => group.mode === 'simple');
  const widgetGroups = visibleTargets.filter(group => group.mode === 'simple' || options.simpleIncludesRich === true);

  // F3: the reset card is routed on a dedicated field, NOT through richGroups/simpleGroups.
  // The 'resets' group has empty windowKeys → zero rows → dropped by the rows.length > 0
  // filter above, so it cannot ride those arrays. Resolve it directly, independent of any
  // row-signal filter (no dependence on rows.length / rowHasDisplaySignal / visibleTargets).
  const resetsGroupId = quotaGroupId('codex', 'resets');
  const resetMode = targetMode(options.settings, resetsGroupId, 'simple');
  const resetData = (options.providerQuotas.codex?.resetCredits ?? null) as ProviderResetCreditsData | null;
  const resetCredits = resetMode === 'none'
    ? null   // None hides the card; collection continues in main (data still fetched/cached)
    : buildResetCreditsViewModel(resetData, Date.now(), resetMode);

  return {
    targets,
    richGroups,
    simpleGroups,
    widgetGroups,
    settingsTargets: targets,
    extraUsage: firstExtraUsage(options.settings, options.providerQuotas),
    resetCredits,
  };
}
