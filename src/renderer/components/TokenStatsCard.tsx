import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { WindowStats } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtTokens, fmtCost, fmtDuration, quotaPctBarColor, quotaSourceBadgeToneStyle, Theme } from '../theme';
import type { LimitDataState, LimitSourceTone } from '../limitDisplay';

function cacheBadge(eff: number, C: Theme) {
  if (eff <= 0) return null;
  const label = `Cache ${Math.round(eff)}%`;
  if (eff >= 80) return { label, bg: C.gradeExcellentBg, color: C.gradeExcellentColor };
  if (eff >= 60) return { label, bg: C.gradeGoodBg, color: C.gradeGoodColor };
  if (eff >= 40) return { label, bg: C.gradeFairBg, color: C.gradeFairColor };
  return { label, bg: C.gradePoorBg, color: C.gradePoorColor };
}

function cacheBadgeTitle(title: string | undefined): string {
  return title || i18n.t('tokenStatsCard.providerCacheMetric');
}

function formatUsagePct(pct: number): string {
  if (pct <= 0) return '0%';
  if (pct < 1) return '<1%';
  if (pct < 10) return `${Math.round(pct * 10) / 10}%`;
  return `${Math.round(pct)}%`;
}

function timeElapsedPct(durationMs: number | null | undefined, resetMs: number | null | undefined): number | null {
  if (!durationMs || resetMs == null || resetMs < 0 || resetMs > durationMs) return null;
  return Math.max(0, Math.min(100, ((durationMs - resetMs) / durationMs) * 100));
}

interface Props {
  provider: string;
  period: string;
  stats: WindowStats;
  currency: string;
  usdToKrw: number;
  limitPct?: number;
  resetMs?: number | null;
  resetLabel?: string;
  apiConnected?: boolean;
  hideCost?: boolean;
  hero?: boolean;
  borderRight?: boolean;
  limitSourceLabel?: string;
  limitSourceTitle?: string;
  limitSourceTone?: LimitSourceTone;
  limitDataState?: LimitDataState;
  limitState?: 'unlimited';
  pendingLimit?: boolean;
  pendingLimitLabel?: string;
  pendingLimitTitle?: string;
  cacheMetricTitle?: string;
  durationMs?: number;
  accountTooltip?: string;
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
  timeElapsedPct: elapsedPct,
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
  const elapsed = elapsedPct == null ? 0 : Math.max(0, Math.min(100, elapsedPct));
  const elapsedColor = C.bgCard === '#ffffff' ? '#cbd5e1' : '#334155';
  return (
    <div style={{ position: 'relative', height, background: C.bgRow, borderRadius: height / 2, overflow: 'hidden' }}>
      <div style={{
        position: 'absolute',
        inset: '0 auto 0 0',
        width: `${elapsed}%`,
        background: elapsedColor,
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

function LimitStatusIndicator({
  state,
  hero = false,
}: {
  state: Exclude<LimitDataState, 'ready'>;
  hero?: boolean;
}) {
  const C = useTheme();
  const { t } = useTranslation();
  const label = state === 'syncing' ? t('tokenStatsCard.syncing') : t('tokenStatsCard.waiting');
  const title = state === 'syncing'
    ? t('tokenStatsCard.syncingTooltip')
    : t('tokenStatsCard.waitingTooltip');
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: hero ? 7 : 5,
        color: state === 'syncing' ? C.accent : C.textMuted,
        fontSize: hero ? 18 : 10,
        fontWeight: 800,
        lineHeight: 1.1,
        fontFamily: C.fontMono,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        {[0, 1, 2].map(index => (
          <span
            key={index}
            className="wmt-sync-dot"
            style={{
              background: state === 'syncing' ? C.accent : C.textMuted,
              animationDelay: `${index * 0.16}s`,
            }}
          />
        ))}
      </span>
      {label}
    </span>
  );
}

function LimitStatusBar({ state, color }: { state: Exclude<LimitDataState, 'ready'>; color: string }) {
  const C = useTheme();
  const trackColor = C.bgCard === '#ffffff' ? '#e7e9f2' : '#131d30';
  return (
    <div style={{ position: 'relative', height: 8, background: trackColor, borderRadius: 4, overflow: 'hidden' }}>
      <span
        className="wmt-sync-sweep"
        style={{
          background: state === 'syncing'
            ? `linear-gradient(90deg, transparent, ${color}88, transparent)`
            : `linear-gradient(90deg, transparent, ${C.textMuted}55, transparent)`,
        }}
      />
    </div>
  );
}

function UnlimitedLimitBar({ color, height = 8 }: { color: string; height?: number }) {
  const C = useTheme();
  const trackColor = C.bgCard === '#ffffff' ? '#e7e9f2' : '#131d30';
  return (
    <div style={{ position: 'relative', height, background: trackColor, borderRadius: height / 2, overflow: 'hidden' }}>
      <div style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: Math.max(1, Math.floor((height - 3) / 2)),
        height: 3,
        background: color,
        borderRadius: 3,
        opacity: 0.62,
        boxShadow: `0 0 8px ${color}44`,
      }} />
    </div>
  );
}

function TokenStatsCard({
  provider,
  period,
  stats,
  currency,
  usdToKrw,
  limitPct,
  resetMs,
  resetLabel,
  apiConnected,
  hideCost,
  hero,
  borderRight,
  limitSourceLabel,
  limitSourceTitle,
  limitSourceTone = 'neutral',
  limitDataState,
  limitState,
  pendingLimit = false,
  pendingLimitLabel,
  pendingLimitTitle,
  cacheMetricTitle,
  durationMs,
  accountTooltip,
}: Props) {
  const C = useTheme();
  const { t } = useTranslation();

  if (!hero && stats.totalTokens === 0 && stats.requestCount === 0) return null;

  const costStr = fmtCost(stats.costUSD, currency, usdToKrw);
  const costColor = stats.costUSD > 5 ? C.barRed : stats.costUSD > 2 ? C.barYellow : C.textDim;
  const showLimitBar = limitPct != null;
  const barPct = Math.max(0, Math.min(100, limitPct ?? 0));
  const isUnlimited = limitState === 'unlimited';
  const barColor = pendingLimit || isUnlimited ? C.accent : quotaPctBarColor(barPct, C);
  const timeElapsed = pendingLimit ? null : timeElapsedPct(durationMs, resetMs);
  const resolvedLimitState: LimitDataState = pendingLimit
    ? 'syncing'
    : (limitDataState ?? (apiConnected === false && barPct === 0 && !limitSourceLabel ? 'waiting' : 'ready'));
  const noData = showLimitBar && !isUnlimited && resolvedLimitState !== 'ready';

  let resetStr = '';
  if (isUnlimited) {
    resetStr = t('tokenStatsCard.unlimitedReset');
  } else if (resetMs && resetMs > 0) {
    const approx = apiConnected === false ? '~' : '';
    const durationStr = `↻${approx}${fmtDuration(resetMs)}`;
    if (resetMs > 4 * 24 * 3600 * 1000) {
      const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.now() + resetMs).getDay()];
      resetStr = `${durationStr} · ${t('tokenStatsCard.resets', { day: dayName })}`;
    } else {
      resetStr = durationStr;
    }
  } else if (resetLabel) {
    resetStr = resetLabel;
  }

  const cache = cacheBadge(stats.cacheEfficiency, C);
  const cacheTitle = cacheBadgeTitle(cacheMetricTitle);
  const showSavings = stats.cacheSavingsUSD > 0.005;
  const breakdownTokens = stats.inputTokens + stats.outputTokens + stats.cacheCreationTokens + stats.cacheReadTokens;
  const displayTitle = `${provider} ${period}`;
  const displayTitleTooltip = accountTooltip ? `${displayTitle} · ${accountTooltip}` : displayTitle;
  const displayLimitSourceLabel = pendingLimit ? (pendingLimitLabel ?? t('tokenStatsCard.syncing')) : limitSourceLabel;
  const displayLimitSourceTitle = pendingLimitTitle ?? limitSourceTitle ?? displayLimitSourceLabel ?? '';
  const cachedDisconnected = apiConnected === false && limitSourceLabel === 'Cache';
  const limitValueColor = pendingLimit ? C.textMuted : barColor;
  const quotaBarColor = pendingLimit ? C.textMuted : barColor;
  const sourceToneStyle = quotaSourceBadgeToneStyle(limitSourceTone, C);
  const sourceChip = displayLimitSourceLabel ? (
    <span
      title={displayLimitSourceTitle}
      style={{
        fontSize: pendingLimit ? 8 : 9,
        fontWeight: 700,
        padding: '1px 4px',
        borderRadius: 4,
        ...(pendingLimit ? { background: C.accentDim, color: C.accent, border: `1px solid ${C.accent}45` } : sourceToneStyle),
        flexShrink: 0,
        maxWidth: 92,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {displayLimitSourceLabel}
    </span>
  ) : null;

  if (hero && showLimitBar) {
    return (
      <div data-testid="hero-card" style={{
        minWidth: 0,
        borderRight: borderRight ? `1px solid ${C.border}` : 'none',
        padding: '8px 12px 8px',
        background: C.bgCard,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span title={displayTitleTooltip} style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1, minWidth: 0, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {displayTitle}
            {!displayLimitSourceLabel && apiConnected === false && limitPct != null && limitPct > 0 && (
              <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: 4 }}>{t('tokenStatsCard.cachedSuffix')}</span>
            )}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flexShrink: 0 }}>
            {sourceChip}
            {cache && (
              <span title={cacheTitle} style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 5, background: cache.bg, color: cache.color, flexShrink: 0, maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {cache.label}
              </span>
            )}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 30, fontWeight: 800, color: noData || cachedDisconnected ? C.textMuted : limitValueColor, lineHeight: 1.1, fontFamily: C.fontMono }}>
            {isUnlimited ? (
              <span title={t('tokenStatsCard.unlimitedTooltip')} style={{ fontSize: 24 }}>
                {t('tokenStatsCard.unlimited')}
              </span>
            ) : noData ? <LimitStatusIndicator state={resolvedLimitState} hero /> : formatUsagePct(barPct)}
          </div>
          {!isUnlimited && !noData && timeElapsed != null && (
            <div
              title={t('tokenStatsCard.windowElapsedTooltip', { pct: Math.round(timeElapsed), period })}
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
              <div style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('tokenStatsCard.timeElapsed')}</div>
              <div style={{ fontSize: 12, color: C.textDim }}>{Math.round(timeElapsed)}%</div>
            </div>
          )}
        </div>

        <div style={{ marginBottom: 6 }}>
          {isUnlimited ? (
            <UnlimitedLimitBar color={C.accent} />
          ) : noData ? (
            <LimitStatusBar state={resolvedLimitState} color={C.accent} />
          ) : (
            <StackedProgressBar quotaPct={barPct} timeElapsedPct={timeElapsed} quotaColor={quotaBarColor} height={8} />
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', marginBottom: 4 }}>
          <TokenDotRow label="In" value={stats.inputTokens} color={C.input} />
          <TokenDotRow label="Out" value={stats.outputTokens} color={C.output} />
          <TokenDotRow label="Cache" value={stats.cacheReadTokens + stats.cacheCreationTokens} color={C.cacheR} />
          {breakdownTokens === 0 && stats.totalTokens > 0 && (
            <TokenDotRow label="Tok" value={stats.totalTokens} color={C.textMuted} />
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 6 }}>
          {(isUnlimited || !noData) && resetStr ? (
            <span style={{ fontSize: 10, color: C.textMuted }}>{resetStr}</span>
          ) : <span />}
          {!hideCost && stats.costUSD > 0 && (
            <span title={t('tokenStatsCard.usageWindowCost')} style={{ fontSize: 12, fontWeight: 700, color: costColor, fontFamily: C.fontMono }}>{costStr}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      borderRight: borderRight ? `1px solid ${C.border}` : 'none',
      padding: '7px 14px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: showLimitBar ? 5 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>{provider} · {period}</span>
          {!displayLimitSourceLabel && apiConnected === false && limitPct != null && limitPct > 0 && (
            <span style={{ fontSize: 8, color: C.textMuted, opacity: 0.6 }}>{t('tokenStatsCard.cachedSuffix')}</span>
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
            <span title={t('tokenStatsCard.usageWindowCost')} style={{ fontSize: 12, fontWeight: 600, color: costColor }}>{costStr}</span>
          )}
        </div>
      </div>

      {showLimitBar && (() => {
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ flex: 1 }}>
              {isUnlimited ? (
                <UnlimitedLimitBar color={C.accent} />
              ) : noData ? (
                <LimitStatusBar state={resolvedLimitState} color={C.accent} />
              ) : (
                <StackedProgressBar quotaPct={barPct} timeElapsedPct={timeElapsed} quotaColor={quotaBarColor} height={8} />
              )}
            </div>
            <span style={{ fontSize: 10, fontWeight: 600, color: noData || cachedDisconnected ? C.textMuted : limitValueColor, width: noData || isUnlimited ? 72 : 28, textAlign: 'right', flexShrink: 0, fontFamily: C.fontMono }}>
              {isUnlimited ? t('tokenStatsCard.unlimited') : noData ? <LimitStatusIndicator state={resolvedLimitState} /> : formatUsagePct(barPct)}
            </span>
            {(isUnlimited || !noData) && resetStr && (
              <span style={{ fontSize: 10, color: C.textMuted, flexShrink: 0 }}>{resetStr}</span>
            )}
          </div>
        );
      })()}

    </div>
  );
}

export default React.memo(TokenStatsCard);
