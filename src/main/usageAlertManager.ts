/**
 * Usage threshold alerts (50% / 80% / 90%)
 * 60-minute cooldown, re-arm after reset allowed
 */
import { Notification } from 'electron';
import { addNotification } from './notificationHistory';
import type { ProviderId, ProviderQuotaSnapshot, QuotaDisplayMode } from './providers/types';

interface AlertState {
  lastAlertTime: number;    // ms timestamp
  lastResetTime: number;    // for reset detection
  firedThresholds: Set<number>;
}

interface AlertOptions {
  deferCodexLocalLog?: boolean;
  quotaTargetModes?: Partial<Record<string, QuotaDisplayMode>>;
  nowMs?: number;
  emitNotification?: (title: string, body: string) => void;
}

const alertStates: Record<string, AlertState> = {};
const COOLDOWN_MS = 60 * 60 * 1000;

function getState(key: string): AlertState {
  if (!alertStates[key]) {
    alertStates[key] = { lastAlertTime: 0, lastResetTime: 0, firedThresholds: new Set() };
  }
  return alertStates[key];
}

// Store previous percentage (only alert when rising)
const prevPct: Record<string, number> = {};

// 3-샘플 이동 평균 스무딩 — 순간 급등/급락에 의한 오발 방지
const pctHistory: Map<string, number[]> = new Map();

function smoothedPct(key: string, rawPct: number): number {
  const hist = pctHistory.get(key) ?? [];
  hist.push(rawPct);
  if (hist.length > 3) hist.shift();
  pctHistory.set(key, hist);
  return hist.reduce((a, b) => a + b, 0) / hist.length;
}

function formatReset(resetMs: number | null | undefined): string {
  if (!resetMs || resetMs <= 0) return '';
  const minutes = Math.max(1, Math.round(resetMs / 60000));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours <= 0) return ` · resets in ${mins}m`;
  if (mins === 0) return ` · resets in ${hours}h`;
  return ` · resets in ${hours}h ${mins}m`;
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

function providerLabel(provider: ProviderId): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  if (provider === 'antigravity') return 'Antigravity';
  return provider;
}

function windowLabel(windowKey: string): string {
  if (windowKey === 'h5') return '5h usage';
  if (windowKey === 'week') return 'weekly usage';
  if (windowKey === 'sonnetWeek') return 'Sonnet weekly';
  return `${windowKey} usage`;
}

function quotaGroupId(provider: ProviderId, groupKey: string): string {
  return `${provider}.group.${encodeURIComponent(groupKey)}`;
}

function modelQuotaGroupKey(model: string): string {
  return `model.${model}`;
}

function quotaTargetMode(
  provider: ProviderId,
  groupKey: string,
  defaultMode: QuotaDisplayMode,
  modes: Partial<Record<string, QuotaDisplayMode>> | undefined,
): QuotaDisplayMode {
  return modes?.[quotaGroupId(provider, groupKey)] ?? defaultMode;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function modelDurationLabel(durationMs: number | undefined, resetMs: number | null | undefined): string {
  const resolved = durationMs || (resetMs != null ? (resetMs <= FIVE_HOURS_MS ? FIVE_HOURS_MS : WEEK_MS) : undefined);
  if (resolved === FIVE_HOURS_MS) return '5h';
  if (resolved === WEEK_MS) return '1w';
  return 'quota';
}

function modelWindowLabel(durationMs: number | undefined, resetMs: number | null | undefined): string {
  const label = modelDurationLabel(durationMs, resetMs);
  if (label === '5h') return '5h usage';
  if (label === '1w') return 'weekly usage';
  return 'usage';
}

export function quotaChecks(
  providerQuotas: Partial<Record<ProviderId, ProviderQuotaSnapshot>>,
  enabledProviders: ReadonlySet<ProviderId>,
  options: Pick<AlertOptions, 'quotaTargetModes'> = {},
): Array<{ key: string; pct: number; resetMs: number | null; label: string; source?: string; provider: ProviderId }> {
  const checks: Array<{ key: string; pct: number; resetMs: number | null; label: string; source?: string; provider: ProviderId }> = [];
  for (const provider of enabledProviders) {
    const quota = providerQuotas[provider];
    const windows = quota?.windows;
    const groupedWindows = new Set<string>();
    for (const group of quota?.groups ?? []) {
      const mode = quotaTargetMode(provider, group.key, group.defaultMode, options.quotaTargetModes);
      for (const windowKey of group.windowKeys) {
        groupedWindows.add(windowKey);
        if (mode === 'none') continue;
        const window = windows?.[windowKey];
        if (!window) continue;
        checks.push({
          key: `${provider}-${windowKey}`,
          pct: window.pct,
          resetMs: window.resetMs,
          label: `${providerLabel(provider)} ${windowLabel(windowKey)}`,
          source: window.source,
          provider,
        });
      }
    }
    for (const [windowKey, window] of Object.entries(windows ?? {})) {
      if (groupedWindows.has(windowKey)) continue;
      checks.push({
        key: `${provider}-${windowKey}`,
        pct: window.pct,
        resetMs: window.resetMs,
        label: `${providerLabel(provider)} ${windowLabel(windowKey)}`,
        source: window.source,
        provider,
      });
    }
    for (const model of quota?.models ?? []) {
      const resetMs = model.resetMs ?? null;
      const durationLabel = modelDurationLabel(model.durationMs, resetMs);
      const groupKey = model.groupKey ?? modelQuotaGroupKey(model.model);
      const mode = quotaTargetMode(provider, groupKey, model.defaultMode ?? 'simple', options.quotaTargetModes);
      if (mode === 'none') continue;
      checks.push({
        key: `${provider}-model-${model.model}-${durationLabel}`,
        pct: Math.max(0, Math.min(100, 100 - model.remainingPct)),
        resetMs,
        label: `${providerLabel(provider)} ${model.label} ${modelWindowLabel(model.durationMs, resetMs)}`,
        source: quota?.source,
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
  const triggered: Array<{
    label: string;
    threshold: number;
    pct: number;
    resetMs: number | null;
    source?: string;
  }> = [];

  for (const { key, pct, resetMs, label, source, provider } of quotaChecks(providerQuotas, enabledProviders, options)) {
    if (options.deferCodexLocalLog && provider === 'codex' && source === 'localLog') continue;
    if (pct <= 0) continue;
    const state = getState(key);

    // Reset detection: if resetMs grows larger than before (new cycle started)
    const currentReset = resetMs != null ? now + resetMs : state.lastResetTime;
    if (resetMs != null && currentReset > state.lastResetTime + 5000) {
      state.lastResetTime = currentReset;
      state.firedThresholds.clear();
      pctHistory.delete(key); // 리셋 후 스무딩 히스토리 초기화
    }

    const prev = prevPct[key] ?? 0;
    if (resetMs == null && prev >= 50 && pct <= Math.max(5, prev * 0.25)) {
      state.firedThresholds.clear();
      state.lastAlertTime = 0;
      pctHistory.delete(key);
    }

    // 3-샘플 이동 평균으로 노이즈 제거 후 threshold 비교
    const smoothPct = smoothedPct(key, pct);

    // Cooldown check
    const cooldownExpired = now - state.lastAlertTime > COOLDOWN_MS;
    // Only alert when percentage is actually rising (avoid repeating at 100% due to bad calculation)
    prevPct[key] = smoothPct;
    const isRising = smoothPct > prev + 1;  // only when rising by more than 1%

    for (const threshold of [...thresholds].sort((a, b) => b - a)) {
      if (smoothPct >= threshold && !state.firedThresholds.has(threshold) && cooldownExpired && (isRising || prev === 0)) {
        state.firedThresholds.add(threshold);
        state.lastAlertTime = now;
        triggered.push({ label, threshold, pct: smoothPct, resetMs, source });
        break; // only fire the highest matching threshold
      }
    }
  }

  if (triggered.length === 0) return;
  if (triggered.length === 1) {
    const alert = triggered[0];
    emitUsageAlert(
      `Usage alert: ${alert.label} reached ${alert.threshold}%`,
      `Currently at ${Math.round(alert.pct)}% usage${formatReset(alert.resetMs)}${formatSource(alert.source)}`,
      options,
    );
    return;
  }

  const body = triggered
    .map(alert => `${alert.label} reached ${alert.threshold}% · currently ${Math.round(alert.pct)}% usage${formatReset(alert.resetMs)}${formatSource(alert.source)}`)
    .join('\n');
  emitUsageAlert(`Usage alerts: ${triggered.length} limits reached thresholds`, body, options);
}
