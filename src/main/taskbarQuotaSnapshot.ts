import type { AppSettings } from './ipc';
import type { AppState } from './stateManager';
import type {
  ProviderId,
  ProviderModelQuota,
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
  ProviderQuotaWindowDisplay,
  QuotaDisplayMode,
} from './providers/types';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type TaskbarQuotaPeriod = '5h' | '1w';
export type TaskbarQuotaSeverity = 'normal' | 'warning' | 'danger' | 'unknown';
export type ProviderStatusTone = 'normal' | 'warning' | 'danger' | 'unknown';

export interface TaskbarQuotaSnapshot {
  updatedAt: number;
  theme: 'light' | 'dark';
  rows: TaskbarQuotaPeriodRow[];
}

export interface TaskbarQuotaPeriodRow {
  period: TaskbarQuotaPeriod;
  blocks: TaskbarQuotaBlock[];
  hiddenCount: number;
  statusLabel: string | null;
}

export interface TaskbarQuotaBlock {
  targetId: string;
  provider: ProviderId;
  abbreviation: string;
  label: string;
  quotaPct: number | null;
  elapsedPct: number | null;
  resetLabel: string | null;
  severity: TaskbarQuotaSeverity;
  providerStatusTone: ProviderStatusTone;
}

interface CandidateBlock extends TaskbarQuotaBlock {
  risk: number;
  configuredOrder: number;
  naturalOrder: number;
}

function quotaGroupId(provider: ProviderId, groupKey: string): string {
  return `${provider}.group.${encodeURIComponent(groupKey)}`;
}

function modelQuotaGroupKey(model: string): string {
  return `model.${model}`;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function nullablePct(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? clampPct(value) : null;
}

function finiteMs(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function quotaPctFromModel(model: ProviderModelQuota): number | null {
  return typeof model.remainingPct === 'number' && Number.isFinite(model.remainingPct)
    ? clampPct(100 - model.remainingPct)
    : null;
}

function periodFromDuration(durationMs: number | undefined): TaskbarQuotaPeriod | null {
  if (durationMs === FIVE_HOURS_MS) return '5h';
  if (durationMs === WEEK_MS) return '1w';
  return null;
}

function periodFromDisplay(display: ProviderQuotaWindowDisplay | undefined, fallbackLabel?: string): TaskbarQuotaPeriod | null {
  const durationPeriod = periodFromDuration(display?.durationMs);
  if (durationPeriod) return durationPeriod;
  const label = display?.label ?? fallbackLabel;
  if (label === '5h') return '5h';
  if (label === '1w') return '1w';
  return null;
}

function elapsedPct(durationMs: number | undefined, resetMs: number | null | undefined): number | null {
  if (!durationMs || resetMs == null || !Number.isFinite(resetMs) || resetMs < 0 || resetMs > durationMs) return null;
  return Math.round(clampPct(((durationMs - resetMs) / durationMs) * 100));
}

function resetLabel(resetMs: number | null | undefined): string | null {
  if (resetMs == null || !Number.isFinite(resetMs) || resetMs <= 0) return null;
  const totalMinutes = Math.max(1, Math.round(resetMs / 60000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  const days = Math.max(1, Math.round(totalHours / 24));
  return `${days}d`;
}

function sourceStatusTone(source: ProviderQuotaSnapshot['source'] | undefined): ProviderStatusTone | null {
  if (source === 'localLog') return 'warning';
  if (source === 'api' || source === 'localRpc' || source === 'statusLine' || source === 'cache') return 'normal';
  return null;
}

function providerStatusTone(quota: ProviderQuotaSnapshot, source: ProviderQuotaSnapshot['source'] | undefined): ProviderStatusTone {
  const effectiveSource = source ?? quota.source;
  if (quota.status?.connected === false) {
    if (effectiveSource === 'statusLine') return 'normal';
    if (effectiveSource === 'cache' || effectiveSource === 'localLog') return 'warning';
    return 'danger';
  }
  const sourceTone = sourceStatusTone(effectiveSource);
  if (sourceTone) return sourceTone;
  if (!quota.status) return 'unknown';
  return 'unknown';
}

function severity(quotaPct: number | null, elapsedPctValue: number | null): TaskbarQuotaSeverity {
  if (quotaPct == null || elapsedPctValue == null) return 'unknown';
  if (quotaPct >= 90 || quotaPct > elapsedPctValue + 25) return 'danger';
  if (quotaPct > elapsedPctValue + 10) return 'warning';
  return 'normal';
}

function windowSeverity(window: ProviderQuotaWindow | undefined, quotaPct: number | null, elapsedPctValue: number | null): TaskbarQuotaSeverity {
  if (window?.limitState === 'unlimited' || window?.limitState === 'unreported') return 'normal';
  return severity(quotaPct, elapsedPctValue);
}

function risk(quotaPct: number | null, elapsedPctValue: number | null): number {
  if (quotaPct == null) return Number.NEGATIVE_INFINITY;
  if (elapsedPctValue == null) return quotaPct;
  return quotaPct - elapsedPctValue;
}

function targetMode(settings: AppSettings, targetId: string, defaultMode: QuotaDisplayMode): QuotaDisplayMode {
  return settings.quotaTargetModes?.[targetId] ?? defaultMode;
}

function configuredOrder(settings: AppSettings): Map<string, number> {
  return new Map((settings.quotaTargetOrder ?? []).map((targetId, index) => [targetId, index]));
}

function labelInitial(label: string): string {
  return label.toUpperCase().match(/[A-Z0-9]/)?.[0] ?? '?';
}

function shortLabelCode(label: string, fallback: string): string {
  const words = label
    .toUpperCase()
    .match(/[A-Z0-9]+/g) ?? [];
  const initials = words.map(word => word[0]).join('');
  if (initials.length >= 2) return initials.slice(0, 3);
  const compact = words.join('');
  if (compact.length >= 2) return compact.slice(0, 3);
  return initials || compact || fallback;
}

export function resolveQuotaAbbreviation(
  targetId: string,
  provider: string,
  label: string,
  settings: Pick<AppSettings, 'quotaTargetAbbreviations'>,
): string {
  const override = settings.quotaTargetAbbreviations?.[targetId];
  if (typeof override === 'string' && /^[A-Z0-9]{1,3}$/.test(override)) return override;
  const normalizedLabel = label.trim().toLowerCase();
  if (provider === 'claude') return normalizedLabel.includes('sonnet') ? 'S' : 'C';
  if (provider === 'codex') return 'CX';
  if (provider === 'antigravity') return shortLabelCode(label, 'AG');
  if (provider === 'gemini') return 'G';
  return labelInitial(label);
}

function makeBlock(
  provider: ProviderId,
  targetId: string,
  label: string,
  quotaPctValue: number | null,
  durationMs: number | undefined,
  resetMs: number | null | undefined,
  quotaWindow: ProviderQuotaWindow | undefined,
  statusTone: ProviderStatusTone,
  settings: AppSettings,
  order: Map<string, number>,
  naturalOrder: number,
): CandidateBlock {
  const safeResetMs = finiteMs(resetMs);
  const elapsedPctValue = elapsedPct(durationMs, safeResetMs);
  const noCap = quotaWindow?.limitState === 'unlimited' || quotaWindow?.limitState === 'unreported';
  return {
    targetId,
    provider,
    abbreviation: resolveQuotaAbbreviation(targetId, provider, label, settings),
    label,
    quotaPct: noCap ? null : quotaPctValue,
    elapsedPct: noCap ? null : elapsedPctValue,
    resetLabel: noCap ? 'unlimited' : resetLabel(safeResetMs),
    severity: windowSeverity(quotaWindow, quotaPctValue, elapsedPctValue),
    providerStatusTone: statusTone,
    risk: noCap ? Number.NEGATIVE_INFINITY : risk(quotaPctValue, elapsedPctValue),
    configuredOrder: order.get(targetId) ?? Number.MAX_SAFE_INTEGER,
    naturalOrder,
  };
}

function addWindowCandidate(
  rows: Record<TaskbarQuotaPeriod, CandidateBlock[]>,
  provider: ProviderId,
  quota: ProviderQuotaSnapshot,
  targetId: string,
  label: string,
  windowKey: string,
  settings: AppSettings,
  order: Map<string, number>,
  naturalOrder: number,
): void {
  const display = quota.windowDisplay?.[windowKey];
  const period = periodFromDisplay(display, windowKey);
  if (!period) return;
  const window = quota.windows?.[windowKey];
  if (!window) return;
  const hasWindowSignal = window.source || finiteMs(window.resetMs) != null || window.resetLabel || window.pct > 0 || window.limitState === 'unlimited' || window.limitState === 'unreported';
  if (!hasWindowSignal) return;
  rows[period].push(makeBlock(
    provider,
    targetId,
    label,
    nullablePct(window.pct),
    display?.durationMs,
    window.resetMs,
    window,
    providerStatusTone(quota, window.source ?? quota.source),
    settings,
    order,
    naturalOrder,
  ));
}

function addModelCandidate(
  rows: Record<TaskbarQuotaPeriod, CandidateBlock[]>,
  provider: ProviderId,
  quota: ProviderQuotaSnapshot,
  model: ProviderModelQuota,
  settings: AppSettings,
  order: Map<string, number>,
  naturalOrder: number,
): void {
  const period = periodFromDuration(model.durationMs) ?? (model.label === '5h' || model.label === '1w' ? model.label : null);
  if (!period) return;
  const groupKey = model.groupKey ?? modelQuotaGroupKey(model.model);
  const targetId = quotaGroupId(provider, groupKey);
  if (targetMode(settings, targetId, model.defaultMode ?? 'simple') === 'none') return;
  rows[period].push(makeBlock(
    provider,
    targetId,
    model.label || model.model,
    quotaPctFromModel(model),
    model.durationMs,
    model.resetMs ?? null,
    undefined,
    providerStatusTone(quota, quota.source),
    settings,
    order,
    naturalOrder,
  ));
}

function markHiddenWindowTargets(
  hiddenPeriods: Record<TaskbarQuotaPeriod, boolean>,
  quota: ProviderQuotaSnapshot,
  windowKeys: readonly string[],
): void {
  for (const windowKey of windowKeys) {
    const period = periodFromDisplay(quota.windowDisplay?.[windowKey], windowKey);
    if (period) hiddenPeriods[period] = true;
  }
}

function modelPeriod(model: ProviderModelQuota): TaskbarQuotaPeriod | null {
  return periodFromDuration(model.durationMs) ?? (model.label === '5h' || model.label === '1w' ? model.label : null);
}

function sortBlocks(blocks: CandidateBlock[]): CandidateBlock[] {
  return [...blocks].sort((a, b) => {
    if (a.configuredOrder !== b.configuredOrder) return a.configuredOrder - b.configuredOrder;
    if (a.risk !== b.risk) return b.risk - a.risk;
    return a.naturalOrder - b.naturalOrder;
  });
}

function taskbarQuotaMaxBlocks(settings: AppSettings): number {
  const value = settings.taskbarQuotaMaxBlocks;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(3, Math.round(value)))
    : 2;
}

function publicBlock(block: CandidateBlock): TaskbarQuotaBlock {
  const {
    risk: _risk,
    configuredOrder: _configuredOrder,
    naturalOrder: _naturalOrder,
    ...rest
  } = block;
  return rest;
}

export function buildTaskbarQuotaSnapshot(
  state: Pick<AppState, 'settings' | 'providerQuotas' | 'lastUpdated'> & Partial<Pick<AppState, 'initialRefreshComplete'>>,
  resolvedTheme?: 'light' | 'dark',
): TaskbarQuotaSnapshot {
  const settings = state.settings;
  const maxBlocks = taskbarQuotaMaxBlocks(settings);
  const order = configuredOrder(settings);
  const rows: Record<TaskbarQuotaPeriod, CandidateBlock[]> = { '5h': [], '1w': [] };
  const hiddenPeriods: Record<TaskbarQuotaPeriod, boolean> = { '5h': false, '1w': false };
  let naturalOrder = 0;
  const waiting = state.initialRefreshComplete === false;
  const hasOfflineProvider = settings.enabledProviders.some(provider => state.providerQuotas?.[provider]?.status?.connected === false);

  for (const provider of settings.enabledProviders) {
    const quota = state.providerQuotas?.[provider];
    if (!quota) continue;
    const coveredModelGroups = new Set<string>();
    for (const group of quota.groups ?? []) {
      coveredModelGroups.add(group.key);
      const targetId = quotaGroupId(provider, group.key);
      const groupOrder = naturalOrder;
      naturalOrder += 1;
      if (targetMode(settings, targetId, group.defaultMode) === 'none') {
        markHiddenWindowTargets(hiddenPeriods, quota, group.windowKeys);
        continue;
      }
      for (const windowKey of group.windowKeys) {
        addWindowCandidate(rows, provider, quota, targetId, group.label, windowKey, settings, order, groupOrder);
      }
    }
    for (const model of quota.models ?? []) {
      const groupKey = model.groupKey ?? modelQuotaGroupKey(model.model);
      if (coveredModelGroups.has(groupKey)) continue;
      const modelOrder = naturalOrder;
      naturalOrder += 1;
      const targetId = quotaGroupId(provider, groupKey);
      if (targetMode(settings, targetId, model.defaultMode ?? 'simple') === 'none') {
        const period = modelPeriod(model);
        if (period) hiddenPeriods[period] = true;
        continue;
      }
      addModelCandidate(rows, provider, quota, model, settings, order, modelOrder);
    }
  }

  return {
    updatedAt: state.lastUpdated || Date.now(),
    theme: settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : (resolvedTheme ?? 'dark'),
    rows: (['5h', '1w'] as const).map(period => {
      const sorted = sortBlocks(rows[period]);
      const blocks = sorted.slice(0, maxBlocks).map(publicBlock);
      return {
        period,
        blocks,
        hiddenCount: Math.max(0, sorted.length - blocks.length),
        statusLabel: blocks.length > 0 ? null : waiting ? 'waiting' : hiddenPeriods[period] ? 'hidden' : hasOfflineProvider ? 'offline' : 'no data',
      };
    }),
  };
}
