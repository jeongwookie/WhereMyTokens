import React from 'react';
import { WindowStats } from '../types';
import { C, fmtTokens, fmtCost, fmtDuration } from '../theme';

// 캐시 효율 등급 계산
function cacheGrade(eff: number): { label: string; bg: string; color: string } | null {
  if (eff <= 0) return null;
  if (eff >= 80) return { label: 'Excellent', bg: '#e6f7ee', color: '#1e7e44' };
  if (eff >= 60) return { label: 'Good',      bg: '#e6f0ff', color: '#1a5fb4' };
  if (eff >= 40) return { label: 'Fair',      bg: '#fff4e0', color: '#9a5c00' };
  return           { label: 'Poor',      bg: '#fde8e8', color: '#8b1a1a' };
}

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

  const grade = cacheGrade(stats.cacheEfficiency);
  const showSavings = stats.cacheSavingsUSD > 0.005;

  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, padding: '7px 14px' }}>
      {/* header: provider · period, 등급 뱃지, tokens, req count, cost */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: showLimitBar ? 5 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>{provider} · {period}</span>
          {apiConnected === false && limitPct != null && limitPct > 0 && (
            <span style={{ fontSize: 8, color: C.textMuted, opacity: 0.6 }}>(cached)</span>
          )}
          {/* 캐시 효율 등급 뱃지 */}
          {grade && (
            <span style={{ fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 6, background: grade.bg, color: grade.color }}>
              {grade.label}
            </span>
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

      {/* 캐시 절감 비용 */}
      {showSavings && (
        <div style={{ fontSize: 9, color: '#1e7e44', marginTop: 3 }}>
          ✦ Saved {fmtCost(stats.cacheSavingsUSD, currency, usdToKrw)} via cache
        </div>
      )}
    </div>
  );
}
