/**
 * Usage threshold alerts (50% / 80% / 90%)
 * 60-minute cooldown, re-arm after reset allowed
 */
import { Notification } from 'electron';
import { addNotification } from './notificationHistory';
import { UsageLimits } from './stateManager';

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

export function checkAlerts(
  limits: UsageLimits,
  thresholds: number[],
  enabled: boolean,
): void {
  if (!enabled) return;

  const checks: Array<{ key: string; pct: number; resetMs: number; label: string }> = [
    { key: 'h5',   pct: limits.h5.pct,   resetMs: limits.h5.resetMs,   label: '5h usage' },
    { key: 'week', pct: limits.week.pct, resetMs: limits.week.resetMs, label: 'Weekly usage' },
    { key: 'so',   pct: limits.so.pct,   resetMs: limits.so.resetMs,   label: 'Sonnet weekly' },
  ];

  const now = Date.now();

  for (const { key, pct, resetMs, label } of checks) {
    if (pct <= 0) continue;
    const state = getState(key);

    // Reset detection: if resetMs grows larger than before (new cycle started)
    const currentReset = now + resetMs;
    if (currentReset > state.lastResetTime + 5000) {
      state.lastResetTime = currentReset;
      state.firedThresholds.clear();
    }

    // Cooldown check
    const cooldownExpired = now - state.lastAlertTime > COOLDOWN_MS;
    // Only alert when percentage is actually rising (avoid repeating at 100% due to bad calculation)
    const prev = prevPct[key] ?? 0;
    prevPct[key] = pct;
    const isRising = pct > prev + 1;  // only when rising by more than 1%

    for (const threshold of [...thresholds].sort((a, b) => b - a)) {
      if (pct >= threshold && !state.firedThresholds.has(threshold) && cooldownExpired && (isRising || prev === 0)) {
        state.firedThresholds.add(threshold);
        state.lastAlertTime = now;

        const title = `⚠️ ${label} reached ${threshold}%`;
        const body = `Currently at ${Math.round(pct)}% usage`;
        addNotification('alert', title, body);
        try {
          new Notification({ title: `WhereMyTokens ${title}`, body }).show();
        } catch { /* ignore */ }
        break; // only fire the highest matching threshold
      }
    }
  }
}
