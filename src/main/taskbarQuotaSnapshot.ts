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

export interface TaskbarQuotaSnapshot {
  updatedAt: number;
  theme: 'light' | 'dark';
  rows: TaskbarQuotaPeriodRow[];
}

export interface TaskbarQuotaPeriodRow {
  period: TaskbarQuotaPeriod;
  blocks: TaskbarQuotaBlock[];
  hiddenCount: number;
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
  if (!durationMs || resetMs == null || resetMs < 0 || resetMs > durationMs) return null;
  return Math.round(clampPct(((durationMs - resetMs) / durationMs) * 100));
}

function resetLabel(resetMs: number | null | undefined): string | null {
  if (resetMs == null || resetMs <= 0) return null;
  const totalMinutes = Math.max(1, Math.round(resetMs / 60000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  const days = Math.max(1, Math.round(totalHours / 24));
  return `${days}d`;
}

function severity(quotaPct: number | null, elapsedPctValue: number | null): TaskbarQuotaSeverity {
  if (quotaPct == null || elapsedPctValue == null) return 'unknown';
  if (quotaPct >= 90 || quotaPct > elapsedPctValue + 25) return 'danger';
  if (quotaPct > elapsedPctValue + 10) return 'warning';
  return 'normal';
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

export function resolveQuotaAbbreviation(
  targetId: string,
  provider: string,
  label: string,
  settings: Pick<AppSettings, 'quotaTargetAbbreviations'>,
): string {
  const override = settings.quotaTargetAbbreviations?.[targetId];
  if (typeof override === 'string' && /^[A-Z0-9]{1,3}$/.test(override)) return override;
  if (provider === 'claude') return 'C';
  if (provider === 'codex') return 'X';
  if (provider === 'antigravity') return 'A';
  if (provider === 'gemini') return 'G';
  return label.toUpperCase().match(/[A-Z0-9]/)?.[0] ?? '?';
}

function makeBlock(
  provider: ProviderId,
  targetId: string,
  label: string,
  quotaPctValue: number | null,
  durationMs: number | undefined,
  resetMs: number | null | undefined,
  settings: AppSettings,
  order: Map<string, number>,
  naturalOrder: number,
): CandidateBlock {
  const elapsedPctValue = elapsedPct(durationMs, resetMs);
  return {
    targetId,
    provider,
    abbreviation: resolveQuotaAbbreviation(targetId, provider, label, settings),
    label,
    quotaPct: quotaPctValue,
    elapsedPct: elapsedPctValue,
    resetLabel: resetLabel(resetMs),
    severity: severity(quotaPctValue, elapsedPctValue),
    risk: risk(quotaPctValue, elapsedPctValue),
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
  rows[period].push(makeBlock(
    provider,
    targetId,
    label,
    nullablePct(window?.pct),
    display?.durationMs,
    window?.resetMs,
    settings,
    order,
    naturalOrder,
  ));
}

function addModelCandidate(
  rows: Record<TaskbarQuotaPeriod, CandidateBlock[]>,
  provider: ProviderId,
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
    settings,
    order,
    naturalOrder,
  ));
}

function sortBlocks(blocks: CandidateBlock[]): CandidateBlock[] {
  return [...blocks].sort((a, b) => {
    if (a.configuredOrder !== b.configuredOrder) return a.configuredOrder - b.configuredOrder;
    return a.naturalOrder - b.naturalOrder;
  });
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

export function buildTaskbarQuotaSnapshot(state: Pick<AppState, 'settings' | 'providerQuotas' | 'lastUpdated'>): TaskbarQuotaSnapshot {
  const settings = state.settings;
  const order = configuredOrder(settings);
  const rows: Record<TaskbarQuotaPeriod, CandidateBlock[]> = { '5h': [], '1w': [] };
  let naturalOrder = 0;

  for (const provider of settings.enabledProviders) {
    const quota = state.providerQuotas?.[provider];
    if (!quota) continue;
    const coveredModelGroups = new Set<string>();
    for (const group of quota.groups ?? []) {
      coveredModelGroups.add(group.key);
      const targetId = quotaGroupId(provider, group.key);
      const groupOrder = naturalOrder;
      naturalOrder += 1;
      if (targetMode(settings, targetId, group.defaultMode) === 'none') continue;
      for (const windowKey of group.windowKeys) {
        addWindowCandidate(rows, provider, quota, targetId, group.label, windowKey, settings, order, groupOrder);
      }
    }
    for (const model of quota.models ?? []) {
      const groupKey = model.groupKey ?? modelQuotaGroupKey(model.model);
      if (coveredModelGroups.has(groupKey)) continue;
      const modelOrder = naturalOrder;
      naturalOrder += 1;
      addModelCandidate(rows, provider, model, settings, order, modelOrder);
    }
  }

  return {
    updatedAt: state.lastUpdated || Date.now(),
    theme: settings.theme === 'light' ? 'light' : 'dark',
    rows: (['5h', '1w'] as const).map(period => {
      const sorted = sortBlocks(rows[period]);
      return {
        period,
        blocks: sorted.slice(0, 3).map(publicBlock),
        hiddenCount: Math.max(0, sorted.length - 3),
      };
    }),
  };
}
