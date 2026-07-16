import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';
import { projectKeysForCwd } from './providers/shared/repoContext';
import { UsageData, UsageWindowResetHints } from './usageWindows';
import { AppSettings, DEFAULT_SETTINGS, normalizeSettings } from './ipc';
import { API_USAGE_CACHE_SCHEMA_VERSION, CLAUDE_API_MAX_BACKOFF_MS, ApiUsagePct, ClaudeApiStatus, hasClaudeCredentials, normalizeStoredApiUsagePct } from './rateLimitFetcher';
import { CODEX_RESET_CREDITS_CACHE_SCHEMA_VERSION, CODEX_USAGE_CACHE_SCHEMA_VERSION, CODEX_USAGE_MAX_BACKOFF_MS, CodexResetCreditsData, CodexUsagePct, CodexUsageStatus, getCodexAuthIdentityHash, getCodexAuthMtimeMs, hasCodexUsageCredentials, normalizeStoredCodexResetCredits, normalizeStoredCodexUsagePct } from './codexUsageFetcher';
import { checkAlerts } from './usageAlertManager';
import Store from 'electron-store';
import { BridgeWatcher, LiveSessionData } from './bridgeWatcher';
import { aggregateDailyAllStats, aggregateDailyStats, buildDaily7dWindow, getGitStatsAsync, GitDailyStats, GitStats } from './gitStatsCollector';
import {
  GitOutputLedgerStore,
  buildCategoryNetLines,
  buildCodeOutputFromGitLedger,
  hasCommitsInRange,
} from './gitOutputLedger';
import { isSafeLocalCwd } from './pathSafety';
import { clearSessionMetadataCache, invalidateSessionMetadataCache } from './sessionMetadata';
import { normalizeGitCwdKey, normalizeGitPathKey, preferGitStats, repoKeyFromGitStats } from './gitStatsKeys';
import { ActivityBreakdown, ActivityBreakdownKind, CodexRateLimitWindow, FileUsageSummary, SessionSnapshot } from './jsonlTypes';
import { CodexAccountState, readCodexAccountState } from './codexAccount';
import { appendDebugMemoryLog, collectRuntimeMemorySnapshot, isDebugInstrumentationEnabled } from './debugInstrumentation';
import { getOAuthCredentialMarker } from './oauthRefresh';
import { RefreshRequest, RefreshScheduler, RefreshWork } from './refreshScheduler';
import { UsageTrendData, emptyUsageTrendData } from './usageTrendTypes';
import { bucketDateRange, type BreakdownGrain } from '../shared/bucketKey';
import {
  emptyOutputComposition,
  emptyToolActivity,
  type BucketBreakdown,
  type ProviderBreakdown,
} from '../shared/breakdownTypes';
import { makeStartupStateSnapshot, normalizeStartupStateSnapshot, StateFreshness } from './startupStateSnapshot';
import { createProviderRegistry, ProviderRegistry } from './providers';
import type {
  DiscoveredSession,
  ExcludedProjectMatcher,
  ProviderAdapter,
  ProviderContext,
  ProviderCreditBalance,
  ProviderModelQuota,
  ProviderQuotaDisplayBadge,
  ProviderQuotaGroupSpec,
  ProviderQuotaRowVisualKind,
  ProviderId,
  ProviderQuotaSnapshot,
  ProviderQuotaStatus,
  ProviderResetCredit,
  ProviderResetCreditsData,
  ProviderQuotaWindow,
  ProviderQuotaWindowDisplay,
  ProviderSource,
  QuotaDisplayMode,
  SessionDiscoveryScope,
  SessionState,
  SourceBackedProviderAdapter,
} from './providers/types';
import { PROVIDER_IDS, isProviderEnabled } from './providers/settings';
import { buildClaudeQuotaDisplayMetadata, isClaudeQuotaSnapshot } from './providers/claude/quota';
import { buildCodexQuotaDisplayMetadata, CodexProviderQuotaSnapshot, isCodexQuotaSnapshot } from './providers/codex/quota';
import {
  buildUsageVisibilityFilter,
  usageProviderVisible,
  type UsageVisibilityFilter,
} from './usageVisibilityFilter';
import {
  DefaultUsageIndex,
  InMemoryUsageIndexStorage,
  type UsageIndex,
  type UsageIndexCoverage,
  type UsageIndexHealth,
  type UsageSessionProjection,
  type UsageSourceDescriptor,
  type UsageSourceScanner,
} from './usageIndex';
import {
  buildTrendDataFromUsageIndex,
  computeUsageFromUsageIndex,
  loadUsageIndexProjection,
  type UsageIndexProjection,
} from './usageIndexPresentation';

export interface SessionInfo extends DiscoveredSession {
  modelName: string;
  contextUsed: number;
  contextMax: number;
  toolCounts: Record<string, number>;
  gitStats: GitStats | null;
  activityBreakdown: ActivityBreakdown | null;
  activityBreakdownKind: ActivityBreakdownKind | null;
}

export interface CodeOutputStats {
  today: { commits: number; added: number; removed: number };
  all: { commits: number; added: number; removed: number };
  daily7d: GitDailyStats[];
  dailyAll: GitDailyStats[];
  repoCount: number;
  scopeLabel: string;
}

export interface DebugMemSnapshot {
  label: string;
  ts: string;
  runtime: ReturnType<typeof collectRuntimeMemorySnapshot>;
  collections: {
    summaries: number;
    sessions: number;
    repoGitStats: number;
    gitStatsCache: number;
    dirtySessionFiles: number;
    deferredFastFiles: number;
  };
  watcher: {
    profile: WatcherProfile;
    targets: number;
    watchedDirectories: number;
    watchedFiles: number;
  };
}

export type ProviderQuotaMap = Partial<Record<ProviderId, ProviderQuotaSnapshot>>;

const INDEXED_USAGE_PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'antigravity'];

function isIndexedUsageProvider(provider: ProviderId): boolean {
  return INDEXED_USAGE_PROVIDERS.includes(provider);
}

export interface AppState {
  sessions: SessionInfo[];
  usage: UsageData;
  usageTrend: UsageTrendData;
  providerQuotas: ProviderQuotaMap;
  settings: AppSettings;
  codexAccount: CodexAccountState;
  stateFreshness: StateFreshness;
  initialRefreshComplete: boolean;
  historyWarmupPending: boolean;
  historyWarmupStartsAt: number | null;
  usageIndexCoverage: UsageIndexCoverage;
  usageIndexHealth: UsageIndexHealth;
  lastUpdated: number;
  apiConnected: boolean;
  apiStatusLabel?: string;
  apiError?: string;
  codexUsageConnected: boolean;
  codexStatusLabel?: string;
  codexError?: string;
  bridgeActive: boolean;
  repoGitStats: Record<string, GitStats>;
  codeOutputStats: CodeOutputStats;
  codeOutputLoading: boolean;
  allTimeSessions: number;
}

type WatcherProfile = 'wide' | 'recent' | 'off';
type WatcherMode = 'auto' | 'wide' | 'recent';

const PROVIDER_QUOTA_SOURCES: ProviderQuotaSnapshot['source'][] = ['api', 'statusLine', 'localLog', 'localRpc', 'cache'];
const QUOTA_DISPLAY_MODES: QuotaDisplayMode[] = ['rich', 'simple', 'none'];
const QUOTA_ROW_VISUAL_KINDS: ProviderQuotaRowVisualKind[] = ['pace', 'percentOnly'];
const QUOTA_BADGE_TONES: Array<NonNullable<ProviderQuotaDisplayBadge['tone']>> = ['good', 'neutral', 'warning'];

interface PerfSampleStart {
  wallNs: bigint;
  cpu: NodeJS.CpuUsage;
}

interface PerfMetrics {
  elapsedMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuTotalMs: number;
}

interface SessionBuildResult {
  sessions: SessionInfo[];
  discoveryScope: SessionDiscoveryScope;
  discoveredCount: number;
  dedupedCount: number;
  reusedCount: number;
  sessionCountDelta: number;
  anomaly?: string;
}


const NULL_RESET_CACHE_TTL_MS = 30 * 60 * 1000;
const CODEX_H5_WINDOW_MS = 5 * 60 * 60 * 1000;
const CODEX_WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CODEX_RESET_COUNT_ONLY_TTL_MS = 10 * 60 * 1000;
const STARTUP_STATE_SNAPSHOT_KEY = '_startupStateSnapshot';

function getJsonlMtime(filePath: string): Date | null {
  try { return fs.statSync(filePath).mtime; }
  catch { return null; }
}

function ageResetMs(resetMs: number | null, elapsedMs: number): number | null {
  if (resetMs == null) return null;
  return Math.max(0, resetMs - elapsedMs);
}

function ageCachedPct(pct: number, resetMs: number | null, elapsedMs: number): number {
  if (resetMs == null) return elapsedMs > NULL_RESET_CACHE_TTL_MS ? 0 : pct;
  return elapsedMs > resetMs ? 0 : pct;
}

function ageApiUsageSample(sample: ApiUsagePct, elapsedMs: number): ApiUsagePct {
  const h5Expired = sample.h5ResetMs == null
    ? elapsedMs > NULL_RESET_CACHE_TTL_MS
    : elapsedMs > sample.h5ResetMs;
  const weekExpired = sample.weekResetMs == null
    ? elapsedMs > NULL_RESET_CACHE_TTL_MS
    : elapsedMs > sample.weekResetMs;
  const h5ResetMs = h5Expired ? null : ageResetMs(sample.h5ResetMs, elapsedMs);
  const weekResetMs = weekExpired ? null : ageResetMs(sample.weekResetMs, elapsedMs);
  return {
    ...sample,
    h5Pct: h5Expired ? 0 : sample.h5Pct,
    weekPct: weekExpired ? 0 : sample.weekPct,
    soPct: ageCachedPct(sample.soPct, sample.soResetMs, elapsedMs),
    h5ResetMs,
    weekResetMs,
    soResetMs: ageResetMs(sample.soResetMs, elapsedMs),
    extraUsage: sample.extraUsage ?? null,
  };
}

function ageCodexUsageSample(sample: CodexUsagePct, elapsedMs: number): CodexUsagePct {
  const h5Expired = !sample.h5Available || (sample.h5ResetMs == null
    ? elapsedMs > NULL_RESET_CACHE_TTL_MS
    : elapsedMs > sample.h5ResetMs);
  const weekExpired = !sample.weekAvailable || (sample.weekResetMs == null
    ? elapsedMs > NULL_RESET_CACHE_TTL_MS
    : elapsedMs > sample.weekResetMs);
  return {
    ...sample,
    h5Available: !h5Expired,
    weekAvailable: !weekExpired,
    h5Pct: h5Expired ? 0 : sample.h5Pct,
    weekPct: weekExpired ? 0 : sample.weekPct,
    h5ResetMs: h5Expired ? null : ageResetMs(sample.h5ResetMs, elapsedMs),
    weekResetMs: weekExpired ? null : ageResetMs(sample.weekResetMs, elapsedMs),
    h5LimitReached: !h5Expired && sample.h5LimitReached,
    weekLimitReached: !weekExpired && sample.weekLimitReached,
    limitReached: sample.limitReached && (!h5Expired || !weekExpired),
  };
}

function hasMeaningfulQuotaWindow(window: ProviderQuotaWindow | null | undefined): boolean {
  if (!window) return false;
  return window.pct > 0
    || window.resetMs != null
    || !!window.resetLabel
    || window.source === 'api'
    || window.source === 'statusLine'
    || window.source === 'localLog';
}

function emptyQuotaWindow(): ProviderQuotaWindow {
  return { pct: 0, resetMs: null };
}

function quotaRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteQuotaNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeQuotaInteger(value: unknown): number | undefined {
  const numberValue = finiteQuotaNumber(value);
  return numberValue == null ? undefined : Math.max(0, Math.round(numberValue));
}

function validQuotaIsoOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : undefined;
}

function quotaString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function quotaStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim());
  return list.length > 0 ? list : undefined;
}

function quotaSource(value: unknown, fallback: ProviderQuotaSnapshot['source'] = 'cache'): ProviderQuotaSnapshot['source'] {
  return typeof value === 'string' && PROVIDER_QUOTA_SOURCES.includes(value as ProviderQuotaSnapshot['source'])
    ? value as ProviderQuotaSnapshot['source']
    : fallback;
}

function quotaDisplayMode(value: unknown): QuotaDisplayMode {
  return typeof value === 'string' && (QUOTA_DISPLAY_MODES as readonly string[]).includes(value)
    ? value as QuotaDisplayMode
    : 'simple';
}

function quotaVisualKind(value: unknown): ProviderQuotaRowVisualKind | undefined {
  return typeof value === 'string' && (QUOTA_ROW_VISUAL_KINDS as readonly string[]).includes(value)
    ? value as ProviderQuotaRowVisualKind
    : undefined;
}

function quotaBadgeTone(value: unknown): 'good' | 'neutral' | 'warning' | undefined {
  return typeof value === 'string' && (QUOTA_BADGE_TONES as readonly string[]).includes(value)
    ? value as 'good' | 'neutral' | 'warning'
    : undefined;
}

function sanitizeQuotaWindow(value: unknown): ProviderQuotaWindow | null {
  const record = quotaRecord(value);
  if (!record) return null;
  const resetMs = finiteQuotaNumber(record.resetMs);
  const pct = finiteQuotaNumber(record.pct) ?? 0;
  return {
    pct: Math.max(0, Math.min(100, pct)),
    resetMs: resetMs ?? null,
    resetLabel: quotaString(record.resetLabel),
    source: typeof record.source === 'string' ? quotaSource(record.source) : undefined,
  };
}

function sanitizeQuotaWindows(value: unknown): ProviderQuotaSnapshot['windows'] | undefined {
  const record = quotaRecord(value);
  if (!record) return undefined;
  const windows: NonNullable<ProviderQuotaSnapshot['windows']> = {};
  for (const [key, entry] of Object.entries(record)) {
    const window = sanitizeQuotaWindow(entry);
    if (window) windows[key] = window;
  }
  return Object.keys(windows).length > 0 ? windows : undefined;
}

function sanitizeQuotaBadge(value: unknown): ProviderQuotaDisplayBadge | null {
  const record = quotaRecord(value);
  const key = quotaString(record?.key);
  const label = quotaString(record?.label);
  if (!key || !label) return null;
  return {
    key,
    label,
    title: quotaString(record?.title),
    tone: quotaBadgeTone(record?.tone),
  };
}

function sanitizeQuotaBadges(value: unknown): ProviderQuotaDisplayBadge[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const badges = value
    .map(sanitizeQuotaBadge)
    .filter((badge): badge is ProviderQuotaDisplayBadge => !!badge);
  return badges.length > 0 ? badges : undefined;
}

function sanitizeQuotaGroup(value: unknown): ProviderQuotaGroupSpec | null {
  const record = quotaRecord(value);
  const key = quotaString(record?.key);
  const label = quotaString(record?.label);
  const windowKeys = Array.isArray(record?.windowKeys)
    ? record.windowKeys.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : undefined;
  if (!record || !key || !label || !windowKeys) return null;
  return {
    key,
    label,
    windowKeys,
    defaultMode: quotaDisplayMode(record.defaultMode),
    accentColor: quotaString(record.accentColor),
    badges: sanitizeQuotaBadges(record.badges),
    sortOrder: finiteQuotaNumber(record.sortOrder),
  };
}

function sanitizeQuotaGroups(value: unknown): ProviderQuotaGroupSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groups = value
    .map(sanitizeQuotaGroup)
    .filter((group): group is ProviderQuotaGroupSpec => !!group);
  return groups.length > 0 ? groups : undefined;
}

function sanitizeQuotaWindowDisplay(value: unknown): ProviderQuotaWindowDisplay | null {
  const record = quotaRecord(value);
  const label = quotaString(record?.label);
  if (!record || !label) return null;
  return {
    label,
    visualKind: quotaVisualKind(record.visualKind),
    cacheMetricTitle: quotaString(record.cacheMetricTitle),
    durationMs: finiteQuotaNumber(record.durationMs),
    modelIncludes: quotaStringList(record.modelIncludes),
    hideCost: record.hideCost === true,
    badges: sanitizeQuotaBadges(record.badges),
  };
}

function sanitizeQuotaWindowDisplayMap(value: unknown): ProviderQuotaSnapshot['windowDisplay'] | undefined {
  const record = quotaRecord(value);
  if (!record) return undefined;
  const display: Record<string, ProviderQuotaWindowDisplay> = {};
  for (const [key, entry] of Object.entries(record)) {
    const item = sanitizeQuotaWindowDisplay(entry);
    if (item) display[key] = item;
  }
  return Object.keys(display).length > 0 ? display : undefined;
}

function sanitizeProviderQuotaStatus(value: unknown): ProviderQuotaStatus | undefined {
  const record = quotaRecord(value);
  if (!record) return undefined;
  return {
    connected: record.connected === true,
    code: quotaString(record.code) ?? 'unknown',
    label: quotaString(record.label),
    detail: quotaString(record.detail),
    severity: record.severity === 'ok' || record.severity === 'warning' || record.severity === 'danger'
      ? record.severity
      : undefined,
  };
}

function sanitizeProviderCredit(value: unknown): ProviderCreditBalance | null {
  const record = quotaRecord(value);
  if (!record) return null;
  const resetMs = finiteQuotaNumber(record.resetMs);
  return {
    available: Math.max(0, finiteQuotaNumber(record.available) ?? 0),
    used: finiteQuotaNumber(record.used),
    total: finiteQuotaNumber(record.total),
    remainingPct: finiteQuotaNumber(record.remainingPct),
    resetMs: resetMs ?? (record.resetMs === null ? null : undefined),
  };
}

function sanitizeProviderCredits(value: unknown): ProviderQuotaSnapshot['credits'] | undefined {
  const record = quotaRecord(value);
  if (!record) return undefined;
  const credits: Record<string, ProviderCreditBalance> = {};
  for (const [key, entry] of Object.entries(record)) {
    const credit = sanitizeProviderCredit(entry);
    if (credit) credits[key] = credit;
  }
  return Object.keys(credits).length > 0 ? credits : undefined;
}

function sanitizeProviderModelQuota(value: unknown): ProviderModelQuota | null {
  const record = quotaRecord(value);
  const model = quotaString(record?.model);
  const label = quotaString(record?.label);
  if (!record || !model || !label) return null;
  return {
    model,
    label,
    usageModel: quotaString(record.usageModel),
    statsWindowKey: quotaString(record.statsWindowKey),
    remainingPct: Math.max(0, Math.min(100, finiteQuotaNumber(record.remainingPct) ?? 0)),
    resetMs: finiteQuotaNumber(record.resetMs) ?? (record.resetMs === null ? null : undefined),
    groupKey: quotaString(record.groupKey),
    defaultMode: record.defaultMode == null ? undefined : quotaDisplayMode(record.defaultMode),
    visualKind: quotaVisualKind(record.visualKind),
    cacheMetricTitle: quotaString(record.cacheMetricTitle),
    durationMs: finiteQuotaNumber(record.durationMs),
    hideCost: record.hideCost === true,
    accentColor: quotaString(record.accentColor),
    badges: sanitizeQuotaBadges(record.badges),
  };
}

function sanitizeProviderModels(value: unknown): ProviderModelQuota[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models = value
    .map(sanitizeProviderModelQuota)
    .filter((model): model is ProviderModelQuota => !!model);
  return models.length > 0 ? models : undefined;
}

function isProviderIdValue(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function sanitizeProviderQuotaSnapshot(provider: ProviderId, value: unknown): ProviderQuotaSnapshot | null {
  const record = quotaRecord(value);
  if (!record) return null;
  if (record.provider != null && record.provider !== provider) return null;
  return {
    provider,
    source: quotaSource(record.source),
    capturedAt: finiteQuotaNumber(record.capturedAt) ?? 0,
    accountLabel: quotaString(record.accountLabel),
    accountTooltip: quotaString(record.accountLabel),
    planName: quotaString(record.planName),
    windows: sanitizeQuotaWindows(record.windows),
    models: sanitizeProviderModels(record.models),
    groups: sanitizeQuotaGroups(record.groups),
    windowDisplay: sanitizeQuotaWindowDisplayMap(record.windowDisplay),
    credits: sanitizeProviderCredits(record.credits),
    status: sanitizeProviderQuotaStatus(record.status),
    resetCredits: sanitizeResetCredits(record.resetCredits),
  };
}

export function activeCodexResetCredits(
  data: CodexResetCreditsData,
  now: number,
  connected: boolean,
  latestStatus?: CodexUsageStatus | null,
): CodexResetCreditsData {
  const activeCredits = data.countOnly ? [] : data.credits.filter(c => {
    if (c.expiresAtUtc == null) return true;
    const ms = Date.parse(c.expiresAtUtc);
    return Number.isFinite(ms) && ms > now;
  });
  const attemptFailed = !!latestStatus && latestStatus.code !== 'ok';
  const status = attemptFailed ? latestStatus! : data.status;
  const source: 'api' | 'cache' | 'usage' = data.source === 'usage'
    ? 'usage'
    : (!connected || attemptFailed) ? 'cache' : data.source;
  return {
    ...data,
    credits: activeCredits,
    availableCount: data.countOnly ? data.availableCount : activeCredits.length,
    status,
    source,
  };
}

export function sanitizeResetCredits(value: unknown): ProviderResetCreditsData | null {
  const r = quotaRecord(value);
  if (!r) return null;
  const rawCredits = Array.isArray(r.credits) ? r.credits : [];
  const credits = rawCredits
    .map(quotaRecord)
    .filter((c): c is Record<string, unknown> => !!c)
    .map((c): ProviderResetCredit | null => {
      const expiresAtUtc = validQuotaIsoOrNull(c.expiresAtUtc);
      if (expiresAtUtc === undefined) return null;
      return {
        idSuffix: null,
        status: typeof c.status === 'string' ? c.status : 'available',
        expiresAtUtc,
      };
    })
    .filter((c): c is ProviderResetCredit => !!c);
  const sourceAvailableCount = nonNegativeQuotaInteger(r.availableCount) ?? credits.length;
  const countOnly = r.countOnly === true || sourceAvailableCount !== credits.length;
  const publicCredits = countOnly ? [] : credits;
  return {
    credits: publicCredits,
    availableCount: countOnly ? sourceAvailableCount : publicCredits.length,
    totalEarnedCount: nonNegativeQuotaInteger(r.totalEarnedCount) ?? 0,
    checkedAt: finiteQuotaNumber(r.checkedAt) ?? 0,
    countOnly,
    source: r.source === 'cache' ? 'cache' : r.source === 'usage' ? 'usage' : 'api',
    status: sanitizeProviderQuotaStatus(r.status) ?? { connected: false, code: 'unknown' },
  };
}

function sanitizeProviderQuotaMap(value: unknown): ProviderQuotaMap {
  const record = quotaRecord(value);
  if (!record) return {};
  const quotas: ProviderQuotaMap = {};
  for (const [provider, snapshot] of Object.entries(record)) {
    if (!isProviderIdValue(provider)) continue;
    const sanitized = sanitizeProviderQuotaSnapshot(provider, snapshot);
    if (sanitized) quotas[provider] = sanitized;
  }
  return quotas;
}

function canReuseClaudeCachedWindow(window: ProviderQuotaWindow | null | undefined): boolean {
  return hasMeaningfulQuotaWindow(window) && window?.source !== 'statusLine';
}

function approximateSessionState(lastModified: Date | null): SessionState {
  if (!lastModified) return 'idle';
  const diffMin = (Date.now() - lastModified.getTime()) / 60000;
  if (diffMin < 2) return 'active';
  if (diffMin < 15) return 'waiting';
  return 'idle';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function currentSessionState(provider: SessionInfo['provider'], pid: number | null, lastModified: Date | null): SessionState {
  if (provider === 'claude' && pid != null && !isProcessAlive(pid)) return 'idle';
  return approximateSessionState(lastModified);
}

function isSourceBackedProvider(provider: ProviderAdapter): provider is SourceBackedProviderAdapter {
  return typeof (provider as SourceBackedProviderAdapter).ownsPath === 'function'
    && typeof (provider as SourceBackedProviderAdapter).listRecentSources === 'function'
    && typeof (provider as SourceBackedProviderAdapter).listAllSources === 'function'
    && typeof (provider as SourceBackedProviderAdapter).usageIndexSource === 'function';
}

function gitStatsCacheKey(cwd: string): string {
  return normalizeGitCwdKey(cwd);
}

function normalizeFileKey(filePath: string): string {
  return path.normalize(filePath);
}

function makeExcludedMatcher(excludedProjects: readonly string[] = []): ExcludedProjectMatcher {
  const exact = new Set(excludedProjects.filter(Boolean));
  const folded = new Set([...exact].map(name => name.toLowerCase()));
  const matcher = ((keys: Array<string | null | undefined>) => keys.some(key => {
    if (!key) return false;
    return exact.has(key) || folded.has(key.toLowerCase());
  })) as { (keys: Array<string | null | undefined>): boolean; hasExclusions: boolean };
  matcher.hasExclusions = exact.size > 0;
  return matcher;
}

function isSameOrChildPath(parentPath: string | null, childPath: string | null): boolean {
  if (!parentPath || !childPath) return false;
  const parent = parentPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const child = childPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const fold = process.platform === 'win32'
    ? (value: string) => value.toLowerCase()
    : (value: string) => value;
  const parentKey = fold(parent);
  const childKey = fold(child);
  return childKey === parentKey || childKey.startsWith(`${parentKey}/`);
}

export function resolveSessionRepoKeys(
  sessions: Array<{ cwd: string; gitStats?: Pick<GitStats, 'gitCommonDir' | 'toplevel'> | null }>,
  repoGitStats: Record<string, Pick<GitStats, 'gitCommonDir' | 'toplevel'>>
): Set<string> {
  const scopedRepoKeys = new Set<string>();
  const repoEntries = Object.entries(repoGitStats)
    .map(([key, stats]) => ({
      repoKey: normalizeGitPathKey(key) ?? repoKeyFromGitStats(stats),
      topLevelKey: normalizeGitPathKey(stats.toplevel),
    }))
    .filter((entry): entry is { repoKey: string; topLevelKey: string | null } => !!entry.repoKey);

  for (const session of sessions) {
    const directKey = repoKeyFromGitStats(session.gitStats);
    if (directKey) scopedRepoKeys.add(directKey);

    const cwdKey = normalizeGitPathKey(session.cwd);
    if (!cwdKey) continue;
    for (const entry of repoEntries) {
      if (isSameOrChildPath(entry.topLevelKey, cwdKey)) scopedRepoKeys.add(entry.repoKey);
    }
  }

  return scopedRepoKeys;
}

function currentLedgerRepoStats<T extends Pick<GitStats, 'gitCommonDir' | 'toplevel'>>(
  sessions: Array<{ cwd: string; gitStats?: Pick<GitStats, 'gitCommonDir' | 'toplevel'> | null }>,
  repoGitStats: Record<string, T>
): T[] {
  const scopedRepoKeys = resolveSessionRepoKeys(sessions, repoGitStats);
  return Object.entries(repoGitStats)
    .filter(([key, stats]) => {
      if (scopedRepoKeys.size === 0) return true;
      const repoKey = normalizeGitPathKey(key);
      const topLevelKey = normalizeGitPathKey(stats.toplevel);
      return (!!repoKey && scopedRepoKeys.has(repoKey)) || (!!topLevelKey && scopedRepoKeys.has(topLevelKey));
    })
    .map(([, stats]) => stats);
}

export function currentLedgerRepoKeys<T extends Pick<GitStats, 'gitCommonDir' | 'toplevel'>>(
  sessions: Array<{ cwd: string; gitStats?: Pick<GitStats, 'gitCommonDir' | 'toplevel'> | null }>,
  repoGitStats: Record<string, T>
): string[] {
  return currentLedgerRepoStats(sessions, repoGitStats)
    .map(stats => repoKeyFromGitStats(stats) ?? normalizeGitPathKey(stats.toplevel))
    .filter((key): key is string => !!key);
}

function sessionSummaryFromProjection(
  projection: UsageSessionProjection,
  descriptor: UsageSourceDescriptor,
): FileUsageSummary {
  const snapshot = projection.payload.sessionSnapshot as SessionSnapshot | undefined;
  if (!snapshot) throw new Error(`Missing session snapshot for ${projection.sourceId}`);
  return {
    provider: descriptor.provider,
    projectKeys: [...(descriptor.projectKeys ?? [])],
    sessionSnapshot: snapshot,
    mtimeMs: descriptor.version.mtimeMs ?? projection.updatedAt,
    size: descriptor.version.size ?? projection.byteSize,
  };
}

function incompleteUsageIndexCoverage(): UsageIndexCoverage {
  return {
    state: 'incomplete',
    requiredSourceCount: 0,
    indexedSourceCount: 0,
    pendingSourceCount: 0,
    failedSourceCount: 0,
  };
}

export class StateManager {
  private store: Store<AppSettings>;
  private summaries = new Map<string, FileUsageSummary>();
  private state: AppState;
  private fastTimer: NodeJS.Timeout | null = null;
  private heavyTimer: NodeJS.Timeout | null = null;
  private quotaRefreshTimer: NodeJS.Timeout | null = null;
  private watcher: chokidar.FSWatcher | null = null;
  private fastDebounce: NodeJS.Timeout | null = null;
  private onUpdate: (s: AppState) => void;
  private apiUsagePct: ApiUsagePct | null = null;
  private apiUsagePctStoredAt = 0;
  private apiConnected = false;
  private apiStatusLabel = '';
  private apiError = '';
  private lastApiCallMs = 0;
  private apiBackoffMs = 0;
  private apiRequestSeq = 0;
  private lastOAuthCredentialMarker: string | null = null;
  private codexUsagePct: CodexUsagePct | null = null;
  private codexUsagePctStoredAt = 0;
  private codexUsageAuthMtimeMs: number | null = null;
  private codexUsageAuthIdentityHash: string | null = null;
  private codexUsageAttemptAuthMtimeMs: number | null = null;
  private codexUsageAttemptAuthIdentityHash: string | null = null;
  private codexAuthMissingObserved = false;
  private codexUsageConnected = false;
  private codexStatusLabel = '';
  private codexError = '';
  private lastCodexUsageCallMs = 0;
  private codexUsageBackoffMs = 0;
  private codexUsageRequestSeq = 0;
  private codexResetCredits: CodexResetCreditsData | null = null;
  private codexResetCountOnlyFallback: CodexResetCreditsData | null = null;
  private codexResetCreditsStoredAt = 0;
  private codexResetAuthMtimeMs: number | null = null;
  private codexResetAuthIdentityHash: string | null = null;
  private codexResetAttemptAuthMtimeMs: number | null = null;
  private codexResetAttemptAuthIdentityHash: string | null = null;
  private codexResetStatus: CodexUsageStatus | null = null;
  private codexResetBackoffMs = 0;
  private lastCodexResetCallMs = 0;
  private providerQuotaRequestSeqs = new Map<ProviderId, number>();
  private providerQuotaSnapshots = new Map<ProviderId, ProviderQuotaSnapshot>();
  private lastManualProviderUsageForceMs = 0;
  private bridgeWatcher: BridgeWatcher;
  private refreshScheduler: RefreshScheduler;
  private liveSession: LiveSessionData | null = null;
  private readonly providerRegistry: ProviderRegistry;
  private readonly usageIndex: UsageIndex;
  private usageIndexProjections: UsageIndexProjection[] = [];
  private usageIndexCoverage = incompleteUsageIndexCoverage();
  private codexRateLimits: SessionSnapshot['codexRateLimits'] | null = null;
  private gitStatsCache = new Map<string, { stats: GitStats | null; ts: number }>();
  private dirtySessionFiles = new Set<string>();
  private gitOutputLedgerStore = new GitOutputLedgerStore();
  private historyWarmupTimer: NodeJS.Timeout | null = null;
  private gitWarmupTimer: NodeJS.Timeout | null = null;
  private foregroundRefreshTimer: NodeJS.Timeout | null = null;
  private wideWatcherPromotionTimer: NodeJS.Timeout | null = null;
  private debugMemTimer: NodeJS.Timeout | null = null;
  private uiBusy = false;
  private uiVisible = false;
  private startupFreshComplete = false;
  private watcherProfile: WatcherProfile = 'off';
  private watcherTargetCount = 0;
  private repoGitStatsLastRefresh = 0;
  private static readonly API_MIN_INTERVAL_MS = 300_000;
  private static readonly CODEX_USAGE_MIN_INTERVAL_MS = 300_000;
  private static readonly CODEX_RESET_MIN_INTERVAL_MS = 300_000;
  private static readonly MANUAL_PROVIDER_USAGE_FORCE_MIN_INTERVAL_MS = 60_000;
  private static readonly GIT_STATS_TTL_MS = 600_000;
  private static readonly FAST_REFRESH_VISIBLE_MS = 60_000;
  private static readonly HEAVY_REFRESH_VISIBLE_MS = 300_000;
  private static readonly FAST_REFRESH_HIDDEN_MS = 300_000;
  private static readonly HEAVY_REFRESH_HIDDEN_MS = 900_000;
  private static readonly STARTUP_SCAN_BUDGET_MS = 2_500;
  private static readonly FOREGROUND_REFRESH_DELAY_MS = 750;
  private static readonly FOREGROUND_SCAN_BUDGET_MS = 2_500;
  private static readonly FOREGROUND_WARMUP_DELAY_MS = 3_000;
  private static readonly WIDE_WATCHER_PROMOTION_DELAY_MS = 5_000;
  private static readonly STARTUP_WARMUP_DELAY_MS = 30_000;
  private static readonly STARTUP_GIT_DELAY_MS = 60_000;
  private static readonly STARTUP_CLAUDE_FILE_LIMIT = 48;
  private static readonly STARTUP_CODEX_FILE_LIMIT = 96;
  private static readonly CODEX_RATE_LIMIT_FAST_FILE_LIMIT = 24;
  private static readonly HIDDEN_CLAUDE_WATCH_LIMIT = 24;
  private static readonly HIDDEN_CODEX_WATCH_LIMIT = 48;
  private static readonly SESSION_SCOPE: SessionDiscoveryScope = 'recent-active';
  private static readonly SESSION_SPIKE_MARGIN = 24;

  constructor(
    store: Store<AppSettings>,
    onUpdate: (s: AppState) => void,
    options: { providerRegistry?: ProviderRegistry; usageIndex?: UsageIndex } = {},
  ) {
    this.store = store;
    this.onUpdate = onUpdate;
    this.providerRegistry = options.providerRegistry ?? createProviderRegistry();
    this.usageIndex = options.usageIndex ?? new DefaultUsageIndex(new InMemoryUsageIndexStorage());
    this.state = this.emptyState();
    const restoredState = normalizeStartupStateSnapshot(
      this.getPersistedValue(STARTUP_STATE_SNAPSHOT_KEY, null),
      this.state,
    );
    if (restoredState) this.state = this.reviveRestoredState(restoredState);
    const oauthCredentialMarker = getOAuthCredentialMarker();
    this.lastOAuthCredentialMarker = oauthCredentialMarker;
    this.refreshScheduler = new RefreshScheduler({
      foregroundScanBudgetMs: StateManager.FOREGROUND_SCAN_BUDGET_MS,
      getState: () => ({ uiVisible: this.uiVisible, uiBusy: this.uiBusy }),
      execute: (work) => this.executeRefresh(work),
    });
    const cachedRaw = this.getPersistedValue('_cachedApiPct', null);
    const cached = normalizeStoredApiUsagePct(cachedRaw, oauthCredentialMarker);
    if (cachedRaw && !cached) {
      this.deletePersistedValue('_cachedApiPct');
    }
    if (cached && hasClaudeCredentials()) {
      this.apiUsagePctStoredAt = cached.storedAt;
      this.apiUsagePct = cached;
    }
    const settings = this.getSettings();
    if (settings.enabledProviders.includes('codex')) {
      this.hydrateCodexCachesFromStore(settings);
      if (this.codexUsagePct || this.codexResetCredits) {
        this.state = {
          ...this.state,
          providerQuotas: this.buildProviderQuotas(Date.now(), settings),
          codexAccount: this.codexAccountForSettings(settings),
          codexUsageConnected: this.codexUsageConnected,
          codexStatusLabel: this.codexStatusLabel || undefined,
          codexError: this.codexError || undefined,
        };
      }
    }
    this.bridgeWatcher = new BridgeWatcher((data) => {
      this.liveSession = data;
      this.state = {
        ...this.state,
        providerQuotas: this.buildProviderQuotas(Date.now(), this.getSettings()),
        bridgeActive: true,
        apiConnected: this.apiConnected,
        apiStatusLabel: this.apiStatusLabel || undefined,
        apiError: this.apiError || undefined,
        codexUsageConnected: this.codexUsageConnected,
        codexStatusLabel: this.codexStatusLabel || undefined,
        codexError: this.codexError || undefined,
        stateFreshness: this.currentStateFreshness(),
      };
      this.publishState();
    });
  }

  async getBreakdown(grain: BreakdownGrain, bucketKey: string): Promise<BucketBreakdown> {
    const settings = this.getSettings();
    const repoKeys = this.getCurrentLedgerRepoKeys();
    const enabledProviders = this.enabledProviderSet(settings);
    const canUseGit = (settings.excludedProjects?.length ?? 0) === 0 && repoKeys.length > 0;
    const { startDate, endDate } = bucketDateRange(grain, bucketKey);
    const git = this.gitOutputLedgerStore.getSnapshot();
    const netLines = canUseGit && hasCommitsInRange(git, repoKeys, startDate, endDate)
      ? buildCategoryNetLines(git, repoKeys, startDate, endDate)
      : null;
    const indexedProviders = await this.queryIndexedProviderBreakdowns(
      grain,
      bucketKey,
      [...enabledProviders].filter(isIndexedUsageProvider),
      settings.excludedProjects ?? [],
    );
    return {
      grain,
      bucketKey,
      providers: indexedProviders.sort((a, b) => a.provider.localeCompare(b.provider)),
      netLines,
    };
  }

  private async queryIndexedProviderBreakdowns(
    grain: BreakdownGrain,
    bucketKey: string,
    providers: readonly ProviderId[],
    excludedProjectKeys: readonly string[],
  ): Promise<ProviderBreakdown[]> {
    const { startDate, endDate } = bucketDateRange(grain, bucketKey);
    const fromMs = new Date(`${startDate}T00:00:00`).getTime();
    const afterEnd = new Date(`${endDate}T00:00:00`);
    afterEnd.setDate(afterEnd.getDate() + 1);
    const toMs = afterEnd.getTime();
    const queryGrain = grain === 'month' ? 'month' : 'day';
    const results = await Promise.all(providers.map(async (provider): Promise<ProviderBreakdown | null> => {
      const providerScope = new Set<ProviderId>([provider]);
      const [usage, breakdown] = await Promise.all([
        this.usageIndex.queryUsage({
          grain: queryGrain,
          providers: providerScope,
          excludedProjectKeys,
          fromMs,
          toMs,
        }),
        this.usageIndex.queryBreakdown({
          grain: queryGrain,
          providers: providerScope,
          excludedProjectKeys,
          fromMs,
          toMs,
        }),
      ]);
      const hasUsage = usage.aggregate.requestCount > 0
        || usage.aggregate.inputTokens > 0
        || usage.aggregate.outputTokens > 0;
      if (!hasUsage) return null;
      const output = emptyOutputComposition();
      output.thinking = breakdown.aggregate.thinking;
      output.response = breakdown.aggregate.response;
      output.toolOutput.read = breakdown.aggregate.toolOutputRead;
      output.toolOutput.editWrite = breakdown.aggregate.toolOutputEditWrite;
      output.toolOutput.search = breakdown.aggregate.toolOutputSearch;
      output.toolOutput.git = breakdown.aggregate.toolOutputGit;
      output.toolOutput.buildTest = breakdown.aggregate.toolOutputBuildTest;
      output.toolOutput.terminal = breakdown.aggregate.toolOutputTerminal;
      output.toolOutput.subagents = breakdown.aggregate.toolOutputSubagents;
      output.toolOutput.web = breakdown.aggregate.toolOutputWeb;
      const tools = emptyToolActivity();
      tools.read = breakdown.aggregate.read;
      tools.editWrite = breakdown.aggregate.editWrite;
      tools.search = breakdown.aggregate.search;
      tools.git = breakdown.aggregate.git;
      tools.buildTest = breakdown.aggregate.buildTest;
      tools.terminal = breakdown.aggregate.terminal;
      tools.subagents = breakdown.aggregate.subagents;
      tools.web = breakdown.aggregate.web;
      const firstBucket = usage.buckets
        .filter(bucket => bucket.metrics.requestCount > 0 || bucket.metrics.inputTokens > 0 || bucket.metrics.outputTokens > 0)
        .sort((a, b) => a.bucketStartMs - b.bucketStartMs)[0];
      const firstSeen = firstBucket ? new Date(firstBucket.bucketStartMs) : new Date(fromMs);
      const firstSeenDate = `${firstSeen.getFullYear()}-${String(firstSeen.getMonth() + 1).padStart(2, '0')}-${String(firstSeen.getDate()).padStart(2, '0')}`;
      return {
        provider,
        input: usage.aggregate.inputTokens,
        output,
        thinkingExact: provider === 'codex',
        tools,
        firstSeenDate,
      } satisfies ProviderBreakdown;
    }));
    return results.filter((result): result is ProviderBreakdown => result !== null);
  }

  private getPersistedValue(key: string, fallback: unknown = null): unknown {
    try {
      return (this.store as unknown as Store<Record<string, unknown>>).get(key, fallback);
    } catch {
      return fallback;
    }
  }

  private setPersistedValue(key: string, value: unknown): void {
    try {
      (this.store as unknown as Store<Record<string, unknown>>).set(key, value);
    } catch {
      // electron-store 오류가 화면 갱신을 막지 않도록 메모리 상태를 우선 유지한다.
    }
  }

  private deletePersistedValue(key: string): void {
    try {
      (this.store as unknown as Store<Record<string, unknown>>).delete(key);
    } catch {
      // 캐시 정리에 실패해도 다음 정규화 단계에서 다시 무시된다.
    }
  }

  private publishState(persistSnapshot = true): void {
    this.onUpdate(this.state);
    if (persistSnapshot && this.state.stateFreshness === 'fresh') {
      this.persistStartupStateSnapshot();
    }
  }

  private persistStartupStateSnapshot(): void {
    this.setPersistedValue(STARTUP_STATE_SNAPSHOT_KEY, makeStartupStateSnapshot(this.state));
  }

  private currentStateFreshness(): StateFreshness {
    return this.startupFreshComplete ? 'fresh' : this.state.stateFreshness;
  }

  private reviveRestoredState(state: AppState): AppState {
    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    const settings = this.getSettings();
    const enabled = new Set(settings.enabledProviders);
    const restoredProviderQuotas = sanitizeProviderQuotaMap(state.providerQuotas);
    const providerQuotas: ProviderQuotaMap = {};
    this.providerQuotaSnapshots.clear();
    for (const [provider, snapshot] of Object.entries(restoredProviderQuotas) as Array<[ProviderId, ProviderQuotaSnapshot | undefined]>) {
      if (!enabled.has(provider) || snapshot?.provider !== provider) continue;
      if (provider === 'codex') continue;
      providerQuotas[provider] = snapshot;
      this.providerQuotaSnapshots.set(provider, snapshot);
    }
    return {
      ...state,
      settings,
      usageIndexCoverage: incompleteUsageIndexCoverage(),
      usageIndexHealth: this.usageIndex.getHealth(),
      repoGitStats: state.repoGitStats && typeof state.repoGitStats === 'object' ? state.repoGitStats : {},
      providerQuotas,
      codexAccount: this.codexAccountForSettings(settings),
      sessions: sessions.map(session => ({
        ...session,
        startedAt: this.reviveDate(session.startedAt) ?? new Date(0),
        lastModified: this.reviveDate(session.lastModified),
      })),
    };
  }

  private reviveDate(value: Date | string | null | undefined): Date | null {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value !== 'string') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private clearClaudeApiCache(): void {
    this.apiUsagePct = null;
    this.apiUsagePctStoredAt = 0;
    this.deletePersistedValue('_cachedApiPct');
  }

  private getSettings(): AppSettings {
    return normalizeSettings(this.store.store);
  }

  private enabledProviders(settings: AppSettings): ProviderAdapter[] {
    return this.providerRegistry
      .getAll()
      .filter(provider => isProviderEnabled(settings, provider.id));
  }

  private enabledProviderSet(settings: AppSettings): ReadonlySet<ProviderId> {
    return new Set(settings.enabledProviders);
  }

  private providerSelectionChanged(next: AppSettings, previous: AppSettings): boolean {
    const nextProviders = this.enabledProviderSet(next);
    const previousProviders = this.enabledProviderSet(previous);
    if (nextProviders.size !== previousProviders.size) return true;
    return [...nextProviders].some(provider => !previousProviders.has(provider));
  }

  private quotaAffectingSettingsChanged(next: AppSettings, previous: AppSettings): boolean {
    return next.antigravityQuotaDurationPaceEnabled !== previous.antigravityQuotaDurationPaceEnabled;
  }

  private projectExclusionsChanged(next: AppSettings, previous: AppSettings): boolean {
    const nextProjects = new Set(next.excludedProjects ?? []);
    const previousProjects = new Set(previous.excludedProjects ?? []);
    if (nextProjects.size !== previousProjects.size) return true;
    return [...nextProjects].some(project => !previousProjects.has(project));
  }

  private sourceBackedProviders(settings: AppSettings): SourceBackedProviderAdapter[] {
    return this.enabledProviders(settings).filter(isSourceBackedProvider);
  }

  private providerContext(overrides: Partial<ProviderContext> & { settings: AppSettings }): ProviderContext {
    const { settings, ...rest } = overrides;
    return {
      nowMs: Date.now(),
      scanBudgetMs: null,
      prioritySourceIds: new Set<string>(),
      includeFullHistory: false,
      force: false,
      ...rest,
      settings,
    };
  }

  private startupLimitForProvider(provider: ProviderId): number {
    if (provider === 'claude') return StateManager.STARTUP_CLAUDE_FILE_LIMIT;
    if (provider === 'codex') return StateManager.STARTUP_CODEX_FILE_LIMIT;
    return StateManager.STARTUP_CODEX_FILE_LIMIT;
  }

  private sourceForPath(provider: SourceBackedProviderAdapter, filePath: string, priority = false): ProviderSource {
    return {
      provider: provider.id,
      sourceId: normalizeFileKey(filePath),
      filePath,
      priority,
    };
  }

  private emptyState(): AppState {
    return {
      sessions: [],
      usage: {
        byProvider: {
          claude: { windows: { h5: this.emptyWindow(), week: this.emptyWindow(), sonnetWeek: this.emptyWindow() } },
          codex: { windows: { h5: this.emptyWindow(), week: this.emptyWindow() } },
        },
        modelWindows: {},
        models: [],
        heatmap: [],
        heatmap30: [],
        heatmap90: [],
        weeklyTimeline: [],
        todayTokens: 0,
        todayCost: 0,
        todayRequestCount: 0,
        todayInputTokens: 0,
        todayOutputTokens: 0,
        todayCacheTokens: 0,
        todayCacheSavingsUSD: 0,
        todayCacheEfficiency: 0,
        allTimeRequestCount: 0,
        allTimeCost: 0,
        allTimeCacheTokens: 0,
        allTimeInputTokens: 0,
        allTimeOutputTokens: 0,
        allTimeSavedUSD: 0,
        allTimeAvgCacheEfficiency: 0,
        todBuckets: [],
      },
      usageTrend: emptyUsageTrendData(),
      providerQuotas: {},
      settings: this.getSettings(),
      codexAccount: this.codexAccountForSettings(),
      stateFreshness: 'empty',
      initialRefreshComplete: false,
      historyWarmupPending: false,
      historyWarmupStartsAt: null,
      usageIndexCoverage: incompleteUsageIndexCoverage(),
      usageIndexHealth: this.usageIndex.getHealth(),
      lastUpdated: 0,
      apiConnected: false,
      apiStatusLabel: undefined,
      apiError: undefined,
      codexUsageConnected: false,
      codexStatusLabel: undefined,
      codexError: undefined,
      bridgeActive: false,
      repoGitStats: {},
      codeOutputStats: this.emptyCodeOutputStats(),
      codeOutputLoading: false,
      allTimeSessions: 0,
    };
  }

  private emptyWindow() {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUSD: 0,
      requestCount: 0,
      cacheEfficiency: 0,
      cacheSavingsUSD: 0,
    };
  }

  private codexAccountForSettings(settings: AppSettings = this.getSettings()): CodexAccountState {
    return settings.enabledProviders.includes('codex')
      ? readCodexAccountState()
      : { serviceTier: null };
  }

  private hydrateCodexCachesFromStore(settings: AppSettings = this.getSettings()): void {
    if (!settings.enabledProviders.includes('codex')) return;
    const cachedCodexRaw = this.getPersistedValue('_cachedCodexUsagePct', null);
    const cachedResetRaw = this.getPersistedValue('_cachedCodexResetCredits', null);
    const codexAuthMtimeMs = getCodexAuthMtimeMs();
    const codexAuthIdentityHash = getCodexAuthIdentityHash();
    const cachedCodex = normalizeStoredCodexUsagePct(cachedCodexRaw, codexAuthMtimeMs, codexAuthIdentityHash);
    if (cachedCodexRaw && !cachedCodex) {
      this.deletePersistedValue('_cachedCodexUsagePct');
    }
    if (cachedCodex && hasCodexUsageCredentials()) {
      this.codexUsagePctStoredAt = cachedCodex.storedAt;
      this.codexUsageAuthMtimeMs = cachedCodex.authMtimeMs;
      this.codexUsageAuthIdentityHash = cachedCodex.authIdentityHash;
      this.codexUsageAttemptAuthMtimeMs = cachedCodex.authMtimeMs;
      this.codexUsageAttemptAuthIdentityHash = cachedCodex.authIdentityHash;
      this.codexUsagePct = cachedCodex;
    }

    const cachedReset = normalizeStoredCodexResetCredits(cachedResetRaw, codexAuthMtimeMs, codexAuthIdentityHash);
    if (cachedResetRaw && !cachedReset) {
      this.deletePersistedValue('_cachedCodexResetCredits');
    }
    if (cachedReset && hasCodexUsageCredentials()) {
      this.codexResetCreditsStoredAt = cachedReset.storedAt;
      this.codexResetCredits = cachedReset.data;
      this.codexResetAuthMtimeMs = cachedReset.authMtimeMs;
      this.codexResetAuthIdentityHash = cachedReset.authIdentityHash;
      this.codexResetAttemptAuthMtimeMs = cachedReset.authMtimeMs;
      this.codexResetAttemptAuthIdentityHash = cachedReset.authIdentityHash;
    }
  }

  private emptyCodeOutputStats(): CodeOutputStats {
    return {
      today: { commits: 0, added: 0, removed: 0 },
      all: { commits: 0, added: 0, removed: 0 },
      daily7d: buildDaily7dWindow(),
      dailyAll: [],
      repoCount: 0,
      scopeLabel: 'Current session repos',
    };
  }

  private sessionProjectKeys(session: Pick<DiscoveredSession, 'cwd' | 'mainRepoName' | 'projectName'>): string[] {
    return [
      session.mainRepoName,
      session.projectName,
      ...projectKeysForCwd(session.cwd),
    ].filter((key): key is string => !!key);
  }

  start() {
    this.bridgeWatcher.start();
    void this.requestRefresh({ mode: 'heavy', reason: 'startup', allowStartupBudget: true });
    this.startTimers();
    this.startWatcher();
    this.startDebugMemTimer();

    this.quotaRefreshTimer = setInterval(() => {
      void this.refreshProviderQuotas(this.getSettings(), false).catch(() => {});
    }, 5 * 60 * 1000);
  }

  stop() {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.heavyTimer) clearInterval(this.heavyTimer);
    if (this.quotaRefreshTimer) clearInterval(this.quotaRefreshTimer);
    if (this.debugMemTimer) clearInterval(this.debugMemTimer);
    if (this.fastDebounce) clearTimeout(this.fastDebounce);
    if (this.historyWarmupTimer) clearTimeout(this.historyWarmupTimer);
    if (this.gitWarmupTimer) clearTimeout(this.gitWarmupTimer);
    if (this.foregroundRefreshTimer) clearTimeout(this.foregroundRefreshTimer);
    if (this.wideWatcherPromotionTimer) clearTimeout(this.wideWatcherPromotionTimer);
    this.foregroundRefreshTimer = null;
    this.wideWatcherPromotionTimer = null;
    this.watcher?.close();
    this.bridgeWatcher.stop();
  }

  async close(): Promise<void> {
    await this.usageIndex.close();
  }

  private requestRefresh(request: RefreshRequest): Promise<void> {
    const changedFiles = request.changedFiles
      ? [...request.changedFiles].map(file => normalizeFileKey(file))
      : undefined;
    return this.refreshScheduler.request({ ...request, changedFiles });
  }

  private async executeRefresh(work: RefreshWork): Promise<void> {
    if (work.mode === 'fast') {
      await this.fastRefresh(work.changedFiles);
      return;
    }

    await this.heavyRefresh(
      work.force,
      work.forceProviderUsage,
      work.allowStartupBudget,
      work.scanBudgetMs,
      work.allowHiddenFullScan,
      work.changedFiles,
      work.includeFullHistory,
    );
  }

  setUiBusy(busy: boolean): void {
    this.uiBusy = busy;
    if (!busy) this.refreshScheduler.notifyStateChanged();
  }

  setUiVisible(visible: boolean): void {
    if (this.uiVisible === visible) return;
    this.uiVisible = visible;
    this.startTimers();
    if (visible) {
      this.startWatcher('popup:show:recent', 'recent');
      if (this.state.initialRefreshComplete) {
        this.scheduleForegroundRefresh();
        this.scheduleWideWatcherPromotion();
      }
      this.refreshScheduler.notifyStateChanged();
      return;
    }
    this.clearForegroundTimers();
    this.startWatcher('popup:hide', 'recent');
    this.refreshScheduler.notifyStateChanged();
  }

  private clearForegroundTimers(): void {
    if (this.foregroundRefreshTimer) clearTimeout(this.foregroundRefreshTimer);
    if (this.wideWatcherPromotionTimer) clearTimeout(this.wideWatcherPromotionTimer);
    this.foregroundRefreshTimer = null;
    this.wideWatcherPromotionTimer = null;
  }

  private scheduleForegroundRefresh(
    delayMs = StateManager.FOREGROUND_REFRESH_DELAY_MS,
    scanBudgetMs = StateManager.FOREGROUND_SCAN_BUDGET_MS,
  ): void {
    if (this.foregroundRefreshTimer) clearTimeout(this.foregroundRefreshTimer);
    this.foregroundRefreshTimer = setTimeout(() => {
      this.foregroundRefreshTimer = null;
      if (!this.uiVisible) return;
      if (this.uiBusy) {
        this.scheduleForegroundRefresh(delayMs, scanBudgetMs);
        return;
      }
      void this.requestRefresh({
        mode: 'heavy',
        reason: 'foreground',
        scanBudgetMs,
      });
    }, delayMs);
  }

  private scheduleWideWatcherPromotion(): void {
    if (this.wideWatcherPromotionTimer) clearTimeout(this.wideWatcherPromotionTimer);
    this.wideWatcherPromotionTimer = setTimeout(() => {
      this.wideWatcherPromotionTimer = null;
      if (!this.uiVisible) return;
      this.startWatcher('popup:show:wide', 'wide');
      this.scheduleForegroundRefresh();
    }, StateManager.WIDE_WATCHER_PROMOTION_DELAY_MS);
  }

  private isPerfDebugEnabled(): boolean {
    const proc = process as NodeJS.Process & { defaultApp?: boolean };
    return proc.defaultApp === true || process.env.WMT_DEBUG_PERF === '1';
  }

  private isMemoryDebugEnabled(): boolean {
    const proc = process as NodeJS.Process & { defaultApp?: boolean };
    return proc.defaultApp === true || process.env.WMT_DEBUG_MEMORY === '1' || process.env.WMT_DEBUG_PERF === '1';
  }

  private beginPerfSample(): PerfSampleStart {
    return {
      wallNs: process.hrtime.bigint(),
      cpu: process.cpuUsage(),
    };
  }

  private finishPerfSample(sample: PerfSampleStart): PerfMetrics {
    const elapsedMs = Number(process.hrtime.bigint() - sample.wallNs) / 1_000_000;
    const cpu = process.cpuUsage(sample.cpu);
    const cpuUserMs = cpu.user / 1000;
    const cpuSystemMs = cpu.system / 1000;
    return {
      elapsedMs: Math.round(elapsedMs * 10) / 10,
      cpuUserMs: Math.round(cpuUserMs * 10) / 10,
      cpuSystemMs: Math.round(cpuSystemMs * 10) / 10,
      cpuTotalMs: Math.round((cpuUserMs + cpuSystemMs) * 10) / 10,
    };
  }

  private perfFields(prefix: string, metrics: PerfMetrics): Record<string, number> {
    return {
      [`${prefix}ElapsedMs`]: metrics.elapsedMs,
      [`${prefix}CpuUserMs`]: metrics.cpuUserMs,
      [`${prefix}CpuSystemMs`]: metrics.cpuSystemMs,
      [`${prefix}CpuTotalMs`]: metrics.cpuTotalMs,
    };
  }

  private getDebugCounts(): Record<string, number | string | boolean> {
    return {
      uiVisible: this.uiVisible,
      uiBusy: this.uiBusy,
      watcherProfile: this.watcherProfile,
      watcherTargets: this.watcherTargetCount,
      summaryCount: this.summaries.size,
      sessionCount: this.state.sessions.length,
      allTimeSessions: this.state.allTimeSessions,
      gitCacheEntries: this.gitStatsCache.size,
      dirtyFiles: this.dirtySessionFiles.size,
      deferredFastFiles: this.refreshScheduler.getPendingChangedFileCount(),
    };
  }

  private logPerfTrace(label: string, sample: PerfSampleStart, extras: Record<string, unknown> = {}): void {
    if (!this.isPerfDebugEnabled()) return;
    const metrics = this.finishPerfSample(sample);
    console.info('[WhereMyTokens][perf]', {
      label,
      ...metrics,
      ...this.getDebugCounts(),
      ...extras,
    });
  }

  private logWatcherProfile(reason: string): void {
    if (!this.isPerfDebugEnabled()) return;
    console.info('[WhereMyTokens][watcher]', {
      reason,
      profile: this.watcherProfile,
      targets: this.watcherTargetCount,
      ...this.getDebugCounts(),
    });
  }

  private startDebugMemTimer(): void {
    if (!isDebugInstrumentationEnabled()) return;
    if (this.debugMemTimer) clearInterval(this.debugMemTimer);
    void this.writeDebugMemSnapshot('startup');
    this.debugMemTimer = setInterval(() => {
      void this.writeDebugMemSnapshot('interval');
    }, 30_000);
  }

  private countWatchedPaths(): { watchedDirectories: number; watchedFiles: number } {
    const watched = this.watcher?.getWatched();
    if (!watched) return { watchedDirectories: 0, watchedFiles: 0 };
    let watchedDirectories = 0;
    let watchedFiles = 0;
    for (const files of Object.values(watched)) {
      watchedDirectories += 1;
      watchedFiles += files.length;
    }
    return { watchedDirectories, watchedFiles };
  }

  async getDebugMemSnapshot(label = 'ipc'): Promise<DebugMemSnapshot> {
    const watched = this.countWatchedPaths();
    return {
      label,
      ts: new Date().toISOString(),
      runtime: collectRuntimeMemorySnapshot(),
      collections: {
        summaries: this.summaries.size,
        sessions: this.state.sessions.length,
        repoGitStats: Object.keys(this.state.repoGitStats).length,
        gitStatsCache: this.gitStatsCache.size,
        dirtySessionFiles: this.dirtySessionFiles.size,
        deferredFastFiles: this.refreshScheduler.getPendingChangedFileCount(),
      },
      watcher: {
        profile: this.watcherProfile,
        targets: this.watcherTargetCount,
        watchedDirectories: watched.watchedDirectories,
        watchedFiles: watched.watchedFiles,
      },
    };
  }

  private async writeDebugMemSnapshot(label: string): Promise<void> {
    if (!isDebugInstrumentationEnabled()) return;
    const snapshot = await this.getDebugMemSnapshot(label);
    appendDebugMemoryLog('state-manager-snapshot', snapshot as unknown as Record<string, unknown>);
  }

  private applyApiStatus(status: ClaudeApiStatus): void {
    this.apiConnected = status.connected;
    this.apiStatusLabel = status.label;
    this.apiError = status.detail;
  }

  private applyCodexStatus(status: CodexUsageStatus): void {
    this.codexUsageConnected = status.connected;
    this.codexStatusLabel = status.label;
    this.codexError = status.detail;
  }

  private getAgedApiUsagePct(now = Date.now()): ApiUsagePct | null {
    if (!this.apiUsagePct) return null;
    if (!this.apiUsagePctStoredAt) return this.apiUsagePct;
    return ageApiUsageSample(this.apiUsagePct, now - this.apiUsagePctStoredAt);
  }

  private getAgedCodexUsagePct(now = Date.now()): CodexUsagePct | null {
    if (!this.codexUsagePct) return null;
    if (!this.codexAuthMarkerMatches(this.codexUsageAuthMtimeMs, this.codexUsageAuthIdentityHash)) {
      this.clearCodexUsageCache();
      this.clearCodexResetCache();
      this.codexResetStatus = null;
      this.codexResetBackoffMs = 0;
      this.codexUsageBackoffMs = 0;
      this.lastCodexUsageCallMs = 0;
      this.lastCodexResetCallMs = 0;
      return null;
    }
    if (!this.codexUsagePctStoredAt) return this.codexUsagePct;
    const aged = ageCodexUsageSample(this.codexUsagePct, now - this.codexUsagePctStoredAt);
    return aged.h5Available || aged.weekAvailable ? aged : null;
  }

  private mergeApiUsageSample(next: ApiUsagePct, status: ClaudeApiStatus, now = Date.now()): ApiUsagePct {
    if (status.code !== 'reset-unavailable') return next;
    if (next.soPct !== 0 || next.soResetMs != null) return next;
    const previous = this.getAgedApiUsagePct(now);
    if (!previous) return next;
    if (previous.soPct <= 0 || previous.soResetMs == null) return next;
    return {
      ...next,
      soPct: previous.soPct,
      soResetMs: previous.soResetMs,
    };
  }

  private consumeOAuthCredentialChange(): boolean {
    const marker = getOAuthCredentialMarker() ?? 'missing';
    const changed = this.lastOAuthCredentialMarker !== null && this.lastOAuthCredentialMarker !== marker;
    this.lastOAuthCredentialMarker = marker;
    return changed;
  }

  private beginClaudeQuotaRequest(force: boolean, now: number): number | null {
    const credentialsChanged = this.consumeOAuthCredentialChange();
    if (credentialsChanged) {
      this.apiBackoffMs = 0;
      this.clearClaudeApiCache();
    }
    const elapsedSinceLastApiCall = now - this.lastApiCallMs;
    if (!credentialsChanged && this.apiBackoffMs > 0 && elapsedSinceLastApiCall < this.apiBackoffMs) return null;
    if (!force && !credentialsChanged && elapsedSinceLastApiCall < StateManager.API_MIN_INTERVAL_MS) return null;
    this.lastApiCallMs = now;
    return ++this.apiRequestSeq;
  }

  private beginCodexQuotaRequest(force: boolean, now: number): { requestSeq: number; skipCodexUsage: boolean; skipCodexResetCredits: boolean } | null {
    const authChanged = this.consumeCodexAuthChange();
    const elapsedSinceLastCall = now - this.lastCodexUsageCallMs;
    const usageBlockedByBackoff = this.codexUsageBackoffMs > 0 && elapsedSinceLastCall < this.codexUsageBackoffMs;
    const usageBlockedByInterval = !force && !authChanged && elapsedSinceLastCall < StateManager.CODEX_USAGE_MIN_INTERVAL_MS;
    const usageAllowed = !usageBlockedByBackoff && !usageBlockedByInterval;
    const skipCodexResetCredits = this.shouldSkipCodexResetCredits(now, force || authChanged);
    if (!usageAllowed && skipCodexResetCredits) return null;
    if (usageAllowed) this.lastCodexUsageCallMs = now;
    if (!skipCodexResetCredits) this.lastCodexResetCallMs = now;
    return {
      requestSeq: ++this.codexUsageRequestSeq,
      skipCodexUsage: !usageAllowed,
      skipCodexResetCredits,
    };
  }

  private beginProviderQuotaRequest(provider: ProviderId, force: boolean, now: number): { requestSeq: number; skipCodexUsage?: boolean; skipCodexResetCredits?: boolean } | null {
    if (provider === 'codex') {
      const admission = this.beginCodexQuotaRequest(force, now);
      if (!admission) return null;
      this.providerQuotaRequestSeqs.set(provider, admission.requestSeq);
      return admission;
    }
    const requestSeq = provider === 'claude'
      ? this.beginClaudeQuotaRequest(force, now)
      : (this.providerQuotaRequestSeqs.get(provider) ?? 0) + 1;
    if (requestSeq == null) return null;
    this.providerQuotaRequestSeqs.set(provider, requestSeq);
    return { requestSeq };
  }

  private applyClaudeQuotaSnapshot(snapshot: ProviderQuotaSnapshot, requestSeq: number, requestStartedAtMs: number): boolean {
    if (!isClaudeQuotaSnapshot(snapshot)) return false;
    if (requestSeq !== this.apiRequestSeq) return false;
    this.applyApiStatus(snapshot.status);

    if (snapshot.usage) {
      const mergedUsage = this.mergeApiUsageSample(snapshot.usage, snapshot.status, requestStartedAtMs);
      const credentialMarker = snapshot.credentialMarker;
      this.lastOAuthCredentialMarker = credentialMarker;
      this.apiUsagePct = mergedUsage;
      this.apiUsagePctStoredAt = Date.now();
      this.apiBackoffMs = 0;
      this.setPersistedValue('_cachedApiPct', {
        ...mergedUsage,
        storedAt: this.apiUsagePctStoredAt,
        schemaVersion: API_USAGE_CACHE_SCHEMA_VERSION,
        credentialMarker,
      });
      return true;
    }

    if (snapshot.status.code === 'no-credentials') {
      this.clearClaudeApiCache();
    }

    if (snapshot.status.code === 'rate-limited') {
      this.apiBackoffMs = typeof snapshot.status.retryAfterMs === 'number'
        ? Math.min(CLAUDE_API_MAX_BACKOFF_MS, Math.max(0, snapshot.status.retryAfterMs))
        : Math.min(this.apiBackoffMs === 0 ? 120_000 : this.apiBackoffMs * 2, CLAUDE_API_MAX_BACKOFF_MS);
      this.apiError = `${snapshot.status.detail} Retry in ${Math.max(1, Math.ceil(this.apiBackoffMs / 60000))}m.`;
      this.apiStatusLabel = snapshot.status.label || 'rate limited';
    } else {
      this.apiBackoffMs = 0;
    }
    return true;
  }

  private codexBackoffForStatus(status: CodexUsageStatus): number {
    if (status.code === 'rate-limited') {
      return typeof status.retryAfterMs === 'number'
        ? Math.min(CODEX_USAGE_MAX_BACKOFF_MS, Math.max(0, status.retryAfterMs))
        : Math.min(this.codexUsageBackoffMs === 0 ? 120_000 : this.codexUsageBackoffMs * 2, CODEX_USAGE_MAX_BACKOFF_MS);
    }
    if (status.code === 'unauthorized' || status.code === 'forbidden' || status.code === 'schema-changed') {
      return CODEX_USAGE_MAX_BACKOFF_MS;
    }
    if (status.code === 'timeout' || status.code === 'network' || status.code === 'http-error') {
      return Math.min(this.codexUsageBackoffMs === 0 ? 300_000 : this.codexUsageBackoffMs * 2, CODEX_USAGE_MAX_BACKOFF_MS);
    }
    return 0;
  }

  private codexBackoffForResetStatus(status: CodexUsageStatus): number {
    if (status.code === 'ok') return 0;
    if (status.code === 'rate-limited') {
      return typeof status.retryAfterMs === 'number'
        ? Math.min(CODEX_USAGE_MAX_BACKOFF_MS, Math.max(0, status.retryAfterMs))
        : Math.min(this.codexResetBackoffMs === 0 ? 120_000 : this.codexResetBackoffMs * 2, CODEX_USAGE_MAX_BACKOFF_MS);
    }
    if (status.code === 'unauthorized' || status.code === 'forbidden' || status.code === 'schema-changed') {
      return CODEX_USAGE_MAX_BACKOFF_MS;
    }
    if (status.code === 'timeout' || status.code === 'network' || status.code === 'http-error') {
      return Math.min(this.codexResetBackoffMs === 0 ? 300_000 : this.codexResetBackoffMs * 2, CODEX_USAGE_MAX_BACKOFF_MS);
    }
    return 0;
  }

  private shouldSkipCodexResetCredits(now: number, force: boolean): boolean {
    const elapsed = now - this.lastCodexResetCallMs;
    if (this.codexResetBackoffMs > 0 && elapsed < this.codexResetBackoffMs) return true;
    return !force && this.lastCodexResetCallMs > 0 && elapsed < StateManager.CODEX_RESET_MIN_INTERVAL_MS;
  }

  private codexAuthMarkerMatches(
    markerMtime: number | null,
    markerHash: string | null,
    currentMtime = getCodexAuthMtimeMs(),
    currentHash = getCodexAuthIdentityHash(),
  ): boolean {
    return markerMtime != null
      && currentMtime != null
      && Math.abs(markerMtime - currentMtime) <= 1
      && !!markerHash
      && !!currentHash
      && markerHash === currentHash;
  }

  private codexAuthMarkerChanged(
    markerMtime: number | null,
    markerHash: string | null,
    currentMtime = getCodexAuthMtimeMs(),
    currentHash = getCodexAuthIdentityHash(),
  ): boolean {
    if (markerMtime == null || !markerHash) return false;
    return currentMtime == null
      || !currentHash
      || Math.abs(markerMtime - currentMtime) > 1
      || markerHash !== currentHash;
  }

  private consumeCodexAuthChange(): boolean {
    const currentMtime = getCodexAuthMtimeMs();
    const currentHash = getCodexAuthIdentityHash();
    const usageChanged = this.codexAuthMarkerChanged(this.codexUsageAttemptAuthMtimeMs, this.codexUsageAttemptAuthIdentityHash, currentMtime, currentHash);
    const resetChanged = this.codexAuthMarkerChanged(this.codexResetAttemptAuthMtimeMs, this.codexResetAttemptAuthIdentityHash, currentMtime, currentHash);
    const authAppeared = this.codexAuthMissingObserved && currentMtime != null && !!currentHash;
    if (!usageChanged && !resetChanged && !authAppeared) return false;

    this.clearCodexUsageCache();
    this.clearCodexResetCache();
    this.codexAuthMissingObserved = currentMtime == null || !currentHash;
    this.codexUsageAttemptAuthMtimeMs = null;
    this.codexUsageAttemptAuthIdentityHash = null;
    this.codexResetAttemptAuthMtimeMs = null;
    this.codexResetAttemptAuthIdentityHash = null;
    this.codexResetStatus = null;
    this.codexUsageBackoffMs = 0;
    this.codexResetBackoffMs = 0;
    this.lastCodexUsageCallMs = 0;
    this.lastCodexResetCallMs = 0;
    return true;
  }

  private clearCodexUsageCache(options: { deletePersisted?: boolean } = {}): void {
    this.codexUsagePct = null;
    this.codexUsagePctStoredAt = 0;
    this.codexUsageAuthMtimeMs = null;
    this.codexUsageAuthIdentityHash = null;
    this.providerQuotaSnapshots.delete('codex');
    if (options.deletePersisted !== false) this.deletePersistedValue('_cachedCodexUsagePct');
  }

  private clearCodexResetCache(options: { deletePersisted?: boolean } = {}): void {
    this.codexResetCredits = null;
    this.codexResetCountOnlyFallback = null;
    this.codexResetCreditsStoredAt = 0;
    this.codexResetAuthMtimeMs = null;
    this.codexResetAuthIdentityHash = null;
    if (options.deletePersisted !== false) this.deletePersistedValue('_cachedCodexResetCredits');
  }

  private codexResetStatusInvalidatesUsage(status: CodexUsageStatus): boolean {
    return status.code === 'no-credentials'
      || status.code === 'unauthorized'
      || status.code === 'forbidden'
      || status.code === 'schema-changed';
  }

  private applyCodexResetCredits(snapshot: CodexProviderQuotaSnapshot): void {
    const incomingReset = snapshot.resetCredits;
    if (incomingReset == null) {
      return;
    }
    const reset: CodexResetCreditsData = {
      ...incomingReset,
      credits: incomingReset.credits.map(credit => ({ ...credit, idSuffix: null })),
    };
    this.lastCodexResetCallMs = Date.now();
    this.codexResetAttemptAuthMtimeMs = snapshot.resetAuthMtimeMs;
    this.codexResetAttemptAuthIdentityHash = snapshot.resetAuthIdentityHash;
    this.codexResetStatus = reset.status;
    if (reset.status.code === 'ok') {
      if (reset.countOnly) {
        this.codexResetCountOnlyFallback = reset;
        this.codexResetCredits = null;
        this.codexResetCreditsStoredAt = 0;
        this.codexResetAuthMtimeMs = null;
        this.codexResetAuthIdentityHash = null;
        this.deletePersistedValue('_cachedCodexResetCredits');
      } else {
        this.codexResetCountOnlyFallback = null;
        this.codexResetCredits = reset;
        this.codexResetCreditsStoredAt = Date.now();
        this.codexResetAuthMtimeMs = snapshot.resetAuthMtimeMs;
        this.codexResetAuthIdentityHash = snapshot.resetAuthIdentityHash;
        this.setPersistedValue('_cachedCodexResetCredits', {
          schemaVersion: CODEX_RESET_CREDITS_CACHE_SCHEMA_VERSION,
          storedAt: this.codexResetCreditsStoredAt,
          authMtimeMs: snapshot.resetAuthMtimeMs,
          authIdentityHash: snapshot.resetAuthIdentityHash,
          data: reset,
        });
      }
    } else if (reset.countOnly) {
      this.codexResetCountOnlyFallback = reset;
    } else if (reset.status.code === 'no-credentials' || reset.status.code === 'unauthorized' || reset.status.code === 'forbidden' || reset.status.code === 'schema-changed') {
      this.clearCodexResetCache();
      this.codexResetAttemptAuthMtimeMs = snapshot.resetAuthMtimeMs;
      this.codexResetAttemptAuthIdentityHash = snapshot.resetAuthIdentityHash;
    }
    this.codexResetBackoffMs = this.codexBackoffForResetStatus(reset.status);
  }

  private applyCodexQuotaSnapshot(snapshot: ProviderQuotaSnapshot, requestSeq: number): boolean {
    if (!isCodexQuotaSnapshot(snapshot)) return false;
    if (requestSeq !== this.codexUsageRequestSeq) return false;
    if (!snapshot.usageSkipped) {
      this.codexUsageAttemptAuthMtimeMs = snapshot.authMtimeMs;
      this.codexUsageAttemptAuthIdentityHash = snapshot.authIdentityHash;
      this.codexAuthMissingObserved = snapshot.status.code === 'no-credentials';
      this.applyCodexStatus(snapshot.status);
    }
    this.applyCodexResetCredits(snapshot);

    if (snapshot.usageSkipped) {
      const resetStatus = snapshot.resetCredits?.status;
      if (resetStatus && this.codexResetStatusInvalidatesUsage(resetStatus)) {
        this.applyCodexStatus(resetStatus);
        this.clearCodexUsageCache();
        this.codexUsageBackoffMs = resetStatus.code === 'no-credentials' ? 0 : this.codexBackoffForStatus(resetStatus);
        if (resetStatus.code === 'no-credentials') {
          this.codexAuthMissingObserved = true;
          this.lastCodexUsageCallMs = 0;
        }
      }
      return true;
    }

    if (snapshot.usage) {
      this.codexAuthMissingObserved = false;
      this.codexUsagePct = snapshot.usage;
      this.codexUsagePctStoredAt = Date.now();
      this.codexUsageAuthMtimeMs = snapshot.authMtimeMs;
      this.codexUsageAuthIdentityHash = snapshot.authIdentityHash;
      this.codexUsageBackoffMs = 0;
      this.setPersistedValue('_cachedCodexUsagePct', {
        ...snapshot.usage,
        authMtimeMs: snapshot.authMtimeMs,
        authIdentityHash: snapshot.authIdentityHash,
        storedAt: this.codexUsagePctStoredAt,
        schemaVersion: CODEX_USAGE_CACHE_SCHEMA_VERSION,
      });
      return true;
    }

    if (snapshot.status.code === 'no-credentials') {
      this.clearCodexUsageCache();
      this.clearCodexResetCache();
      this.codexUsageAttemptAuthMtimeMs = null;
      this.codexUsageAttemptAuthIdentityHash = null;
      this.codexResetAttemptAuthMtimeMs = null;
      this.codexResetAttemptAuthIdentityHash = null;
      this.codexAuthMissingObserved = true;
      this.codexResetBackoffMs = 0;
      this.lastCodexUsageCallMs = 0;
      this.lastCodexResetCallMs = 0;
      this.codexResetStatus = { code: 'no-credentials', connected: false, label: 'local log', detail: 'Codex auth.json with ChatGPT tokens was not found.' };
    }
    this.codexUsageBackoffMs = this.codexBackoffForStatus(snapshot.status);
    if (snapshot.status.code === 'rate-limited' && this.codexUsageBackoffMs > 0) {
      this.codexError = `${snapshot.status.detail} Retry in ${Math.max(1, Math.ceil(this.codexUsageBackoffMs / 60000))}m.`;
      this.codexStatusLabel = snapshot.status.label || 'rate limited';
    }
    return true;
  }

  private applyProviderQuotaSnapshot(snapshot: ProviderQuotaSnapshot, requestSeq: number, requestStartedAtMs: number): boolean {
    if (this.providerQuotaRequestSeqs.get(snapshot.provider) !== requestSeq) return false;
    let accepted = true;
    if (snapshot.provider === 'claude') {
      accepted = this.applyClaudeQuotaSnapshot(snapshot, requestSeq, requestStartedAtMs);
    } else if (snapshot.provider === 'codex') {
      accepted = this.applyCodexQuotaSnapshot(snapshot, requestSeq);
    }
    if (!accepted) return false;
    const snapshotForStore = snapshot.provider === 'codex' && isCodexQuotaSnapshot(snapshot) && snapshot.usageSkipped
      ? {
          ...snapshot,
          status: {
            connected: this.codexUsageConnected,
            code: this.codexStatusLabel || (this.codexUsageConnected ? 'connected' : 'local-log'),
            label: this.codexStatusLabel || undefined,
            detail: this.codexError || undefined,
          },
        }
      : snapshot;
    const publicSnapshot = sanitizeProviderQuotaSnapshot(snapshot.provider, snapshotForStore);
    if (!publicSnapshot) return false;
    this.providerQuotaSnapshots.set(snapshot.provider, publicSnapshot);
    return true;
  }

  private async refreshProviderQuota(
    provider: ProviderAdapter,
    settings: AppSettings,
    force = false,
    fetchQuota = provider.fetchQuota,
  ): Promise<boolean> {
    if (!fetchQuota || !provider.capabilities.has('quota')) return false;
    const now = Date.now();
    const admission = this.beginProviderQuotaRequest(provider.id, force, now);
    if (admission == null) return false;
    const baseCtx = { settings, force, nowMs: now };
    const ctxOverrides = provider.id === 'codex'
      ? { ...baseCtx, skipCodexUsage: admission.skipCodexUsage, skipCodexResetCredits: admission.skipCodexResetCredits }
      : baseCtx;
    const snapshot = await fetchQuota(this.providerContext(ctxOverrides));
    if (!snapshot) return false;
    return this.applyProviderQuotaSnapshot(snapshot, admission.requestSeq, now);
  }

  private async refreshProviderQuotas(settings: AppSettings, force = false): Promise<boolean> {
    const refreshes: Array<Promise<boolean>> = [];
    for (const provider of this.enabledProviders(settings)) {
      if (!provider.fetchQuota) continue;
      refreshes.push(this.refreshProviderQuota(provider, settings, force, provider.fetchQuota));
    }
    const results = await Promise.all(refreshes);
    return results.some(Boolean);
  }

  private consumeManualProviderUsageForce(): boolean {
    const now = Date.now();
    if (now - this.lastManualProviderUsageForceMs < StateManager.MANUAL_PROVIDER_USAGE_FORCE_MIN_INTERVAL_MS) {
      return false;
    }
    this.lastManualProviderUsageForceMs = now;
    return true;
  }

  async forceRefresh(): Promise<void> {
    this.clearHistoryWarmup();
    this.clearGitWarmup();
    await this.requestRefresh({
      mode: 'heavy',
      reason: 'manual',
      forceProviderUsage: this.consumeManualProviderUsageForce(),
      includeFullHistory: true,
      scanBudgetMs: StateManager.FOREGROUND_SCAN_BUDGET_MS,
    });
  }

  async resetUsageIndex(): Promise<void> {
    this.clearHistoryWarmup();
    this.clearGitWarmup();
    await this.usageIndex.reset();
    this.usageIndexProjections = [];
    this.usageIndexCoverage = incompleteUsageIndexCoverage();
    this.state = {
      ...this.state,
      usageTrend: emptyUsageTrendData(),
      historyWarmupPending: true,
      usageIndexCoverage: this.usageIndexCoverage,
      usageIndexHealth: this.usageIndex.getHealth(),
      stateFreshness: this.currentStateFreshness(),
    };
    this.publishState();
    await this.requestRefresh({
      mode: 'heavy',
      reason: 'manual',
      force: true,
      includeFullHistory: true,
    });
  }

  private startTimers() {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.heavyTimer) clearInterval(this.heavyTimer);
    const fastIntervalMs = this.uiVisible
      ? StateManager.FAST_REFRESH_VISIBLE_MS
      : StateManager.FAST_REFRESH_HIDDEN_MS;
    const heavyIntervalMs = this.uiVisible
      ? StateManager.HEAVY_REFRESH_VISIBLE_MS
      : StateManager.HEAVY_REFRESH_HIDDEN_MS;
    this.fastTimer = setInterval(() => {
      void this.requestRefresh({
        mode: 'fast',
        reason: 'timer',
        changedFiles: this.takeDirtySessionFiles(),
      });
    }, fastIntervalMs);
    this.heavyTimer = setInterval(() => {
      void this.requestRefresh({ mode: 'heavy', reason: 'timer', allowHiddenFullScan: true });
    }, heavyIntervalMs);
    if (!this.isPerfDebugEnabled()) return;
    console.info('[WhereMyTokens][runtime]', {
      label: 'timers:start',
      fastIntervalMs,
      heavyIntervalMs,
      hiddenUsesForcedScan: !this.uiVisible,
      ...this.getDebugCounts(),
    });
  }

  private scheduleHistoryWarmup(delayMs = StateManager.STARTUP_WARMUP_DELAY_MS, allowHiddenFullScan = false): number {
    if (this.historyWarmupTimer) clearTimeout(this.historyWarmupTimer);
    const startsAt = Date.now() + delayMs;
    this.historyWarmupTimer = setTimeout(() => {
      this.historyWarmupTimer = null;
      void this.requestRefresh({
        mode: 'heavy',
        reason: 'history-warmup',
        allowHiddenFullScan,
        includeFullHistory: true,
        scanBudgetMs: StateManager.FOREGROUND_SCAN_BUDGET_MS,
      });
    }, delayMs);
    return startsAt;
  }

  private clearHistoryWarmup(): void {
    if (!this.historyWarmupTimer) return;
    clearTimeout(this.historyWarmupTimer);
    this.historyWarmupTimer = null;
  }

  private scheduleGitWarmup(delayMs = StateManager.STARTUP_GIT_DELAY_MS): void {
    if (this.gitWarmupTimer) clearTimeout(this.gitWarmupTimer);
    this.gitWarmupTimer = setTimeout(() => {
      this.gitWarmupTimer = null;
      void this.refreshGitStatsAfterStartup();
    }, delayMs);
  }

  private clearGitWarmup(): void {
    if (!this.gitWarmupTimer) return;
    clearTimeout(this.gitWarmupTimer);
    this.gitWarmupTimer = null;
  }

  private computeDerivedUsage(settings: AppSettings): Pick<AppState, 'usage' | 'providerQuotas' | 'bridgeActive'> {
    const now = Date.now();
    const providerQuotas = this.buildProviderQuotas(now, settings);
    const usageVisibilityFilter = buildUsageVisibilityFilter(settings);
    const bridgeActive = !!(this.liveSession?._ts && now - this.liveSession._ts < 300_000);
    const resetWindows: UsageWindowResetHints = {};
    for (const provider of this.enabledProviderSet(settings)) {
      const windows = providerQuotas[provider]?.windows;
      if (!windows) continue;
      resetWindows[provider] = {
        weekResetMs: windows.week?.resetMs ?? null,
        h5ResetMs: windows.h5?.resetMs ?? null,
      };
    }
    const usage = computeUsageFromUsageIndex(
      this.usageIndexProjections,
      resetWindows,
      now,
      usageVisibilityFilter,
      providerQuotas,
    );
    return {
      usage,
      providerQuotas,
      bridgeActive,
    };
  }

  private buildUsageTrend(settings = this.getSettings()): UsageTrendData {
    return buildTrendDataFromUsageIndex(this.usageIndexProjections, buildUsageVisibilityFilter(settings));
  }

  private async refreshUsageIndexProjections(settings: AppSettings): Promise<void> {
    const enabled = this.enabledProviderSet(settings);
    const projections = await Promise.all(INDEXED_USAGE_PROVIDERS
      .filter(provider => enabled.has(provider))
      .map(provider => loadUsageIndexProjection(
        this.usageIndex,
        provider,
        settings.excludedProjects ?? [],
      )));
    this.usageIndexProjections = projections;
    this.usageIndexCoverage = projections.length > 0
      ? {
        state: projections.every(projection => projection.monthly.coverage.state === 'complete') ? 'complete' : 'incomplete',
        requiredSourceCount: projections.reduce((sum, projection) => sum + projection.monthly.coverage.requiredSourceCount, 0),
        indexedSourceCount: projections.reduce((sum, projection) => sum + projection.monthly.coverage.indexedSourceCount, 0),
        pendingSourceCount: projections.reduce((sum, projection) => sum + projection.monthly.coverage.pendingSourceCount, 0),
        failedSourceCount: projections.reduce((sum, projection) => sum + projection.monthly.coverage.failedSourceCount, 0),
      }
      : {
        state: 'complete',
        requiredSourceCount: 0,
        indexedSourceCount: 0,
        pendingSourceCount: 0,
        failedSourceCount: 0,
      };
  }

  private isExcludedSummary(
    filePath: string,
    summary: FileUsageSummary,
    provider: ProviderId,
    isExcluded: ReturnType<typeof makeExcludedMatcher>,
  ): boolean {
    if (summary.projectKeys && summary.projectKeys.length > 0) {
      return isExcluded(summary.projectKeys);
    }
    const adapter = this.providerRegistry.get(provider);
    if (adapter && isSourceBackedProvider(adapter) && adapter.isExcludedSource) {
      return adapter.isExcludedSource(this.sourceForPath(adapter, filePath), isExcluded);
    }
    return isExcluded([path.basename(path.dirname(filePath))]);
  }

  private getVisibleSummaries(settings: AppSettings): FileUsageSummary[] {
    const excludedProjects = settings.excludedProjects ?? [];
    const enabled = this.enabledProviderSet(settings);
    if (excludedProjects.length === 0) {
      return [...this.summaries.values()].filter(summary => enabled.has(summary.provider));
    }
    const isExcluded = makeExcludedMatcher(excludedProjects);
    const visible: FileUsageSummary[] = [];
    for (const [filePath, summary] of this.summaries.entries()) {
      if (!enabled.has(summary.provider)) continue;
      if (this.isExcludedSummary(filePath, summary, summary.provider, isExcluded)) continue;
      visible.push(summary);
    }
    return visible;
  }

  private countAllTimeUsageSessions(settings: AppSettings): number {
    const usageVisibilityFilter = buildUsageVisibilityFilter(settings);
    return this.getVisibleSummaries(settings).filter(summary =>
      usageProviderVisible(usageVisibilityFilter, summary.provider)
    ).length;
  }

  private sessionIdentityKey(session: Pick<DiscoveredSession, 'provider' | 'jsonlPath' | 'summaryKey' | 'cwd' | 'sessionId'>): string {
    if (session.summaryKey) return `${session.provider}:${session.summaryKey}`;
    return session.jsonlPath
      ? `${session.provider}:${normalizeFileKey(session.jsonlPath)}`
      : `${session.provider}:${session.cwd}:${session.sessionId}`;
  }

  private sessionSortValue(session: Pick<DiscoveredSession, 'lastModified' | 'startedAt'>): number {
    return session.lastModified?.getTime() ?? session.startedAt.getTime();
  }

  private isSameSessionInfo(a: SessionInfo, b: SessionInfo): boolean {
    return a.provider === b.provider
      && a.sessionId === b.sessionId
      && a.cwd === b.cwd
      && a.projectName === b.projectName
      && a.state === b.state
      && a.modelName === b.modelName
      && a.contextUsed === b.contextUsed
      && a.contextMax === b.contextMax
      && a.entrypoint === b.entrypoint
      && a.source === b.source
      && a.lastModified?.getTime() === b.lastModified?.getTime()
      && a.gitStats === b.gitStats
      && JSON.stringify(a.toolCounts) === JSON.stringify(b.toolCounts);
  }

  private sessionDebugExtras(nextSessions: SessionInfo[], extras: Partial<Omit<SessionBuildResult, 'sessions'>> = {}): Record<string, unknown> {
    const previousCount = this.state.sessions.length;
    const sessionCountDelta = extras.sessionCountDelta ?? (nextSessions.length - previousCount);
    const comparisonBaseline = previousCount;
    const anomaly = extras.anomaly
      ?? ((sessionCountDelta > StateManager.SESSION_SPIKE_MARGIN || nextSessions.length > comparisonBaseline + StateManager.SESSION_SPIKE_MARGIN)
        ? 'session-count-spike'
        : undefined);
    return {
      discoveryScope: extras.discoveryScope ?? StateManager.SESSION_SCOPE,
      discoveredCount: extras.discoveredCount ?? nextSessions.length,
      dedupedCount: extras.dedupedCount ?? 0,
      reusedCount: extras.reusedCount ?? 0,
      sessionCountDelta,
      anomaly,
    };
  }

  private async buildScopedSessionInfosDetailed(
    summaries: Map<string, FileUsageSummary> = this.summaries,
    extraJsonlPaths?: Iterable<string>,
  ): Promise<SessionBuildResult> {
    const settings = this.getSettings();
    const providers = this.enabledProviders(settings);
    const sourceBackedProviders = providers.filter(isSourceBackedProvider);
    const ctx = this.providerContext({ settings });
    const isExcluded = makeExcludedMatcher(settings.excludedProjects ?? []);
    const previousByKey = new Map(this.state.sessions.map(session => [this.sessionIdentityKey(session), session]));
    const sessionsByKey = new Map<string, SessionInfo>();
    const summarySources = new Map<string, { provider: SourceBackedProviderAdapter; source: ProviderSource }>();
    const discoveryPaths = new Set<string>();
    let discoveredCount = 0;
    let reusedCount = 0;

    const pushSource = (provider: SourceBackedProviderAdapter, source: ProviderSource): void => {
      const normalized = normalizeFileKey(source.filePath);
      discoveryPaths.add(normalized);
      if (summaries.has(normalized) && !summarySources.has(normalized)) {
        summarySources.set(normalized, { provider, source: { ...source, filePath: normalized } });
      }
    };

    for (const provider of sourceBackedProviders) {
      const limit = this.startupLimitForProvider(provider.id);
      for (const filePath of this.collectTrackedSessionFiles(provider.id, limit)) {
        pushSource(provider, this.sourceForPath(provider, filePath, true));
      }
      for (const source of provider.listRecentSources(ctx, limit).sources) {
        pushSource(provider, source);
      }
    }
    if (extraJsonlPaths) {
      for (const filePath of extraJsonlPaths) {
        const provider = this.providerForSourcePath(filePath, settings);
        if (provider) pushSource(provider, this.sourceForPath(provider, filePath, true));
      }
    }

    const addSession = (session: DiscoveredSession, summaryOverride?: FileUsageSummary | null) => {
      if (isExcluded(this.sessionProjectKeys(session))) return;
      discoveredCount += 1;
      const key = this.sessionIdentityKey(session);
      if (sessionsByKey.has(key)) return;
      const previous = previousByKey.get(key);
      const next = this.buildSessionInfo(session, previous?.gitStats, summaryOverride);
      if (previous && this.isSameSessionInfo(previous, next)) {
        reusedCount += 1;
        sessionsByKey.set(key, previous);
        return;
      }
      sessionsByKey.set(key, next);
    };

    const discoveryCtx = this.providerContext({
      settings,
      prioritySourceIds: discoveryPaths,
    });
    for (const provider of providers) {
      if (!provider.discoverSessions) continue;
      let discovered: DiscoveredSession[] = [];
      try {
        discovered = await provider.discoverSessions(discoveryCtx);
      } catch {
        continue;
      }
      for (const session of discovered) {
        const summary = session.summaryKey
          ? summaries.get(session.summaryKey) ?? null
          : session.jsonlPath
            ? summaries.get(normalizeFileKey(session.jsonlPath)) ?? null
            : null;
        if (isSourceBackedProvider(provider) && provider.id === 'codex' && !summary) continue;
        addSession(session, summary);
      }
    }

    for (const [filePath, { provider, source }] of summarySources) {
      const summary = summaries.get(filePath);
      if (!summary) continue;
      if (summary.provider !== provider.id) continue;
      const bootstrap = provider.buildStartupSession?.(ctx, source);
      if (!bootstrap) continue;
      addSession(bootstrap, summary);
    }

    const sessions = [...sessionsByKey.values()].sort((a, b) => this.sessionSortValue(b) - this.sessionSortValue(a));
    return {
      sessions,
      discoveryScope: StateManager.SESSION_SCOPE,
      discoveredCount,
      dedupedCount: Math.max(0, discoveredCount - sessions.length),
      reusedCount,
      sessionCountDelta: sessions.length - this.state.sessions.length,
      anomaly: this.state.sessions.length > 0 && sessions.length > this.state.sessions.length + StateManager.SESSION_SPIKE_MARGIN
        ? 'session-count-spike'
        : undefined,
    };
  }

  private debouncedFastRefresh(filePath?: string) {
    if (filePath) this.dirtySessionFiles.add(normalizeFileKey(filePath));
    if (this.fastDebounce) clearTimeout(this.fastDebounce);
    this.fastDebounce = setTimeout(() => {
      this.fastDebounce = null;
      const files = this.takeDirtySessionFiles();
      void this.requestRefresh({ mode: 'fast', reason: 'watcher', changedFiles: files });
    }, 1200);
  }

  private takeDirtySessionFiles(): Set<string> | undefined {
    if (this.dirtySessionFiles.size === 0) return undefined;
    const files = new Set(this.dirtySessionFiles);
    this.dirtySessionFiles.clear();
    return files;
  }

  private collectTrackedSessionFiles(
    provider: ProviderId,
    maxFiles: number,
    sessions: SessionInfo[] = this.state.sessions,
  ): string[] {
    const ranked = sessions
      .filter((session): session is SessionInfo & { jsonlPath: string } => session.provider === provider && !!session.jsonlPath)
      .sort((a, b) => {
        const aHot = a.state === 'active' ? 2 : (a.state === 'waiting' ? 1 : 0);
        const bHot = b.state === 'active' ? 2 : (b.state === 'waiting' ? 1 : 0);
        if (aHot !== bHot) return bHot - aHot;
        const aTs = a.lastModified?.getTime() ?? a.startedAt.getTime();
        const bTs = b.lastModified?.getTime() ?? b.startedAt.getTime();
        return bTs - aTs;
      })
      .slice(0, maxFiles);
    return ranked.map(session => normalizeFileKey(session.jsonlPath));
  }

  private retainScopedSessionInfos(
    sessions: SessionInfo[],
    extraJsonlPaths?: Iterable<string>,
  ): SessionInfo[] {
    const retainedPaths = new Set<string>();
    for (const filePath of this.collectTrackedSessionFiles('claude', StateManager.STARTUP_CLAUDE_FILE_LIMIT, sessions)) {
      retainedPaths.add(normalizeFileKey(filePath));
    }
    for (const filePath of this.collectTrackedSessionFiles('codex', StateManager.STARTUP_CODEX_FILE_LIMIT, sessions)) {
      retainedPaths.add(normalizeFileKey(filePath));
    }
    if (extraJsonlPaths) {
      for (const filePath of extraJsonlPaths) retainedPaths.add(normalizeFileKey(filePath));
    }

    return sessions.filter(session => {
      if (session.summaryKey) {
        return this.summaries.has(session.summaryKey)
          || session.state === 'active'
          || session.state === 'waiting';
      }
      if (!session.jsonlPath) return session.state === 'active' || session.state === 'waiting';
      return retainedPaths.has(normalizeFileKey(session.jsonlPath));
    });
  }

  private buildRecentWatchTargets(settings: AppSettings): string[] {
    const targets: string[] = [];
    const seen = new Set<string>();
    const pushFile = (filePath: string) => {
      const normalized = normalizeFileKey(filePath);
      if (seen.has(normalized) || !fs.existsSync(normalized)) return;
      seen.add(normalized);
      targets.push(normalized);
    };
    const ctx = this.providerContext({ settings });

    for (const provider of this.sourceBackedProviders(settings)) {
      const limit = provider.id === 'claude'
        ? StateManager.HIDDEN_CLAUDE_WATCH_LIMIT
        : StateManager.HIDDEN_CODEX_WATCH_LIMIT;
      for (const filePath of this.collectTrackedSessionFiles(provider.id, limit)) pushFile(filePath);
      for (const source of provider.listRecentSources(ctx, limit).sources) pushFile(source.filePath);
    }

    return targets;
  }

  private startWatcher(reason = 'refresh', mode: WatcherMode = 'auto') {
    this.watcher?.close();
    this.watcher = null;

    const settings = this.getSettings();
    const watchTargets: string[] = [];
    const seenTargets = new Set<string>();
    const pushTarget = (target: string) => {
      if (seenTargets.has(target)) return;
      seenTargets.add(target);
      watchTargets.push(target);
    };
    const useWideWatcher = mode === 'wide' || (mode === 'auto' && this.uiVisible);

    if (useWideWatcher) {
      const ctx = this.providerContext({ settings });
      for (const provider of this.sourceBackedProviders(settings)) {
        for (const target of provider.watchTargets?.(ctx, 'wide') ?? []) pushTarget(target);
      }
      this.watcherProfile = 'wide';
    } else {
      for (const target of this.buildRecentWatchTargets(settings)) pushTarget(target);
      this.watcherProfile = watchTargets.length > 0 ? 'recent' : 'off';
    }
    this.watcherTargetCount = watchTargets.length;
    if (watchTargets.length === 0) {
      this.logWatcherProfile(reason);
      return;
    }

    this.watcher = chokidar.watch(watchTargets, { ignoreInitial: true });
    this.watcher.on('add', (filePath: string) => {
      if (filePath.endsWith('.jsonl')) {
        this.debouncedFastRefresh(filePath);
      } else {
        void this.requestRefresh({ mode: 'fast', reason: 'watcher' });
      }
    });
    this.watcher.on('unlink', (filePath: string) => {
      if (filePath.endsWith('.jsonl')) {
        this.summaries.delete(normalizeFileKey(filePath));
        invalidateSessionMetadataCache(filePath);
        this.codexRateLimits = this.collectCodexRateLimits();
      }
      this.debouncedFastRefresh();
    });
    this.watcher.on('change', (filePath: string) => {
      this.debouncedFastRefresh(filePath);
    });
    this.logWatcherProfile(reason);
  }

  private async fastRefresh(changedFiles?: Set<string>) {
    const totalPerf = this.beginPerfSample();
    let changedPerf: PerfMetrics | null = null;
    let sessionPerf: PerfMetrics | null = null;
    let sessionResult: SessionBuildResult | null = null;

    if (changedFiles && changedFiles.size > 0) {
      const changedSample = this.beginPerfSample();
      await this.refreshChangedSummaries(changedFiles);
      changedPerf = this.finishPerfSample(changedSample);
    }

    const sessionSample = this.beginPerfSample();
    const sessions = changedFiles && changedFiles.size > 0
      ? ((sessionResult = this.updateChangedSessionInfos(changedFiles)).sessions)
      : ((sessionResult = this.refreshCachedSessionInfos()).sessions);
    sessionPerf = this.finishPerfSample(sessionSample);
    const settings = this.getSettings();
    const derived = this.computeDerivedUsage(settings);
    const usageTrend = this.buildUsageTrend();
    const codexAccount = this.codexAccountForSettings(settings);
    const codeOutputStats = this.buildCodeOutputStats(sessions, this.state.repoGitStats);
    const allTimeSessions = this.countAllTimeUsageSessions(settings);
    this.state = {
      ...this.state,
      sessions,
      settings,
      usage: derived.usage,
      usageTrend,
      providerQuotas: derived.providerQuotas,
      codexAccount,
      bridgeActive: derived.bridgeActive,
      apiStatusLabel: this.apiStatusLabel || undefined,
      apiError: this.apiError || undefined,
      codexUsageConnected: this.codexUsageConnected,
      codexStatusLabel: this.codexStatusLabel || undefined,
      codexError: this.codexError || undefined,
      codeOutputStats,
      codeOutputLoading: false,
      allTimeSessions,
      stateFreshness: this.currentStateFreshness(),
      lastUpdated: Date.now(),
    };
    this.publishState();
    this.logPerfTrace('fastRefresh', totalPerf, {
      changedFiles: changedFiles?.size ?? 0,
      uiVisible: this.uiVisible,
      ...(changedPerf ? this.perfFields('changed', changedPerf) : {}),
      ...(sessionPerf ? this.perfFields('sessions', sessionPerf) : {}),
      ...(sessionResult ? this.sessionDebugExtras(sessions, sessionResult) : {}),
    });
  }

  private async refreshGitStatsAfterStartup(): Promise<void> {
    if (this.uiBusy || this.refreshScheduler.isRunning()) {
      this.scheduleGitWarmup(5_000);
      return;
    }

    const settings = this.getSettings();
    const repoGitStats = await this.getRepoGitStats(settings, false, this.state.sessions);
    const sessions = this.attachCachedGitStats(this.state.sessions);
    const codeOutputStats = this.buildCodeOutputStats(sessions, repoGitStats);
    this.state = {
      ...this.state,
      sessions,
      repoGitStats,
      codeOutputStats,
      codeOutputLoading: false,
      stateFreshness: this.currentStateFreshness(),
      lastUpdated: Date.now(),
    };
    this.publishState();
  }

  private async heavyRefresh(
    force = false,
    forceProviderUsage = false,
    allowStartupBudget = false,
    scanBudgetMs: number | null = null,
    allowHiddenFullScan = false,
    priorityFiles?: Set<string>,
    includeFullHistory = false,
  ) {
    const totalPerf = this.beginPerfSample();
    let apiPerf: PerfMetrics | null = null;
    let loadPerf: PerfMetrics | null = null;
    let sessionPerf: PerfMetrics | null = null;
    let gitPerf: PerfMetrics | null = null;
    let sessionResult: SessionBuildResult | null = null;
      await this.logMemorySnapshot('heavyRefresh:start');
      const apiSample = this.beginPerfSample();
      const settingsForApi = this.getSettings();
      await this.refreshProviderQuotas(settingsForApi, force || forceProviderUsage);
      apiPerf = this.finishPerfSample(apiSample);
      const initialRefreshDone = this.startupFreshComplete;
      const effectiveScanBudgetMs = scanBudgetMs ?? (allowStartupBudget && !initialRefreshDone ? StateManager.STARTUP_SCAN_BUDGET_MS : null);
      if (!force && !allowHiddenFullScan && initialRefreshDone && !this.uiVisible) {
        const sessionSample = this.beginPerfSample();
        const settings = this.getSettings();
        const derived = this.computeDerivedUsage(settings);
        const usageTrend = this.buildUsageTrend();
        const codexAccount = this.codexAccountForSettings(settings);
        const sessionState = this.refreshCachedSessionInfos();
        const sessions = sessionState.sessions;
        sessionResult = sessionState;
        const codeOutputStats = this.buildCodeOutputStats(sessions, this.state.repoGitStats);
        const allTimeSessions = this.countAllTimeUsageSessions(settings);
        sessionPerf = this.finishPerfSample(sessionSample);
        this.state = {
          ...this.state,
          sessions,
          usage: derived.usage,
          usageTrend,
          providerQuotas: derived.providerQuotas,
          settings,
          codexAccount,
          lastUpdated: Date.now(),
          apiConnected: this.apiConnected,
          apiStatusLabel: this.apiStatusLabel || undefined,
          apiError: this.apiError || undefined,
          codexUsageConnected: this.codexUsageConnected,
          codexStatusLabel: this.codexStatusLabel || undefined,
          codexError: this.codexError || undefined,
          bridgeActive: derived.bridgeActive,
          codeOutputStats,
          codeOutputLoading: false,
          allTimeSessions,
          stateFreshness: this.currentStateFreshness(),
        };
        this.publishState();
        checkAlerts(derived.providerQuotas, settings.alertThresholds, settings.enableAlerts, this.enabledProviderSet(settings), {
          deferCodexLocalLog: this.state.historyWarmupPending,
          quotaTargetModes: settings.quotaTargetModes,
        });
        this.logPerfTrace('heavyRefresh:deferred', totalPerf, {
          uiVisible: false,
          ...(apiPerf ? this.perfFields('api', apiPerf) : {}),
          ...(sessionPerf ? this.perfFields('sessions', sessionPerf) : {}),
          ...(sessionResult ? this.sessionDebugExtras(sessions, sessionResult) : {}),
        });
        return;
      }
      const loadSample = this.beginPerfSample();
      const loaded = await this.loadProviderSummaries(
        force,
        effectiveScanBudgetMs,
        priorityFiles,
        includeFullHistory,
        includeFullHistory,
      );
      loadPerf = this.finishPerfSample(loadSample);
      this.startupFreshComplete = true;
      const totalScannedFiles = loaded.scannedFiles;
      const summaryPartial = loaded.scanPartial || loaded.sourceListPartial;
      const partialHistoryScan = summaryPartial;
      const nextSummaries = partialHistoryScan && initialRefreshDone
        ? new Map([...this.summaries, ...loaded.summaries])
        : loaded.summaries;
      const nextCodexRateLimits = partialHistoryScan && initialRefreshDone
        ? this.mergeCodexRateLimits(this.codexRateLimits, loaded.codexRateLimits ?? undefined)
        : loaded.codexRateLimits;
      this.summaries = nextSummaries;
      this.codexRateLimits = nextCodexRateLimits;

      const settings = this.getSettings();
      const derived = this.computeDerivedUsage(settings);
      const usageTrend = this.buildUsageTrend();
      const codexAccount = this.codexAccountForSettings(settings);
      const allTimeSessions = this.countAllTimeUsageSessions(settings);
      const showHistoryWarmupBanner = allowStartupBudget && !initialRefreshDone && partialHistoryScan;
      const historyWarmupStartsAt = partialHistoryScan
        ? this.scheduleHistoryWarmup(
            showHistoryWarmupBanner ? StateManager.STARTUP_WARMUP_DELAY_MS : StateManager.FOREGROUND_WARMUP_DELAY_MS,
            true,
          )
        : null;
      const keepHistoryWarmupBanner = partialHistoryScan
        && (showHistoryWarmupBanner || this.state.historyWarmupPending);
      if (!partialHistoryScan) this.clearHistoryWarmup();
      const sessionBuildSample = this.beginPerfSample();
      sessionResult = await this.buildScopedSessionInfosDetailed(nextSummaries);
      let sessions = sessionResult.sessions;
      sessionPerf = this.finishPerfSample(sessionBuildSample);
      const partialCodeOutputStats = this.buildCodeOutputStats(sessions, this.state.repoGitStats);
      this.state = {
        sessions,
        usage: derived.usage,
        usageTrend,
        providerQuotas: derived.providerQuotas,
        settings,
        codexAccount,
        stateFreshness: 'fresh',
        initialRefreshComplete: true,
        historyWarmupPending: keepHistoryWarmupBanner,
        historyWarmupStartsAt: keepHistoryWarmupBanner ? historyWarmupStartsAt : null,
        usageIndexCoverage: this.usageIndexCoverage,
        usageIndexHealth: this.usageIndex.getHealth(),
        lastUpdated: Date.now(),
        apiConnected: this.apiConnected,
        apiStatusLabel: this.apiStatusLabel || undefined,
        apiError: this.apiError || undefined,
        codexUsageConnected: this.codexUsageConnected,
        codexStatusLabel: this.codexStatusLabel || undefined,
        codexError: this.codexError || undefined,
        bridgeActive: derived.bridgeActive,
        repoGitStats: this.state.repoGitStats,
        codeOutputStats: partialCodeOutputStats,
        codeOutputLoading: true,
        allTimeSessions,
      };
      this.publishState();
      if (!initialRefreshDone && !force) {
        this.scheduleGitWarmup();
        checkAlerts(derived.providerQuotas, settings.alertThresholds, settings.enableAlerts, this.enabledProviderSet(settings), {
          deferCodexLocalLog: partialHistoryScan,
          quotaTargetModes: settings.quotaTargetModes,
        });
        await this.logMemorySnapshot('heavyRefresh:end', totalScannedFiles);
        if (!this.uiVisible) this.startWatcher('heavyRefresh:startupsync');
        else this.scheduleWideWatcherPromotion();
        this.logPerfTrace('heavyRefresh', totalPerf, {
          force,
          scannedFiles: totalScannedFiles,
          summaryScannedFiles: loaded.scannedFiles,
          partial: partialHistoryScan,
          summaryPartial: loaded.partial,
          summarySourcePartial: loaded.sourceListPartial,
          summaryScanPartial: loaded.scanPartial,
          scanBudgetMs: effectiveScanBudgetMs,
          ...(apiPerf ? this.perfFields('api', apiPerf) : {}),
          ...(loadPerf ? this.perfFields('load', loadPerf) : {}),
          ...(sessionPerf ? this.perfFields('sessions', sessionPerf) : {}),
          ...(sessionResult ? this.sessionDebugExtras(sessions, sessionResult) : {}),
        });
        return;
      }
      this.clearGitWarmup();

      const gitSample = this.beginPerfSample();
      const repoGitStats = await this.getRepoGitStats(settings, force, sessions);
      gitPerf = this.finishPerfSample(gitSample);
      sessions = this.attachCachedGitStats(sessions);
      const codeOutputStats = this.buildCodeOutputStats(sessions, repoGitStats);

      this.state = {
        sessions,
        usage: derived.usage,
        usageTrend,
        providerQuotas: derived.providerQuotas,
        settings,
        codexAccount,
        stateFreshness: 'fresh',
        initialRefreshComplete: true,
        historyWarmupPending: keepHistoryWarmupBanner,
        historyWarmupStartsAt: keepHistoryWarmupBanner ? historyWarmupStartsAt : null,
        usageIndexCoverage: this.usageIndexCoverage,
        usageIndexHealth: this.usageIndex.getHealth(),
        lastUpdated: Date.now(),
        apiConnected: this.apiConnected,
        apiStatusLabel: this.apiStatusLabel || undefined,
        apiError: this.apiError || undefined,
        codexUsageConnected: this.codexUsageConnected,
        codexStatusLabel: this.codexStatusLabel || undefined,
        codexError: this.codexError || undefined,
        bridgeActive: derived.bridgeActive,
        repoGitStats,
        codeOutputStats,
        codeOutputLoading: false,
        allTimeSessions,
      };
      this.publishState();

      checkAlerts(derived.providerQuotas, settings.alertThresholds, settings.enableAlerts, this.enabledProviderSet(settings), {
        deferCodexLocalLog: partialHistoryScan,
        quotaTargetModes: settings.quotaTargetModes,
      });
      await this.logMemorySnapshot('heavyRefresh:end', totalScannedFiles);
      if (!this.uiVisible) this.startWatcher('heavyRefresh:hidden');
      this.logPerfTrace('heavyRefresh', totalPerf, {
        force,
        scannedFiles: totalScannedFiles,
        summaryScannedFiles: loaded.scannedFiles,
        partial: partialHistoryScan,
        summaryPartial: loaded.partial,
        summarySourcePartial: loaded.sourceListPartial,
        summaryScanPartial: loaded.scanPartial,
        scanBudgetMs: effectiveScanBudgetMs,
        ...(apiPerf ? this.perfFields('api', apiPerf) : {}),
        ...(loadPerf ? this.perfFields('load', loadPerf) : {}),
        ...(sessionPerf ? this.perfFields('sessions', sessionPerf) : {}),
        ...(gitPerf ? this.perfFields('git', gitPerf) : {}),
        ...(sessionResult ? this.sessionDebugExtras(sessions, sessionResult) : {}),
      });
  }

  private buildStartupPriorityFiles(providers: readonly ProviderId[]): Set<string> {
    const priority = new Set<string>();
    const settings = normalizeSettings({ ...this.getSettings(), enabledProviders: providers });

    for (const sourceProvider of this.sourceBackedProviders(normalizeSettings(settings))) {
      for (const filePath of this.collectTrackedSessionFiles(sourceProvider.id, this.startupLimitForProvider(sourceProvider.id))) {
        priority.add(normalizeFileKey(filePath));
      }
    }

    return priority;
  }

  private async buildStartupSessionInfos(summaries: Map<string, FileUsageSummary>): Promise<SessionInfo[]> {
    return (await this.buildScopedSessionInfosDetailed(summaries)).sessions;
  }

  private buildProviderQuotas(now = Date.now(), settings: AppSettings = this.getSettings()): ProviderQuotaMap {
    const quotas: ProviderQuotaMap = {};
    const enabled = this.enabledProviderSet(settings);
    for (const [provider, snapshot] of this.providerQuotaSnapshots.entries()) {
      if (!enabled.has(provider)) continue;
      const publicSnapshot = sanitizeProviderQuotaSnapshot(provider, snapshot);
      if (publicSnapshot) quotas[provider] = publicSnapshot;
    }
    if (enabled.has('claude')) quotas.claude = this.buildClaudeProviderQuota(now);
    if (enabled.has('codex')) quotas.codex = this.buildCodexProviderQuota(now);
    return quotas;
  }

  private buildClaudeProviderQuota(now: number): ProviderQuotaSnapshot {
    const displayMetadata = buildClaudeQuotaDisplayMetadata();
    const apiUsagePct = this.getAgedApiUsagePct(now);
    const rl = this.liveSession?.rate_limits;
    const bridgeActive = !!(this.liveSession?._ts && now - this.liveSession._ts < 300_000);
    const bridgeH5 = bridgeActive && rl?.five_hour
      ? {
          pct: rl.five_hour.used_percentage ?? 0,
          resetMs: rl.five_hour.resets_at ? rl.five_hour.resets_at - now : null,
        }
      : null;
    const bridgeWeek = bridgeActive && rl?.seven_day
      ? {
          pct: rl.seven_day.used_percentage ?? 0,
          resetMs: rl.seven_day.resets_at ? rl.seven_day.resets_at - now : null,
      }
      : null;
    const status = {
      connected: this.apiConnected,
      code: this.apiStatusLabel || (this.apiConnected ? 'connected' : 'unknown'),
      label: this.apiStatusLabel || undefined,
      detail: this.apiError || undefined,
    };
    const planName = apiUsagePct?.plan || this.state.providerQuotas.claude?.planName;

    if (apiUsagePct) {
      const source: ProviderQuotaSnapshot['source'] = this.apiConnected ? 'api' : 'cache';
      const claudeH5 = !this.apiConnected && bridgeH5
        ? {
            pct: bridgeH5.pct,
            resetMs: bridgeH5.resetMs,
            source: 'statusLine' as ProviderQuotaSnapshot['source'],
          }
        : {
            pct: apiUsagePct.h5Pct,
            resetMs: apiUsagePct.h5ResetMs ?? bridgeH5?.resetMs ?? null,
            resetLabel: (apiUsagePct.h5ResetMs ?? bridgeH5?.resetMs ?? null) == null ? 'Claude 5h reset unavailable' : undefined,
            source,
          };
      const claudeWeek = !this.apiConnected && bridgeWeek
        ? {
            pct: bridgeWeek.pct,
            resetMs: bridgeWeek.resetMs,
            source: 'statusLine' as ProviderQuotaSnapshot['source'],
          }
        : {
            pct: apiUsagePct.weekPct,
            resetMs: apiUsagePct.weekResetMs ?? bridgeWeek?.resetMs ?? null,
            resetLabel: (apiUsagePct.weekResetMs ?? bridgeWeek?.resetMs ?? null) == null ? 'Claude weekly reset unavailable' : undefined,
            source,
          };
      return {
        provider: 'claude',
        source,
        capturedAt: now,
        accountLabel: planName || undefined,
        planName: planName || undefined,
        ...displayMetadata,
        windows: {
          h5: claudeH5,
          week: claudeWeek,
          sonnetWeek: {
            pct: apiUsagePct.soPct,
            resetMs: apiUsagePct.soResetMs,
            resetLabel: apiUsagePct.soResetMs == null ? 'Claude Sonnet reset unavailable' : undefined,
            source,
          },
        },
        credits: this.claudeCredits(apiUsagePct),
        status,
      };
    }

    if (bridgeH5 || bridgeWeek) {
      return {
        provider: 'claude',
        source: 'statusLine',
        capturedAt: now,
        accountLabel: planName || undefined,
        planName: planName || undefined,
        ...displayMetadata,
        windows: {
          h5: bridgeH5 ? { pct: bridgeH5.pct, resetMs: bridgeH5.resetMs, source: 'statusLine' } : emptyQuotaWindow(),
          week: bridgeWeek ? { pct: bridgeWeek.pct, resetMs: bridgeWeek.resetMs, source: 'statusLine' } : emptyQuotaWindow(),
          sonnetWeek: emptyQuotaWindow(),
        },
        status,
      };
    }

    if (this.apiStatusLabel === 'local only') {
      return {
        provider: 'claude',
        source: 'cache',
        capturedAt: now,
        accountLabel: planName || undefined,
        planName: planName || undefined,
        ...displayMetadata,
        windows: {
          h5: emptyQuotaWindow(),
          week: emptyQuotaWindow(),
          sonnetWeek: emptyQuotaWindow(),
        },
        status,
      };
    }

    const previous = this.state.providerQuotas.claude?.windows ?? {};
    return {
      provider: 'claude',
      source: 'cache',
      capturedAt: now,
      accountLabel: planName || undefined,
      planName: planName || undefined,
      ...displayMetadata,
      windows: {
        h5: canReuseClaudeCachedWindow(previous.h5) ? { ...previous.h5, source: 'cache' } : emptyQuotaWindow(),
        week: canReuseClaudeCachedWindow(previous.week) ? { ...previous.week, source: 'cache' } : emptyQuotaWindow(),
        sonnetWeek: canReuseClaudeCachedWindow(previous.sonnetWeek) ? { ...previous.sonnetWeek, source: 'cache' } : emptyQuotaWindow(),
      },
      status,
    };
  }

  private claudeCredits(usage: ApiUsagePct | null): ProviderQuotaSnapshot['credits'] {
    const extraUsage = usage?.extraUsage;
    if (!extraUsage?.isEnabled) return undefined;
    return {
      extraUsage: {
        available: Math.max(0, extraUsage.monthlyLimit - extraUsage.usedCredits),
        used: extraUsage.usedCredits,
        total: extraUsage.monthlyLimit,
        remainingPct: Math.max(0, Math.min(100, 100 - extraUsage.utilization)),
        resetMs: null,
      },
    };
  }

  private buildCodexProviderQuota(now: number): ProviderQuotaSnapshot {
    const windows = this.getCodexLimitWindows(now);
    const raw = sanitizeProviderQuotaSnapshot('codex', this.providerQuotaSnapshots.get('codex'));
    const source = windows.h5.source ?? windows.week.source ?? raw?.source ?? (this.codexUsageConnected ? 'api' : 'localLog');
    const currentAuthMtimeMs = getCodexAuthMtimeMs();
    const currentAuthIdentityHash = getCodexAuthIdentityHash();
    const storedReset = this.codexAuthMarkerMatches(this.codexResetAuthMtimeMs, this.codexResetAuthIdentityHash, currentAuthMtimeMs, currentAuthIdentityHash)
      ? this.codexResetCredits
      : null;
    const resetConnected = this.codexResetStatus ? this.codexResetStatus.code === 'ok' : this.codexUsageConnected;
    const rawResetCandidate = (raw as ProviderQuotaSnapshot | undefined)?.resetCredits ?? null;
    const rawResetFresh = !rawResetCandidate?.countOnly || now - rawResetCandidate.checkedAt <= CODEX_RESET_COUNT_ONLY_TTL_MS;
    const rawReset = rawResetCandidate && rawResetFresh && this.codexAuthMarkerMatches(this.codexResetAttemptAuthMtimeMs, this.codexResetAttemptAuthIdentityHash, currentAuthMtimeMs, currentAuthIdentityHash)
      ? rawResetCandidate
      : null;
    const fallbackResetFresh = !!this.codexResetCountOnlyFallback && now - this.codexResetCountOnlyFallback.checkedAt <= CODEX_RESET_COUNT_ONLY_TTL_MS;
    const fallbackReset = this.codexResetCountOnlyFallback && fallbackResetFresh && this.codexAuthMarkerMatches(this.codexResetAttemptAuthMtimeMs, this.codexResetAttemptAuthIdentityHash, currentAuthMtimeMs, currentAuthIdentityHash)
      ? this.codexResetCountOnlyFallback
      : null;
    let resetCredits: ProviderResetCreditsData | null;
    if (fallbackReset) {
      resetCredits = sanitizeResetCredits(activeCodexResetCredits(fallbackReset, now, resetConnected, this.codexResetStatus));
    } else if (storedReset) {
      resetCredits = sanitizeResetCredits(activeCodexResetCredits(storedReset, now, resetConnected, this.codexResetStatus));
    } else if (rawReset) {
      resetCredits = sanitizeResetCredits(rawReset);
    } else if (this.codexResetStatus && this.codexResetStatus.code !== 'ok') {
      resetCredits = sanitizeResetCredits({ credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: this.codexResetCreditsStoredAt || now, countOnly: false, source: 'api', status: this.codexResetStatus });
    } else {
      resetCredits = null;
    }
    return {
      ...raw,
      ...buildCodexQuotaDisplayMetadata(),
      provider: 'codex',
      source,
      capturedAt: now,
      planName: this.getAgedCodexUsagePct(now)?.plan || raw?.planName,
      windows,
      resetCredits,
      status: raw?.status ?? {
        connected: this.codexUsageConnected,
        code: this.codexUsageConnected ? 'connected' : 'local-log',
      },
    };
  }

  private getCodexLocalLogWindows(now: number): { h5: ProviderQuotaWindow; week: ProviderQuotaWindow } {
    const toWindow = (window: CodexRateLimitWindow | undefined, maxWindowMs: number): ProviderQuotaWindow => {
      if (!window) return emptyQuotaWindow();
      const resetMs = window.resetsAt * 1000 - now;
      if (!Number.isFinite(window.pct) || !Number.isFinite(resetMs) || resetMs <= 0 || resetMs > maxWindowMs) {
        return emptyQuotaWindow();
      }
      return {
        pct: Math.max(0, Math.min(100, window.pct)),
        resetMs,
        source: 'localLog',
      };
    };
    return {
      h5: toWindow(this.codexRateLimits?.h5, CODEX_H5_WINDOW_MS),
      week: toWindow(this.codexRateLimits?.week, CODEX_WEEK_WINDOW_MS),
    };
  }

  private getCodexLimitWindows(now: number): { h5: ProviderQuotaWindow; week: ProviderQuotaWindow } {
    const local = this.getCodexLocalLogWindows(now);
    const live = this.getAgedCodexUsagePct(now);
    if (!live) return local;
    const source: ProviderQuotaSnapshot['source'] = this.codexUsageConnected ? 'api' : 'cache';
    const liveWindow = (
      available: boolean,
      pct: number,
      resetMs: number | null,
      resetLabel: string,
    ): ProviderQuotaWindow | null => {
      if (!available) return null;
      return {
        pct: Math.max(0, Math.min(100, pct)),
        resetMs,
        resetLabel: resetMs == null ? resetLabel : undefined,
        source,
      };
    };
    return {
      h5: liveWindow(live.h5Available, live.h5Pct, live.h5ResetMs, 'Codex 5h reset unavailable') ?? local.h5,
      week: liveWindow(live.weekAvailable, live.weekPct, live.weekResetMs, 'Codex weekly reset unavailable') ?? local.week,
    };
  }

  private mergeCodexRateLimits(
    current: SessionSnapshot['codexRateLimits'] | null,
    next: SessionSnapshot['codexRateLimits'] | undefined,
  ): SessionSnapshot['codexRateLimits'] | null {
    if (!next?.h5 && !next?.week) return current;
    const merged: SessionSnapshot['codexRateLimits'] = { ...(current ?? {}) };
    if (next.h5 && (!merged.h5 || next.h5.observedAt >= merged.h5.observedAt)) merged.h5 = next.h5;
    if (next.week && (!merged.week || next.week.observedAt >= merged.week.observedAt)) merged.week = next.week;
    return merged;
  }

  private collectCodexRateLimits(): SessionSnapshot['codexRateLimits'] | null {
    let merged: SessionSnapshot['codexRateLimits'] | null = null;
    for (const summary of this.summaries.values()) {
      if (summary.provider !== 'codex') continue;
      merged = this.mergeCodexRateLimits(merged, summary.sessionSnapshot.codexRateLimits);
    }
    return merged;
  }

  private async scanGenericProviderUsage(
    settings: AppSettings,
    ctx: ProviderContext,
  ): Promise<{
    summaries: Map<string, FileUsageSummary>;
    scannedFiles: number;
    partial: boolean;
  }> {
    const summaries = new Map<string, FileUsageSummary>();
    let scannedFiles = 0;
    let partial = false;

    for (const provider of this.enabledProviders(settings)) {
      if (isSourceBackedProvider(provider) || !provider.scanUsage) continue;
      try {
        const result = await provider.scanUsage(ctx);
        this.usageIndex.declareSources(
          provider.id,
          result.usageIndexSources.map(source => source.descriptor),
          !result.partial,
        );
        for (const source of result.usageIndexSources) {
          try {
            const refreshed = await this.usageIndex.refreshSource(source.descriptor, source.scanner);
            if (refreshed.status !== 'unchanged') scannedFiles += 1;
            const [projection] = await this.usageIndex.readSessionProjections([source.descriptor.sourceId]);
            if (projection) {
              summaries.set(
                source.descriptor.sourceId,
                sessionSummaryFromProjection(projection, source.descriptor),
              );
            }
          } catch {
            partial = true;
          }
        }
        partial = partial || result.partial;
      } catch {
        partial = true;
      }
    }

    return { summaries, scannedFiles, partial };
  }

  private async loadProviderSummaries(
    force = false,
    budgetMs: number | null = null,
    priorityFiles?: Iterable<string>,
    includeFullHistory = false,
    includeIndexedFullHistory = false,
  ): Promise<{
    summaries: Map<string, FileUsageSummary>;
    sessionCount: number;
    codexRateLimits: SessionSnapshot['codexRateLimits'] | null;
    scannedFiles: number;
    partial: boolean;
    sourceListPartial: boolean;
    scanPartial: boolean;
  }> {
    const settings = this.getSettings();
    const summaries = new Map<string, FileUsageSummary>();
    let sessionCount = 0;
    let codexRateLimits: SessionSnapshot['codexRateLimits'] | null = null;
    let scannedFiles = 0;
    let sourceListPartial = false;
    let scanPartial = false;
    const startedAt = Date.now();
    const startupPriority = new Set<string>();
    for (const filePath of priorityFiles ?? []) startupPriority.add(normalizeFileKey(filePath));
    const providers = this.sourceBackedProviders(settings);

    if (budgetMs !== null) {
      for (const provider of providers) {
        if (provider.id !== 'claude' && provider.id !== 'codex') continue;
        for (const filePath of this.collectTrackedSessionFiles(provider.id, this.startupLimitForProvider(provider.id))) {
          startupPriority.add(normalizeFileKey(filePath));
        }
      }
    } else {
      const discoveryCtx = this.providerContext({
        settings,
        force,
        includeFullHistory: false,
        prioritySourceIds: startupPriority,
      });
      for (const provider of providers) {
        if (!provider.discoverSessions) continue;
        let discovered: DiscoveredSession[] = [];
        try {
          discovered = await provider.discoverSessions(discoveryCtx);
        } catch {
          continue;
        }
        for (const session of discovered) {
          if (session.jsonlPath) startupPriority.add(normalizeFileKey(session.jsonlPath));
        }
      }
    }

    const ctx = this.providerContext({
      settings,
      force,
      scanBudgetMs: budgetMs,
      includeFullHistory,
      prioritySourceIds: startupPriority,
    });

    const shouldStopForBudget = () => budgetMs !== null && Date.now() - startedAt >= budgetMs;
    const shouldPrioritize = (source: ProviderSource) => source.priority === true || startupPriority.has(normalizeFileKey(source.filePath));

    const scanSummary = async (
      indexedSource: { descriptor: UsageSourceDescriptor; scanner: UsageSourceScanner },
    ): Promise<FileUsageSummary | null> => {
      try {
        const refreshed = await this.usageIndex.refreshSource(indexedSource.descriptor, indexedSource.scanner);
        if (refreshed.status !== 'unchanged') scannedFiles += 1;
        const [projection] = await this.usageIndex.readSessionProjections([indexedSource.descriptor.sourceId]);
        return projection ? sessionSummaryFromProjection(projection, indexedSource.descriptor) : null;
      } catch {
        scanPartial = true;
        return null;
      }
    };

    for (const provider of this.sourceBackedProviders(settings)) {
      const sourcesByPath = new Map<string, ProviderSource>();
      for (const filePath of startupPriority) {
        if (!provider.ownsPath(filePath)) continue;
        const source = this.sourceForPath(provider, filePath, true);
        sourcesByPath.set(normalizeFileKey(source.filePath), source);
      }

      const sourceList = includeFullHistory || (includeIndexedFullHistory && !!provider.usageIndexSource)
        ? provider.listAllSources(ctx)
        : provider.listRecentSources(ctx, this.startupLimitForProvider(provider.id));
      sourceListPartial = sourceListPartial || sourceList.truncated;
      for (const source of sourceList.sources) {
        const key = normalizeFileKey(source.filePath);
        if (!sourcesByPath.has(key)) sourcesByPath.set(key, source);
      }

      const sources = [...sourcesByPath.values()]
        .sort((a, b) => Number(shouldPrioritize(b)) - Number(shouldPrioritize(a)));

      const preparedSources: Array<{
        source: ProviderSource;
        indexedSource: { descriptor: UsageSourceDescriptor; scanner: UsageSourceScanner };
      }> = [];
      let providerPreparationPartial = false;
      for (const source of sources) {
        if (!fs.existsSync(source.filePath)) continue;
        try {
          preparedSources.push({ source, indexedSource: provider.usageIndexSource(ctx, source) });
        } catch {
          providerPreparationPartial = true;
          scanPartial = true;
        }
      }
      this.usageIndex.declareSources(
        provider.id,
        preparedSources.map(prepared => prepared.indexedSource.descriptor),
        !sourceList.truncated && !providerPreparationPartial,
      );

      for (const { source, indexedSource } of preparedSources) {
        const priority = shouldPrioritize(source);
        if (!priority && shouldStopForBudget()) {
          scanPartial = true;
          break;
        }
        const summary = await scanSummary(indexedSource);
        if (!summary) continue;
        sessionCount += 1;
        if (provider.id === 'codex') {
          codexRateLimits = this.mergeCodexRateLimits(codexRateLimits, summary.sessionSnapshot.codexRateLimits);
        }
        summaries.set(normalizeFileKey(source.filePath), summary);
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingBudgetMs = budgetMs === null ? null : Math.max(0, budgetMs - elapsedMs);
    if (remainingBudgetMs === 0) {
      scanPartial = true;
    } else {
      const genericCtx = budgetMs === null
        ? ctx
        : this.providerContext({
          settings,
          force,
          scanBudgetMs: remainingBudgetMs,
          includeFullHistory,
          prioritySourceIds: startupPriority,
        });
      const genericUsage = await this.scanGenericProviderUsage(settings, genericCtx);
      for (const [key, summary] of genericUsage.summaries.entries()) {
        summaries.set(key, summary);
      }
      scannedFiles += genericUsage.scannedFiles;
      scanPartial = scanPartial || genericUsage.partial;
    }

    await this.refreshUsageIndexProjections(settings);

    return {
      summaries,
      sessionCount,
      codexRateLimits,
      scannedFiles,
      partial: sourceListPartial || scanPartial,
      sourceListPartial,
      scanPartial,
    };
  }

  private async refreshChangedSummaries(changedFiles: Set<string>): Promise<void> {
    const settings = this.getSettings();
    const ctx = this.providerContext({ settings, force: true });
    for (const file of changedFiles) {
      const normalizedPath = normalizeFileKey(file);
      const provider = this.providerForSourcePath(file, settings);
      if (!provider) continue;
      if (!fs.existsSync(file)) {
        this.summaries.delete(normalizedPath);
        continue;
      }
      try {
        const source = this.sourceForPath(provider, file, true);
        const indexedSource = provider.usageIndexSource(ctx, source);
        await this.usageIndex.refreshSource(indexedSource.descriptor, indexedSource.scanner);
        const [projection] = await this.usageIndex.readSessionProjections([indexedSource.descriptor.sourceId]);
        if (projection) {
          this.summaries.set(normalizedPath, sessionSummaryFromProjection(projection, indexedSource.descriptor));
        }
      } catch {
        this.dirtySessionFiles.add(normalizedPath);
      }
    }
    await this.refreshUsageIndexProjections(settings);
    this.codexRateLimits = this.collectCodexRateLimits();
  }

  private providerForSourcePath(filePath: string, settings: AppSettings = this.getSettings()): SourceBackedProviderAdapter | null {
    const normalized = normalizeFileKey(filePath);
    return this.sourceBackedProviders(settings).find(candidate => candidate.ownsPath(normalized)) ?? null;
  }

  private getSummary(filePath: string): FileUsageSummary | null {
    return this.summaries.get(normalizeFileKey(filePath)) ?? null;
  }

  private peekCachedGitStats(cwd: string): GitStats | null {
    const now = Date.now();
    const cached = this.gitStatsCache.get(gitStatsCacheKey(cwd));
    if (cached && now - cached.ts < StateManager.GIT_STATS_TTL_MS) return cached.stats;
    return null;
  }

  private async getCachedGitStatsAsync(cwd: string): Promise<GitStats | null> {
    const now = Date.now();
    const key = gitStatsCacheKey(cwd);
    const cached = this.gitStatsCache.get(key);
    if (cached && now - cached.ts < StateManager.GIT_STATS_TTL_MS) return cached.stats;
    const stats = await getGitStatsAsync(cwd).catch(() => null);
    this.gitStatsCache.set(key, { stats, ts: now });
    return stats;
  }

  private async getRepoGitStats(settings: AppSettings, force = false, sessions: SessionInfo[] = []): Promise<Record<string, GitStats>> {
    const now = Date.now();
    if (!force
      && this.repoGitStatsLastRefresh > 0
      && now - this.repoGitStatsLastRefresh < StateManager.GIT_STATS_TTL_MS
      && !this.hasUnscopedSessionCwd(sessions, this.state.repoGitStats)) {
      return this.state.repoGitStats;
    }

    const isExcluded = makeExcludedMatcher(settings.excludedProjects ?? []);
    const cwdSet = new Set(sessions.map(session => session.cwd));
    const allCwds = [...cwdSet]
      .filter(cwd => isSafeLocalCwd(cwd) && !isExcluded(projectKeysForCwd(cwd)));
    if (allCwds.length === 0) {
      this.repoGitStatsLastRefresh = now;
      return {};
    }
    const rawStats = await Promise.all(allCwds.map(cwd => this.getCachedGitStatsAsync(cwd)));
    const repoGitStats: Record<string, GitStats> = {};

    for (const stats of rawStats) {
      if (!stats?.gitCommonDir) continue;
      const repoKey = repoKeyFromGitStats(stats);
      if (!repoKey) continue;
      const preferred = preferGitStats(repoGitStats[repoKey], stats);
      if (preferred) repoGitStats[repoKey] = preferred;
    }

    this.repoGitStatsLastRefresh = now;
    return repoGitStats;
  }

  private hasUnscopedSessionCwd(sessions: SessionInfo[], repoGitStats: Record<string, GitStats>): boolean {
    if (sessions.length === 0) return false;
    return sessions.some(session => resolveSessionRepoKeys([session], repoGitStats).size === 0);
  }

  private getCurrentLedgerRepoKeys(
    sessions: SessionInfo[] = this.state.sessions,
    repoGitStats: Record<string, GitStats> = this.state.repoGitStats,
  ): string[] {
    return currentLedgerRepoKeys(sessions, repoGitStats);
  }

  private buildCodeOutputStats(sessions: SessionInfo[], repoGitStats: Record<string, GitStats>): CodeOutputStats {
    const today = { commits: 0, added: 0, removed: 0 };
    const repoStats = currentLedgerRepoStats(sessions, repoGitStats);
    let dailySources = repoStats;
    let repoCount = repoStats.length;
    let scopeLabel = repoStats.length > 0
      ? `Current session repos (${repoStats.length})`
      : 'Current session repos';

    if (repoStats.length > 0) {
      for (const stats of repoStats) {
        today.commits += stats.commitsToday;
        today.added += stats.linesAdded;
        today.removed += stats.linesRemoved;
      }
    } else {
      const seenToday = new Set<string>();
      const fallbackStats: GitStats[] = [];
      for (const session of sessions) {
        if (!session.gitStats) continue;
        const repoKey = repoKeyFromGitStats(session.gitStats) ?? normalizeGitCwdKey(session.cwd);
        if (seenToday.has(repoKey)) continue;
        seenToday.add(repoKey);
        today.commits += session.gitStats.commitsToday;
        today.added += session.gitStats.linesAdded;
        today.removed += session.gitStats.linesRemoved;
        fallbackStats.push(session.gitStats);
      }
      dailySources = fallbackStats;
      repoCount = fallbackStats.length;
      if (fallbackStats.length > 0) scopeLabel = `Current session repos (${fallbackStats.length})`;
    }

    const all = { commits: 0, added: 0, removed: 0 };
    for (const stats of repoStats) {
      all.commits += stats.totalCommits;
      all.added += stats.totalLinesAdded;
      all.removed += stats.totalLinesRemoved ?? 0;
    }

    const ledgerRepoKeys = this.getCurrentLedgerRepoKeys(sessions, repoGitStats);
    const ledgerStats = buildCodeOutputFromGitLedger(this.gitOutputLedgerStore.getSnapshot(), ledgerRepoKeys, undefined, scopeLabel);
    if (ledgerRepoKeys.length > 0 && ledgerStats.dailyAll.length > 0) {
      return { ...ledgerStats, repoCount, scopeLabel };
    }

    return {
      today,
      all,
      daily7d: aggregateDailyStats(dailySources),
      dailyAll: aggregateDailyAllStats(dailySources),
      repoCount,
      scopeLabel,
    };
  }

  private attachCachedGitStats(sessions: SessionInfo[]): SessionInfo[] {
    let changed = false;
    const next = sessions.map(session => {
      const gitStats = this.peekCachedGitStats(session.cwd);
      if (gitStats === session.gitStats) return session;
      changed = true;
      return { ...session, gitStats };
    });
    return changed ? next : sessions;
  }

  private buildSessionInfo(
    s: DiscoveredSession,
    gitStats: GitStats | null = this.peekCachedGitStats(s.cwd),
    summaryOverride?: FileUsageSummary | null,
  ): SessionInfo {
    let modelName = '';
    let contextUsed = 0;
    let contextMax = 200_000;
    let toolCounts: Record<string, number> = {};
    let activityBreakdown: SessionInfo['activityBreakdown'] = null;
    let activityBreakdownKind: SessionInfo['activityBreakdownKind'] = null;

    const summary = summaryOverride !== undefined
      ? summaryOverride
      : s.summaryKey
        ? this.summaries.get(s.summaryKey) ?? null
        : (s.jsonlPath ? this.getSummary(s.jsonlPath) : null);
    if (summary) {
      const snapshot = summary.sessionSnapshot;
      modelName = snapshot.modelName;
      contextUsed = snapshot.latestInputTokens + snapshot.latestCacheCreationTokens + snapshot.latestCacheReadTokens;
      toolCounts = snapshot.toolCounts;
      activityBreakdown = snapshot.activityBreakdown;
      activityBreakdownKind = snapshot.activityBreakdownKind;

      const raw = snapshot.rawModel.toLowerCase();
      if (snapshot.contextMax && snapshot.contextMax > 0) contextMax = snapshot.contextMax;
      else if (raw.includes('1m') || raw.includes('1-000k')) contextMax = 1_000_000;
    }

    return { ...s, modelName, contextUsed, contextMax, toolCounts, gitStats, activityBreakdown, activityBreakdownKind };
  }

  private buildSessionInfoForJsonlPath(
    filePath: string,
    previousByKey = new Map(this.state.sessions.map(session => [this.sessionIdentityKey(session), session])),
    summaries: Map<string, FileUsageSummary> = this.summaries,
  ): SessionInfo | null {
    const normalized = normalizeFileKey(filePath);
    const summary = summaries.get(normalized);
    if (!summary) return null;
    const settings = this.getSettings();
    const provider = this.providerForSourcePath(normalized, settings);
    if (!provider || summary.provider !== provider.id) return null;

    const bootstrap = provider.buildStartupSession?.(
      this.providerContext({ settings }),
      this.sourceForPath(provider, normalized, true),
    );
    if (!bootstrap) return null;

    const isExcluded = makeExcludedMatcher(this.getSettings().excludedProjects ?? []);
    if (isExcluded(this.sessionProjectKeys(bootstrap))) return null;

    const key = this.sessionIdentityKey(bootstrap);
    const previous = previousByKey.get(key);
    const next = this.buildSessionInfo(bootstrap, previous?.gitStats, summary);
    if (previous && this.isSameSessionInfo(previous, next)) return previous;
    return next;
  }

  private updateChangedSessionInfos(changedFiles: Set<string>): SessionBuildResult {
    const normalized = new Set([...changedFiles].map(file => normalizeFileKey(file)));
    const previousByKey = new Map(this.state.sessions.map(session => [this.sessionIdentityKey(session), session]));
    const previousSet = new Set(this.state.sessions);
    const matchedPaths = new Set<string>();
    const sessionsByKey = new Map<string, SessionInfo>();
    let discoveredCount = 0;

    for (const session of this.state.sessions) {
      if (!session.jsonlPath) {
        sessionsByKey.set(this.sessionIdentityKey(session), session);
        continue;
      }

      const fileKey = normalizeFileKey(session.jsonlPath);
      if (!normalized.has(fileKey)) {
        sessionsByKey.set(this.sessionIdentityKey(session), session);
        continue;
      }

      matchedPaths.add(fileKey);
      discoveredCount += 1;
      const lastModified = getJsonlMtime(session.jsonlPath) ?? session.lastModified;
      const next = this.buildSessionInfo({ ...session, lastModified }, session.gitStats);
      sessionsByKey.set(this.sessionIdentityKey(next), next);
    }

    for (const filePath of normalized) {
      if (matchedPaths.has(filePath)) continue;
      const next = this.buildSessionInfoForJsonlPath(filePath, previousByKey, this.summaries);
      if (!next) continue;
      discoveredCount += 1;
      sessionsByKey.set(this.sessionIdentityKey(next), next);
    }

    const sessions = this.retainScopedSessionInfos(
      [...sessionsByKey.values()].sort((a, b) => this.sessionSortValue(b) - this.sessionSortValue(a)),
      normalized,
    );
    return {
      sessions,
      discoveryScope: StateManager.SESSION_SCOPE,
      discoveredCount,
      dedupedCount: Math.max(0, discoveredCount - Math.max(0, sessions.length - this.state.sessions.length)),
      reusedCount: sessions.filter(session => previousSet.has(session)).length,
      sessionCountDelta: sessions.length - this.state.sessions.length,
    };
  }

  private refreshCachedSessionInfos(): SessionBuildResult {
    let changed = false;
    const next: SessionInfo[] = [];
    let reusedCount = 0;

    for (const session of this.state.sessions) {
      if (!session.jsonlPath) {
        next.push(session);
        reusedCount += 1;
        continue;
      }
      if (!fs.existsSync(session.jsonlPath)) {
        changed = true;
        continue;
      }

      const lastModified = getJsonlMtime(session.jsonlPath) ?? session.lastModified;
      const state = currentSessionState(session.provider, session.pid, lastModified);
      if (lastModified?.getTime() !== session.lastModified?.getTime() || state !== session.state) {
        changed = true;
        next.push({ ...session, lastModified, state });
      } else {
        next.push(session);
        reusedCount += 1;
      }
    }

    const sessions = changed
      ? this.retainScopedSessionInfos(next)
      : this.retainScopedSessionInfos(this.state.sessions);
    return {
      sessions,
      discoveryScope: StateManager.SESSION_SCOPE,
      discoveredCount: sessions.length,
      dedupedCount: 0,
      reusedCount,
      sessionCountDelta: sessions.length - this.state.sessions.length,
    };
  }

  private async buildSessionInfos(): Promise<SessionInfo[]> {
    return (await this.buildScopedSessionInfosDetailed()).sessions;
  }

  getState(): AppState {
    return this.state;
  }

  applySettingsChange() {
    const settings = this.getSettings();
    const providerChanged = this.providerSelectionChanged(settings, this.state.settings);
    const quotaSettingsChanged = this.quotaAffectingSettingsChanged(settings, this.state.settings);
    const projectExclusionsChanged = this.projectExclusionsChanged(settings, this.state.settings);
    if (providerChanged) {
      const previousEnabled = this.enabledProviderSet(this.state.settings);
      const enabled = this.enabledProviderSet(settings);
      const codexSelectionChanged = enabled.has('codex') !== previousEnabled.has('codex');
      if (codexSelectionChanged) {
        this.lastCodexUsageCallMs = 0;
        this.lastCodexResetCallMs = 0;
        this.codexUsageBackoffMs = 0;
        this.codexResetBackoffMs = 0;
      }
      if (!enabled.has('codex')) {
        this.clearCodexUsageCache({ deletePersisted: false });
        this.clearCodexResetCache({ deletePersisted: false });
        this.codexUsageAttemptAuthMtimeMs = null;
        this.codexUsageAttemptAuthIdentityHash = null;
        this.codexAuthMissingObserved = false;
        this.codexResetStatus = null;
        this.codexResetAttemptAuthMtimeMs = null;
        this.codexResetAttemptAuthIdentityHash = null;
        this.codexUsageConnected = false;
        this.codexStatusLabel = '';
        this.codexError = '';
        this.providerQuotaSnapshots.delete('codex');
      } else {
        this.hydrateCodexCachesFromStore(settings);
      }
      this.summaries.clear();
      clearSessionMetadataCache();
      this.codexRateLimits = null;
      this.repoGitStatsLastRefresh = 0;
      const isExcluded = makeExcludedMatcher(settings.excludedProjects ?? []);
      const sessions = this.state.sessions.filter(session =>
        enabled.has(session.provider)
        && !isExcluded(this.sessionProjectKeys(session)),
      );
      const derived = this.computeDerivedUsage(settings);
      const usageTrend = this.buildUsageTrend();
      const codeOutputStats = this.buildCodeOutputStats(sessions, this.state.repoGitStats);
      const allTimeSessions = this.countAllTimeUsageSessions(settings);
      this.state = {
        ...this.state,
        sessions,
        settings,
        usage: derived.usage,
        usageTrend,
        providerQuotas: derived.providerQuotas,
        codexAccount: this.codexAccountForSettings(settings),
        bridgeActive: derived.bridgeActive,
        codeOutputStats,
        codeOutputLoading: true,
        allTimeSessions,
        stateFreshness: this.currentStateFreshness(),
        lastUpdated: Date.now(),
      };
      this.publishState();
      this.startWatcher();
      this.clearHistoryWarmup();
      this.clearGitWarmup();
      void this.requestRefresh({
        mode: 'heavy',
        reason: 'settings',
        includeFullHistory: true,
        scanBudgetMs: StateManager.FOREGROUND_SCAN_BUDGET_MS,
      });
      return;
    }

    const isExcluded = makeExcludedMatcher(settings.excludedProjects ?? []);
    const sessions = this.state.sessions.filter(session => !isExcluded(this.sessionProjectKeys(session)));
    const codeOutputStats = this.buildCodeOutputStats(sessions, this.state.repoGitStats);
    const allTimeSessions = this.countAllTimeUsageSessions(settings);
    this.state = {
      ...this.state,
      sessions,
      settings,
      usageTrend: this.buildUsageTrend(),
      codeOutputStats,
      codeOutputLoading: false,
      allTimeSessions,
      stateFreshness: this.currentStateFreshness(),
      lastUpdated: Date.now(),
    };
    this.publishState();
    if (projectExclusionsChanged) {
      void this.requestRefresh({
        mode: 'heavy',
        reason: 'settings',
      });
    }
    if (quotaSettingsChanged && this.enabledProviderSet(settings).has('antigravity')) {
      void this.requestRefresh({
        mode: 'heavy',
        reason: 'settings',
        force: true,
        scanBudgetMs: StateManager.FOREGROUND_SCAN_BUDGET_MS,
      });
    }
  }

  private async logMemorySnapshot(label: string, scannedFiles = 0): Promise<void> {
    const proc = process as NodeJS.Process & {
      defaultApp?: boolean;
      getProcessMemoryInfo?: () => Promise<{
        workingSetSize: number;
        private: number;
        shared: number;
      }>;
    };
    if (!this.isMemoryDebugEnabled()) return;
    if (!proc.getProcessMemoryInfo) return;

    try {
      const info = await proc.getProcessMemoryInfo() as unknown as {
        workingSetSize?: number;
        workingSet?: number;
        private: number;
        shared: number;
      };
      const workingSet = info.workingSetSize ?? info.workingSet ?? 0;
      const toMb = (kb: number) => Math.round((kb / 1024) * 10) / 10;
      const watched = this.countWatchedPaths();
      console.info('[WhereMyTokens][memory]', {
        label,
        workingSetMB: toMb(workingSet),
        privateMB: toMb(info.private),
        sharedMB: toMb(info.shared),
        summaryCount: this.summaries.size,
        sessionCount: this.state.sessions.length,
        allTimeSessions: this.state.allTimeSessions,
        watcherProfile: this.watcherProfile,
        watcherTargets: this.watcherTargetCount,
        dirtyFiles: this.dirtySessionFiles.size,
        deferredFastFiles: this.refreshScheduler.getPendingChangedFileCount(),
        scannedFiles,
      });
      appendDebugMemoryLog('memory-snapshot', {
        label,
        electronProcessMemory: {
          workingSetMB: toMb(workingSet),
          privateMB: toMb(info.private),
          sharedMB: toMb(info.shared),
        },
        runtime: collectRuntimeMemorySnapshot(),
        collections: {
          summaries: this.summaries.size,
          sessions: this.state.sessions.length,
          repoGitStats: Object.keys(this.state.repoGitStats).length,
          gitStatsCache: this.gitStatsCache.size,
          dirtySessionFiles: this.dirtySessionFiles.size,
          deferredFastFiles: this.refreshScheduler.getPendingChangedFileCount(),
        },
        watcher: {
          profile: this.watcherProfile,
          targets: this.watcherTargetCount,
          watchedDirectories: watched.watchedDirectories,
          watchedFiles: watched.watchedFiles,
        },
        scannedFiles,
      });
    } catch {
      // 메모리 로그 실패는 무시한다.
    }
  }
}
