import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelBottom, PictureInPicture2 } from 'lucide-react';
import { AppState, ProviderQuotaSource, ProviderQuotaStatus, SessionInfo } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtTokens, fmtCost, fmtRelative, modelColor, quotaPctBarColor, quotaSourceBadgeToneStyle } from '../theme';
// Plain (non-component) helper functions below call the i18next singleton's `.t()` directly
// (same pattern as limitDisplay.ts), since React hooks cannot be used outside components.
// Memoized call sites that consume their output must include `i18n.language` in their
// dependency array so results recompute after a language switch.
import i18n from '../i18n';
import SessionRow from '../components/SessionRow';
import TokenStatsCard from '../components/TokenStatsCard';
import ActivityChart from '../components/ActivityChart';
import ModelBreakdown from '../components/ModelBreakdown';
import ExtraUsageCard from '../components/ExtraUsageCard';
import CodeOutputCard from '../components/CodeOutputCard';
import TrendCard from '../components/TrendCard';
import RenderErrorBoundary from '../components/RenderErrorBoundary';
import { MainSectionId, normalizeHiddenMainSections, normalizeMainSectionOrder } from '../mainSections';
import { limitDataState, limitSourceDisplay } from '../limitDisplay';
import {
  buildQuotaDisplayModels,
  buildRichCardRows,
  quotaGroupId,
  creditUrgencyBucket,
  formatCreditDuration,
  CreditUrgency,
  QuotaDisplayRichCardViewModel,
  QuotaDisplayGroupViewModel,
  QuotaDisplayRowViewModel,
  ResetCreditsViewModel,
} from '../quotaDisplayModels';

interface Props {
  state: AppState;
  onNav: (view: 'settings' | 'notifications' | 'help') => void;
  onQuit: () => void;
  onRefresh: () => void;
  onScrollActivity: () => void;
  onToggleCompactWidget: () => void;
  onToggleTaskbarQuota: () => void;
}

type NavView = 'settings' | 'notifications' | 'help';
type ProviderId = AppState['settings']['enabledProviders'][number];
type HeaderStatusTone = 'warning' | 'danger';
type HeaderStatus = { label: string; title: string; tone: HeaderStatusTone };
const RESET_CREDITS_TOOLTIP_ID = 'codex-reset-credits-tooltip';
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
function formatRefreshAge(lastUpdated: number): string {
  if (!lastUpdated) return i18n.t('mainView.refresh.label');
  const elapsed = Math.round((Date.now() - lastUpdated) / 1000);
  if (elapsed < 5) return i18n.t('mainView.refresh.justNow');
  // Named "n" rather than "count" so i18next does not treat this as a pluralizable key —
  // these are compact "5s/5m/5h ago" unit labels, not grammatically pluralized phrases.
  if (elapsed < 60) return i18n.t('mainView.refresh.secondsAgo', { n: elapsed });
  if (elapsed < 3600) return i18n.t('mainView.refresh.minutesAgo', { n: Math.floor(elapsed / 60) });
  return i18n.t('mainView.refresh.hoursAgo', { n: Math.floor(elapsed / 3600) });
}

function formatRefreshLabel(lastUpdated: number, stateFreshness: AppState['stateFreshness']): string {
  const age = formatRefreshAge(lastUpdated);
  if (stateFreshness === 'restored' && lastUpdated) return i18n.t('mainView.refresh.lastRun', { age });
  return age;
}

function formatWarmupEta(historyWarmupStartsAt: number | null): string {
  if (!historyWarmupStartsAt) return i18n.t('mainView.warmup.queued');
  const remainingMs = Math.max(0, historyWarmupStartsAt - Date.now());
  if (remainingMs === 0) return i18n.t('mainView.warmup.syncing');
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return i18n.t('mainView.warmup.inMinutesSeconds', { minutes, seconds });
  return i18n.t('mainView.warmup.inSeconds', { seconds });
}

function formatWarmupStatus(historyWarmupStartsAt: number | null): string {
  const etaLabel = formatWarmupEta(historyWarmupStartsAt);
  if (etaLabel === i18n.t('mainView.warmup.queued')) return i18n.t('mainView.warmup.statusQueued');
  if (etaLabel === i18n.t('mainView.warmup.syncing')) return i18n.t('mainView.warmup.statusSyncing');
  return i18n.t('mainView.warmup.statusStarts', { eta: etaLabel });
}

function cacheMetricColor(value: number, C: ReturnType<typeof useTheme>): string {
  if (value >= 80) return C.active;
  if (value >= 60) return C.barYellow;
  return C.barRed;
}

function providerLabel(provider: ProviderId): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'antigravity') return 'Antigravity';
  return 'Claude';
}

function cacheMetricTitle(enabledProviders: readonly ProviderId[]): string {
  if (enabledProviders.length === 1) {
    const provider = enabledProviders[0];
    if (provider === 'codex' || provider === 'antigravity') return i18n.t('mainView.cacheMetric.singleSimple', { provider: providerLabel(provider) });
    return i18n.t('mainView.cacheMetric.singleClaude', { provider: providerLabel(provider) });
  }
  return i18n.t('mainView.cacheMetric.combined');
}

function sessionProviderLabel(provider: SessionInfo['provider']): string {
  return providerLabel(provider);
}

function sessionProviderBadgeColors(provider: SessionInfo['provider'], C: ReturnType<typeof useTheme>): { background: string; color: string } {
  if (provider === 'codex') return { background: C.output + '16', color: C.output };
  if (provider === 'antigravity') return { background: C.input + '16', color: C.input };
  return { background: C.accentDim, color: C.textMuted };
}

function emptySessionLabel(enabledProviders: readonly ProviderId[]): string {
  const enabled = new Set(enabledProviders);
  const labels = [
    enabled.has('claude') ? 'Claude Code' : null,
    enabled.has('codex') ? 'Codex' : null,
    enabled.has('antigravity') ? 'Antigravity' : null,
  ].filter((label): label is string => !!label);
  // Japanese uses "、" list separators and "または" for "or" instead of ", "/"or" — pick the
  // separator here rather than hardcoding an English-shaped join inside the translated string.
  const listSeparator = i18n.language.startsWith('ja') ? '、' : ', ';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return i18n.t('mainView.sessions.providersTwo', { a: labels[0], b: labels[1] });
  if (labels.length > 2) return i18n.t('mainView.sessions.providersList', { list: labels.slice(0, -1).join(listSeparator), last: labels[labels.length - 1] });
  return i18n.t('mainView.sessions.enabledProviderFallback');
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
    fontSize: 10,
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

function headerIconButtonStyle(
  active: boolean,
  C: ReturnType<typeof useTheme>,
): React.CSSProperties {
  return {
    ...noDrag,
    width: 24,
    height: 20,
    padding: 0,
    borderRadius: 5,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    flexShrink: 0,
    lineHeight: 1,
    color: active ? C.active : C.headerSub,
    background: active ? `${C.active}16` : 'none',
    border: active ? `1px solid ${C.active}40` : '1px solid transparent',
  };
}

function buildClaudeHeaderStatus(args: {
  showClaudeUsage: boolean;
  hasClaudeFallback: boolean;
  apiConnected: boolean;
  apiStatusLabel?: string;
  apiError?: string;
}): HeaderStatus | null {
  const { showClaudeUsage, hasClaudeFallback, apiConnected, apiStatusLabel, apiError } = args;
  if (!showClaudeUsage) return null;

  if (hasClaudeFallback) {
    return {
      label: i18n.t('mainView.status.claude.localLabel'),
      title: i18n.t('mainView.status.claude.localTitle', {
        status: apiStatusLabel || i18n.t('mainView.status.provider.unavailable'),
        errorSuffix: apiError ? ` - ${apiError}` : '',
      }),
      tone: 'warning',
    };
  }

  switch (apiStatusLabel) {
    case 'rate limited':
      return { label: i18n.t('mainView.status.claude.limitedLabel'), title: apiError || i18n.t('mainView.status.claude.limitedTitleDefault'), tone: 'warning' };
    case 'refresh limited':
      return { label: i18n.t('mainView.status.claude.refreshLabel'), title: apiError || i18n.t('mainView.status.claude.refreshLimitedTitleDefault'), tone: 'warning' };
    case 'refresh failed':
      return { label: i18n.t('mainView.status.claude.refreshLabel'), title: apiError || i18n.t('mainView.status.claude.refreshFailedTitleDefault'), tone: 'danger' };
    case 'schema changed':
      return { label: i18n.t('mainView.status.claude.schemaLabel'), title: apiError || i18n.t('mainView.status.claude.schemaTitleDefault'), tone: 'danger' };
    case 'reset partial':
      return { label: i18n.t('mainView.status.claude.partialLabel'), title: apiError || i18n.t('mainView.status.claude.partialTitleDefault'), tone: 'warning' };
    case 'local only':
      return { label: i18n.t('mainView.status.claude.localLabel'), title: apiError || i18n.t('mainView.status.claude.localOnlyTitleDefault'), tone: 'warning' };
    case 'auth failed':
      return { label: i18n.t('mainView.status.claude.authLabel'), title: apiError || i18n.t('mainView.status.claude.authTitleDefault'), tone: 'danger' };
    case 'login required':
      return { label: i18n.t('mainView.status.claude.loginLabel'), title: apiError || i18n.t('mainView.status.claude.loginTitleDefault'), tone: 'danger' };
    case 'forbidden':
      return { label: i18n.t('mainView.status.claude.blockedLabel'), title: apiError || i18n.t('mainView.status.claude.blockedTitleDefault'), tone: 'danger' };
    case 'api disconnected':
      return { label: i18n.t('mainView.status.claude.offlineLabel'), title: apiError || i18n.t('mainView.status.claude.offlineTitleDefault'), tone: 'danger' };
    default:
      break;
  }

  if (!apiConnected) {
    return {
      label: i18n.t('mainView.status.claude.offlineLabel'),
      title: apiError || i18n.t('mainView.status.claude.offlineTitleDefault'),
      tone: 'danger',
    };
  }

  return null;
}

function buildCodexHeaderStatus(args: {
  showCodexUsage: boolean;
  hasCodexFallback: boolean;
  codexUsageConnected: boolean;
  codexStatusLabel?: string;
  codexError?: string;
  codexFallbackSource?: ProviderQuotaSource;
}): HeaderStatus | null {
  const {
    showCodexUsage,
    hasCodexFallback,
    codexUsageConnected,
    codexStatusLabel,
    codexError,
    codexFallbackSource,
  } = args;
  if (!showCodexUsage) return null;

  switch (codexStatusLabel) {
    case 'rate limited':
      return { label: i18n.t('mainView.status.codex.limitedLabel'), title: codexError || i18n.t('mainView.status.codex.limitedTitleDefault'), tone: 'warning' };
    case 'schema changed':
      return { label: i18n.t('mainView.status.codex.schemaLabel'), title: codexError || i18n.t('mainView.status.codex.schemaTitleDefault'), tone: 'danger' };
    case 'unsupported endpoint':
      return { label: i18n.t('mainView.status.codex.endpointLabel'), title: codexError || i18n.t('mainView.status.codex.endpointTitleDefault'), tone: 'warning' };
    case 'local log':
      return { label: i18n.t('mainView.status.codex.localLabel'), title: codexError || i18n.t('mainView.status.codex.localTitleDefault'), tone: 'warning' };
    case 'auth failed':
      return { label: i18n.t('mainView.status.codex.authLabel'), title: codexError || i18n.t('mainView.status.codex.authTitleDefault'), tone: 'danger' };
    case 'forbidden':
      return { label: i18n.t('mainView.status.codex.blockedLabel'), title: codexError || i18n.t('mainView.status.codex.blockedTitleDefault'), tone: 'danger' };
    case 'api timeout':
      return { label: i18n.t('mainView.status.codex.timeoutLabel'), title: codexError || i18n.t('mainView.status.codex.timeoutTitleDefault'), tone: 'warning' };
    case 'api disconnected':
      return { label: i18n.t('mainView.status.codex.offlineLabel'), title: codexError || i18n.t('mainView.status.codex.offlineTitleDefault'), tone: 'danger' };
    default:
      break;
  }

  if (hasCodexFallback) {
    const label = codexFallbackSource === 'cache' ? i18n.t('mainView.status.codex.cacheLabel') : i18n.t('mainView.status.codex.logLabel');
    const source = codexFallbackSource === 'cache' ? i18n.t('mainView.status.codex.fallbackSourceCache') : i18n.t('mainView.status.codex.fallbackSourceLog');
    return {
      label,
      title: i18n.t('mainView.status.codex.fallbackTitle', { source }),
      tone: 'warning',
    };
  }

  if (!codexUsageConnected && codexStatusLabel) {
    return {
      label: i18n.t('mainView.status.codex.offlineLabel'),
      title: codexError || i18n.t('mainView.status.codex.offlineNoDetail'),
      tone: 'danger',
    };
  }

  return null;
}

function buildProviderQuotaHeaderStatus(
  provider: ProviderId,
  status: ProviderQuotaStatus | undefined,
): HeaderStatus | null {
  if (!status || status.connected || status.severity === 'ok') return null;
  const label = providerLabel(provider);
  const statusLabel = status.label || status.code || i18n.t('mainView.status.provider.unavailable');
  const compactLabel = status.code === 'not-running'
    ? (provider === 'antigravity' ? i18n.t('mainView.status.provider.startAntigravity') : i18n.t('mainView.status.provider.offCompact', { label }))
    : status.code === 'unavailable'
      ? i18n.t('mainView.status.provider.offlineCompact', { label })
      : i18n.t('mainView.status.provider.genericCompact', { label, status: statusLabel });
  return {
    label: compactLabel,
    title: status.detail || i18n.t('mainView.status.provider.genericTitle', { label, status: statusLabel }),
    tone: status.severity === 'danger' ? 'danger' : 'warning',
  };
}

function buildHeaderStatus(args: {
  enabledProviders: readonly ProviderId[];
  providerQuotas: AppState['providerQuotas'];
  showClaudeUsage: boolean;
  showCodexUsage: boolean;
  hasClaudeFallback: boolean;
  hasCodexFallback: boolean;
  apiConnected: boolean;
  apiStatusLabel?: string;
  apiError?: string;
  codexUsageConnected: boolean;
  codexStatusLabel?: string;
  codexError?: string;
  codexFallbackSource?: ProviderQuotaSource;
}): HeaderStatus | null {
  const claudeStatus = buildClaudeHeaderStatus(args);
  const codexStatus = buildCodexHeaderStatus(args);
  const statuses = [
    claudeStatus,
    codexStatus,
    ...args.enabledProviders
      .filter(provider => !((provider === 'claude' && claudeStatus) || (provider === 'codex' && codexStatus)))
      .map(provider => buildProviderQuotaHeaderStatus(provider, args.providerQuotas[provider]?.status)),
  ].filter((status): status is HeaderStatus => !!status);
  return statuses.find(status => status.tone === 'danger') ?? statuses[0] ?? null;
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
  stateFreshness,
}: {
  lastUpdated: number;
  refreshing: boolean;
  syncingHistory: boolean;
  historyWarmupStartsAt: number | null;
  stateFreshness: AppState['stateFreshness'];
}) {
  const { t, i18n: i18nInstance } = useTranslation();
  const [label, setLabel] = useState(() => syncingHistory ? formatWarmupEta(historyWarmupStartsAt) : formatRefreshLabel(lastUpdated, stateFreshness));

  useEffect(() => {
    if (refreshing) {
      setLabel(t('mainView.refresh.refreshing'));
      return;
    }
    if (syncingHistory) {
      setLabel(t('mainView.refresh.scan', { eta: formatWarmupEta(historyWarmupStartsAt) }));
      const timer = setInterval(() => setLabel(t('mainView.refresh.scan', { eta: formatWarmupEta(historyWarmupStartsAt) })), 1000);
      return () => clearInterval(timer);
    }
    setLabel(formatRefreshLabel(lastUpdated, stateFreshness));
    const timer = setInterval(() => setLabel(formatRefreshLabel(lastUpdated, stateFreshness)), 1000);
    return () => clearInterval(timer);
    // i18nInstance.language is included so this re-runs (and picks up freshly translated
    // strings) immediately after a language switch, instead of waiting for the next tick.
  }, [historyWarmupStartsAt, lastUpdated, refreshing, stateFreshness, syncingHistory, t, i18nInstance.language]);

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

const HeaderMetrics = React.memo(function HeaderMetrics({
  state,
  onQuit,
  onToggleCompactWidget,
  onToggleTaskbarQuota,
}: {
  state: AppState;
  onQuit: () => void;
  onToggleCompactWidget: () => void;
  onToggleTaskbarQuota: () => void;
}) {
  const C = useTheme();
  const { t, i18n: i18nInstance } = useTranslation();
  const {
    sessions,
    usage,
    settings,
    apiConnected,
    apiError,
    apiStatusLabel,
    codexUsageConnected,
    codexError,
    codexStatusLabel,
  } = state;
  const { currency, usdToKrw } = settings;
  const compactWidgetEnabled = settings.compactWidgetEnabled === true;
  const taskbarQuotaEnabled = settings.taskbarQuotaEnabled === true;
  const enabledProviderList = settings.enabledProviders;
  const enabledProviders = new Set(enabledProviderList);
  const showClaudeUsage = enabledProviders.has('claude');
  const showCodexUsage = enabledProviders.has('codex');
  const claudeQuota = state.providerQuotas.claude;
  const codexQuota = state.providerQuotas.codex;
  const claudeStatus = claudeQuota?.status;
  const resolvedApiConnected = claudeStatus?.connected ?? apiConnected;
  const resolvedApiStatusLabel = claudeStatus?.label ?? apiStatusLabel;
  const resolvedApiError = claudeStatus?.detail ?? apiError;
  const hasClaudeFallback = showClaudeUsage && Object.values(claudeQuota?.windows ?? {}).some(window => window.source === 'statusLine');
  const codexFallbackWindows = Object.values(codexQuota?.windows ?? {}).filter(window => window.source === 'localLog' || window.source === 'cache');
  const hasCodexFallback = showCodexUsage && codexFallbackWindows.length > 0;
  const codexFallbackSource = codexFallbackWindows.some(window => window.source === 'cache') ? 'cache' : (codexFallbackWindows[0]?.source as ProviderQuotaSource | undefined);
  const [period, setPeriod] = useState<'today' | 'all'>('today');
  const headerStatus = useMemo(() => buildHeaderStatus({
    enabledProviders: enabledProviderList,
    providerQuotas: state.providerQuotas,
    showClaudeUsage,
    showCodexUsage,
    hasClaudeFallback,
    hasCodexFallback,
    apiConnected: resolvedApiConnected,
    apiStatusLabel: resolvedApiStatusLabel,
    apiError: resolvedApiError,
    codexUsageConnected,
    codexStatusLabel,
    codexError,
    codexFallbackSource,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- i18nInstance.language forces
    // recomputation of the translated label/title strings built by buildHeaderStatus after a
    // language switch, since that helper reads the i18next singleton directly.
  }), [resolvedApiConnected, resolvedApiError, resolvedApiStatusLabel, codexError, codexFallbackSource, codexStatusLabel, codexUsageConnected, enabledProviderList, hasClaudeFallback, hasCodexFallback, showClaudeUsage, showCodexUsage, state.providerQuotas, i18nInstance.language]);

  const isAll = period === 'all';
  const cost = isAll ? usage.allTimeCost : usage.todayCost;
  const calls = isAll ? usage.allTimeRequestCount : usage.todayRequestCount;
  const sessionCount = isAll ? state.allTimeSessions : sessions.length;
  const cacheEff = isAll ? usage.allTimeAvgCacheEfficiency : usage.todayCacheEfficiency;
  const saved = isAll ? usage.allTimeSavedUSD : usage.todayCacheSavingsUSD;
  const cacheColor = cacheMetricColor(cacheEff, C);
  const cacheTitle = cacheMetricTitle(enabledProviderList);
  const planLabel = showClaudeUsage ? (claudeQuota?.planName || claudeQuota?.accountLabel) : undefined;
  const codexTierLabel = showCodexUsage
    ? (codexQuota?.planName || codexQuota?.accountLabel || formatCodexServiceTier(state.codexAccount.serviceTier))
    : null;
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
        <span style={{ fontSize: 8, color: C.headerSub, opacity: 0.42, flexShrink: 0, whiteSpace: 'nowrap', marginLeft: -3 }}>
          by jeongwookie
        </span>
        <div style={{ ...noDrag, display: 'inline-flex', gap: 3, marginLeft: 4, flexShrink: 0 }}>
          {(['today', 'all'] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={headerPeriodButtonStyle(period === p, C)}>
              {p === 'today' ? t('mainView.header.periodToday') : t('mainView.header.periodAll')}
            </button>
          ))}
        </div>
        <div style={{ ...noDrag, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          {headerStatus && (
            <span
              title={headerStatus.title}
              style={{
                fontSize: 10,
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
          <button
            type="button"
            onClick={onToggleCompactWidget}
            aria-label={compactWidgetEnabled ? t('mainView.header.hideCompactWidget') : t('mainView.header.showCompactWidget')}
            aria-pressed={compactWidgetEnabled}
            title={compactWidgetEnabled ? t('mainView.header.hideCompactWidget') : t('mainView.header.showCompactWidget')}
            style={headerIconButtonStyle(compactWidgetEnabled, C)}
          >
            <PictureInPicture2 size={13} strokeWidth={2.1} aria-hidden="true" />
            {compactWidgetEnabled && (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: 3,
                  right: 3,
                  width: 4,
                  height: 4,
                  borderRadius: 999,
                  background: C.active,
                  boxShadow: `0 0 0 2px ${C.headerBg}`,
                }}
              />
            )}
          </button>
          <button
            type="button"
            onClick={onToggleTaskbarQuota}
            aria-label={taskbarQuotaEnabled ? t('mainView.header.hideTaskbarQuota') : t('mainView.header.showTaskbarQuota')}
            aria-pressed={taskbarQuotaEnabled}
            title={taskbarQuotaEnabled ? t('mainView.header.hideTaskbarQuota') : t('mainView.header.showTaskbarQuota')}
            style={headerIconButtonStyle(taskbarQuotaEnabled, C)}
          >
            <PanelBottom size={13} strokeWidth={2.1} aria-hidden="true" />
            {taskbarQuotaEnabled && (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: 3,
                  right: 3,
                  width: 4,
                  height: 4,
                  borderRadius: 999,
                  background: C.active,
                  boxShadow: `0 0 0 2px ${C.headerBg}`,
                }}
              />
            )}
          </button>
          <div style={{ width: 1, height: 14, background: C.headerBorder, flexShrink: 0 }} />
          <button onClick={() => window.wmt.minimize().catch(() => {})} title={t('mainView.header.minimize')} style={{ ...noDrag, width: 24, height: 20, background: 'none', border: 'none', color: C.headerSub, cursor: 'pointer', fontSize: 16, borderRadius: 4, lineHeight: 1, fontWeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>-</button>
          <button onClick={onQuit} title={t('mainView.header.quit')} style={{ ...noDrag, width: 24, height: 20, background: 'none', border: 'none', color: C.headerSub, cursor: 'pointer', fontSize: 14, borderRadius: 4, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>x</button>
        </div>
      </div>

      <div style={{ ...drag, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 14, padding: '4px 14px 10px', alignItems: 'end', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginBottom: 3 }}>
            <div style={{ fontSize: 9, color: C.headerSub, textTransform: 'uppercase', letterSpacing: 1.1, whiteSpace: 'nowrap' }}>
              {isAll ? t('mainView.header.allTimeCost') : t('mainView.header.todayCost')}
            </div>
          </div>
          {(planLabel || codexTierLabel) && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', minWidth: 0, marginBottom: 6 }}>
              {planLabel && (
                <div title={t('mainView.header.claudePlanTooltip', { plan: planLabel })} style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  <span style={{
                    fontSize: 9,
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
                  <span style={{ fontSize: 10, color: C.headerSub, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}>
                    {planLabel}
                  </span>
                </div>
              )}
              {codexTierLabel && (
                <div title={t('mainView.header.codexTierTooltip', { tier: codexTierLabel })} style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  <span style={{
                    fontSize: 9,
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
                  <span style={{ fontSize: 10, color: C.headerSub, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}>
                    {codexTierLabel}
                  </span>
                </div>
              )}
            </div>
          )}
          <div style={{ fontSize: 28, fontWeight: 800, color: C.headerText, lineHeight: 1, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}>
            {fmtCost(cost, currency, usdToKrw)}
          </div>
          <div style={{ fontSize: 11, color: C.headerSub, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ fontFamily: C.fontMono, fontWeight: 700, color: C.headerText }}>{fmtTokens(calls)}</span> {t('mainView.header.calls')}
            <span style={{ margin: '0 6px', color: C.textMuted }}>/</span>
            <span style={{ fontFamily: C.fontMono, fontWeight: 700, color: C.headerText }}>{sessionCount}</span> {t('mainView.header.sessions')}
          </div>
        </div>
        <div style={{ textAlign: 'right', minWidth: 0 }} title={cacheTitle}>
          <div style={{ fontSize: 9, color: C.headerSub, textTransform: 'uppercase', letterSpacing: 1.1, marginBottom: 3, whiteSpace: 'nowrap' }}>
            {isAll ? t('mainView.header.avgCacheEfficiency') : t('mainView.header.cacheEfficiency')}
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, color: cacheColor, lineHeight: 1, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}>
            {Math.round(cacheEff)}%
          </div>
          <div style={{ fontSize: 11, color: cacheColor, marginTop: 4, whiteSpace: 'nowrap' }}>
            {isAll
              ? t('mainView.header.savedTotal', { saved: fmtCost(saved, currency, usdToKrw) })
              : t('mainView.header.savedToday', { saved: fmtCost(saved, currency, usdToKrw) })}
          </div>
        </div>
      </div>

    </div>
  );
});

function formatSimplePct(pct: number | null): string {
  if (pct == null) return '--';
  if (!Number.isFinite(pct) || pct <= 0) return '0%';
  if (pct < 1) return '<1%';
  if (pct < 10) return `${Math.round(pct * 10) / 10}%`;
  return `${Math.round(pct)}%`;
}

function clampSimplePct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function simpleTimeElapsedPct(durationMs: number | null | undefined, resetMs: number | null): number | null {
  if (!durationMs || resetMs == null || resetMs < 0 || resetMs > durationMs) return null;
  return clampSimplePct(((durationMs - resetMs) / durationMs) * 100);
}

function formatSimpleReset(resetMs: number | null, resetLabel?: string): string {
  if (resetLabel) return resetLabel;
  if (resetMs == null || resetMs <= 0) return i18n.t('mainView.quota.waitingReset');
  const totalMinutes = Math.max(1, Math.round(resetMs / 60000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) return `${Math.round(hours / 24)}d`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function SimpleQuotaRow({ row }: { row: QuotaDisplayRowViewModel }) {
  const C = useTheme();
  const { t } = useTranslation();
  const source = limitSourceDisplay(row.quota);
  const dataState = limitDataState(row.quota, row.pending);
  const isUnlimited = row.quota.limitState === 'unlimited';
  const isUnreported = row.quota.limitState === 'unreported';
  const noCapState = isUnlimited || isUnreported;
  const percentOnly = row.visualKind === 'percentOnly';
  const quota = clampSimplePct(row.quotaPct);
  const elapsed = !noCapState && !row.pending && dataState === 'ready' && !percentOnly
    ? simpleTimeElapsedPct(row.durationMs, row.resetMs)
    : null;
  const quotaColor = noCapState
    ? C.accent
    : row.pending
    ? C.accent
    : dataState === 'waiting'
      ? C.textMuted
      : quotaPctBarColor(quota, C);
  const paceColor = (elapsed != null && elapsed >= 5 && quota > 0)
    ? (quota / elapsed > 1.5 ? C.barRed : quota / elapsed > 1.0 ? C.barYellow : quotaColor)
    : quotaColor;
  const trackColor = C.bgCard === '#ffffff' ? '#e7e9f2' : '#131d30';
  const elapsedColor = C.bgCard === '#ffffff' ? '#cbd5e1' : '#334155';
  const noCapTitleKey = isUnlimited ? 'tokenStatsCard.unlimitedTooltip' : 'tokenStatsCard.unreportedTooltip';
  const noCapResetKey = isUnlimited ? 'mainView.quota.unlimitedReset' : 'mainView.quota.unreportedReset';
  const noCapLabelKey = isUnlimited ? 'mainView.quota.unlimitedLabel' : 'mainView.quota.unreportedLabel';
  return (
    <div
      title={noCapState ? t(noCapTitleKey) : row.pending ? row.pendingTitle : source.title}
      style={{
        display: 'grid',
        gridTemplateColumns: percentOnly
          ? '24px minmax(0, 1fr) 64px'
          : '24px minmax(0, 1fr) 38px 64px',
        alignItems: 'center',
        gap: 6,
        padding: '3px 0',
      }}
    >
      <span style={{ color: C.textMuted, fontSize: 10, fontFamily: C.fontMono, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {row.label}
      </span>
      <div style={{ position: 'relative', height: 8, background: trackColor, borderRadius: 4, overflow: 'hidden' }}>
        {!percentOnly && elapsed != null && (
          <div
            style={{
              position: 'absolute',
              inset: '0 auto 0 0',
              width: `${elapsed}%`,
              background: elapsedColor,
              borderRadius: 4,
            }}
          />
        )}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 2,
            width: `${noCapState ? 100 : row.pending ? 0 : quota}%`,
            height: 4,
            background: quotaColor,
            borderRadius: 3,
            opacity: noCapState ? 0.62 : row.pending ? 0.35 : 0.9,
            boxShadow: `0 0 4px ${quotaColor}44`,
          }}
        />
      </div>
      {!percentOnly && (
        <span style={{ color: C.textMuted, fontSize: 9, fontFamily: C.fontMono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'right' }}>
          {noCapState ? t(noCapResetKey) : row.pending ? t('mainView.quota.syncingLabel') : formatSimpleReset(row.resetMs, row.resetLabel)}
        </span>
      )}
      <span
        title={percentOnly ? t('mainView.quota.usedTooltip') : t('mainView.quota.usedElapsedTooltip')}
        style={{ color: C.textDim, fontSize: 10, fontFamily: C.fontMono, whiteSpace: 'nowrap', textAlign: 'right', minWidth: 42 }}
      >
        {noCapState ? (
          <span style={{ color: paceColor, fontSize: 12, fontWeight: 800 }}>{t(noCapLabelKey)}</span>
        ) : row.pending ? (
          <span style={{ color: C.textMuted }}>...</span>
        ) : percentOnly ? (
          <span style={{ color: paceColor, fontSize: 12, fontWeight: 800 }}>{formatSimplePct(quota)}</span>
        ) : (
          <>
            <span style={{ color: paceColor, fontSize: 12, fontWeight: 800 }}>{formatSimplePct(quota)}</span>
            <span style={{ color: C.textMuted }}> / </span>
            <span>{formatSimplePct(elapsed)}</span>
          </>
        )}
      </span>
    </div>
  );
}

function SimpleQuotaGroupBlock({ group }: { group: QuotaDisplayGroupViewModel }) {
  const C = useTheme();
  const { t } = useTranslation();
  const tokenRows = group.rows.filter(row => row.stats.totalTokens > 0);
  const tokenBadge = tokenRows.length === 0
    ? null
    : {
      value: tokenRows.length === 1
        ? tokenRows[0].stats.totalTokens
        : tokenRows.reduce((max, row) => Math.max(max, row.stats.totalTokens), 0),
      title: tokenRows.length === 1
        ? t('mainView.quota.tokenBadgeSingle')
        : t('mainView.quota.tokenBadgeMulti'),
    };
  return (
    <div style={{ padding: '6px 12px', borderTop: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, minWidth: 0 }}>
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 10,
            color: C.textMuted,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 1,
          }}
        >
          {group.label}
        </span>
        {(group.badges.length > 0 || tokenBadge) && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }}>
            {group.badges.map(badge => (
              <span
                key={badge.key}
                title={badge.title}
                style={{
                  ...quotaSourceBadgeToneStyle(badge.tone, C),
                  borderRadius: 3,
                  padding: '1px 4px',
                  fontSize: 9,
                  fontWeight: 700,
                  fontFamily: C.fontMono,
                  whiteSpace: 'nowrap',
                }}
              >
                {badge.label}
              </span>
            ))}
            {tokenBadge && (
              <span
                title={tokenBadge.title}
                style={{
                  background: C.bgRow,
                  color: C.textDim,
                  border: `1px solid ${C.border}`,
                  borderRadius: 3,
                  padding: '1px 4px',
                  fontSize: 9,
                  fontWeight: 700,
                  fontFamily: C.fontMono,
                  whiteSpace: 'nowrap',
                }}
              >
                {t('mainView.quota.tokenBadgeSuffix', { tokens: fmtTokens(tokenBadge.value) })}
              </span>
            )}
          </span>
        )}
      </div>
      <div style={{ display: 'grid', gap: 0 }}>
        {group.rows.map(row => <SimpleQuotaRow key={row.key} row={row} />)}
      </div>
    </div>
  );
}

function urgencyColor(urgency: CreditUrgency, C: ReturnType<typeof useTheme>): string {
  if (urgency === 'ok') return C.barGreen;
  if (urgency === 'warn') return C.waiting;
  if (urgency === 'red') return C.barRed;
  return C.textMuted;
}

function resetSourceBadge(vm: ResetCreditsViewModel, C: ReturnType<typeof useTheme>) {
  const isApi = vm.source === 'api';
  const isUsageCount = vm.source === 'usage';
  const degraded = vm.stale || vm.errored || vm.status.code !== 'ok';
  const warningColor = C.bgCard === '#ffffff' ? '#6f3d00' : C.waiting;
  const color = degraded ? warningColor : isUsageCount ? C.accent : isApi ? C.accent : C.barGreen;
  const label = vm.errored
    ? i18n.t('mainView.resetCredits.badge.error')
    : vm.status.code === 'rate-limited'
      ? i18n.t('mainView.resetCredits.badge.limited')
      : degraded
        ? i18n.t('mainView.resetCredits.badge.stale')
        : vm.countOnly
          ? (isUsageCount ? i18n.t('mainView.resetCredits.badge.usage') : i18n.t('mainView.resetCredits.badge.partial'))
          : (isApi ? i18n.t('mainView.resetCredits.badge.api') : i18n.t('mainView.resetCredits.badge.cache'));
  const sourceDesc = isApi ? i18n.t('mainView.resetCredits.badge.fromApi') : i18n.t('mainView.resetCredits.badge.fromCache');
  return {
    label,
    title: vm.countOnly && !vm.errored
      ? (isUsageCount ? i18n.t('mainView.resetCredits.badge.usageOnlyTitle') : i18n.t('mainView.resetCredits.badge.partialOnlyTitle'))
      : degraded
      ? i18n.t('mainView.resetCredits.badge.degradedTitle', { sourceDesc, code: vm.status.code })
      : i18n.t('mainView.resetCredits.badge.okTitle', { sourceDesc }),
    style: {
      background: degraded && C.bgCard === '#ffffff' ? '#fff3cf' : `${color}18`,
      color,
      border: `1px solid ${color}55`,
    },
  };
}

type ResetTooltipAnchor = { left: number; top: number; width: number };
type ResetCreditsTooltipProps = {
  vm: ResetCreditsViewModel;
  visible?: boolean;
  anchor?: ResetTooltipAnchor | null;
  onHoverChange?: (visible: boolean) => void;
};

function resetTooltipAnchorFromElement(trigger: HTMLElement, frame: HTMLElement | null): ResetTooltipAnchor {
  const rect = trigger.getBoundingClientRect();
  const container = frame?.getBoundingClientRect();
  return {
    left: container?.left ?? rect.left,
    top: rect.bottom,
    width: container?.width ?? rect.width,
  };
}

function resetTooltipAnchorFromEvent(event: React.MouseEvent<HTMLElement>, frame: HTMLElement | null): ResetTooltipAnchor {
  return { ...resetTooltipAnchorFromElement(event.currentTarget, frame), top: event.clientY };
}

function resetStatusSummary(status: ProviderQuotaStatus): string {
  if (status.label === 'unsupported endpoint') return i18n.t('mainView.resetCredits.status.unsupported');
  switch (status.code) {
    case 'no-credentials': return i18n.t('mainView.resetCredits.status.loginRequired');
    case 'unauthorized': return i18n.t('mainView.resetCredits.status.loginExpired');
    case 'forbidden': return i18n.t('mainView.resetCredits.status.accessDenied');
    case 'rate-limited': return i18n.t('mainView.resetCredits.status.limited');
    case 'schema-changed': return i18n.t('mainView.resetCredits.status.changed');
    case 'timeout':
    case 'network':
    case 'http-error':
      return i18n.t('mainView.resetCredits.status.offline');
    default:
      return i18n.t('mainView.resetCredits.status.unavailable');
  }
}

function useResetTooltipTrigger<T extends HTMLElement>(frameRef: React.RefObject<T | null>) {
  const [hovered, setHovered] = useState(false);
  const [anchor, setAnchor] = useState<ResetTooltipAnchor | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current == null || typeof window === 'undefined') return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    if (typeof window === 'undefined') {
      setHovered(false);
      return;
    }
    closeTimerRef.current = window.setTimeout(() => {
      setHovered(false);
      closeTimerRef.current = null;
    }, 80);
  }, [clearCloseTimer]);
  const showTooltip = useCallback((event: React.MouseEvent<HTMLElement>) => {
    clearCloseTimer();
    setAnchor(resetTooltipAnchorFromEvent(event, frameRef.current));
    setHovered(true);
  }, [clearCloseTimer, frameRef]);
  const showTooltipFromFocus = useCallback((event: React.FocusEvent<HTMLElement>) => {
    clearCloseTimer();
    setAnchor(resetTooltipAnchorFromElement(event.currentTarget, frameRef.current));
    setHovered(true);
  }, [clearCloseTimer, frameRef]);
  const handleTooltipHover = useCallback((visible: boolean) => {
    if (visible) {
      clearCloseTimer();
      setHovered(true);
    } else {
      scheduleClose();
    }
  }, [clearCloseTimer, scheduleClose]);
  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  return {
    hovered,
    anchor,
    handleTooltipHover,
    tooltipHandlers: {
      onMouseEnter: showTooltip,
      onMouseMove: showTooltip,
      onMouseLeave: scheduleClose,
      onFocus: showTooltipFromFocus,
      onBlur: scheduleClose,
      onClick: showTooltip,
    },
  };
}

export function ResetCreditsTooltip({ vm, visible = false, anchor = null, onHoverChange }: ResetCreditsTooltipProps) {
  const C = useTheme();
  const { t } = useTranslation();
  const updated = new Date(vm.checkedAt);
  const updatedLabel = Number.isFinite(updated.getTime()) ? updated.toLocaleString() : t('mainView.resetCredits.tooltip.unknown');
  const nextExpiryLabel = vm.countOnly ? t('mainView.resetCredits.tooltip.listUnavailable') : vm.nextExpiryMs == null ? '-' : formatCreditDuration(vm.nextExpiryMs);
  const sourceColor = vm.status.code !== 'ok' || vm.stale ? C.waiting : vm.source === 'api' ? C.accent : C.barGreen;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 0;
  const anchoredTop = anchor
    ? Math.min(Math.max(6, anchor.top + 12), Math.max(6, viewportH - 108))
    : 0;
  const positionStyle: React.CSSProperties = anchor
    ? { position: 'fixed', left: anchor.left, width: anchor.width, top: anchoredTop, maxHeight: Math.max(96, viewportH - anchoredTop - 8), overflowY: 'auto' }
    : { position: 'absolute', left: 12, right: 12, top: 'calc(100% + 6px)' };
  const shellStyle: React.CSSProperties = {
    ...positionStyle,
    zIndex: 40,
    opacity: visible ? 1 : 0,
    visibility: visible ? 'visible' : 'hidden',
    pointerEvents: visible ? 'auto' : 'none',
    transition: 'opacity 0.12s ease',
    background: C.bgRow,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 11,
    color: C.textDim,
    fontFamily: C.fontMono,
    boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
  };
  const hoverHandlers = {
    onMouseEnter: () => onHoverChange?.(true),
    onMouseLeave: () => onHoverChange?.(false),
    onFocus: () => onHoverChange?.(true),
    onBlur: () => onHoverChange?.(false),
  };
  if (vm.errored) {
    return (
      <div id={RESET_CREDITS_TOOLTIP_ID} role="tooltip" tabIndex={visible ? 0 : -1} aria-hidden={!visible} data-testid="reset-tooltip" style={shellStyle} {...hoverHandlers}>
        <div style={{ fontWeight: 800, color: C.text, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 7 }}>
          {t('mainView.resetCredits.heading')}
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <div>{t('mainView.resetCredits.tooltip.statusLabel')} <b style={{ color: C.text }}>{vm.status.code}</b> · {resetStatusSummary(vm.status)}</div>
          {vm.status.detail && <div>{vm.status.detail}</div>}
          <div>{t('mainView.resetCredits.tooltip.lastUpdate')} <b style={{ color: C.text }}>{updatedLabel}</b></div>
          <div>{t('mainView.resetCredits.tooltip.sourceLabel')} <b style={{ color: sourceColor }}>{vm.source}</b></div>
        </div>
      </div>
    );
  }
  return (
    <div id={RESET_CREDITS_TOOLTIP_ID} role="tooltip" tabIndex={visible ? 0 : -1} aria-hidden={!visible} data-testid="reset-tooltip" style={shellStyle} {...hoverHandlers}>
      <div style={{ fontWeight: 800, color: C.text, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 7 }}>
        {t('mainView.resetCredits.heading')}
      </div>
      {/* reset fetch가 실패한 count-only fallback도 실제 상태와 상세 사유를 함께 보여준다. */}
      {vm.status.code !== 'ok' && (
        <div style={{ marginBottom: 7, color: C.textDim }}>
          {t('mainView.resetCredits.tooltip.statusLabel')} <b style={{ color: C.text }}>{vm.status.code}</b>{vm.status.detail ? ` - ${vm.status.detail}` : ''}
        </div>
      )}
      {vm.countOnly && (
        <div data-testid="reset-count-only-note" style={{ marginBottom: 7, color: C.textDim }}>
          {t('mainView.resetCredits.tooltip.countOnlyNote')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 14, marginBottom: 8, flexWrap: 'wrap' }}>
        <div>{t('mainView.resetCredits.tooltip.available')}<b style={{ display: 'block', color: urgencyColor(vm.urgency, C), marginTop: 1 }}>{vm.availableCount}</b></div>
        <div>{t('mainView.resetCredits.tooltip.nextExpires')}<b style={{ display: 'block', color: urgencyColor(vm.urgency, C), marginTop: 1 }}>{nextExpiryLabel}</b></div>
        <div>{t('mainView.resetCredits.tooltip.earned')}<b style={{ display: 'block', color: C.text, marginTop: 1 }}>{vm.totalEarnedCount}</b></div>
      </div>
      {vm.credits.length > 0 && (
        <div style={{ display: 'grid', gap: 4 }}>
          {vm.credits.map((credit, index) => {
            const urgency = creditUrgencyBucket(credit.remainingMs);
            const expires = credit.expiresAtUtc ? new Date(credit.expiresAtUtc) : null;
            const local = expires && Number.isFinite(expires.getTime()) ? expires.toLocaleString() : t('mainView.resetCredits.tooltip.unknown');
            return (
              <div
                key={`${credit.idSuffix ?? index}-${credit.expiresAtUtc ?? 'none'}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '30px minmax(0, 72px) minmax(0, 1fr) minmax(0, 1.4fr)',
                  gap: 8,
                  alignItems: 'center',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ color: urgencyColor(urgency, C) }}>#{index + 1}</span>
                <span>{credit.status}</span>
                <span>{t('mainView.resetCredits.tooltip.expiresIn', { duration: formatCreditDuration(credit.remainingMs) })}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{local}</span>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 8, paddingTop: 7, borderTop: `1px solid ${C.borderSub}`, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 9 }}>
        <span>{t('mainView.resetCredits.tooltip.updatedFooter', { date: updatedLabel })}</span>
        <span>{t('mainView.resetCredits.tooltip.sourceFooter', { source: vm.source })}</span>
      </div>
    </div>
  );
}

export function ResetCreditsCard({ vm }: { vm: ResetCreditsViewModel }) {
  const C = useTheme();
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement>(null);
  const { hovered, anchor, tooltipHandlers, handleTooltipHover } = useResetTooltipTrigger(frameRef);
  const source = resetSourceBadge(vm, C);
  const countColor = vm.errored || vm.availableCount === 0
    ? C.textMuted
    : vm.countOnly
      ? (vm.status.code !== 'ok' ? C.waiting : C.accent)
      : vm.status.code !== 'ok' ? C.waiting : urgencyColor(vm.urgency, C);
  const errorTextColor = C.textDim;
  const chipCredits = vm.countOnly || vm.availableCount === 0 || vm.errored
    ? []
    : vm.credits.length > 6
      ? vm.credits.slice(0, 5)
      : vm.credits;
  const hiddenCount = vm.credits.length > 6 ? vm.credits.length - 5 : 0;

  return (
    <div
      ref={frameRef}
      {...tooltipHandlers}
      tabIndex={0}
      aria-label={t('mainView.resetCredits.detailsAriaLabel')}
      aria-describedby={RESET_CREDITS_TOOLTIP_ID}
      style={{ position: 'relative', minWidth: 0 }}
    >
      <div
        data-testid="reset-card-body"
        style={{
          minWidth: 0,
          padding: '8px 12px 8px',
          background: 'transparent',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1, minWidth: 0, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t('mainView.resetCredits.cardHeading')}
          </span>
          <span
            title={source.title}
            style={{
              ...source.style,
              fontSize: 9,
              fontWeight: 700,
              padding: '1px 4px',
              borderRadius: 4,
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            {source.label}
          </span>
        </div>

        {vm.errored ? (
          <div
            data-testid="reset-error-trigger"
            style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, cursor: 'default' }}
          >
            <span style={{ color: errorTextColor, fontSize: 12, fontWeight: 800, fontFamily: C.fontMono }}>
              {resetStatusSummary(vm.status)}
            </span>
            <span
              title={vm.status.code}
              style={{
                background: C.bgRow,
                color: errorTextColor,
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                padding: '2px 6px',
                fontSize: 10,
                fontWeight: 700,
                fontFamily: C.fontMono,
              }}
            >
              {vm.status.code}
            </span>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
              <div
                data-testid="reset-available-trigger"
                style={{ fontSize: 30, fontWeight: 800, color: countColor, lineHeight: 1.1, fontFamily: C.fontMono, cursor: 'default' }}
              >
                {vm.availableCount}
                <span style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, marginLeft: 6 }}>
                  {t('mainView.resetCredits.card.available')}
                </span>
              </div>
              {vm.nextExpiryMs != null && (
                <div style={{ marginTop: 4, fontSize: 9, lineHeight: 1.25, color: C.textMuted, textAlign: 'right', fontFamily: C.fontMono, opacity: 0.78, flexShrink: 0 }}>
                  <div style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('mainView.resetCredits.card.nextExpiresLabel')}</div>
                  <div style={{ fontSize: 12, color: countColor }}>{formatCreditDuration(vm.nextExpiryMs)}</div>
                </div>
              )}
            </div>

            {vm.availableCount === 0 ? (
              <div style={{ color: C.textMuted, fontSize: 10, fontFamily: C.fontMono, marginBottom: 4 }}>
                {t('mainView.resetCredits.card.noResets')}
              </div>
            ) : chipCredits.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 6px', marginBottom: 4 }}>
                {chipCredits.map((credit, index) => {
                  const urgency = creditUrgencyBucket(credit.remainingMs);
                  const color = urgencyColor(urgency, C);
                  return (
                    <span
                      key={`${credit.idSuffix ?? index}-${credit.expiresAtUtc ?? 'none'}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 10,
                        fontFamily: C.fontMono,
                        color,
                        background: C.bgRow,
                        border: `1px solid ${C.borderSub}`,
                        borderRadius: 4,
                        padding: '2px 6px',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
                      #{index + 1} {formatCreditDuration(credit.remainingMs)}
                    </span>
                  );
                })}
                {hiddenCount > 0 && (
                  <span style={{ fontSize: 10, fontFamily: C.fontMono, color: C.textMuted, background: C.bgRow, border: `1px solid ${C.borderSub}`, borderRadius: 4, padding: '2px 6px', whiteSpace: 'nowrap' }}>
                    {t('mainView.resetCredits.card.moreCount', { n: hiddenCount })}
                  </span>
                )}
              </div>
            ) : vm.countOnly ? (
              <div data-testid="reset-count-only-note" style={{ color: C.textMuted, fontSize: 10, fontFamily: C.fontMono, marginBottom: 4 }}>
                {t('mainView.resetCredits.card.countOnlyShort')}
              </div>
            ) : null}
          </>
        )}
      </div>
      <ResetCreditsTooltip vm={vm} visible={hovered} anchor={anchor} onHoverChange={handleTooltipHover} />
    </div>
  );
}

export function ResetCreditsSimpleRow({ vm }: { vm: ResetCreditsViewModel }) {
  const C = useTheme();
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement>(null);
  const { hovered, anchor, tooltipHandlers, handleTooltipHover } = useResetTooltipTrigger(frameRef);
  const source = resetSourceBadge(vm, C);
  const countColor = vm.errored || vm.availableCount === 0
    ? C.textMuted
    : vm.countOnly
      ? (vm.status.code !== 'ok' ? C.waiting : C.accent)
      : vm.status.code !== 'ok' ? C.waiting : urgencyColor(vm.urgency, C);
  const errorTextColor = C.textDim;

  return (
    <div
      ref={frameRef}
      data-testid="reset-simple-line"
      {...tooltipHandlers}
      tabIndex={0}
      aria-label={t('mainView.resetCredits.detailsAriaLabel')}
      aria-describedby={RESET_CREDITS_TOOLTIP_ID}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        padding: '7px 12px',
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      <span style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, flexShrink: 0 }}>
        {t('mainView.resetCredits.rowHeading')}
      </span>

      {vm.errored ? (
        <>
          <span
            data-testid="reset-error-trigger"
            style={{ color: errorTextColor, fontSize: 11, fontFamily: C.fontMono, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default' }}
          >
            {resetStatusSummary(vm.status)}
          </span>
          <span
            title={vm.status.code}
            style={{
              marginLeft: 'auto',
              background: C.bgRow,
              color: errorTextColor,
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              padding: '1px 4px',
              fontSize: 9,
              fontWeight: 700,
              fontFamily: C.fontMono,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {vm.status.code}
          </span>
        </>
      ) : (
        <>
          <span style={{ fontSize: 11, fontFamily: C.fontMono, color: C.textDim, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {vm.availableCount === 0 ? (
              <span style={{ color: C.textMuted }}>{t('mainView.resetCredits.row.noResetsAvailable')}</span>
            ) : (
              <span
                data-testid="reset-available-trigger"
                style={{ cursor: 'default' }}
              >
                <b style={{ fontSize: 13, fontWeight: 800, color: countColor }}>{vm.availableCount}</b>{' '}{t('mainView.resetCredits.row.available')}
              </span>
            )}
          </span>
          {vm.nextExpiryMs != null && (
            <span style={{ marginLeft: 'auto', fontSize: 10, fontFamily: C.fontMono, color: C.textMuted, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {t('mainView.resetCredits.row.nextIn', { duration: formatCreditDuration(vm.nextExpiryMs) })}
            </span>
          )}
          {vm.countOnly && vm.availableCount > 0 && (
            <span data-testid="reset-count-only-note" title={t('mainView.resetCredits.tooltip.countOnlyNote')} style={{ marginLeft: vm.nextExpiryMs == null ? 'auto' : 0, fontSize: 9, fontFamily: C.fontMono, color: C.textMuted, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {t('mainView.resetCredits.row.countOnly')}
            </span>
          )}
        </>
      )}

      <span
        title={source.title}
        style={{
          ...source.style,
          marginLeft: !vm.errored && vm.nextExpiryMs == null ? 'auto' : 0,
          borderRadius: 3,
          padding: '1px 4px',
          fontSize: 9,
          fontWeight: 700,
          fontFamily: C.fontMono,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {source.label}
      </span>
      <ResetCreditsTooltip vm={vm} visible={hovered} anchor={anchor} onHoverChange={handleTooltipHover} />
    </div>
  );
}

export const PlanUsagePanel = React.memo(function PlanUsagePanel({
  usage,
  providerQuotas,
  settings,
  historyWarmupPending,
  historyWarmupStartsAt,
}: {
  usage: AppState['usage'];
  providerQuotas: AppState['providerQuotas'];
  settings: AppState['settings'];
  historyWarmupPending: boolean;
  historyWarmupStartsAt: number | null;
}) {
  const C = useTheme();
  const { t } = useTranslation();
  const { currency, usdToKrw } = settings;
  const { targets, richGroups, simpleGroups, extraUsage, resetCredits } = buildQuotaDisplayModels({
    usage,
    providerQuotas,
    settings,
    historyWarmupPending,
    historyWarmupStartsAt,
    formatWarmupEta,
  });
  const showExtraUsage = !!extraUsage?.isEnabled;
  const resetTargetId = quotaGroupId('codex', 'resets');
  const visibleTargetIds = new Set([...richGroups.map(group => group.id), ...simpleGroups.map(group => group.id)]);
  const orderedTargetIds = targets
    .filter(group => group.id === resetTargetId || visibleTargetIds.has(group.id))
    .map(group => group.id);
  const richGroupById = new Map(richGroups.map(group => [group.id, group]));
  const simpleGroupById = new Map(simpleGroups.map(group => [group.id, group]));
  const richRows = buildRichCardRows(richGroups);
  const richCards = richRows.map(row => row.cards).flat();
  const richCardsByGroupId = new Map<string, QuotaDisplayRichCardViewModel[]>();
  for (const card of richCards) {
    const cards = richCardsByGroupId.get(card.group.id);
    if (cards) {
      cards.push(card);
    } else {
      richCardsByGroupId.set(card.group.id, [card]);
    }
  }
  const renderResetEntry = (key: string): React.ReactNode => {
    if (resetCredits?.mode === 'rich') {
      return (
        <div key={key} data-testid="reset-rich-row" style={{ display: 'grid', gridTemplateColumns: '1fr', borderBottom: `1px solid ${C.border}` }}>
          <ResetCreditsCard vm={resetCredits} />
        </div>
      );
    }
    if (resetCredits?.mode === 'simple') {
      return <ResetCreditsSimpleRow key={key} vm={resetCredits} />;
    }
    return null;
  };
  const renderRichRow = (cards: QuotaDisplayRichCardViewModel[], key: string): React.ReactNode => (
    <div key={key} data-testid="plan-usage-rich-row" style={{ display: 'grid', gridTemplateColumns: cards.length === 1 ? '1fr' : '1fr 1fr', borderBottom: `1px solid ${C.border}` }}>
      {cards.map((cardView, cardIndex) => {
        const { group, row: card } = cardView;
        const source = limitSourceDisplay(card.quota);
        const accountTooltip = providerQuotas[cardView.provider]?.accountTooltip;
        return (
          <TokenStatsCard
            key={cardView.key}
            provider={group.label}
            period={card.label}
            stats={card.stats}
            currency={currency}
            usdToKrw={usdToKrw}
            limitPct={card.quota.pct}
            resetMs={card.visualKind === 'percentOnly' ? null : card.quota.resetMs}
            resetLabel={card.visualKind === 'percentOnly' ? undefined : card.quota.resetLabel}
            apiConnected={card.apiConnected}
            limitSourceLabel={source.label}
            limitSourceTitle={source.title}
            limitSourceTone={source.tone}
            limitDataState={limitDataState(card.quota, card.pending)}
            limitState={card.quota.limitState}
            pendingLimit={card.pending}
            pendingLimitLabel={t('mainView.quota.pendingLabel')}
            pendingLimitTitle={card.pendingTitle}
            cacheMetricTitle={card.cacheMetricTitle}
            durationMs={card.durationMs}
            accountTooltip={accountTooltip}
            hideCost={card.hideCost}
            hero
            borderRight={cards.length > 1 && cardIndex === 0}
          />
        );
      })}
    </div>
  );
  const orderedPlanEntries: React.ReactNode[] = [];
  let pendingRichCards: QuotaDisplayRichCardViewModel[] = [];
  let richRowIndex = 0;
  const flushRichCards = () => {
    while (pendingRichCards.length > 0) {
      const rowCards = pendingRichCards.splice(0, 2);
      orderedPlanEntries.push(renderRichRow(rowCards, `quota-rich-row-${richRowIndex++}`));
    }
  };
  for (const targetId of orderedTargetIds) {
    if (targetId === resetTargetId) {
      flushRichCards();
      const entry = renderResetEntry('codex-reset-target');
      if (entry) orderedPlanEntries.push(entry);
      continue;
    }
    const richGroup = richGroupById.get(targetId);
    if (richGroup) {
      pendingRichCards.push(...(richCardsByGroupId.get(richGroup.id) ?? []));
      continue;
    }
    const simpleGroup = simpleGroupById.get(targetId);
    if (simpleGroup) {
      flushRichCards();
      orderedPlanEntries.push(
        <div key={`simple-${simpleGroup.id}`} data-testid="plan-usage-simple-group" style={{ display: 'grid', gap: 0, borderBottom: `1px solid ${C.border}` }}>
          <SimpleQuotaGroupBlock group={simpleGroup} />
        </div>,
      );
    }
  }
  flushRichCards();
  return (
    <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 14px 5px 12px', background: C.bgRow, borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>{t('common.mainSections.planUsage')}</span>
      </div>

      <div data-testid="plan-usage-body">
        {orderedPlanEntries}
      </div>

      {showExtraUsage && extraUsage && (
        <div style={{ borderBottom: `1px solid ${C.border}` }}>
          <ExtraUsageCard extraUsage={extraUsage} />
        </div>
      )}

    </div>
  );
});

const HistoryWarmupBanner = React.memo(function HistoryWarmupBanner({ historyWarmupStartsAt }: {
  historyWarmupStartsAt: number | null;
}) {
  const C = useTheme();
  const { t } = useTranslation();
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
      <div style={{ fontSize: 11, fontWeight: 700, color: C.headerAccent, textTransform: 'uppercase', letterSpacing: 0.8 }}>
        {t('mainView.warmup.bannerTitle')}
      </div>
      <div style={{ fontSize: 11, lineHeight: 1.5, marginTop: 3 }}>
        {t('mainView.warmup.bannerBody', { status: statusLabel })}
      </div>
    </div>
  );
});

const IndexCoverageBanner = React.memo(function IndexCoverageBanner({ coverage }: {
  coverage: AppState['usageIndexCoverage'];
}) {
  const C = useTheme();
  const { t } = useTranslation();
  const progress = coverage.requiredSourceCount > 0
    ? t('mainView.usageIndexCoverage.progress', {
      indexed: coverage.indexedSourceCount,
      required: coverage.requiredSourceCount,
    })
    : t('mainView.usageIndexCoverage.discovering');
  const failures = coverage.failedSourceCount > 0
    ? ` ${t('mainView.usageIndexCoverage.failures', { count: coverage.failedSourceCount })}`
    : '';
  return (
    <div style={{
      margin: '10px 8px 0',
      padding: '9px 12px',
      borderRadius: 10,
      border: `1px solid ${C.headerAccent}26`,
      background: `${C.headerAccent}10`,
      color: C.textDim,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.headerAccent, textTransform: 'uppercase', letterSpacing: 0.8 }}>
        {t('mainView.usageIndexCoverage.title')}
      </div>
      <div style={{ fontSize: 11, lineHeight: 1.5, marginTop: 3 }}>
        {t('mainView.usageIndexCoverage.body', { progress, failures })}
      </div>
    </div>
  );
});

const UsageIndexHealthBanner = React.memo(function UsageIndexHealthBanner({ health }: {
  health: AppState['usageIndexHealth'];
}) {
  const C = useTheme();
  const { t } = useTranslation();
  const unavailable = health.state === 'unavailable';
  const color = unavailable ? C.barRed : C.headerAccent;
  return (
    <div style={{
      margin: '10px 8px 0',
      padding: '9px 12px',
      borderRadius: 10,
      border: `1px solid ${color}30`,
      background: `${color}10`,
      color: C.textDim,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 0.8 }}>
        {unavailable ? t('mainView.usageIndexHealth.unavailableTitle') : t('mainView.usageIndexHealth.recoveredTitle')}
      </div>
      <div style={{ fontSize: 11, lineHeight: 1.5, marginTop: 3 }} title={health.preservedPath}>
        {health.message ?? (unavailable
          ? t('mainView.usageIndexHealth.unavailableBody')
          : t('mainView.usageIndexHealth.recoveredBody'))}
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
  const { t } = useTranslation();
  const provider = sessionProviderLabel(item.provider);
  const providerBadge = sessionProviderBadgeColors(item.provider, C);
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
            <span title={item.modelName} style={{ fontSize: 9, background: `${modelColorValue}16`, color: modelColorValue, border: `1px solid ${modelColorValue}33`, borderRadius: 3, padding: '1px 5px', fontWeight: 700, maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.modelName}
            </span>
          )}
          <span style={{ fontSize: 9, background: providerBadge.background, color: providerBadge.color, border: `1px solid ${C.border}`, borderRadius: 3, padding: '1px 5px', fontWeight: 700 }}>
            {provider}
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>
            {t('mainView.sessions.stackCount', { count: item.sessions.length, state: t(`common.state.${item.state}`) })}
          </span>
        </span>
        <span style={{ display: 'block', fontSize: 10, color: C.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.source} - {t('mainView.sessions.latest')} {fmtRelative(item.latest)} - {t('mainView.sessions.maxCtx')} {Math.round(item.maxCtxPct)}%
        </span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: `${chipColor}1a`, color: chipColor, fontWeight: 700 }}>
          {expanded ? t('mainView.sessions.chipOpen') : t('mainView.sessions.chipStack')}
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

const SessionsPanel = React.memo(function SessionsPanel({ sessions, settings }: {
  sessions: SessionInfo[];
  settings: AppState['settings'];
}) {
  const C = useTheme();
  const { t } = useTranslation();
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
        <span style={{ fontSize: 11, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>{t('common.mainSections.sessions')}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'active'] as const).map(filter => (
            <button
              key={filter}
              onClick={() => setActiveFilter(filter)}
              style={{
                background: activeFilter === filter ? C.accent + '22' : 'none',
                border: `1px solid ${activeFilter === filter ? C.accent + '66' : C.border}`,
                color: activeFilter === filter ? C.accent : C.textMuted,
                borderRadius: 3, padding: '1px 7px', fontSize: 10, cursor: 'pointer', fontWeight: activeFilter === filter ? 700 : 400,
              }}
            >
              {filter === 'all' ? t('mainView.sessions.filterAll') : t('mainView.sessions.filterActive')}
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
                  <span style={{ fontSize: 10, color: C.textMuted, fontFamily: C.fontMono }}>
                    {t('mainView.sessions.commitCount', { count: project.totalCommits })} · +{project.totalAdded} / -{project.totalRemoved}
                  </span>
                )}
                <div style={{ position: 'relative' }}>
                  <button
                    onClick={() => setProjectMenuOpen(open => open === project.name ? null : project.name)}
                    title={t('mainView.sessions.projectActionsTitle')}
                    style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textMuted, cursor: 'pointer', fontSize: 11, padding: '0 6px', lineHeight: 1.4, borderRadius: 4 }}
                  >
                    ...
                  </button>
                  {projectMenuOpen === project.name && (
                    <div style={{ position: 'absolute', right: 0, top: 20, zIndex: 5, display: 'grid', gap: 2, padding: 4, background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 6, boxShadow: '0 4px 10px rgba(0,0,0,0.18)' }}>
                      <button onClick={() => hideProject(project.name)} style={{ background: C.bgRow, border: `1px solid ${C.border}`, color: C.textDim, cursor: 'pointer', fontSize: 11, padding: '3px 8px', borderRadius: 3, textAlign: 'left' }}>{t('mainView.sessions.hide')}</button>
                      <button onClick={() => excludeProject(project.name)} style={{ background: C.bgRow, border: `1px solid ${C.border}`, color: C.textDim, cursor: 'pointer', fontSize: 11, padding: '3px 8px', borderRadius: 3, textAlign: 'left' }}>{t('mainView.sessions.exclude')}</button>
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
                    fontSize: 11, color: C.textDim, fontWeight: 500, fontFamily: C.fontMono,
                    maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{branch.branch}</span>
                  {branch.commits > 0 && (
                    <>
                      <span style={{ fontSize: 9, background: '#60a5fa1a', color: '#60a5fa', borderRadius: 3, padding: '1px 5px', fontFamily: C.fontMono, fontWeight: 600 }}>
                        {t('mainView.sessions.commitCount', { count: branch.commits })}
                      </span>
                      <span style={{ fontSize: 9, background: '#34d3991a', color: '#34d399', borderRadius: 3, padding: '1px 5px', fontFamily: C.fontMono, fontWeight: 600 }}>+{branch.added}</span>
                      <span style={{ fontSize: 9, background: '#f871711a', color: '#f87171', borderRadius: 3, padding: '1px 5px', fontFamily: C.fontMono, fontWeight: 600 }}>-{branch.removed}</span>
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
                      fontSize: 10,
                      padding: '3px 8px',
                      fontFamily: C.fontMono,
                    }}
                  >
                    {t('mainView.sessions.showMore', { n: hiddenCount })}
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
                      fontSize: 10,
                      padding: '3px 8px',
                      fontFamily: C.fontMono,
                    }}
                  >
                    {t('mainView.sessions.showLess')}
                  </button>
                )}
              </div>
            );})}
          </div>
        ))
        : sessions.length === 0
          ? <div style={{ padding: '10px 14px', fontSize: 12, color: C.textMuted }}>{t('mainView.sessions.noActive', { providers: emptySessionLabel(settings.enabledProviders) })}</div>
          : null
      }

      {staleSessions.length > 0 && activeFilter === 'all' && (
        <div style={{ padding: '6px 14px', display: 'flex', justifyContent: 'center' }}>
          <button
            onClick={() => setShowStale(v => !v)}
            style={{
              background: 'none', border: `1px solid ${C.border}`, borderRadius: 10,
              color: C.textMuted, cursor: 'pointer', fontSize: 10, padding: '3px 12px',
              fontFamily: C.fontMono,
            }}
          >
            {showStale
              ? t('mainView.sessions.hideIdleSessions', { count: staleSessions.length })
              : t('mainView.sessions.showIdleSessions', { count: staleSessions.length })}
          </button>
        </div>
      )}

      {hiddenProjects.length > 0 && (
        <div style={{ padding: '4px 14px', marginTop: 8, borderTop: `1px solid ${C.border}` }}>
          <button
            onClick={() => setShowHiddenManager(v => !v)}
            style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: 11, padding: 0 }}
          >
            {showHiddenManager ? 'v' : '>'} {t('mainView.sessions.hiddenProjectsCount', { count: hiddenProjects.length })}
          </button>
          {showHiddenManager && (
            <div style={{ marginTop: 4 }}>
              {hiddenProjects.map(name => (
                <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
                  <span style={{ fontSize: 11, color: C.textDim, flex: 1 }}>{name}</span>
                  <button
                    onClick={() => unhideProject(name)}
                    style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textDim, cursor: 'pointer', fontSize: 11, padding: '1px 6px', borderRadius: 3 }}
                  >{t('mainView.sessions.show')}</button>
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

const BottomNav = React.memo(function BottomNav({ lastUpdated, refreshing, syncingHistory, historyWarmupStartsAt, stateFreshness, onRefresh, onNav }: {
  lastUpdated: number;
  refreshing: boolean;
  syncingHistory: boolean;
  historyWarmupStartsAt: number | null;
  stateFreshness: AppState['stateFreshness'];
  onRefresh: () => void;
  onNav: (view: NavView) => void;
}) {
  const C = useTheme();
  const { t } = useTranslation();
  const items: Array<{ key: NavView | 'refresh'; icon: string; label: React.ReactNode }> = [
    { key: 'settings', icon: '⚙', label: t('mainView.nav.settings') },
    { key: 'notifications', icon: '!', label: t('mainView.nav.alerts') },
    { key: 'help', icon: '?', label: t('help.title') },
    { key: 'refresh', icon: '↻', label: <RefreshStatus lastUpdated={lastUpdated} refreshing={refreshing} syncingHistory={syncingHistory} historyWarmupStartsAt={historyWarmupStartsAt} stateFreshness={stateFreshness} /> },
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
            fontSize: 11, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
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

export default function MainView({ state, onNav, onQuit, onRefresh, onScrollActivity, onToggleCompactWidget, onToggleTaskbarQuota }: Props) {
  const C = useTheme();
  const { t } = useTranslation();
  const { sessions, usage, settings } = state;
  const { currency, usdToKrw } = settings;
  const allTimeCost = useMemo(() => usage.models.reduce((sum, model) => sum + model.costUSD, 0), [usage.models]);
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTopRef = useRef(0);
  const sessionLayoutKey = useMemo(
    () => sessions.map(s => `${s.sessionId}:${s.provider}:${s.source}:${s.state}:${s.projectName}:${s.worktreeBranch ?? s.gitBranch ?? ''}:${s.modelName}`).join('|'),
    [sessions]
  );
  const mainSectionOrder = useMemo(() => normalizeMainSectionOrder(settings.mainSectionOrder), [settings.mainSectionOrder]);
  const hiddenMainSections = useMemo(() => normalizeHiddenMainSections(settings.hiddenMainSections, mainSectionOrder), [mainSectionOrder, settings.hiddenMainSections]);
  const visibleMainSections = useMemo(() => mainSectionOrder.filter(id => !hiddenMainSections.includes(id)), [hiddenMainSections, mainSectionOrder]);

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

  const renderMainSection = useCallback((sectionId: MainSectionId) => {
    switch (sectionId) {
      case 'planUsage':
        return (
          <RenderErrorBoundary key={sectionId} label={t('mainView.errorBoundary.planUsagePanel')}>
            <PlanUsagePanel
              usage={usage}
              providerQuotas={state.providerQuotas}
              settings={settings}
              historyWarmupPending={state.historyWarmupPending}
              historyWarmupStartsAt={state.historyWarmupStartsAt}
            />
          </RenderErrorBoundary>
        );
      case 'codeOutput':
        return (
          <RenderErrorBoundary key={sectionId} label={t('mainView.errorBoundary.codeOutputCard')}>
            <CodeOutputCard stats={state.codeOutputStats} loading={state.codeOutputLoading} todayCost={usage.todayCost} allTimeCost={allTimeCost} currency={currency} usdToKrw={usdToKrw} />
          </RenderErrorBoundary>
        );
      case 'trend':
        return (
          <RenderErrorBoundary key={sectionId} label={t('mainView.errorBoundary.trendCard')}>
            <TrendCard usageTrend={state.usageTrend} codeOutputStats={state.codeOutputStats} lastUpdated={state.lastUpdated} currency={currency} usdToKrw={usdToKrw} />
          </RenderErrorBoundary>
        );
      case 'sessions':
        return (
          <RenderErrorBoundary key={sectionId} label={t('mainView.errorBoundary.sessionsPanel')}>
            <SessionsPanel sessions={sessions} settings={settings} />
          </RenderErrorBoundary>
        );
      case 'activity':
        return (
          <RenderErrorBoundary key={sectionId} label={t('mainView.errorBoundary.activitySection')}>
            <ActivitySection usage={usage} currency={currency} usdToKrw={usdToKrw} />
          </RenderErrorBoundary>
        );
      case 'modelUsage':
        return (
          <RenderErrorBoundary key={sectionId} label={t('mainView.errorBoundary.modelSection')}>
            <ModelSection models={usage.models} currency={currency} usdToKrw={usdToKrw} />
          </RenderErrorBoundary>
        );
      default:
        return null;
    }
  }, [allTimeCost, currency, sessions, settings, state.codeOutputLoading, state.codeOutputStats, state.historyWarmupPending, state.historyWarmupStartsAt, state.providerQuotas, state.usageTrend, usage, usdToKrw, t]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, color: C.text, overflow: 'hidden' }}>
      <RenderErrorBoundary label={t('mainView.errorBoundary.headerMetrics')}>
        <HeaderMetrics state={state} onQuit={onQuit} onToggleCompactWidget={onToggleCompactWidget} onToggleTaskbarQuota={onToggleTaskbarQuota} />
      </RenderErrorBoundary>
      <div ref={scrollRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 8, overflowAnchor: 'none' }}>
        {state.usageIndexHealth.state !== 'ready' && (
          <RenderErrorBoundary label={t('mainView.errorBoundary.usageIndexHealthBanner')}>
            <UsageIndexHealthBanner health={state.usageIndexHealth} />
          </RenderErrorBoundary>
        )}
        {settings.enabledProviders.some(provider => provider === 'claude' || provider === 'codex' || provider === 'antigravity')
          && state.usageIndexHealth.state !== 'unavailable'
          && state.usageIndexCoverage.state === 'incomplete' && (
          <RenderErrorBoundary label={t('mainView.errorBoundary.usageIndexCoverageBanner')}>
            <IndexCoverageBanner coverage={state.usageIndexCoverage} />
          </RenderErrorBoundary>
        )}
        {state.historyWarmupPending && (
          <RenderErrorBoundary label={t('mainView.errorBoundary.historyWarmupBanner')}>
            <HistoryWarmupBanner historyWarmupStartsAt={state.historyWarmupStartsAt} />
          </RenderErrorBoundary>
        )}
        {visibleMainSections.map(renderMainSection)}
      </div>
      <RenderErrorBoundary label={t('mainView.errorBoundary.bottomNavigation')}>
        <BottomNav
          lastUpdated={state.lastUpdated}
          refreshing={refreshing}
          syncingHistory={state.historyWarmupPending}
          historyWarmupStartsAt={state.historyWarmupStartsAt}
          stateFreshness={state.stateFreshness}
          onRefresh={handleRefresh}
          onNav={onNav}
        />
      </RenderErrorBoundary>
    </div>
  );
}
