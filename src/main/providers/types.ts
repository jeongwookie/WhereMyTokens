import type { AppSettings } from '../ipc';
import type { ActivityBreakdown, ActivityBreakdownKind } from '../jsonlTypes';
import type { UsageSourceDescriptor, UsageSourceScanner } from '../usageIndex';
import type { ProviderId, ProviderQuotaSnapshot } from '../../shared/quotaTypes';

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
  summaryKey?: string | null;
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
  nowMs: number;
  scanBudgetMs: number | null;
  prioritySourceIds: Set<string>;
  includeFullHistory: boolean;
  force: boolean;
  /** true이면 Codex usage GET을 건너뛰고 reset credits만 갱신한다. */
  skipCodexUsage?: boolean;
  /** true이면 reset credits 전용 GET만 건너뛴다. usage GET은 계속 실행된다. */
  skipCodexResetCredits?: boolean;
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

  usageIndexSource(
    ctx: ProviderContext,
    source: ProviderSource,
  ): { descriptor: UsageSourceDescriptor; scanner: UsageSourceScanner };

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
  usageIndexSources: Array<{
    descriptor: UsageSourceDescriptor;
    scanner: UsageSourceScanner;
  }>;
  partial: boolean;
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
