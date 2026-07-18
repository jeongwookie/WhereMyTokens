import type { AppSettings } from './ipc';
import type { AppState } from './stateManager';
import { quotaElapsedPct } from '../shared/quotaDomain';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
  QuotaDisplayMode,
  QuotaEntry,
  QuotaPeriod,
} from '../shared/quotaTypes';

export type TaskbarQuotaSeverity = 'normal' | 'warning' | 'danger' | 'unknown';
export type ProviderStatusTone = 'normal' | 'warning' | 'danger' | 'unknown';

export interface TaskbarQuotaSnapshot {
  updatedAt: number;
  theme: 'light' | 'dark';
  lines: [TaskbarQuotaDisplayLine, TaskbarQuotaDisplayLine];
}

export interface TaskbarQuotaDisplayLine {
  period: QuotaPeriod;
  label: '5h' | '1w';
  blocks: TaskbarQuotaBlock[];
  hiddenCount: number;
}

export interface TaskbarQuotaBlock {
  targetId: string;
  provider: ProviderId;
  abbreviation: string;
  label: string;
  state: 'limited' | 'unlimited';
  usedPct: number | null;
  elapsedPct: number | null;
  durationInferred: boolean;
  resetLabel: string | null;
  severity: TaskbarQuotaSeverity;
  providerStatusTone: ProviderStatusTone;
}

interface CandidateBlock extends TaskbarQuotaBlock {
  configuredOrder: number;
  defaultOrder: number;
  entryKey: string;
}

function targetMode(settings: AppSettings, targetId: string, defaultMode: QuotaDisplayMode): QuotaDisplayMode {
  return settings.quotaTargetModes?.[targetId] ?? defaultMode;
}

function configuredOrder(settings: AppSettings): Map<string, number> {
  return new Map((settings.quotaTargetOrder ?? []).map((targetId, index) => [targetId, index]));
}

export function resolveQuotaAbbreviation(
  targetId: string,
  defaultAbbreviation: string,
  settings: Pick<AppSettings, 'quotaTargetAbbreviations'>,
): string {
  const override = settings.quotaTargetAbbreviations?.[targetId];
  if (typeof override === 'string' && /^[A-Z0-9]{1,3}$/.test(override)) return override;
  return /^[A-Z0-9]{1,3}$/.test(defaultAbbreviation) ? defaultAbbreviation : '?';
}

function compactResetLabel(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null || !Number.isFinite(resetsAt) || resetsAt <= now) return null;
  const totalMinutes = Math.max(1, Math.round((resetsAt - now) / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  return `${Math.max(1, Math.round(totalHours / 24))}d`;
}

function statusTone(snapshot: ProviderQuotaSnapshot): ProviderStatusTone {
  if (snapshot.status?.connected === false) {
    if (snapshot.source === 'cache' || snapshot.source === 'localLog') return 'warning';
    if (snapshot.source === 'statusLine') return 'normal';
    return 'danger';
  }
  if (snapshot.source === 'localLog') return 'warning';
  if (snapshot.source === 'api' || snapshot.source === 'localRpc' || snapshot.source === 'statusLine' || snapshot.source === 'cache') return 'normal';
  return 'unknown';
}

function severity(entry: QuotaEntry, elapsedPct: number | null): TaskbarQuotaSeverity {
  if (entry.state === 'unlimited') return 'normal';
  if (elapsedPct == null) {
    if (entry.usedPct >= 90) return 'danger';
    if (entry.usedPct >= 75) return 'warning';
    return 'normal';
  }
  if (entry.usedPct >= 90 || entry.usedPct > elapsedPct + 25) return 'danger';
  if (entry.usedPct > elapsedPct + 10) return 'warning';
  return 'normal';
}

function candidate(
  provider: ProviderId,
  snapshot: ProviderQuotaSnapshot,
  entry: QuotaEntry,
  settings: AppSettings,
  order: Map<string, number>,
  now: number,
): CandidateBlock {
  const elapsedPct = quotaElapsedPct(entry, now);
  return {
    targetId: entry.target.id,
    provider,
    abbreviation: resolveQuotaAbbreviation(entry.target.id, entry.target.taskbarAbbreviation, settings),
    label: entry.target.label,
    state: entry.state,
    usedPct: entry.state === 'limited' ? entry.usedPct : null,
    elapsedPct,
    durationInferred: entry.durationInferred,
    resetLabel: compactResetLabel(entry.resetsAt, now),
    severity: severity(entry, elapsedPct),
    providerStatusTone: statusTone(snapshot),
    configuredOrder: order.get(entry.target.id) ?? Number.MAX_SAFE_INTEGER,
    defaultOrder: entry.target.defaultOrder,
    entryKey: entry.key,
  };
}

function sortBlocks(blocks: CandidateBlock[]): CandidateBlock[] {
  return [...blocks].sort((left, right) => (
    left.configuredOrder - right.configuredOrder
    || left.defaultOrder - right.defaultOrder
    || left.provider.localeCompare(right.provider)
    || left.targetId.localeCompare(right.targetId)
    || left.entryKey.localeCompare(right.entryKey)
  ));
}

function publicBlock(block: CandidateBlock): TaskbarQuotaBlock {
  const { configuredOrder: _configuredOrder, defaultOrder: _defaultOrder, entryKey: _entryKey, ...value } = block;
  return value;
}

function maxBlocks(settings: AppSettings): number {
  const value = settings.taskbarQuotaMaxBlocks;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(3, Math.round(value)))
    : 2;
}

function line(period: QuotaPeriod, blocks: CandidateBlock[], hiddenCount = 0): TaskbarQuotaDisplayLine {
  return {
    period,
    label: period === '5h' ? '5h' : '1w',
    blocks: blocks.map(publicBlock),
    hiddenCount,
  };
}

export function buildTaskbarQuotaSnapshot(
  state: Pick<AppState, 'settings' | 'providerQuotas' | 'lastUpdated'>,
  resolvedTheme?: 'light' | 'dark',
): TaskbarQuotaSnapshot | null {
  const settings = state.settings;
  const order = configuredOrder(settings);
  const updatedAt = state.lastUpdated || Date.now();
  const byPeriod: Record<QuotaPeriod, CandidateBlock[]> = { '5h': [], '7d': [] };
  for (const provider of settings.enabledProviders) {
    const snapshot = state.providerQuotas[provider];
    if (!snapshot) continue;
    for (const entry of snapshot.entries) {
      if (entry.period == null || targetMode(settings, entry.target.id, entry.target.defaultMode) === 'none') continue;
      byPeriod[entry.period].push(candidate(provider, snapshot, entry, settings, order, updatedAt));
    }
  }
  const periods = (['5h', '7d'] as const).filter(period => byPeriod[period].length > 0);
  if (periods.length === 0) return null;
  const cap = maxBlocks(settings);
  let lines: [TaskbarQuotaDisplayLine, TaskbarQuotaDisplayLine];
  if (periods.length === 2) {
    const h5 = sortBlocks(byPeriod['5h']);
    const d7 = sortBlocks(byPeriod['7d']);
    lines = [line('5h', h5.slice(0, cap), Math.max(0, h5.length - cap)), line('7d', d7.slice(0, cap), Math.max(0, d7.length - cap))];
  } else {
    const period = periods[0];
    const sorted = sortBlocks(byPeriod[period]);
    const selected = sorted.slice(0, cap * 2);
    const splitAt = Math.ceil(selected.length / 2);
    lines = [
      line(period, selected.slice(0, splitAt)),
      line(period, selected.slice(splitAt), Math.max(0, sorted.length - selected.length)),
    ];
  }
  return {
    updatedAt,
    theme: settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : (resolvedTheme ?? 'dark'),
    lines,
  };
}
