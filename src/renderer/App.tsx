import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppState,
  AppSettings,
  WindowStats,
} from './types';
import type { ProviderId, QuotaDisplayMode } from '../shared/quotaTypes';
import { validateProviderQuotaSnapshot } from '../shared/quotaDomain';
import MainView from './views/MainView';
import SettingsView from './views/SettingsView';
import NotificationsView from './views/NotificationsView';
import HelpView from './views/HelpView';
import CompactWidgetView from './views/CompactWidgetView';
import RenderErrorBoundary from './components/RenderErrorBoundary';
import { getTheme, applyThemeCssVars, Theme } from './theme';
import { ThemeProvider } from './ThemeContext';
import { DEFAULT_MAIN_SECTION_ORDER, normalizeHiddenMainSections, normalizeMainSectionOrder } from './mainSections';
import { applyLanguagePreference, normalizeLanguagePreference } from './i18n';

type View = 'main' | 'settings' | 'notifications' | 'help';

const EMPTY_WINDOW = { inputTokens:0, outputTokens:0, cacheCreationTokens:0, cacheReadTokens:0, totalTokens:0, costUSD:0, requestCount:0, cacheEfficiency:0, cacheSavingsUSD:0 };
const EMPTY_CODE_OUTPUT = {
  today: { commits: 0, added: 0, removed: 0 },
  all: { commits: 0, added: 0, removed: 0 },
  daily7d: [],
  dailyAll: [],
  repoCount: 0,
  scopeLabel: 'Current session repos',
};
const EMPTY_USAGE_TREND = { daily: [], weekly: [], monthly: [] };
const BOOT_FALLBACK_DELAY_MS = 12_000;

const DEFAULT_STATE: AppState = {
  sessions: [],
  usage: {
    fixedPeriodByProvider: {},
    entryStats: {},
    models: [], heatmap: [], heatmap30: [], heatmap90: [], weeklyTimeline: [],
    todayTokens: 0, todayCost: 0, todayRequestCount: 0,
    todayInputTokens: 0, todayOutputTokens: 0, todayCacheTokens: 0,
    todayCacheSavingsUSD: 0, todayCacheEfficiency: 0,
    allTimeRequestCount: 0, allTimeCost: 0, allTimeCacheTokens: 0,
    allTimeInputTokens: 0, allTimeOutputTokens: 0,
    allTimeSavedUSD: 0, allTimeAvgCacheEfficiency: 0,
    todBuckets: [],
  },
  usageTrend: EMPTY_USAGE_TREND,
  providerQuotas: {},
  settings: {
    enabledProviders: ['claude', 'codex'],
    alertThresholds: [50,80,90], openAtLogin: false,
    alwaysOnTop: true,
    currency: 'USD', usdToKrw: 1380,
    globalHotkey: 'CommandOrControl+Shift+D', enableAlerts: true,
    language: 'system',
    trayDisplay: 'h5pct', theme: 'auto',
    mainSectionOrder: DEFAULT_MAIN_SECTION_ORDER,
    hiddenMainSections: [],
    hiddenProjects: [], excludedProjects: [],
    quotaTargetModes: {},
    quotaTargetOrder: [],
    taskbarQuotaEnabled: false,
    taskbarQuotaMaxBlocks: 2,
    quotaTargetAbbreviations: {},
    antigravityQuotaDurationPaceEnabled: false,
    compactWidgetEnabled: false, compactWidgetWaitingAnimationEnabled: false, compactWidgetBounds: null,
  },
  codexAccount: { serviceTier: null },
  stateFreshness: 'empty',
  initialRefreshComplete: false,
  historyWarmupPending: false,
  historyWarmupStartsAt: null,
  usageIndexCoverage: {
    state: 'incomplete',
    requiredSourceCount: 0,
    indexedSourceCount: 0,
    pendingSourceCount: 0,
    failedSourceCount: 0,
  },
  usageIndexHealth: { state: 'ready' },
  lastUpdated: 0,
  apiConnected: false,
  apiStatusLabel: undefined,
  apiError: undefined,
  codexUsageConnected: false,
  codexStatusLabel: undefined,
  codexError: undefined,
  bridgeActive: false,
  repoGitStats: {},
  codeOutputStats: EMPTY_CODE_OUTPUT,
  codeOutputLoading: false,
  allTimeSessions: 0,
};

function arrayOrEmpty<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function numberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) record[key] = entry;
  }
  return record;
}

const PROVIDER_IDS: ProviderId[] = ['claude', 'codex', 'antigravity'];

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as string[]).includes(value);
}

function isQuotaDisplayMode(value: unknown): value is QuotaDisplayMode {
  return value === 'rich' || value === 'simple' || value === 'none';
}

function isSafeQuotaGroupKey(value: string): boolean {
  return /^[A-Za-z0-9._~%-]+$/.test(value);
}

function isQuotaTargetId(value: string): boolean {
  const [provider, namespace, ...groupParts] = value.split('.');
  const encodedGroupKey = groupParts.join('.');
  return isProviderId(provider)
    && namespace === 'group'
    && encodedGroupKey.length > 0
    && isSafeQuotaGroupKey(encodedGroupKey);
}

export function normalizeProviderQuotas(value: unknown): AppState['providerQuotas'] {
  const record = recordOrNull(value);
  if (!record) return {};
  const providerQuotas: AppState['providerQuotas'] = {};
  for (const [provider, snapshot] of Object.entries(record)) {
    if (!isProviderId(provider)) continue;
    const normalized = validateProviderQuotaSnapshot(snapshot);
    if (normalized?.provider === provider) providerQuotas[provider] = normalized;
  }
  return providerQuotas;
}

const RETIRED_QUOTA_TARGET_ID = 'claude.group.sonnet';

function normalizeQuotaTargetModes(value: unknown): AppState['settings']['quotaTargetModes'] {
  const record = recordOrNull(value);
  if (!record) return {};
  const modes: AppState['settings']['quotaTargetModes'] = {};
  for (const [targetId, mode] of Object.entries(record)) {
    if (targetId === RETIRED_QUOTA_TARGET_ID || !isQuotaTargetId(targetId)) continue;
    if (isQuotaDisplayMode(mode)) modes[targetId] = mode;
  }
  return modes;
}

function normalizeQuotaTargetOrder(value: unknown): AppState['settings']['quotaTargetOrder'] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const order: AppState['settings']['quotaTargetOrder'] = [];
  for (const targetId of value) {
    if (typeof targetId !== 'string' || targetId === RETIRED_QUOTA_TARGET_ID || !isQuotaTargetId(targetId) || seen.has(targetId)) continue;
    seen.add(targetId);
    order.push(targetId);
  }
  return order;
}

function normalizeQuotaTargetAbbreviations(value: unknown): AppState['settings']['quotaTargetAbbreviations'] {
  const record = recordOrNull(value);
  if (!record) return {};
  const abbreviations: AppState['settings']['quotaTargetAbbreviations'] = {};
  for (const [targetId, abbreviation] of Object.entries(record)) {
    if (targetId === RETIRED_QUOTA_TARGET_ID || !isQuotaTargetId(targetId) || typeof abbreviation !== 'string') continue;
    const normalized = abbreviation.trim().toUpperCase();
    if (/^[A-Z0-9]{1,3}$/.test(normalized)) abbreviations[targetId] = normalized;
  }
  return abbreviations;
}

function normalizeTaskbarQuotaMaxBlocks(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 2;
  return Math.max(1, Math.min(3, Math.round(value)));
}

function normalizeStateFreshness(value: unknown, initialRefreshComplete: boolean): AppState['stateFreshness'] {
  if (value === 'empty' || value === 'restored' || value === 'fresh') return value;
  return initialRefreshComplete ? 'fresh' : 'empty';
}

function normalizeUsageIndexCoverage(value: unknown): AppState['usageIndexCoverage'] {
  const record = recordOrNull(value);
  if (!record) return DEFAULT_STATE.usageIndexCoverage;
  const count = (field: string) => {
    const candidate = record[field];
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? Math.floor(candidate)
      : 0;
  };
  return {
    state: record.state === 'complete' ? 'complete' : 'incomplete',
    requiredSourceCount: count('requiredSourceCount'),
    indexedSourceCount: count('indexedSourceCount'),
    pendingSourceCount: count('pendingSourceCount'),
    failedSourceCount: count('failedSourceCount'),
  };
}

function normalizeUsageIndexHealth(value: unknown): AppState['usageIndexHealth'] {
  const record = recordOrNull(value);
  const state = record?.state;
  return {
    state: state === 'recovered' || state === 'unavailable' ? state : 'ready',
    ...(typeof record?.message === 'string' ? { message: record.message } : {}),
    ...(typeof record?.preservedPath === 'string' ? { preservedPath: record.preservedPath } : {}),
  };
}

function normalizeWindowStats(value: unknown): WindowStats {
  const record = recordOrNull(value);
  return { ...EMPTY_WINDOW, ...(record ?? {}) } as WindowStats;
}

function normalizeFixedPeriodUsage(value: unknown): AppState['usage']['fixedPeriodByProvider'] {
  const record = recordOrNull(value);
  const normalized: AppState['usage']['fixedPeriodByProvider'] = {};
  if (!record) return normalized;
  for (const provider of PROVIDER_IDS) {
    const providerRecord = recordOrNull(record[provider]);
    const periods = recordOrNull(providerRecord?.periods);
    if (!periods || !periods['5h']) continue;
    normalized[provider] = { periods: { '5h': normalizeWindowStats(periods['5h']) } };
  }
  return normalized;
}

function normalizeEntryStats(value: unknown): AppState['usage']['entryStats'] {
  const record = recordOrNull(value);
  const normalized: AppState['usage']['entryStats'] = {};
  if (!record) return normalized;
  for (const [entryKey, stats] of Object.entries(record)) {
    normalized[entryKey] = normalizeWindowStats(stats);
  }
  return normalized;
}

function normalizeSession(
  session: (Partial<Omit<AppState['sessions'][number], 'startedAt' | 'lastModified'>> & {
    startedAt?: string | Date;
    lastModified?: string | Date | null;
  }) | null | undefined,
): AppState['sessions'][number] {
  const state = session?.state;
  const normalizedState = state === 'active' || state === 'waiting' || state === 'idle' || state === 'compacting'
    ? state
    : 'idle';
  const startedAt = session?.startedAt instanceof Date
    ? session.startedAt.toISOString()
    : typeof session?.startedAt === 'string'
      ? session.startedAt
      : new Date(0).toISOString();
  const lastModified = session?.lastModified instanceof Date
    ? session.lastModified.toISOString()
    : typeof session?.lastModified === 'string'
      ? session.lastModified
      : null;

  return {
    provider: session?.provider === 'codex' || session?.provider === 'antigravity'
      ? session.provider
      : 'claude',
    pid: typeof session?.pid === 'number' ? session.pid : null,
    sessionId: typeof session?.sessionId === 'string' ? session.sessionId : '',
    cwd: typeof session?.cwd === 'string' ? session.cwd : '',
    projectName: typeof session?.projectName === 'string' ? session.projectName : '',
    startedAt,
    entrypoint: typeof session?.entrypoint === 'string' ? session.entrypoint : '',
    source: typeof session?.source === 'string' ? session.source : '',
    state: normalizedState,
    jsonlPath: typeof session?.jsonlPath === 'string' ? session.jsonlPath : null,
    summaryKey: typeof session?.summaryKey === 'string' ? session.summaryKey : null,
    lastModified,
    modelName: typeof session?.modelName === 'string' ? session.modelName : '',
    contextUsed: typeof session?.contextUsed === 'number' ? session.contextUsed : 0,
    contextMax: typeof session?.contextMax === 'number' ? session.contextMax : 0,
    toolCounts: numberRecord(session?.toolCounts),
    isWorktree: !!session?.isWorktree,
    worktreeBranch: typeof session?.worktreeBranch === 'string' ? session.worktreeBranch : null,
    gitBranch: typeof session?.gitBranch === 'string' ? session.gitBranch : null,
    mainRepoName: typeof session?.mainRepoName === 'string' ? session.mainRepoName : null,
    gitStats: session?.gitStats ?? null,
    activityBreakdown: session?.activityBreakdown ? numberRecord(session.activityBreakdown) as AppState['sessions'][number]['activityBreakdown'] : null,
    activityBreakdownKind: session?.activityBreakdownKind === 'tokens' || session?.activityBreakdownKind === 'events'
      ? session.activityBreakdownKind
      : null,
  };
}

function normalizeState(next: AppState): AppState {
  const mainSectionOrder = normalizeMainSectionOrder(next.settings?.mainSectionOrder);
  return {
    ...DEFAULT_STATE,
    ...next,
    stateFreshness: normalizeStateFreshness(next.stateFreshness, next.initialRefreshComplete === true),
    usageIndexCoverage: normalizeUsageIndexCoverage(next.usageIndexCoverage),
    usageIndexHealth: normalizeUsageIndexHealth(next.usageIndexHealth),
    sessions: arrayOrEmpty(next.sessions).map(session => normalizeSession(session)),
    usage: {
      ...DEFAULT_STATE.usage,
      ...next.usage,
      fixedPeriodByProvider: normalizeFixedPeriodUsage(next.usage?.fixedPeriodByProvider),
      entryStats: normalizeEntryStats(next.usage?.entryStats),
      models: arrayOrEmpty(next.usage?.models),
      heatmap: arrayOrEmpty(next.usage?.heatmap),
      heatmap30: arrayOrEmpty(next.usage?.heatmap30),
      heatmap90: arrayOrEmpty(next.usage?.heatmap90),
      weeklyTimeline: arrayOrEmpty(next.usage?.weeklyTimeline),
      todBuckets: arrayOrEmpty(next.usage?.todBuckets),
    },
    usageTrend: {
      daily: arrayOrEmpty(next.usageTrend?.daily),
      weekly: arrayOrEmpty(next.usageTrend?.weekly),
      monthly: arrayOrEmpty(next.usageTrend?.monthly),
    },
    providerQuotas: normalizeProviderQuotas(next.providerQuotas),
    settings: {
      ...DEFAULT_STATE.settings,
      ...next.settings,
      alertThresholds: arrayOrEmpty(next.settings?.alertThresholds),
      mainSectionOrder,
      hiddenMainSections: normalizeHiddenMainSections(next.settings?.hiddenMainSections, mainSectionOrder),
      hiddenProjects: arrayOrEmpty(next.settings?.hiddenProjects),
      excludedProjects: arrayOrEmpty(next.settings?.excludedProjects),
      language: normalizeLanguagePreference(next.settings?.language),
      quotaTargetModes: normalizeQuotaTargetModes(next.settings?.quotaTargetModes),
      quotaTargetOrder: normalizeQuotaTargetOrder(next.settings?.quotaTargetOrder),
      taskbarQuotaEnabled: next.settings?.taskbarQuotaEnabled === true,
      taskbarQuotaMaxBlocks: normalizeTaskbarQuotaMaxBlocks(next.settings?.taskbarQuotaMaxBlocks),
      quotaTargetAbbreviations: normalizeQuotaTargetAbbreviations(next.settings?.quotaTargetAbbreviations),
      antigravityQuotaDurationPaceEnabled: next.settings?.antigravityQuotaDurationPaceEnabled === true,
      compactWidgetEnabled: next.settings?.compactWidgetEnabled === true,
      compactWidgetWaitingAnimationEnabled: next.settings?.compactWidgetWaitingAnimationEnabled === true,
      compactWidgetBounds: next.settings?.compactWidgetBounds
        && typeof next.settings.compactWidgetBounds.x === 'number'
        && typeof next.settings.compactWidgetBounds.y === 'number'
        && Number.isFinite(next.settings.compactWidgetBounds.x)
        && Number.isFinite(next.settings.compactWidgetBounds.y)
        ? next.settings.compactWidgetBounds
        : null,
    },
    historyWarmupStartsAt: typeof next.historyWarmupStartsAt === 'number' && Number.isFinite(next.historyWarmupStartsAt)
      ? next.historyWarmupStartsAt
      : null,
    apiStatusLabel: typeof next.apiStatusLabel === 'string' ? next.apiStatusLabel : undefined,
    apiError: typeof next.apiError === 'string' ? next.apiError : undefined,
    codexUsageConnected: next.codexUsageConnected === true,
    codexStatusLabel: typeof next.codexStatusLabel === 'string' ? next.codexStatusLabel : undefined,
    codexError: typeof next.codexError === 'string' ? next.codexError : undefined,
    repoGitStats: next.repoGitStats && typeof next.repoGitStats === 'object' ? next.repoGitStats : {},
    codeOutputStats: {
      ...EMPTY_CODE_OUTPUT,
      ...next.codeOutputStats,
      today: { ...EMPTY_CODE_OUTPUT.today, ...next.codeOutputStats?.today },
      all: { ...EMPTY_CODE_OUTPUT.all, ...next.codeOutputStats?.all },
      daily7d: arrayOrEmpty(next.codeOutputStats?.daily7d),
      dailyAll: arrayOrEmpty(next.codeOutputStats?.dailyAll),
      repoCount: typeof next.codeOutputStats?.repoCount === 'number' ? next.codeOutputStats.repoCount : 0,
      scopeLabel: typeof next.codeOutputStats?.scopeLabel === 'string' ? next.codeOutputStats.scopeLabel : EMPTY_CODE_OUTPUT.scopeLabel,
    },
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  return tagName === 'INPUT'
    || tagName === 'TEXTAREA'
    || tagName === 'SELECT'
    || target.isContentEditable;
}

function sameNumberRecord(a: Record<string, number> | null | undefined, b: Record<string, number> | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(key => a[key] === b[key]);
}

function sameGitStats(a: AppState['sessions'][number]['gitStats'], b: AppState['sessions'][number]['gitStats']): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return a.branch === b.branch
    && a.toplevel === b.toplevel
    && a.gitCommonDir === b.gitCommonDir
    && a.commitsToday === b.commitsToday
    && a.linesAdded === b.linesAdded
    && a.linesRemoved === b.linesRemoved
    && a.commits7d === b.commits7d
    && a.linesAdded7d === b.linesAdded7d
    && a.linesRemoved7d === b.linesRemoved7d
    && a.commits30d === b.commits30d
    && a.linesAdded30d === b.linesAdded30d
    && a.linesRemoved30d === b.linesRemoved30d
    && a.totalCommits === b.totalCommits
    && a.totalLinesAdded === b.totalLinesAdded
    && a.totalLinesRemoved === b.totalLinesRemoved
    && sameDailyStats(a.daily7d, b.daily7d)
    && sameDailyStats(a.dailyAll, b.dailyAll);
}

function sameDailyStats(a: NonNullable<AppState['sessions'][number]['gitStats']>['daily7d'] | undefined, b: NonNullable<AppState['sessions'][number]['gitStats']>['daily7d'] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  return a.every((day, index) => {
    const other = b[index];
    return day.date === other.date
      && day.commits === other.commits
      && day.added === other.added
      && day.removed === other.removed;
  });
}

function sameSession(a: AppState['sessions'][number], b: AppState['sessions'][number]): boolean {
  return a.provider === b.provider
    && a.pid === b.pid
    && a.sessionId === b.sessionId
    && a.cwd === b.cwd
    && a.projectName === b.projectName
    && String(a.startedAt) === String(b.startedAt)
    && a.entrypoint === b.entrypoint
    && a.source === b.source
    && a.state === b.state
    && a.jsonlPath === b.jsonlPath
    && String(a.lastModified) === String(b.lastModified)
    && a.modelName === b.modelName
    && a.contextUsed === b.contextUsed
    && a.contextMax === b.contextMax
    && a.isWorktree === b.isWorktree
    && a.worktreeBranch === b.worktreeBranch
    && a.gitBranch === b.gitBranch
    && a.mainRepoName === b.mainRepoName
    && a.activityBreakdownKind === b.activityBreakdownKind
    && sameNumberRecord(a.toolCounts, b.toolCounts)
    && sameNumberRecord(a.activityBreakdown as Record<string, number> | null | undefined, b.activityBreakdown as Record<string, number> | null | undefined)
    && sameGitStats(a.gitStats, b.gitStats);
}

function stabilizeSessions(prev: AppState['sessions'], next: AppState['sessions']): AppState['sessions'] {
  if (prev.length === 0 || next.length === 0) return next;
  const prevById = new Map(prev.map(session => [session.sessionId, session]));
  let changed = prev.length !== next.length;
  const sessions = next.map(session => {
    const previous = prevById.get(session.sessionId);
    if (previous && sameSession(previous, session)) return previous;
    changed = true;
    return session;
  });
  if (!changed) {
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== sessions[i]) return sessions;
    }
    return prev;
  }
  return sessions;
}

function stabilizeAppState(prev: AppState, next: AppState): AppState {
  const sessions = stabilizeSessions(prev.sessions, next.sessions);
  return sessions === next.sessions ? next : { ...next, sessions };
}

function BootFallback({
  theme,
  message,
  onRetry,
  onQuit,
}: {
  theme: Theme;
  message: string;
  onRetry: () => void;
  onQuit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      gap: 10,
      padding: '22px 18px',
      background: theme.bg,
      color: theme.text,
      fontFamily: theme.fontSans,
    }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.headerAccent }}>
        {t('app.bootFallback.eyebrow')}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.2 }}>
        {t('app.bootFallback.title')}
      </div>
      <div style={{ fontSize: 12, color: theme.textMuted, lineHeight: 1.6 }}>
        {message}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
        <button
          onClick={onRetry}
          style={{
            background: `${theme.accent}22`,
            color: theme.accent,
            border: `1px solid ${theme.accent}44`,
            borderRadius: 8,
            padding: '7px 12px',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {t('app.bootFallback.retry')}
        </button>
        <button
          onClick={() => window.wmt.minimize().catch(() => {})}
          style={{
            background: theme.bgRow,
            color: theme.textDim,
            border: `1px solid ${theme.border}`,
            borderRadius: 8,
            padding: '7px 12px',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {t('app.bootFallback.minimize')}
        </button>
        <button
          onClick={onQuit}
          style={{
            background: `${theme.barRed}14`,
            color: theme.barRed,
            border: `1px solid ${theme.barRed}33`,
            borderRadius: 8,
            padding: '7px 12px',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {t('app.bootFallback.quit')}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const { t } = useTranslation();
  const isWidget = useMemo(() => new URLSearchParams(window.location.search).get('view') === 'widget', []);
  const [state, setState] = useState<AppState>(DEFAULT_STATE);
  const [view, setView] = useState<View>('main');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark');
  const [bootFallbackVisible, setBootFallbackVisible] = useState(false);
  const [bootFallbackMessage, setBootFallbackMessage] = useState(() => t('app.bootFallback.messageInitial'));
  const scrollingRef = useRef(false);
  const pendingStateRef = useRef<AppState | null>(null);
  const scrollTimerRef = useRef<number | null>(null);

  const revealRoot = useCallback(() => {
    const splash = document.getElementById('splash');
    const root = document.getElementById('root');
    if (splash) splash.style.display = 'none';
    if (root) root.style.display = '';
  }, []);

  const commitState = useCallback((next: AppState) => {
    setState(prev => stabilizeAppState(prev, normalizeState(next)));
  }, []);

  const applyState = useCallback((next: AppState) => {
    if (scrollingRef.current) {
      pendingStateRef.current = next;
      return;
    }
    commitState(next);
  }, [commitState]);

  const handleScrollActivity = useCallback(() => {
    scrollingRef.current = true;
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      scrollingRef.current = false;
      if (pendingStateRef.current) {
        const pending = pendingStateRef.current;
        pendingStateRef.current = null;
        commitState(pending);
      }
    }, 300);
  }, [commitState]);

  const refresh = useCallback(async () => {
    try {
      const s = await window.wmt.getState();
      if (s) {
        applyState(s);
        return;
      }
      setBootFallbackMessage(t('app.bootFallback.messageEmptyState'));
      setBootFallbackVisible(true);
      revealRoot();
    } catch (e) {
      console.error('state:get failed', e);
      setBootFallbackMessage(t('app.bootFallback.messageGetStateFailed'));
      setBootFallbackVisible(true);
      revealRoot();
    }
  }, [applyState, revealRoot, t]);

  const retryStartup = useCallback(async () => {
    try {
      const next = await window.wmt.forceRefresh();
      if (next) applyState(next);
      await refresh();
    } catch {
      await refresh();
    }
  }, [applyState, refresh]);

  useEffect(() => {
    refresh();
    const cleanup = window.wmt.onUpdated(applyState);
    return cleanup;
  }, [refresh, applyState]);

  // widget 창은 transparent window이므로 body 배경을 투명하게
  useEffect(() => {
    if (!isWidget) return;
    const root = document.getElementById('root');
    const previous = {
      htmlBackground: document.documentElement.style.background,
      htmlBackgroundColor: document.documentElement.style.backgroundColor,
      bodyBackground: document.body.style.background,
      bodyBackgroundColor: document.body.style.backgroundColor,
      rootBackground: root?.style.background ?? '',
    };

    document.documentElement.style.background = 'transparent';
    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.background = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    if (root) root.style.background = 'transparent';

    return () => {
      document.documentElement.style.background = previous.htmlBackground;
      document.documentElement.style.backgroundColor = previous.htmlBackgroundColor;
      document.body.style.background = previous.bodyBackground;
      document.body.style.backgroundColor = previous.bodyBackgroundColor;
      if (root) root.style.background = previous.rootBackground;
    };
  }, [isWidget]);

  useEffect(() => {
    if (isWidget) return;
    return window.wmt.onNavigate(nextView => {
      if (nextView === 'main' || nextView === 'settings' || nextView === 'notifications' || nextView === 'help') {
        setView(nextView);
      }
    });
  }, [isWidget]);

  useEffect(() => () => {
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
  }, []);

  useEffect(() => {
    if (view !== 'main') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      window.wmt.minimize().catch(() => {});
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view]);

  // 시스템 테마 감지: 초기 resolve + 실시간 변경 리스너
  useEffect(() => {
    window.wmt.getResolvedTheme().then(setResolvedTheme);
    const cleanup = window.wmt.onThemeChanged(setResolvedTheme);
    return cleanup;
  }, []);

  // settings.theme 변경 시 재resolve (auto가 아니면 직접 사용)
  useEffect(() => {
    const t = state.settings.theme;
    if (t === 'auto') {
      window.wmt.getResolvedTheme().then(setResolvedTheme);
    } else {
      setResolvedTheme(t);
    }
  }, [state.settings.theme]);

  // 핵심 상태가 준비되면 스플래시를 닫고, 장시간 응답이 없으면 복구 화면으로 전환한다.
  useEffect(() => {
    if (isWidget) {
      revealRoot();
      return;
    }
    if (state.initialRefreshComplete) {
      setBootFallbackVisible(false);
      revealRoot();
      return;
    }
    const timer = window.setTimeout(() => {
      setBootFallbackMessage(t('app.bootFallback.messageTimeout'));
      setBootFallbackVisible(true);
      revealRoot();
    }, BOOT_FALLBACK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isWidget, state.initialRefreshComplete, revealRoot, t]);

  async function handleSaveSettings(partial: Partial<AppSettings>) {
    const updated = await window.wmt.setSettings(partial);
    setState(prev => ({ ...prev, settings: updated }));
  }

  const handleToggleCompactWidget = useCallback(async () => {
    const updated = await window.wmt.setSettings({ compactWidgetEnabled: !state.settings.compactWidgetEnabled });
    setState(prev => ({ ...prev, settings: updated }));
  }, [state.settings.compactWidgetEnabled]);

  const handleToggleTaskbarQuota = useCallback(async () => {
    const updated = await window.wmt.setSettings({ taskbarQuotaEnabled: !state.settings.taskbarQuotaEnabled });
    setState(prev => ({ ...prev, settings: updated }));
  }, [state.settings.taskbarQuotaEnabled]);

  const handleQuit = useCallback(() => {
    window.wmt.quit().catch(() => window.close());
  }, []);

  const theme = useMemo(() => getTheme(resolvedTheme), [resolvedTheme]);

  // CSS 커스텀 프로퍼티 동기화 — body/scrollbar 등 CSS 레벨에서 var(--wmt-*) 사용 가능
  useEffect(() => { applyThemeCssVars(theme); }, [theme]);
  useEffect(() => { applyLanguagePreference(state.settings.language); }, [state.settings.language]);

  const bgStyle: React.CSSProperties = { background: theme.bg, height: '100vh', color: theme.text };

  if (isWidget) {
    return (
      <ThemeProvider value={theme}>
        <RenderErrorBoundary label="Compact Widget" fill>
          <CompactWidgetView state={state} onRefresh={retryStartup} />
        </RenderErrorBoundary>
      </ThemeProvider>
    );
  }

  if (bootFallbackVisible && !state.initialRefreshComplete && view === 'main') {
    return (
      <ThemeProvider value={theme}>
        <RenderErrorBoundary label="Startup Recovery" fill>
          <BootFallback theme={theme} message={bootFallbackMessage} onRetry={retryStartup} onQuit={handleQuit} />
        </RenderErrorBoundary>
      </ThemeProvider>
    );
  }

  if (view === 'settings') {
    return (
      <ThemeProvider value={theme}>
        <RenderErrorBoundary label="Settings View" fill>
          <div style={bgStyle}>
            <SettingsView settings={state.settings} providerQuotas={state.providerQuotas} onSave={handleSaveSettings} onBack={() => setView('main')} />
          </div>
        </RenderErrorBoundary>
      </ThemeProvider>
    );
  }

  if (view === 'notifications') {
    return (
      <ThemeProvider value={theme}>
        <RenderErrorBoundary label="Notifications View" fill>
          <div style={bgStyle}>
            <NotificationsView onBack={() => setView('main')} />
          </div>
        </RenderErrorBoundary>
      </ThemeProvider>
    );
  }

  if (view === 'help') {
    return (
      <ThemeProvider value={theme}>
        <RenderErrorBoundary label="Help View" fill>
          <div style={bgStyle}>
            <HelpView onBack={() => setView('main')} />
          </div>
        </RenderErrorBoundary>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider value={theme}>
      <RenderErrorBoundary label="Main View" fill>
        <MainView
          state={state}
          onNav={setView}
          onQuit={handleQuit}
          onRefresh={refresh}
          onScrollActivity={handleScrollActivity}
          onToggleCompactWidget={handleToggleCompactWidget}
          onToggleTaskbarQuota={handleToggleTaskbarQuota}
        />
      </RenderErrorBoundary>
    </ThemeProvider>
  );
}
