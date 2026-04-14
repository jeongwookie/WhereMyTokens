import React from 'react';
import { WindowStats, BurnRate } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtTokens, fmtCost, fmtDuration, Theme } from '../theme';

// 캐시 효율 등급 계산
function cacheGrade(eff: number, C: Theme) {
  if (eff <= 0) return null;
  if (eff >= 80) return { label: 'Excellent', bg: C.gradeExcellentBg, color: C.gradeExcellentColor };
  if (eff >= 60) return { label: 'Good',      bg: C.gradeGoodBg,      color: C.gradeGoodColor };
  if (eff >= 40) return { label: 'Fair',      bg: C.gradeFairBg,      color: C.gradeFairColor };
  return           { label: 'Poor',      bg: C.gradePoorBg,      color: C.gradePoorColor };
}

function pctBarColor(pct: number, C: Theme): string {
  if (pct >= 90) return C.barRed;
  if (pct >= 75) return C.barOrange;
  if (pct >= 50) return C.barYellow;
  return C.accent;
}

interface Props {
  provider: string;
  period: string;
  stats: WindowStats;
  currency: string;
  usdToKrw: number;
  limitPct?: number;    // 0-100
  resetMs?: number;     // ms until reset
  apiConnected?: boolean;
  hideCost?: boolean;
  burnRate?: BurnRate;  // ETA 예측 (h5 카드에만 전달)
  hero?: boolean;       // true = 히어로 대형 % 레이아웃
  borderRight?: boolean;
}

function TokenDotRow({ label, value, color }: { label: string; value: number; color: string }) {
  if (value === 0) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginRight: 10 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 9 }}>{label} {fmtTokens(value)}</span>
    </span>
  );
}

export default function TokenStatsCard({
  provider, period, stats, currency, usdToKrw,
  limitPct, resetMs, apiConnected, hideCost, burnRate,
  hero, borderRight,
}: Props) {
  const C = useTheme();

  if (stats.totalTokens === 0 && stats.requestCount === 0) return null;

  const costStr = fmtCost(stats.costUSD, currency, usdToKrw);
  const costColor = stats.costUSD > 5 ? C.barRed : stats.costUSD > 2 ? C.barYellow : C.textDim;

  const showLimitBar = limitPct != null;
  const barPct = Math.min(100, limitPct ?? 0);
  const barColor = pctBarColor(barPct, C);

  let resetStr = '';
  if (resetMs && resetMs > 0) {
    const approx = apiConnected === false ? '~' : '';
    resetStr = `↻ ${approx}${fmtDuration(resetMs)}`;
  }

  const grade = cacheGrade(stats.cacheEfficiency, C);
  const showSavings = stats.cacheSavingsUSD > 0.005;
  const showEta = burnRate && burnRate.h5EtaMs !== null && burnRate.h5EtaMs < (resetMs ?? Infinity);

  // ── 히어로 레이아웃 (대형 % 숫자 + 토큰 breakdown) ──────────────────────────
  if (hero && showLimitBar) {
    const noData = apiConnected === false && barPct === 0;
    return (
      <div style={{
        borderRight: borderRight ? `1px solid ${C.border}` : 'none',
        padding: '8px 12px 10px',
        background: C.bgCard,
      }}>
        {/* 제공자 + 등급 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
            {provider} {period}
            {apiConnected === false && limitPct != null && limitPct > 0 && (
              <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: 4 }}>(cached)</span>
            )}
          </span>
          {grade && (
            <span style={{ fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 5, background: grade.bg, color: grade.color }}>
              {grade.label}
            </span>
          )}
        </div>

        {/* 대형 퍼센트 */}
        <div style={{ fontSize: 30, fontWeight: 800, color: noData ? C.textMuted : barColor, lineHeight: 1.1, marginBottom: 4 }}>
          {noData ? '—' : `${Math.round(barPct)}%`}
        </div>

        {/* 진행 바 + 리셋 시간 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <div style={{ flex: 1, height: 4, background: C.accentDim, borderRadius: 2, overflow: 'hidden' }}>
            {!noData && (
              <div style={{
                width: `${barPct}%`, height: '100%',
                background: barColor, borderRadius: 2,
                transition: 'width 0.4s',
              }} />
            )}
          </div>
          {!noData && resetStr && (
            <span style={{ fontSize: 9, color: C.textMuted, flexShrink: 0, whiteSpace: 'nowrap' }}>{resetStr}</span>
          )}
        </div>

        {/* 토큰 breakdown (컬러 점) */}
        <div style={{ color: C.textDim, lineHeight: 1.9 }}>
          <div>
            <TokenDotRow label="In"  value={stats.inputTokens}          color={C.input} />
            <TokenDotRow label="Out" value={stats.outputTokens}         color={C.output} />
          </div>
          {(stats.cacheCreationTokens > 0 || stats.cacheReadTokens > 0) && (
            <div>
              <TokenDotRow label="CW" value={stats.cacheCreationTokens} color={C.cacheW} />
              <TokenDotRow label="CR" value={stats.cacheReadTokens}     color={C.cacheR} />
            </div>
          )}
        </div>

        {/* 절감 비용 */}
        {showSavings && (
          <div style={{ fontSize: 9, color: C.gradeExcellentColor, marginTop: 4 }}>
            ✦ Saved {fmtCost(stats.cacheSavingsUSD, currency, usdToKrw)} via cache
          </div>
        )}

        {/* ETA 경고 */}
        {showEta && (
          <div style={{ fontSize: 9, color: C.etaWarning, marginTop: 2 }}>
            ⚡ ~{fmtDuration(burnRate!.h5EtaMs!)} to limit
          </div>
        )}

        {/* Footer: 비용 */}
        {!hideCost && stats.costUSD > 0 && (
          <div style={{ textAlign: 'right', marginTop: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: costColor }}>{costStr}</span>
          </div>
        )}
      </div>
    );
  }

  // ── 일반 레이아웃 (진행 바 위주) ──────────────────────────────────────────
  return (
    <div style={{
      borderBottom: `1px solid ${C.border}`,
      borderRight: borderRight ? `1px solid ${C.border}` : 'none',
      padding: '7px 14px',
    }}>
      {/* header: provider · period, 등급 뱃지, tokens, req count, cost */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: showLimitBar ? 5 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>{provider} · {period}</span>
          {apiConnected === false && limitPct != null && limitPct > 0 && (
            <span style={{ fontSize: 8, color: C.textMuted, opacity: 0.6 }}>(cached)</span>
          )}
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
            <div style={{ flex: 1, height: 5, background: C.accentDim, borderRadius: 3, overflow: 'hidden' }}>
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

      {/* ETA 경고 */}
      {showEta && (
        <div style={{ fontSize: 9, color: C.etaWarning, marginTop: 3 }}>
          ⚡ ~{fmtDuration(burnRate!.h5EtaMs!)} to limit at current rate
        </div>
      )}

      {/* 캐시 절감 비용 */}
      {showSavings && (
        <div style={{ fontSize: 9, color: C.gradeExcellentColor, marginTop: 3 }}>
          ✦ Saved {fmtCost(stats.cacheSavingsUSD, currency, usdToKrw)} via cache
        </div>
      )}
    </div>
  );
}
