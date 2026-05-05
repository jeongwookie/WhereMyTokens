import React from 'react';
import { WindowStats, BurnRate } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtTokens, fmtCost, fmtDuration, Theme } from '../theme';

// 캐시 효율 등급 계산
function cacheBadge(eff: number, C: Theme) {
  if (eff <= 0) return null;
  const label = `Cache ${Math.round(eff)}%`;
  if (eff >= 80) return { label, bg: C.gradeExcellentBg, color: C.gradeExcellentColor };
  if (eff >= 60) return { label, bg: C.gradeGoodBg, color: C.gradeGoodColor };
  if (eff >= 40) return { label, bg: C.gradeFairBg, color: C.gradeFairColor };
  return { label, bg: C.gradePoorBg, color: C.gradePoorColor };
}

function cacheBadgeTitle(mode: 'claude' | 'codex'): string {
  if (mode === 'codex') return 'Codex: cached input / input';
  return 'Claude: cache read / (cache read + cache creation)';
}

function pctBarColor(pct: number, C: Theme): string {
  if (pct >= 90) return C.barRed;
  if (pct >= 75) return C.barOrange;
  if (pct >= 50) return C.barYellow;
  return C.accent;
}

function formatUsagePct(pct: number): string {
  if (pct <= 0) return '0%';
  if (pct < 1) return '<1%';
  if (pct < 10) return `${Math.round(pct * 10) / 10}%`;
  return `${Math.round(pct)}%`;
}

function windowDurationMs(period: string): number | null {
  const normalized = period.trim().toLowerCase();
  if (normalized === '5h') return 5 * 60 * 60 * 1000;
  if (normalized === '1w') return 7 * 24 * 60 * 60 * 1000;
  return null;
}

function timeElapsedPct(period: string, resetMs: number | null | undefined): number | null {
  const durationMs = windowDurationMs(period);
  if (!durationMs || resetMs == null || resetMs < 0 || resetMs > durationMs) return null;
  return Math.max(0, Math.min(100, ((durationMs - resetMs) / durationMs) * 100));
}

interface Props {
  provider: string;
  period: string;
  stats: WindowStats;
  currency: string;
  usdToKrw: number;
  limitPct?: number;    // 0-100
  resetMs?: number | null;     // ms until reset
  resetLabel?: string;
  apiConnected?: boolean;
  hideCost?: boolean;
  burnRate?: BurnRate;  // ETA 예측 (h5 카드에만 전달)
  hero?: boolean;       // true = 히어로 대형 % 레이아웃
  borderRight?: boolean;
  limitSourceLabel?: string;
  cacheMetricMode?: 'claude' | 'codex';
}

function TokenDotRow({ label, value, color }: { label: string; value: number; color: string }) {
  if (value === 0) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginRight: 10 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 10 }}>{label} {fmtTokens(value)}</span>
    </span>
  );
}

function StackedProgressBar({
  quotaPct,
  timeElapsedPct,
  quotaColor,
  height = 8,
}: {
  quotaPct: number;
  timeElapsedPct: number | null;
  quotaColor: string;
  height?: number;
}) {
  const C = useTheme();
  const quota = Math.max(0, Math.min(100, quotaPct));
  const elapsed = timeElapsedPct == null ? 0 : Math.max(0, Math.min(100, timeElapsedPct));
  return (
    <div style={{ position: 'relative', height, background: C.bgRow, borderRadius: height / 2, overflow: 'hidden' }}>
      <div style={{
        position: 'absolute',
        inset: '0 auto 0 0',
        width: `${elapsed}%`,
        background: 'rgba(148,163,184,0.35)',
        borderRadius: height / 2,
        transition: 'width 0.4s',
      }} />
      <div style={{
        position: 'absolute',
        left: 0,
        top: Math.max(1, Math.floor((height - 3) / 2)),
        width: `${quota}%`,
        height: 3,
        background: quotaColor,
        borderRadius: 3,
        boxShadow: `0 0 8px ${quotaColor}55`,
        transition: 'width 0.4s',
      }} />
    </div>
  );
}

function TokenStatsCard({
  provider, period, stats, currency, usdToKrw,
  limitPct, resetMs, resetLabel, apiConnected, hideCost, burnRate,
  hero, borderRight, limitSourceLabel, cacheMetricMode = 'claude',
}: Props) {
  const C = useTheme();

  // hero 카드는 데이터 0이어도 표시 (리셋 직후 빈 상태 방지)
  if (!hero && stats.totalTokens === 0 && stats.requestCount === 0) return null;

  const costStr = fmtCost(stats.costUSD, currency, usdToKrw);
  const costColor = stats.costUSD > 5 ? C.barRed : stats.costUSD > 2 ? C.barYellow : C.textDim;

  const showLimitBar = limitPct != null;
  const barPct = Math.max(0, Math.min(100, limitPct ?? 0));
  const barColor = pctBarColor(barPct, C);

  let resetStr = '';
  if (resetMs && resetMs > 0) {
    const approx = apiConnected === false ? '~' : '';
    const durationStr = `↻ ${approx}${fmtDuration(resetMs)}`;
    if (resetMs > 4 * 24 * 3600 * 1000) {
      // 4일 이상 → 요일 병기: "↻ 152h 3m · resets Mon"
      const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(Date.now() + resetMs).getDay()];
      resetStr = `${durationStr} · resets ${dayName}`;
    } else {
      resetStr = durationStr;
    }
  } else if (resetLabel) {
    resetStr = resetLabel;
  }

  const cache = cacheBadge(stats.cacheEfficiency, C);
  const cacheTitle = cacheBadgeTitle(cacheMetricMode);
  const showSavings = stats.cacheSavingsUSD > 0.005;
  const showEta = burnRate && burnRate.h5EtaMs !== null && resetMs != null && burnRate.h5EtaMs < resetMs;
  const timeElapsed = timeElapsedPct(period, resetMs);
  const sourceChip = limitSourceLabel ? (
    <span
      title={limitSourceLabel}
      style={{ fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 4, background: C.bgRow, color: C.textMuted, border: `1px solid ${C.border}`, maxWidth: 92, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
    >
      {limitSourceLabel}
    </span>
  ) : null;

  // ── 히어로 레이아웃 (대형 % 숫자 + 토큰 breakdown) ──────────────────────────
  if (hero && showLimitBar) {
    const noData = apiConnected === false && barPct === 0 && limitSourceLabel !== 'live fallback' && limitSourceLabel !== 'local log';
    return (
      <div style={{
        borderRight: borderRight ? `1px solid ${C.border}` : 'none',
        padding: '8px 12px 8px',
        background: C.bgCard,
      }}>
        {/* 제공자 + 등급 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1, minWidth: 0 }}>
            {provider} {period}
            {!limitSourceLabel && apiConnected === false && limitPct != null && limitPct > 0 && (
              <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: 4 }}>(cached)</span>
            )}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flexShrink: 1 }}>
            {sourceChip}
            {cache && (
              <span title={cacheTitle} style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 5, background: cache.bg, color: cache.color, maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {cache.label}
              </span>
            )}
          </span>
        </div>

        {/* 대형 퍼센트 */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 30, fontWeight: 800, color: noData ? C.textMuted : barColor, lineHeight: 1.1, fontFamily: C.fontMono }}>
          {noData ? '—' : formatUsagePct(barPct)}
          </div>
          {!noData && timeElapsed != null && (
            <div
              title={`${Math.round(timeElapsed)}% of this ${period} window has elapsed`}
              style={{
                marginTop: 4,
                fontSize: 9,
                lineHeight: 1.25,
                color: C.textMuted,
                textAlign: 'right',
                fontFamily: C.fontMono,
                opacity: 0.78,
                flexShrink: 0,
              }}
            >
              <div style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>time elapsed</div>
              <div style={{ fontSize: 12, color: C.textDim }}>{Math.round(timeElapsed)}%</div>
            </div>
          )}
        </div>

        {/* 진행 바 (전폭) */}
        <div style={{ marginBottom: 6 }}>
          {!noData && (
            <StackedProgressBar quotaPct={barPct} timeElapsedPct={timeElapsed} quotaColor={barColor} height={8} />
          )}
        </div>

        {/* 토큰 breakdown (In / Out / Cache 3개) */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', marginBottom: 4 }}>
          <TokenDotRow label="In"  value={stats.inputTokens}  color={C.input} />
          <TokenDotRow label="Out" value={stats.outputTokens} color={C.output} />
          <TokenDotRow label="Cache" value={stats.cacheReadTokens + stats.cacheCreationTokens} color={C.cacheR} />
        </div>

        {/* ETA 경고 */}
        {showEta && (
          <div style={{ fontSize: 10, color: C.etaWarning, marginTop: 3 }}>
            ⚡ ~{fmtDuration(burnRate!.h5EtaMs!)} to limit
          </div>
        )}

        {/* Footer: 리셋 왼쪽 ↔ 비용 오른쪽 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 6 }}>
          {!noData && resetStr ? (
            <span style={{ fontSize: 10, color: C.textMuted }}>{resetStr}</span>
          ) : <span />}
          {!hideCost && stats.costUSD > 0 && (
            <span title="Usage window cost" style={{ fontSize: 12, fontWeight: 700, color: costColor, fontFamily: C.fontMono }}>{costStr}</span>
          )}
        </div>
      </div>
    );
  }

  // ── 일반 레이아웃 (진행 바 위주) ──────────────────────────────────────────
  return (
    <div style={{
      borderRight: borderRight ? `1px solid ${C.border}` : 'none',
      padding: '7px 14px',
    }}>
      {/* header: provider · period, 등급 뱃지, tokens, req count, cost */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: showLimitBar ? 5 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>{provider} · {period}</span>
          {!limitSourceLabel && apiConnected === false && limitPct != null && limitPct > 0 && (
            <span style={{ fontSize: 9, color: C.textMuted, opacity: 0.6 }}>(cached)</span>
          )}
          {sourceChip}
          {cache && (
            <span title={cacheTitle} style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 6, background: cache.bg, color: cache.color }}>
              {cache.label}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>{fmtTokens(stats.totalTokens)} tok</span>
          {stats.requestCount > 0 && (
            <span style={{ fontSize: 11, color: C.textMuted }}>{stats.requestCount} req</span>
          )}
          {!hideCost && (
            <span title="Usage window cost" style={{ fontSize: 12, fontWeight: 600, color: costColor }}>{costStr}</span>
          )}
        </div>
      </div>

      {/* limit progress bar */}
      {showLimitBar && (() => {
        const noData = apiConnected === false && barPct === 0 && limitSourceLabel !== 'live fallback' && limitSourceLabel !== 'local log';
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ flex: 1 }}>
              {!noData && (
                <StackedProgressBar quotaPct={barPct} timeElapsedPct={timeElapsed} quotaColor={barColor} height={8} />
              )}
            </div>
            <span style={{ fontSize: 11, fontWeight: 600, color: noData ? C.textMuted : barColor, width: 28, textAlign: 'right', flexShrink: 0, fontFamily: C.fontMono }}>
              {noData ? '—' : formatUsagePct(barPct)}
            </span>
            {!noData && resetStr && (
              <span style={{ fontSize: 10, color: C.textMuted, flexShrink: 0 }}>{resetStr}</span>
            )}
          </div>
        );
      })()}

      {/* ETA 경고 */}
      {showEta && (
        <div style={{ fontSize: 10, color: C.etaWarning, marginTop: 3 }}>
          ⚡ ~{fmtDuration(burnRate!.h5EtaMs!)} to limit at current rate
        </div>
      )}
    </div>
  );
}

export default React.memo(TokenStatsCard);
