import type Store from 'electron-store';
import type { AppSettings } from '../ipc';
import type { JsonlCache } from '../jsonlCache';
import type { ActivityBreakdown, ActivityBreakdownKind, FileUsageSummary } from '../jsonlTypes';
import type { UsageLedgerSnapshot } from '../usageLedgerTypes';

export type ProviderId = 'claude' | 'codex' | 'antigravity';

export type SessionState = 'active' | 'waiting' | 'idle' | 'compacting';
export type SessionProvider = ProviderId;
export type SessionDiscoveryScope = 'recent-active' | 'all';

export interface DiscoverSessionsOptions {
  scope?: SessionDiscoveryScope;
  trackedJsonlPaths?: string[];
  maxClaudeSessions?: number;
  maxCodexFiles?: number;
}

export interface DiscoveredSession {
  provider: SessionProvider;
  pid: number | null;
  sessionId: string;
  cwd: string;
  projectName: string;
  startedAt: Date;
  entrypoint: string;
  source: string;
  state: SessionState;
  jsonlPath: string | null;
  lastModified: Date | null;
  isWorktree: boolean;
  worktreeBranch: string | null;
  gitBranch: string | null;
  mainRepoName: string | null;
}

export type ProviderCapability =
  | 'sessions'
  | 'usage'
  | 'quota'
  | 'artifacts';

export interface ProviderContext {
  settings: AppSettings;
  store: Store<AppSettings>;
  nowMs: number;
  jsonlCache: JsonlCache;
  scanBudgetMs: number | null;
  prioritySourceIds: Set<string>;
  includeFullHistory: boolean;
  force: boolean;
}

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  capabilities: ReadonlySet<ProviderCapability>;

  isAvailable(ctx: ProviderContext): Promise<boolean>;

  discoverSessions?: (ctx: ProviderContext) => DiscoveredSession[] | Promise<DiscoveredSession[]>;

  scanUsage?: (ctx: ProviderContext) => Promise<ProviderUsageScanResult>;

  fetchQuota?: (ctx: ProviderContext) => Promise<ProviderQuotaSnapshot | null>;

  collectArtifacts?: (ctx: ProviderContext) => Promise<ProviderArtifact[]>;
}

export interface SourceBackedProviderAdapter extends ProviderAdapter {
  discoverSessions?: (ctx: ProviderContext) => DiscoveredSession[];

  ownsPath(filePath: string): boolean;

  listRecentSources(ctx: ProviderContext, limit: number): ProviderSourceList;

  listAllSources(ctx: ProviderContext): ProviderSourceList;

  buildStartupSession?(ctx: ProviderContext, source: ProviderSource): DiscoveredSession | null;

  scanSourceSummary(
    ctx: ProviderContext,
    source: ProviderSource,
  ): Promise<FileUsageSummary | null>;

  ledgerSource?(ctx: ProviderContext, source: ProviderSource, priority?: boolean): ProviderLedgerSource | null;

  readSourceCwd?(source: ProviderSource): string | null;

  watchTargets?(ctx: ProviderContext, mode: 'recent' | 'wide'): string[];

  isExcludedSource?(
    source: ProviderSource,
    excludedMatcher: ExcludedProjectMatcher,
  ): boolean;
}

export interface ProviderSource {
  provider: ProviderId;
  sourceId: string;
  filePath: string;
  priority?: boolean;
}

/**
 * Matches a session against the user's excluded-project list. Carries
 * `hasExclusions` so callers can skip expensive cwd reads when nothing is
 * excluded.
 */
export interface ExcludedProjectMatcher {
  (keys: Array<string | null | undefined>): boolean;
  readonly hasExclusions: boolean;
}

export interface ProviderSourceList {
  sources: ProviderSource[];
  truncated: boolean;
}

export interface ProviderUsageScanResult {
  summaries: Map<string, FileUsageSummary>;
  ledgerSources: ProviderLedgerSource[];
  scannedSources: number;
  partial: boolean;
  rateLimits?: unknown;
}

export interface ProviderLedgerSource {
  provider: ProviderId;
  sourceId: string;
  sourcePath?: string;
  priority: boolean;
  importIntoSnapshot: (snapshot: UsageLedgerSnapshot, nowMs: number) => Promise<UsageLedgerSnapshot>;
}

export interface ProviderQuotaSnapshot {
  provider: ProviderId;
  source: 'api' | 'statusLine' | 'localLog' | 'localRpc' | 'cache';
  capturedAt: number;
  accountLabel?: string;
  planName?: string;
  windows?: Record<string, ProviderQuotaWindow>;
  models?: ProviderModelQuota[];
  credits?: Record<string, ProviderCreditBalance>;
}

export interface ProviderQuotaWindow {
  pct: number;
  resetMs: number | null;
  resetLabel?: string;
  source?: ProviderQuotaSnapshot['source'];
}

export interface ProviderModelQuota {
  model: string;
  label: string;
  remainingPct: number;
  resetMs?: number | null;
}

export interface ProviderCreditBalance {
  available: number;
  used?: number;
  total?: number;
  remainingPct?: number;
  resetMs?: number | null;
}

export interface ProviderArtifact {
  provider: ProviderId;
  sessionId?: string;
  projectPath?: string;
  name: string;
  path: string;
  relativePath?: string;
  size: number;
  lines?: number;
  modifiedAt: number;
}

export interface ProviderUsageEntry {
  provider: ProviderId;
  sessionId?: string;
  requestId: string;
  timestampMs: number;
  model: string;
  rawModel?: string;

  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;

  credits?: number;
  costUSD?: number;
  cacheSavingsUSD?: number;

  toolCalls?: Record<string, number>;
  activityBreakdown?: ActivityBreakdown;
  activityBreakdownKind?: ActivityBreakdownKind;
}
