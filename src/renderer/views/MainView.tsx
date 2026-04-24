import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { AppState, SessionInfo } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtTokens, fmtCost, fmtRelative, modelColor } from '../theme';
import SessionRow from '../components/SessionRow';
import TokenStatsCard from '../components/TokenStatsCard';
import ActivityChart from '../components/ActivityChart';
import ModelBreakdown from '../components/ModelBreakdown';
import ExtraUsageCard from '../components/ExtraUsageCard';
import CodeOutputCard from '../components/CodeOutputCard';
import RenderErrorBoundary from '../components/RenderErrorBoundary';

interface Props {
  state: AppState;
  onNav: (view: 'settings' | 'notifications' | 'help') => void;
  onQuit: () => void;
  onRefresh: () => void;
  onScrollActivity: () => void;
}

type NavView = 'settings' | 'notifications' | 'help';
type ProviderMode = AppState['settings']['provider'];
type HeaderStatusTone = 'warning' | 'danger';
type SessionListItem =
  | { type: 'session'; session: SessionInfo }
  | {
      type: 'stack';
      key: string;
      sessions: SessionInfo[];
      provider: SessionInfo['provider'];
      source: string;
      modelName: string;
      state: SessionInfo['state'];
      latest: string | null;
      maxCtxPct: number;
      startedAt: string;
    };

const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
const STALE_MS = 6 * 60 * 60 * 1000;

function formatRefreshLabel(lastUpdated: number): string {
  if (!lastUpdated) return 'Refresh';
  const elapsed = Math.round((Date.now() - lastUpdated) / 1000);
  if (elapsed < 5) return 'just now';
  if (elapsed < 60) return `${elapsed}s ago`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  return `${Math.floor(elapsed / 3600)}h ago`;
}

function formatWarmupEta(historyWarmupStartsAt: number | null): string {
  if (!historyWarmupStartsAt) return 'queued';
  const remainingMs = Math.max(0, historyWarmupStartsAt - Date.now());
  if (remainingMs === 0) return 'syncing...';
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `in ${minutes}m ${seconds}s`;
  return `in ${seconds}s`;
}

function formatWarmupStatus(historyWarmupStartsAt: number | null): string {
  const etaLabel = formatWarmupEta(historyWarmupStartsAt);
  if (etaLabel === 'queued') return 'is queued';
  if (etaLabel === 'syncing...') return 'is syncing now';
  return `starts ${etaLabel}`;
}

function cacheMetricColor(value: number, C: ReturnType<typeof useTheme>): string {
  if (value >= 80) return C.active;
  if (value >= 60) return C.barYellow;
  return C.barRed;
}

function cacheMetricTitle(providerMode: ProviderMode): string {
  if (providerMode === 'claude') return 'Claude: cache read / (cache read + cache creation)';
  if (providerMode === 'codex') return 'Codex: cached input / input';
  return 'Combined view: provider-specific cache metrics are aggregated';
}

function formatCodexServiceTier(serviceTier: string | null | undefined): string | null {
  if (!serviceTier) return null;
  return serviceTier
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function headerPeriodButtonStyle(
  active: boolean,
  C: ReturnType<typeof useTheme>,
): React.CSSProperties {
  return {
    ...noDrag,
    padding: '2px 6px',
    fontSize: 9,
    borderRadius: 3,
    cursor: 'pointer',
    fontFamily: C.fontMono,
    border: active ? `1px solid ${C.accent}33` : '1px solid transparent',
    background: active ? `${C.accent}22` : 'none',
    color: active ? C.accent : C.headerSub,
    fontWeight: active ? 700 : 400,
    whiteSpace: 'nowrap',
  };
}

function buildHeaderStatus(args: {
  showClaudeUsage: boolean;
  hasClaudeFallback: boolean;
  apiConnected: boolean;
  apiStatusLabel?: string;
  apiError?: string;
}): { label: string; title: string; tone: HeaderStatusTone } | null {
  const { showClaudeUsage, hasClaudeFallback, apiConnected, apiStatusLabel, apiError } = args;
  if (!showClaudeUsage) return null;

  if (hasClaudeFallback) {
    return {
      label: 'Local estimate',
      title: `Using local Claude status-line data while API status is ${apiStatusLabel || 'unavailable'}${apiError ? ` - ${apiError}` : ''}`,
      tone: 'warning',
    };
  }

  switch (apiStatusLabel) {
    case 'rate limited':
      return { label: 'Rate limited', title: apiError || 'Claude API returned HTTP 429.', tone: 'warning' };
    case 'schema changed':
      return { label: 'Schema changed', title: apiError || 'Claude API response changed shape.', tone: 'danger' };
    case 'reset partial':
      return { label: 'Reset unavailable', title: apiError || 'Claude API usage loaded without reset timing.', tone: 'warning' };
    case 'local only':
      return { label: 'Local only', title: apiError || 'Claude credentials were not found. Showing local data only.', tone: 'warning' };
    case 'auth failed':
      return { label: 'Auth failed', title: apiError || 'Claude API rejected the stored access token.', tone: 'danger' };
    case 'forbidden':
      return { label: 'Access blocked', title: apiError || 'Claude API denied this account or beta surface.', tone: 'danger' };
    case 'api disconnected':
      return { label: 'API offline', title: apiError || 'Claude API request failed.', tone: 'danger' };
    default:
      break;
  }

  if (!apiConnected) {
    return {
      label: 'API offline',
      title: apiError || 'Claude API request failed.',
      tone: 'danger',
    };
  }

  return null;
}

function limitSourceLabel(limit: AppState['limits']['h5']): string | undefined {
  if (limit.source === 'statusLine') return 'live fallback';
  if (limit.source === 'cache') return 'cached';
  if (limit.source === 'localLog') return 'local log';
  return undefined;
}

function buildTrackedH5(usage: AppState['usage'], providerMode: ProviderMode) {
  if (providerMode === 'codex') return usage.h5Codex;
  if (providerMode === 'claude') return usage.h5;
  const cacheTokens = usage.h5.cacheReadTokens + usage.h5.cacheCreationTokens + usage.h5Codex.inputTokens + usage.h5Codex.cacheReadTokens;
  const cacheRead = usage.h5.cacheReadTokens + usage.h5Codex.cacheReadTokens;
  return {
    ...usage.h5,
    inputTokens: usage.h5.inputTokens + usage.h5Codex.inputTokens,
    outputTokens: usage.h5.outputTokens + usage.h5Codex.outputTokens,
    cacheCreationTokens: usage.h5.cacheCreationTokens + usage.h5Codex.cacheCreationTokens,
    cacheReadTokens: usage.h5.cacheReadTokens + usage.h5Codex.cacheReadTokens,
    totalTokens: usage.h5.totalTokens + usage.h5Codex.totalTokens,
    costUSD: usage.h5.costUSD + usage.h5Codex.costUSD,
    requestCount: usage.h5.requestCount + usage.h5Codex.requestCount,
    cacheEfficiency: cacheTokens > 0 ? (cacheRead / cacheTokens) * 100 : 0,
    cacheSavingsUSD: usage.h5.cacheSavingsUSD + usage.h5Codex.cacheSavingsUSD,
  };
}

function latestTime(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function sessionCtxPct(s: SessionInfo): number {
  return s.contextMax > 0 ? Math.min(100, (s.contextUsed / s.contextMax) * 100) : 0;
}

function sessionStartedMs(s: SessionInfo): number {
  const ms = new Date(s.startedAt).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function sessionStableId(s: SessionInfo): string {
  return `${sessionStartedMs(s)}:${s.sessionId}`;
}

function stateSortValue(state: SessionInfo['state']): number {
  if (state === 'active') return 0;
  if (state === 'waiting') return 1;
  if (state === 'compacting') return 2;
  return 3;
}

function buildSessionItems(projectName: string, branch: string, sessions: SessionInfo[]): SessionListItem[] {
  const items: SessionListItem[] = [];
  const stackable = new Map<string, SessionInfo[]>();

  for (const session of sessions) {
    if (session.state === 'active' || session.state === 'waiting' || session.state === 'idle') {
      const key = `${projectName}|${branch}|${session.provider}|${session.source}|${session.modelName}|${session.state}`;
      if (!stackable.has(key)) stackable.set(key, []);
      stackable.get(key)!.push(session);
    } else {
      items.push({ type: 'session', session });
    }
  }

  for (const [key, grouped] of stackable) {
    if (grouped.length < 2) {
      for (const session of grouped) items.push({ type: 'session', session });
      continue;
    }
    const sorted = [...grouped].sort((a, b) => sessionStableId(a).localeCompare(sessionStableId(b)));
    const first = sorted[0];
    items.push({
      type: 'stack',
      key,
      sessions: sorted,
      provider: first.provider,
      source: first.source,
      modelName: first.modelName,
      state: first.state,
      latest: sorted.reduce<string | null>((acc, s) => latestTime(acc, s.lastModified), null),
      maxCtxPct: Math.max(...sorted.map(sessionCtxPct)),
      startedAt: first.startedAt,
    });
  }

  return items.sort((a, b) => {
    const aState = a.type === 'session' ? a.session.state : a.state;
    const bState = b.type === 'session' ? b.session.state : b.state;
    const stateDelta = stateSortValue(aState) - stateSortValue(bState);
    if (stateDelta !== 0) return stateDelta;
    const aStarted = a.type === 'session' ? sessionStartedMs(a.session) : new Date(a.startedAt).getTime();
    const bStarted = b.type === 'session' ? sessionStartedMs(b.session) : new Date(b.startedAt).getTime();
    if (aStarted !== bStarted) return bStarted - aStarted;
    const aId = a.type === 'session' ? a.session.sessionId : a.key;
    const bId = b.type === 'session' ? b.session.sessionId : b.key;
    return aId.localeCompare(bId);
  });
}

const RefreshStatus = React.memo(function RefreshStatus({
  lastUpdated,
  refreshing,
  syncingHistory,
  historyWarmupStartsAt,
}: {
  lastUpdated: number;
  refreshing: boolean;
  syncingHistory: boolean;
  historyWarmupStartsAt: number | null;
}) {
  const [label, setLabel] = useState(() => syncingHistory ? formatWarmupEta(historyWarmupStartsAt) : formatRefreshLabel(lastUpdated));

  useEffect(() => {
    if (refreshing) {
      setLabel('refreshing...');
      return;
    }
    if (syncingHistory) {
      setLabel(formatWarmupEta(historyWarmupStartsAt));
      const t = setInterval(() => setLabel(formatWarmupEta(historyWarmupStartsAt)), 1000);
      return () => clearInterval(t);
    }
    setLabel(formatRefreshLabel(lastUpdated));
    const t = setInterval(() => setLabel(formatRefreshLabel(lastUpdated)), 1000);
    return () => clearInterval(t);
  }, [historyWarmupStartsAt, lastUpdated, refreshing, syncingHistory]);

  return <>{label}</>;
});

const LazySection = React.memo(function LazySection({ minHeight, children }: { minHeight: number; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { root: null, rootMargin: '280px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div ref={ref} style={{ minHeight: visible ? undefined : minHeight, overflowAnchor: 'none', contain: 'layout paint style' }}>
      {visible ? children : null}
    </div>
  );
});

const HeaderMetrics = React.memo(function HeaderMetrics({ state, onQuit }: { state: AppState; onQuit: () => void }) {
  const C = useTheme();
  const { sessions, usage, settings, apiConnected, apiError, apiStatusLabel } = state;
  const { currency, usdToKrw } = settings;
  const providerMode = settings.provider ?? 'both';
  const showClaudeUsage = providerMode !== 'codex';
  const showCodexUsage = providerMode !== 'claude';
  const hasClaudeFallback = showClaudeUsage && (state.limits.h5.source === 'statusLine' || state.limits.week.source === 'statusLine');
  const trackedH5 = useMemo(() => buildTrackedH5(usage, providerMode), [usage, providerMode]);
  const [period, setPeriod] = useState<'today' | 'all'>('today');
  const headerStatus = useMemo(() => buildHeaderStatus({
    showClaudeUsage,
    hasClaudeFallback,
    apiConnected,
    apiStatusLabel,
    apiError,
  }), [apiConnected, apiError, apiStatusLabel, hasClaudeFallback, showClaudeUsage]);

  const isAll = period === 'all';
  const cost = isAll ? usage.allTimeCost : usage.todayCost;
  const calls = isAll ? usage.allTimeRequestCount : usage.todayRequestCount;
  const sessionCount = isAll ? state.allTimeSessions : sessions.length;
  const cacheEff = isAll ? usage.allTimeAvgCacheEfficiency : trackedH5.cacheEfficiency;
  const saved = isAll ? usage.allTimeSavedUSD : trackedH5.cacheSavingsUSD;
  const cacheColor = cacheMetricColor(cacheEff, C);
  const cacheTitle = cacheMetricTitle(providerMode);
  const planLabel = showClaudeUsage && state.autoLimits ? state.autoLimits.plan : undefined;
  const codexTierLabel = showCodexUsage ? formatCodexServiceTier(state.codexAccount.serviceTier) : null;
  const statusStyles = headerStatus?.tone === 'danger'
    ? {
        color: C.barRed,
        background: `${C.barRed}18`,
        border: `1px solid ${C.barRed}33`,
      }
    : {
        color: C.barYellow,
        background: `${C.barYellow}16`,
        border: `1px solid ${C.barYellow}2b`,
      };

  return (
    <div style={{ background: C.headerBg, flexShrink: 0, borderBottom: `1px solid ${C.headerBorder}` }}>
      <div style={{ ...drag, padding: '8px 12px 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: C.headerAccent, letterSpacing: -0.3, flexShrink: 0, whiteSpace: 'nowrap' }}>
          WhereMyTokens
        </span>
        <div style={{ ...noDrag, display: 'inline-flex', gap: 3, marginLeft: 4, flexShrink: 0 }}>
          {(['today', 'all'] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={headerPeriodButtonStyle(period === p, C)}>{p}</button>
          ))}
        </div>
        <div style={{ ...noDrag, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          {headerStatus && (
            <span
              title={headerStatus.title}
              style={{
                fontSize: 9,
                borderRadius: 999,
                padding: '2px 8px',
                fontWeight: 700,
                maxWidth: 132,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flexShrink: 1,
                ...statusStyles,
              }}
            >
              {headerStatus.label}
            </span>
          )}
          <div style={{ width: 1, height: 14, background: C.headerBorder, flexShrink: 0 }} />
          <button onClick={() => window.wmt.minimize().catch(() => {})} title="Minimize" style={{ ...noDrag, width: 24, height: 20, background: 'none', border: 'none', color: C.headerSub, cursor: 'pointer', fontSize: 16, borderRadius: 4, lineHeight: 1, fontWeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>-</button>
          <button onClick={onQuit} title="Quit" style={{ ...noDrag, width: 24, height: 20, background: 'none', border: 'none', color: C.headerSub, cursor: 'pointer', fontSize: 14, borderRadius: 4, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>x</button>
        </div>
      </div>

      <div style={{ ...drag, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 14, padding: '4px 14px 10px', alignItems: 'end', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginBottom: 3 }}>
            <div style={{ fontSize: 8, color: C.headerSub, textTransform: 'uppercase', letterSpacing: 1.1, whiteSpace: 'nowrap' }}>
              {isAll ? 'All-time Cost' : 'Today Cost'}
            </div>
          </div>
          {(planLabel || codexTierLabel) && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', minWidth: 0, marginBottom: 6 }}>
              {planLabel && (
                <div title={`Claude plan: ${planLabel}`} style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  <span style={{
                    fontSize: 8,
                    color: C.textMuted,
                    background: C.bgRow,
                    border: `1px solid ${C.border}`,
                    borderRadius: 4,
                    padding: '1px 4px',
                    fontWeight: 700,
                    flexShrink: 0,
                  }}>
                    Claude
                  </span>
                  <span style={{ fontSize: 9, color: C.headerSub, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}>
                    {planLabel}
                  </span>
                </div>
              )}
              {codexTierLabel && (
                <div title={`Codex service tier: ${codexTierLabel}`} style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  <span style={{
                    fontSize: 8,
                    color: C.textMuted,
                    background: C.bgRow,
                    border: `1px solid ${C.border}`,
                    borderRadius: 4,
                    padding: '1px 4px',
                    fontWeight: 700,
                    flexShrink: 0,
                  }}>
                    Codex
                  </span>
                  <span style={{ fontSize: 9, color: C.headerSub, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}>
                    {codexTierLabel}
                  </span>
                </div>
              )}
            </div>
          )}
          <div style={{ fontSize: 28, fontWeight: 800, color: C.headerText, lineHeight: 1, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}>
            {fmtCost(cost, currency, usdToKrw)}
          </div>
          <div style={{ fontSize: 10, color: C.headerSub, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ fontFamily: C.fontMono, fontWeight: 700, color: C.headerText }}>{fmtTokens(calls)}</span> calls
            <span style={{ margin: '0 6px', color: C.textMuted }}>/</span>
            <span style={{ fontFamily: C.fontMono, fontWeight: 700, color: C.headerText }}>{sessionCount}</span> sessions
          </div>
        </div>
        <div style={{ textAlign: 'right', minWidth: 0 }} title={cacheTitle}>
          <div style={{ fontSize: 8, color: C.headerSub, textTransform: 'uppercase', letterSpacing: 1.1, marginBottom: 3, whiteSpace: 'nowrap' }}>
            {isAll ? 'Avg Cache Efficiency' : 'Cache Efficiency'}
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, color: cacheColor, lineHeight: 1, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}>
            {Math.round(cacheEff)}%
          </div>
          <div style={{ fontSize: 10, color: cacheColor, marginTop: 4, whiteSpace: 'nowrap' }}>
            + {fmtCost(saved, currency, usdToKrw)} saved{isAll ? ' total' : ' today'}
          </div>
        </div>
      </div>

    </div>
  );
});

const PlanUsagePanel = React.memo(function PlanUsagePanel({ usage, limits, settings, apiConnected, extraUsage }: {
  usage: AppState['usage'];
  limits: AppState['limits'];
  settings: AppState['settings'];
  apiConnected: boolean;
  extraUsage: AppState['extraUsage'];
}) {
  const C = useTheme();
  const { currency, usdToKrw } = settings;
  const providerMode = settings.provider ?? 'both';
  const showClaudeUsage = providerMode !== 'codex';
  const showCodexUsage = providerMode !== 'claude';
  const showSonnet = settings.provider !== 'codex' && (limits.so.pct > 0 || usage.sonnetWeekTokens > 0);
  const showExtraUsage = showClaudeUsage && !!extraUsage?.isEnabled;
  const showCodexPanel = showCodexUsage && (
    providerMode === 'codex' ||
    usage.h5Codex.totalTokens > 0 ||
    usage.weekCodex.totalTokens > 0 ||
    limits.codexH5.pct > 0 ||
    limits.codexWeek.pct > 0
  );
  const codexH5HasLimit = limits.codexH5.source === 'localLog' || limits.codexH5.pct > 0 || (limits.codexH5.resetMs ?? 0) > 0;
  const codexWeekHasLimit = limits.codexWeek.source === 'localLog' || limits.codexWeek.pct > 0 || (limits.codexWeek.resetMs ?? 0) > 0;

  return (
    <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 14px 5px 12px', background: C.bgRow, borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Plan Usage</span>
      </div>

      {showClaudeUsage && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: `1px solid ${C.border}` }}>
          <TokenStatsCard provider="Claude" period="5h" stats={usage.h5} currency={currency} usdToKrw={usdToKrw}
            limitPct={limits.h5.pct} resetMs={limits.h5.resetMs} resetLabel={limits.h5.resetLabel} apiConnected={apiConnected} burnRate={usage.burnRate}
            limitSourceLabel={limitSourceLabel(limits.h5)} hero borderRight />
          <TokenStatsCard provider="Claude" period="1w" stats={usage.week} currency={currency} usdToKrw={usdToKrw}
            limitPct={limits.week.pct} resetMs={limits.week.resetMs} resetLabel={limits.week.resetLabel} apiConnected={apiConnected}
            limitSourceLabel={limitSourceLabel(limits.week)} hero />
        </div>
      )}

      {showExtraUsage && extraUsage && (
        <div style={{ borderBottom: `1px solid ${C.border}` }}>
          <ExtraUsageCard extraUsage={extraUsage} />
        </div>
      )}

      {showSonnet && (
        <div style={{ borderBottom: `1px solid ${C.border}` }}>
          <TokenStatsCard provider="Sonnet" period="1w" stats={{
            inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
            totalTokens: usage.sonnetWeekTokens, costUSD: 0, requestCount: 0, cacheEfficiency: 0, cacheSavingsUSD: 0,
          }} currency={currency} usdToKrw={usdToKrw}
            limitPct={limits.so.pct} resetMs={limits.so.resetMs} resetLabel={limits.so.resetLabel} apiConnected={apiConnected}
            limitSourceLabel={limitSourceLabel(limits.so)} hideCost />
        </div>
      )}

      {showCodexPanel && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: `1px solid ${C.border}` }}>
          <TokenStatsCard provider="Codex" period="5h" stats={usage.h5Codex} currency={currency} usdToKrw={usdToKrw}
            limitPct={limits.codexH5.pct} resetMs={limits.codexH5.resetMs} resetLabel={limits.codexH5.resetLabel} apiConnected={codexH5HasLimit}
            limitSourceLabel={limitSourceLabel(limits.codexH5)} cacheMetricMode="codex" hero borderRight />
          <TokenStatsCard provider="Codex" period="1w" stats={usage.weekCodex} currency={currency} usdToKrw={usdToKrw}
            limitPct={limits.codexWeek.pct} resetMs={limits.codexWeek.resetMs} resetLabel={limits.codexWeek.resetLabel} apiConnected={codexWeekHasLimit}
            limitSourceLabel={limitSourceLabel(limits.codexWeek)} cacheMetricMode="codex" hero />
        </div>
      )}
    </div>
  );
});

const HistoryWarmupBanner = React.memo(function HistoryWarmupBanner({ historyWarmupStartsAt }: {
  historyWarmupStartsAt: number | null;
}) {
  const C = useTheme();
  const statusLabel = formatWarmupStatus(historyWarmupStartsAt);
  return (
    <div style={{
      margin: '10px 8px 0',
      padding: '9px 12px',
      borderRadius: 10,
      border: `1px solid ${C.headerAccent}26`,
      background: `${C.headerAccent}10`,
      color: C.textDim,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.headerAccent, textTransform: 'uppercase', letterSpacing: 0.8 }}>
        Partial History
      </div>
      <div style={{ fontSize: 11, lineHeight: 1.5, marginTop: 3 }}>
        Showing current sessions and recent usage first. Full history sync {statusLabel} to keep startup responsive.
      </div>
    </div>
  );
});

const SessionStackRow = React.memo(function SessionStackRow({ item, expanded, onToggle }: {
  item: Extract<SessionListItem, { type: 'stack' }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const C = useTheme();
  const provider = item.provider === 'codex' ? 'Codex' : 'Claude';
  const chipColor = item.state === 'waiting' ? C.waiting : C.textMuted;
  const modelColorValue = item.modelName ? modelColor(item.modelName, C) : C.textMuted;
  return (
    <button
      onClick={onToggle}
      style={{
        width: 'calc(100% - 16px)',
        margin: '3px 8px 0',
        padding: '7px 10px',
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: C.bgRow,
        color: C.text,
        cursor: 'pointer',
        contain: 'layout paint style',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        textAlign: 'left',
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          {item.modelName && (
            <span title={item.modelName} style={{ fontSize: 8, background: `${modelColorValue}16`, color: modelColorValue, border: `1px solid ${modelColorValue}33`, borderRadius: 3, padding: '1px 5px', fontWeight: 700, maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.modelName}
            </span>
          )}
          <span style={{ fontSize: 8, background: item.provider === 'codex' ? C.output + '16' : C.accentDim, color: item.provider === 'codex' ? C.output : C.textMuted, border: `1px solid ${C.border}`, borderRadius: 3, padding: '1px 5px', fontWeight: 700 }}>
            {provider}
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>
            {item.sessions.length} {item.state} sessions
          </span>
        </span>
        <span style={{ display: 'block', fontSize: 9, color: C.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.source} - latest {fmtRelative(item.latest)} - max ctx {Math.round(item.maxCtxPct)}%
        </span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: `${chipColor}1a`, color: chipColor, fontWeight: 700 }}>
          {expanded ? 'open' : 'stack'}
        </span>
        <span style={{ fontSize: 12, color: C.textMuted }}>{expanded ? '^' : 'v'}</span>
      </span>
    </button>
  );
});

const SessionStackItem = React.memo(function SessionStackItem({ item, expanded, onToggleStack }: {
  item: Extract<SessionListItem, { type: 'stack' }>;
  expanded: boolean;
  onToggleStack: (key: string) => void;
}) {
  const handleToggle = useCallback(() => onToggleStack(item.key), [onToggleStack, item.key]);
  return <SessionStackRow item={item} expanded={expanded} onToggle={handleToggle} />;
});

const SessionItem = React.memo(function SessionItem({ session, expanded, onToggleSession }: {
  session: SessionInfo;
  expanded: boolean;
  onToggleSession: (sessionId: string) => void;
}) {
  const handleToggle = useCallback(() => onToggleSession(session.sessionId), [onToggleSession, session.sessionId]);
  return <SessionRow session={session} expanded={expanded} onToggle={handleToggle} />;
});

const SessionsPanel = React.memo(function SessionsPanel({ sessions, settings, providerMode }: {
  sessions: SessionInfo[];
  settings: AppState['settings'];
  providerMode: ProviderMode;
}) {
  const C = useTheme();
  const hiddenProjects = settings.hiddenProjects ?? [];
  const excludedProjects = settings.excludedProjects ?? [];
  const [showHiddenManager, setShowHiddenManager] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<'all' | 'active'>('active');
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(() => new Set());
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(() => new Set());
  const [showStale, setShowStale] = useState(false);

  const hideProject = useCallback((name: string) => {
    setProjectMenuOpen(null);
    window.wmt.setSettings({ hiddenProjects: [...hiddenProjects, name] }).catch(() => {});
  }, [hiddenProjects]);

  const unhideProject = useCallback((name: string) => {
    window.wmt.setSettings({ hiddenProjects: hiddenProjects.filter(p => p !== name) }).catch(() => {});
  }, [hiddenProjects]);

  const excludeProject = useCallback((name: string) => {
    setProjectMenuOpen(null);
    window.wmt.setSettings({ excludedProjects: [...excludedProjects, name] }).catch(() => {});
  }, [excludedProjects]);

  const toggleSession = useCallback((sessionId: string) => {
    setExpandedSession(prev => prev === sessionId ? null : sessionId);
  }, []);

  const toggleStack = useCallback((key: string) => {
    setExpandedStacks(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleBranch = useCallback((key: string) => {
    setExpandedBranches(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const isStale = useCallback((s: SessionInfo) => {
    if (s.state === 'active' || s.state === 'waiting') return false;
    if (!s.lastModified) return true;
    return Date.now() - new Date(s.lastModified).getTime() > STALE_MS;
  }, []);
  const staleSessions = useMemo(() => sessions.filter(isStale), [sessions, isStale]);
  const freshSessions = useMemo(() => sessions.filter(s => !isStale(s)), [sessions, isStale]);
  const filteredSessions = useMemo(() => activeFilter === 'active'
    ? freshSessions.filter(s => s.state === 'active' || s.state === 'waiting')
    : showStale ? sessions : freshSessions, [activeFilter, freshSessions, sessions, showStale]);

  const projectGroups = useMemo(() => {
    const repoNames = new Map<string, string>();
    for (const s of filteredSessions) {
      const repoId = s.gitStats?.gitCommonDir ?? s.gitStats?.toplevel;
      if (repoId && !repoNames.has(repoId)) {
        const nameFromCommonDir = s.gitStats?.gitCommonDir
          ?.replace(/[/\\]\.git$/, '').split(/[/\\]/).filter(Boolean).pop();
        repoNames.set(repoId, s.mainRepoName ?? nameFromCommonDir ?? s.gitStats?.toplevel?.split(/[\\/]/).filter(Boolean).pop() ?? s.projectName);
      }
    }

    const projectMap = new Map<string, SessionInfo[]>();
    for (const s of filteredSessions) {
      const repoId = s.gitStats?.gitCommonDir ?? s.gitStats?.toplevel;
      const key = repoId ? (repoNames.get(repoId) ?? s.projectName) : (s.mainRepoName ?? s.projectName);
      if (!projectMap.has(key)) projectMap.set(key, []);
      projectMap.get(key)!.push(s);
    }

    return Array.from(projectMap.entries())
      .filter(([name]) => !hiddenProjects.includes(name))
      .map(([name, projectSessions]) => {
        const uniqueProjectStats = new Map<string, NonNullable<SessionInfo['gitStats']>>();
        for (const s of projectSessions) {
          if (!s.gitStats) continue;
          const repoKey = s.gitStats.gitCommonDir ?? s.gitStats.toplevel ?? s.cwd;
          if (!uniqueProjectStats.has(repoKey)) uniqueProjectStats.set(repoKey, s.gitStats);
        }
        const branchMap = new Map<string, SessionInfo[]>();
        for (const s of projectSessions) {
          const branch = s.worktreeBranch ?? s.gitStats?.branch ?? s.gitBranch ?? '(unknown)';
          if (!branchMap.has(branch)) branchMap.set(branch, []);
          branchMap.get(branch)!.push(s);
        }
        const branches = Array.from(branchMap.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([branch, branchSessions]) => {
          const firstStats = branchSessions.find(s => s.gitStats)?.gitStats;
          return {
            branch,
            items: buildSessionItems(name, branch, branchSessions),
            commits: firstStats?.commitsToday ?? 0,
            added: firstStats?.linesAdded ?? 0,
            removed: firstStats?.linesRemoved ?? 0,
          };
        });
        return {
          name,
          branches,
          totalCommits: [...uniqueProjectStats.values()].reduce((sum, stats) => sum + stats.commitsToday, 0),
          totalAdded: [...uniqueProjectStats.values()].reduce((sum, stats) => sum + stats.linesAdded, 0),
          totalRemoved: [...uniqueProjectStats.values()].reduce((sum, stats) => sum + stats.linesRemoved, 0),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredSessions, hiddenProjects]);

  return (
    <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}`, paddingBottom: 16, contain: 'layout paint style', overflowAnchor: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px 5px 12px', background: C.bgRow, borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Sessions</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'active'] as const).map(filter => (
            <button
              key={filter}
              onClick={() => setActiveFilter(filter)}
              style={{
                background: activeFilter === filter ? C.accent + '22' : 'none',
                border: `1px solid ${activeFilter === filter ? C.accent + '66' : C.border}`,
                color: activeFilter === filter ? C.accent : C.textMuted,
                borderRadius: 3, padding: '1px 7px', fontSize: 9, cursor: 'pointer', fontWeight: activeFilter === filter ? 700 : 400,
              }}
            >
              {filter === 'all' ? 'All' : 'Active'}
            </button>
          ))}
        </div>
      </div>

      {projectGroups.length > 0
        ? projectGroups.map(project => (
          <div key={project.name}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 10px', margin: '10px 8px 0',
              background: `${C.accent}08`, borderRadius: 4, border: `1px solid ${C.accent}14`,
            }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.text, fontFamily: C.fontSans }}>{project.name}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {project.totalCommits > 0 && (
                  <span style={{ fontSize: 9, color: C.textMuted, fontFamily: C.fontMono }}>
                    {project.totalCommits} commit{project.totalCommits > 1 ? 's' : ''} · +{project.totalAdded} / -{project.totalRemoved}
                  </span>
                )}
                <div style={{ position: 'relative' }}>
                  <button
                    onClick={() => setProjectMenuOpen(open => open === project.name ? null : project.name)}
                    title="Project actions"
                    style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textMuted, cursor: 'pointer', fontSize: 11, padding: '0 6px', lineHeight: 1.4, borderRadius: 4 }}
                  >
                    ...
                  </button>
                  {projectMenuOpen === project.name && (
                    <div style={{ position: 'absolute', right: 0, top: 20, zIndex: 5, display: 'grid', gap: 2, padding: 4, background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 6, boxShadow: '0 4px 10px rgba(0,0,0,0.18)' }}>
                      <button onClick={() => hideProject(project.name)} style={{ background: C.bgRow, border: `1px solid ${C.border}`, color: C.textDim, cursor: 'pointer', fontSize: 10, padding: '3px 8px', borderRadius: 3, textAlign: 'left' }}>Hide</button>
                      <button onClick={() => excludeProject(project.name)} style={{ background: C.bgRow, border: `1px solid ${C.border}`, color: C.textDim, cursor: 'pointer', fontSize: 10, padding: '3px 8px', borderRadius: 3, textAlign: 'left' }}>Exclude</button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {project.branches.map(branch => {
              const branchKey = `${project.name}:${branch.branch}`;
              const isBranchExpanded = expandedBranches.has(branchKey);
              const visibleItems = isBranchExpanded ? branch.items : branch.items.slice(0, 3);
              const hiddenCount = branch.items.length - visibleItems.length;
              return (
              <div key={branch.branch} style={{ margin: '6px 8px 0 14px', contain: 'layout paint style', overflowAnchor: 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 0', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: C.accent, lineHeight: 1 }} aria-hidden="true">›</span>
                  <span title={branch.branch} style={{
                    fontSize: 10, color: C.textDim, fontWeight: 500, fontFamily: C.fontMono,
                    maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{branch.branch}</span>
                  {branch.commits > 0 && (
                    <>
                      <span style={{ fontSize: 8, background: '#60a5fa1a', color: '#60a5fa', borderRadius: 3, padding: '1px 5px', fontFamily: C.fontMono, fontWeight: 600 }}>
                        {branch.commits} commit{branch.commits > 1 ? 's' : ''}
                      </span>
                      <span style={{ fontSize: 8, background: '#34d3991a', color: '#34d399', borderRadius: 3, padding: '1px 5px', fontFamily: C.fontMono, fontWeight: 600 }}>+{branch.added}</span>
                      <span style={{ fontSize: 8, background: '#f871711a', color: '#f87171', borderRadius: 3, padding: '1px 5px', fontFamily: C.fontMono, fontWeight: 600 }}>-{branch.removed}</span>
                    </>
                  )}
                </div>

                {visibleItems.map(item => item.type === 'stack' ? (
                  <React.Fragment key={item.key}>
                    <SessionStackItem
                      item={item}
                      expanded={expandedStacks.has(item.key)}
                      onToggleStack={toggleStack}
                    />
                    {expandedStacks.has(item.key) && item.sessions.map(session => (
                      <SessionItem
                        key={session.sessionId}
                        session={session}
                        expanded={expandedSession === session.sessionId}
                        onToggleSession={toggleSession}
                      />
                    ))}
                  </React.Fragment>
                ) : (
                  <SessionItem
                    key={item.session.sessionId}
                    session={item.session}
                    expanded={expandedSession === item.session.sessionId}
                    onToggleSession={toggleSession}
                  />
                ))}
                {hiddenCount > 0 && (
                  <button
                    onClick={() => toggleBranch(branchKey)}
                    style={{
                      margin: '4px 8px 0',
                      width: 'calc(100% - 16px)',
                      background: 'transparent',
                      border: `1px solid ${C.border}`,
                      color: C.textMuted,
                      borderRadius: 8,
                      cursor: 'pointer',
                      fontSize: 9,
                      padding: '3px 8px',
                      fontFamily: C.fontMono,
                    }}
                  >
                    Show {hiddenCount} more
                  </button>
                )}
                {isBranchExpanded && branch.items.length > 3 && (
                  <button
                    onClick={() => toggleBranch(branchKey)}
                    style={{
                      margin: '4px 8px 0',
                      width: 'calc(100% - 16px)',
                      background: 'transparent',
                      border: `1px solid ${C.border}`,
                      color: C.textMuted,
                      borderRadius: 8,
                      cursor: 'pointer',
                      fontSize: 9,
                      padding: '3px 8px',
                      fontFamily: C.fontMono,
                    }}
                  >
                    Show less
                  </button>
                )}
              </div>
            );})}
          </div>
        ))
        : sessions.length === 0
          ? <div style={{ padding: '10px 14px', fontSize: 12, color: C.textMuted }}>No active {providerMode === 'codex' ? 'Codex' : providerMode === 'claude' ? 'Claude Code' : 'Claude Code or Codex'} sessions</div>
          : null
      }

      {staleSessions.length > 0 && activeFilter === 'all' && (
        <div style={{ padding: '6px 14px', display: 'flex', justifyContent: 'center' }}>
          <button
            onClick={() => setShowStale(v => !v)}
            style={{
              background: 'none', border: `1px solid ${C.border}`, borderRadius: 10,
              color: C.textMuted, cursor: 'pointer', fontSize: 9, padding: '3px 12px',
              fontFamily: C.fontMono,
            }}
          >
            {showStale ? 'Hide' : 'Show'} {staleSessions.length} idle session{staleSessions.length > 1 ? 's' : ''}
          </button>
        </div>
      )}

      {hiddenProjects.length > 0 && (
        <div style={{ padding: '4px 14px', marginTop: 8, borderTop: `1px solid ${C.border}` }}>
          <button
            onClick={() => setShowHiddenManager(v => !v)}
            style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: 10, padding: 0 }}
          >
            {showHiddenManager ? 'v' : '>'} {hiddenProjects.length} hidden project{hiddenProjects.length > 1 ? 's' : ''}
          </button>
          {showHiddenManager && (
            <div style={{ marginTop: 4 }}>
              {hiddenProjects.map(name => (
                <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
                  <span style={{ fontSize: 11, color: C.textDim, flex: 1 }}>{name}</span>
                  <button
                    onClick={() => unhideProject(name)}
                    style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textDim, cursor: 'pointer', fontSize: 10, padding: '1px 6px', borderRadius: 3 }}
                  >show</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const ActivitySection = React.memo(function ActivitySection({ usage, currency, usdToKrw }: {
  usage: AppState['usage'];
  currency: AppState['settings']['currency'];
  usdToKrw: number;
}) {
  const C = useTheme();
  return (
    <LazySection minHeight={220}>
      <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
        <ActivityChart
          heatmap={usage.heatmap}
          heatmap30={usage.heatmap30}
          heatmap90={usage.heatmap90}
          weeklyTimeline={usage.weeklyTimeline}
          todBuckets={usage.todBuckets}
          currency={currency}
          usdToKrw={usdToKrw}
        />
      </div>
    </LazySection>
  );
});

const ModelSection = React.memo(function ModelSection({ models, currency, usdToKrw }: {
  models: AppState['usage']['models'];
  currency: AppState['settings']['currency'];
  usdToKrw: number;
}) {
  const C = useTheme();
  return (
    <LazySection minHeight={130}>
      <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
        <ModelBreakdown models={models} currency={currency} usdToKrw={usdToKrw} />
      </div>
    </LazySection>
  );
});

const BottomNav = React.memo(function BottomNav({ lastUpdated, refreshing, syncingHistory, historyWarmupStartsAt, onRefresh, onNav }: {
  lastUpdated: number;
  refreshing: boolean;
  syncingHistory: boolean;
  historyWarmupStartsAt: number | null;
  onRefresh: () => void;
  onNav: (view: NavView) => void;
}) {
  const C = useTheme();
  const items: Array<{ key: NavView | 'refresh'; icon: string; label: React.ReactNode }> = [
    { key: 'settings', icon: '⚙', label: 'Settings' },
    { key: 'notifications', icon: '!', label: 'Alerts' },
    { key: 'help', icon: '?', label: 'Help' },
    { key: 'refresh', icon: '↻', label: <RefreshStatus lastUpdated={lastUpdated} refreshing={refreshing} syncingHistory={syncingHistory} historyWarmupStartsAt={historyWarmupStartsAt} /> },
  ];
  return (
    <div style={{ display: 'flex', borderTop: `1px solid ${C.border}`, flexShrink: 0, background: C.bgCard }}>
      {items.map(({ key, icon, label }) => (
        <button
          key={key}
          onClick={() => key === 'refresh' ? onRefresh() : onNav(key)}
          style={{
            flex: 1, padding: '7px 0', background: 'none', border: 'none',
            color: key === 'refresh' && refreshing ? C.accent : C.textDim,
            cursor: key === 'refresh' && refreshing ? 'wait' : 'pointer',
            fontSize: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
          }}
        >
          <span style={{
            fontSize: 13,
            display: 'inline-block',
            transition: 'transform 0.4s',
            transform: key === 'refresh' && refreshing ? 'rotate(360deg)' : 'none',
          }}>{icon}</span>
          <span style={{ maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        </button>
      ))}
    </div>
  );
});

export default function MainView({ state, onNav, onQuit, onRefresh, onScrollActivity }: Props) {
  const C = useTheme();
  const { sessions, usage, settings } = state;
  const { currency, usdToKrw } = settings;
  const providerMode = settings.provider ?? 'both';
  const allTimeCost = useMemo(() => usage.models.reduce((sum, model) => sum + model.costUSD, 0), [usage.models]);
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTopRef = useRef(0);
  const sessionLayoutKey = useMemo(
    () => sessions.map(s => `${s.sessionId}:${s.provider}:${s.source}:${s.state}:${s.projectName}:${s.worktreeBranch ?? s.gitBranch ?? ''}:${s.modelName}`).join('|'),
    [sessions]
  );

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (node) lastScrollTopRef.current = node.scrollTop;
    onScrollActivity();
  }, [onScrollActivity]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    const top = lastScrollTopRef.current;
    if (!node || top <= 0) return;
    const frame = requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = top;
    });
    return () => cancelAnimationFrame(frame);
  }, [sessionLayoutKey]);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await window.wmt.forceRefresh();
      onRefresh();
    } catch {
      onRefresh();
    }
    setRefreshing(false);
  }, [refreshing, onRefresh]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, color: C.text, overflow: 'hidden' }}>
      <RenderErrorBoundary label="Header Metrics">
        <HeaderMetrics state={state} onQuit={onQuit} />
      </RenderErrorBoundary>
      <div ref={scrollRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 8, overflowAnchor: 'none' }}>
        {state.historyWarmupPending && (
          <RenderErrorBoundary label="History Warmup Banner">
            <HistoryWarmupBanner historyWarmupStartsAt={state.historyWarmupStartsAt} />
          </RenderErrorBoundary>
        )}
        <RenderErrorBoundary label="Plan Usage Panel">
          <PlanUsagePanel usage={usage} limits={state.limits} settings={settings} apiConnected={state.apiConnected} extraUsage={state.extraUsage} />
        </RenderErrorBoundary>
        <RenderErrorBoundary label="Code Output Card">
          <CodeOutputCard stats={state.codeOutputStats} loading={state.codeOutputLoading} todayCost={usage.todayCost} allTimeCost={allTimeCost} currency={currency} usdToKrw={usdToKrw} />
        </RenderErrorBoundary>
        <RenderErrorBoundary label="Sessions Panel">
          <SessionsPanel sessions={sessions} settings={settings} providerMode={providerMode} />
        </RenderErrorBoundary>
        <RenderErrorBoundary label="Activity Section">
          <ActivitySection usage={usage} currency={currency} usdToKrw={usdToKrw} />
        </RenderErrorBoundary>
        <RenderErrorBoundary label="Model Section">
          <ModelSection models={usage.models} currency={currency} usdToKrw={usdToKrw} />
        </RenderErrorBoundary>
      </div>
      <RenderErrorBoundary label="Bottom Navigation">
        <BottomNav
          lastUpdated={state.lastUpdated}
          refreshing={refreshing}
          syncingHistory={state.historyWarmupPending}
          historyWarmupStartsAt={state.historyWarmupStartsAt}
          onRefresh={handleRefresh}
          onNav={onNav}
        />
      </RenderErrorBoundary>
    </div>
  );
}
