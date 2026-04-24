/**
 * Usage threshold alerts (50% / 80% / 90%)
 * 60-minute cooldown, re-arm after reset allowed
 */
import { Notification } from 'electron';
import { addNotification } from './notificationHistory';
import { UsageLimits } from './stateManager';
import type { AppSettings } from './ipc';

interface AlertState {
  lastAlertTime: number;    // ms timestamp
  lastResetTime: number;    // for reset detection
  firedThresholds: Set<number>;
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

function shouldCheckProvider(key: string, providerMode: AppSettings['provider']): boolean {
  if (key.startsWith('codex-')) return providerMode === 'codex' || providerMode === 'both';
  return providerMode === 'claude' || providerMode === 'both';
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
    statusLine: 'statusLine',
    cache: 'cache',
    localLog: 'local log',
  };
  return ` · source: ${labels[source] ?? source}`;
}

export function checkAlerts(
  limits: UsageLimits,
  thresholds: number[],
  enabled: boolean,
  providerMode: AppSettings['provider'],
): void {
  if (!enabled) return;

  const checks: Array<{ key: string; pct: number; resetMs: number | null; label: string; source?: string }> = [
    { key: 'h5',   pct: limits.h5.pct,   resetMs: limits.h5.resetMs,   label: 'Claude 5h usage', source: limits.h5.source },
    { key: 'week', pct: limits.week.pct, resetMs: limits.week.resetMs, label: 'Claude weekly usage', source: limits.week.source },
    { key: 'so',   pct: limits.so.pct,   resetMs: limits.so.resetMs,   label: 'Claude Sonnet weekly', source: limits.so.source },
    { key: 'codex-h5',   pct: limits.codexH5.pct,   resetMs: limits.codexH5.resetMs,   label: 'Codex 5h usage', source: limits.codexH5.source },
    { key: 'codex-week', pct: limits.codexWeek.pct, resetMs: limits.codexWeek.resetMs, label: 'Codex weekly usage', source: limits.codexWeek.source },
  ];

  const now = Date.now();

  for (const { key, pct, resetMs, label, source } of checks.filter(check => shouldCheckProvider(check.key, providerMode))) {
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

        const title = `Usage alert: ${label} reached ${threshold}%`;
        const body = `Currently at ${Math.round(smoothPct)}% usage${formatReset(resetMs)}${formatSource(source)}`;
        addNotification('alert', title, body);
        try {
          new Notification({ title: `WhereMyTokens ${title}`, body }).show();
        } catch { /* ignore */ }
        break; // only fire the highest matching threshold
      }
    }
  }
}
