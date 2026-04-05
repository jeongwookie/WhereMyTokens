import React from 'react';
import { WindowStats } from '../types';
import { C, fmtTokens, fmtCost, fmtDuration } from '../theme';

interface Props {
  provider: string;
  period: string;
  stats: WindowStats;
  currency: string;
  usdToKrw: number;
  limitPct?: number;   // 0-100
  resetMs?: number;    // ms until reset
  apiConnected?: boolean;
  hideCost?: boolean;
}

function pctBarColor(pct: number): string {
  if (pct >= 90) return '#c0392b';
  if (pct >= 75) return '#e67e22';
  if (pct >= 50) return '#d4a017';
  return C.accent;
}

export default function TokenStatsCard({
  provider, period, stats, currency, usdToKrw,
  limitPct, resetMs, apiConnected, hideCost,
}: Props) {
  if (stats.totalTokens === 0 && stats.requestCount === 0) return null;

  const costStr = fmtCost(stats.costUSD, currency, usdToKrw);
  const costColor = stats.costUSD > 5 ? '#7a3030' : stats.costUSD > 2 ? '#7a5a20' : C.textDim;

  const showLimitBar = limitPct != null;
  const barPct = Math.min(100, limitPct ?? 0);
  const barColor = pctBarColor(barPct);

  let resetStr = '';
  if (resetMs && resetMs > 0) {
    const approx = apiConnected === false ? '~' : '';
    resetStr = `↻ ${approx}${fmtDuration(resetMs)}`;
  }

  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, padding: '7px 14px' }}>
      {/* header: provider · period, tokens, req count, cost */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: showLimitBar ? 5 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>{provider} · {period}</span>
          {apiConnected === false && limitPct != null && limitPct > 0 && (
            <span style={{ fontSize: 8, color: C.textMuted, opacity: 0.6 }}>(cached)</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ fontSize: 10, color: C.textMuted }}>{fmtTokens(stats.totalTokens)} tok</span>
          {stats.requestCount > 0 && (
            <span style={{ fontSize: 10, color: C.textMuted }}>{stats.requestCount} req</span>
          )}
          {!hideCost && (
            <span style={{ fontSize: 12, fontWeight: 600, color: costColor }}>{costStr}</span>
          )}
        </div>
      </div>

      {/* limit progress bar */}
      {showLimitBar && (() => {
        const noData = apiConnected === false && barPct === 0;
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ flex: 1, height: 5, background: '#0000000a', borderRadius: 3, overflow: 'hidden' }}>
              {!noData && (
                <div style={{
                  width: `${barPct}%`, height: '100%',
                  background: barColor, borderRadius: 3,
                  transition: 'width 0.4s',
                }} />
              )}
            </div>
            <span style={{ fontSize: 10, fontWeight: 600, color: noData ? C.textMuted : barColor, width: 28, textAlign: 'right', flexShrink: 0 }}>
              {noData ? '—' : `${Math.round(barPct)}%`}
            </span>
            {!noData && resetStr && (
              <span style={{ fontSize: 9, color: C.textMuted, flexShrink: 0 }}>{resetStr}</span>
            )}
          </div>
        );
      })()}
    </div>
  );
}
