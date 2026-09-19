/**
 * Usage threshold alerts (50% / 80% / 90%).
 * Alert state is keyed by the canonical quota-entry key so dynamic targets
 * re-arm independently when their own reset boundary changes.
 */
import { Notification } from 'electron';
import { addNotification } from './notificationHistory';
import { isSimplifiedChineseLocale } from '../shared/language';
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
  language?: 'system' | 'en' | 'ja' | 'zh';
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

type AlertLanguage = 'en' | 'ja' | 'zh';

function resolveAlertLanguage(preference: AlertOptions['language'] = 'en'): AlertLanguage {
  if (preference === 'en' || preference === 'ja' || preference === 'zh') return preference;
  const systemLanguage = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  if (systemLanguage.startsWith('ja')) return 'ja';
  if (isSimplifiedChineseLocale(systemLanguage)) return 'zh';
  return 'en';
}

function formatReset(resetMs: number | null, language: AlertLanguage): string {
  if (!resetMs || resetMs <= 0) return '';
  const minutes = Math.max(1, Math.round(resetMs / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (language === 'zh') {
    const duration = hours <= 0 ? `${remainder} 分钟` : remainder === 0 ? `${hours} 小时` : `${hours} 小时 ${remainder} 分钟`;
    return ` · ${duration}后重置`;
  }
  if (language === 'ja') {
    const duration = hours <= 0 ? `${remainder}分` : remainder === 0 ? `${hours}時間` : `${hours}時間${remainder}分`;
    return ` · ${duration}後にリセット`;
  }
  if (hours <= 0) return ` · resets in ${remainder}m`;
  if (remainder === 0) return ` · resets in ${hours}h`;
  return ` · resets in ${hours}h ${remainder}m`;
}

function formatSource(source: string | undefined, language: AlertLanguage): string {
  if (!source) return '';
  const labels: Record<string, string> = language === 'zh'
    ? { api: 'API', statusLine: 'Bridge', cache: '缓存', localLog: '日志', localRpc: 'RPC' }
    : language === 'ja'
      ? { api: 'API', statusLine: 'Bridge', cache: 'キャッシュ', localLog: 'ログ', localRpc: 'RPC' }
      : { api: 'API', statusLine: 'Bridge', cache: 'Cache', localLog: 'Log', localRpc: 'RPC' };
  const label = labels[source] ?? source;
  return language === 'zh' ? ` · 来源：${label}` : language === 'ja' ? ` · ソース: ${label}` : ` · source: ${label}`;
}

function periodLabel(period: QuotaPeriod | null, language: AlertLanguage): string {
  if (language === 'zh') return period === '5h' ? '5 小时用量' : period === '7d' ? '周用量' : '用量';
  if (language === 'ja') return period === '5h' ? '5時間使用量' : period === '7d' ? '週間使用量' : '使用量';
  if (period === '5h') return '5h usage';
  if (period === '7d') return 'weekly usage';
  return 'usage';
}

export function quotaChecks(
  providerQuotas: Partial<Record<ProviderId, ProviderQuotaSnapshot>>,
  enabledProviders: ReadonlySet<ProviderId>,
  options: Pick<AlertOptions, 'quotaTargetModes' | 'language'> = {},
): QuotaAlertCheck[] {
  const language = resolveAlertLanguage(options.language);
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
        label: `${entry.target.label} ${periodLabel(entry.period, language)}`,
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
  const language = resolveAlertLanguage(options.language);
  const triggered: Array<QuotaAlertCheck & { threshold: number }> = [];

  for (const check of quotaChecks(providerQuotas, enabledProviders, { ...options, language })) {
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
    const reset = formatReset(alert.resetsAt === null ? null : alert.resetsAt - now, language);
    const source = formatSource(alert.source, language);
    const title = language === 'zh'
      ? `用量提醒：${alert.label}已达到 ${alert.threshold}%`
      : language === 'ja'
        ? `使用量アラート: ${alert.label}が${alert.threshold}%に達しました`
        : `Usage alert: ${alert.label} reached ${alert.threshold}%`;
    const body = language === 'zh'
      ? `当前用量 ${Math.round(alert.pct)}%${reset}${source}`
      : language === 'ja'
        ? `現在の使用量: ${Math.round(alert.pct)}%${reset}${source}`
        : `Currently at ${Math.round(alert.pct)}% usage${reset}${source}`;
    emitUsageAlert(
      title,
      body,
      options,
    );
    return;
  }

  const body = triggered.map(alert => {
    const reset = formatReset(alert.resetsAt === null ? null : alert.resetsAt - now, language);
    const source = formatSource(alert.source, language);
    return language === 'zh'
      ? `${alert.label}已达到 ${alert.threshold}% · 当前用量 ${Math.round(alert.pct)}%${reset}${source}`
      : language === 'ja'
        ? `${alert.label}が${alert.threshold}%に達しました · 現在 ${Math.round(alert.pct)}%${reset}${source}`
        : `${alert.label} reached ${alert.threshold}% · currently ${Math.round(alert.pct)}% usage${reset}${source}`;
  }).join('\n');
  const title = language === 'zh'
    ? `${triggered.length} 项限额达到阈值`
    : language === 'ja'
      ? `${triggered.length} 件の上限がしきい値に達しました`
      : `Usage alerts: ${triggered.length} limits reached thresholds`;
  emitUsageAlert(title, body, options);
}
