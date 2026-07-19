/**
 * Usage threshold alerts (50% / 80% / 90%).
 * Alert state is keyed by the canonical quota-entry key so dynamic targets
 * re-arm independently when their own reset boundary changes.
 */
import { Notification } from 'electron';
import { addNotification } from './notificationHistory';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
  QuotaDisplayMode,
  QuotaPeriod,
} from '../shared/quotaTypes';

interface AlertState {
  lastAlertTime: number;
  lastResetAt: number | null;
  firedThresholds: Set<number>;
}

interface AlertOptions {
  deferCodexLocalLog?: boolean;
  quotaTargetModes?: Partial<Record<string, QuotaDisplayMode>>;
  nowMs?: number;
  emitNotification?: (title: string, body: string) => void;
}

export interface QuotaAlertCheck {
  key: string;
  pct: number;
  resetsAt: number | null;
  label: string;
  source?: string;
  provider: ProviderId;
}

const alertStates: Record<string, AlertState> = {};
const prevPct: Record<string, number> = {};
const pctHistory = new Map<string, number[]>();
const COOLDOWN_MS = 60 * 60 * 1000;

function getState(key: string): AlertState {
  if (!alertStates[key]) {
    alertStates[key] = { lastAlertTime: 0, lastResetAt: null, firedThresholds: new Set() };
  }
  return alertStates[key];
}

function smoothedPct(key: string, rawPct: number): number {
  const history = pctHistory.get(key) ?? [];
  history.push(rawPct);
  if (history.length > 3) history.shift();
  pctHistory.set(key, history);
  return history.reduce((sum, value) => sum + value, 0) / history.length;
}

function formatReset(resetMs: number | null): string {
  if (!resetMs || resetMs <= 0) return '';
  const minutes = Math.max(1, Math.round(resetMs / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours <= 0) return ` · resets in ${remainder}m`;
  if (remainder === 0) return ` · resets in ${hours}h`;
  return ` · resets in ${hours}h ${remainder}m`;
}

function formatSource(source: string | undefined): string {
  if (!source) return '';
  const labels: Record<string, string> = {
    api: 'API',
    statusLine: 'Bridge',
    cache: 'Cache',
    localLog: 'Log',
    localRpc: 'RPC',
  };
  return ` · source: ${labels[source] ?? source}`;
}

function periodLabel(period: QuotaPeriod | null): string {
  if (period === '5h') return '5h usage';
  if (period === '7d') return 'weekly usage';
  return 'usage';
}

export function quotaChecks(
  providerQuotas: Partial<Record<ProviderId, ProviderQuotaSnapshot>>,
  enabledProviders: ReadonlySet<ProviderId>,
  options: Pick<AlertOptions, 'quotaTargetModes'> = {},
): QuotaAlertCheck[] {
  const checks: QuotaAlertCheck[] = [];
  for (const provider of enabledProviders) {
    const snapshot = providerQuotas[provider];
    if (!snapshot) continue;
    for (const entry of snapshot.entries) {
      if (entry.state !== 'limited') continue;
      checks.push({
        key: entry.key,
        pct: entry.usedPct,
        resetsAt: entry.resetsAt,
        label: `${entry.target.label} ${periodLabel(entry.period)}`,
        source: snapshot.source,
        provider,
      });
    }
  }
  return checks;
}

function emitUsageAlert(title: string, body: string, options: AlertOptions): void {
  if (options.emitNotification) {
    options.emitNotification(title, body);
    return;
  }
  addNotification('alert', title, body);
  try {
    new Notification({ title: `WhereMyTokens ${title}`, body }).show();
  } catch { /* ignore */ }
}

export function checkAlerts(
  providerQuotas: Partial<Record<ProviderId, ProviderQuotaSnapshot>>,
  thresholds: number[],
  enabled: boolean,
  enabledProviders: ReadonlySet<ProviderId>,
  options: AlertOptions = {},
): void {
  if (!enabled) return;

  const now = options.nowMs ?? Date.now();
  const triggered: Array<QuotaAlertCheck & { threshold: number }> = [];

  for (const check of quotaChecks(providerQuotas, enabledProviders, options)) {
    const { key, pct, resetsAt, source, provider } = check;
    if (options.deferCodexLocalLog && provider === 'codex' && source === 'localLog') continue;
    if (pct <= 0) continue;

    const state = getState(key);
    if (resetsAt !== null && state.lastResetAt !== resetsAt) {
      state.lastResetAt = resetsAt;
      state.lastAlertTime = 0;
      state.firedThresholds.clear();
      pctHistory.delete(key);
      delete prevPct[key];
    }

    const previous = prevPct[key] ?? 0;
    if (resetsAt === null && previous >= 50 && pct <= Math.max(5, previous * 0.25)) {
      state.lastAlertTime = 0;
      state.firedThresholds.clear();
      pctHistory.delete(key);
      delete prevPct[key];
    }

    const smoothPct = smoothedPct(key, pct);
    const cooldownExpired = now - state.lastAlertTime > COOLDOWN_MS;
    const isRising = smoothPct > previous + 1;
    prevPct[key] = smoothPct;

    for (const threshold of [...thresholds].sort((left, right) => right - left)) {
      if (
        smoothPct >= threshold
        && !state.firedThresholds.has(threshold)
        && cooldownExpired
        && (isRising || previous === 0)
      ) {
        state.firedThresholds.add(threshold);
        state.lastAlertTime = now;
        triggered.push({ ...check, pct: smoothPct, threshold });
        break;
      }
    }
  }

  if (triggered.length === 0) return;
  if (triggered.length === 1) {
    const alert = triggered[0];
    emitUsageAlert(
      `Usage alert: ${alert.label} reached ${alert.threshold}%`,
      `Currently at ${Math.round(alert.pct)}% usage${formatReset(alert.resetsAt === null ? null : alert.resetsAt - now)}${formatSource(alert.source)}`,
      options,
    );
    return;
  }

  const body = triggered
    .map(alert => `${alert.label} reached ${alert.threshold}% · currently ${Math.round(alert.pct)}% usage${formatReset(alert.resetsAt === null ? null : alert.resetsAt - now)}${formatSource(alert.source)}`)
    .join('\n');
  emitUsageAlert(`Usage alerts: ${triggered.length} limits reached thresholds`, body, options);
}
