export const STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION = 5;
export const STARTUP_STATE_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type StateFreshness = 'empty' | 'restored' | 'fresh';

export interface StartupSnapshotState {
  initialRefreshComplete: boolean;
  historyWarmupPending: boolean;
  historyWarmupStartsAt: number | null;
  codeOutputLoading: boolean;
  lastUpdated: number;
  stateFreshness?: StateFreshness;
}

export interface StartupStateSnapshot<TState extends StartupSnapshotState = StartupSnapshotState> {
  schemaVersion: typeof STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION;
  savedAt: number;
  state: TState;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isStateFreshness(value: unknown): value is StateFreshness {
  return value === 'empty' || value === 'restored' || value === 'fresh';
}

function sanitizedSession(session: Record<string, unknown>): Record<string, unknown> {
  return {
    ...session,
    pid: null,
    cwd: '',
    projectName: 'Previous session',
    jsonlPath: null,
    gitStats: null,
    isWorktree: false,
    worktreeBranch: null,
    gitBranch: null,
    mainRepoName: null,
  };
}

function sanitizeStateForSnapshot<TState extends StartupSnapshotState>(state: TState): TState {
  const raw = state as TState & {
    sessions?: unknown;
    repoGitStats?: unknown;
    settings?: unknown;
    providerQuotas?: unknown;
  };
  const { settings: _settings, providerQuotas: rawProviderQuotas, ...rest } = raw;
  const providerQuotas = asRecord(rawProviderQuotas);
  const sanitizedProviderQuotas = providerQuotas
    ? Object.fromEntries(Object.entries(providerQuotas).filter(([provider]) => provider !== 'codex'))
    : undefined;
  return {
    ...rest,
    ...(providerQuotas ? { providerQuotas: sanitizedProviderQuotas } : {}),
    sessions: Array.isArray(raw.sessions)
      ? raw.sessions
          .filter((session): session is Record<string, unknown> => !!session && typeof session === 'object' && !Array.isArray(session))
          .map(sanitizedSession)
      : [],
    repoGitStats: {},
  } as TState;
}

export function makeStartupStateSnapshot<TState extends StartupSnapshotState>(
  state: TState,
  savedAt = Date.now(),
): StartupStateSnapshot<TState> {
  const sanitizedState = sanitizeStateForSnapshot(state);
  return {
    schemaVersion: STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION,
    savedAt,
    state: {
      ...sanitizedState,
      initialRefreshComplete: true,
      historyWarmupPending: false,
      historyWarmupStartsAt: null,
      codeOutputLoading: false,
      stateFreshness: 'fresh',
    } as TState,
  };
}

export function normalizeStartupStateSnapshot<TState extends StartupSnapshotState>(
  value: unknown,
  fallbackState: TState,
  now = Date.now(),
  maxAgeMs = STARTUP_STATE_SNAPSHOT_MAX_AGE_MS,
): TState | null {
  const snapshot = asRecord(value);
  if (!snapshot) return null;
  if (snapshot.schemaVersion !== STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION) return null;
  if (typeof snapshot.savedAt !== 'number' || !Number.isFinite(snapshot.savedAt)) return null;
  if (snapshot.savedAt > now + 60_000) return null;
  if (now - snapshot.savedAt > maxAgeMs) return null;

  const state = asRecord(snapshot.state);
  if (!state) return null;
  if (state.sessions != null && !Array.isArray(state.sessions)) return null;
  const sanitizedState = sanitizeStateForSnapshot({
    ...fallbackState,
    ...(state as Partial<TState>),
  } as TState);

  return {
    ...fallbackState,
    ...sanitizedState,
    initialRefreshComplete: true,
    historyWarmupPending: false,
    historyWarmupStartsAt: null,
    codeOutputLoading: false,
    stateFreshness: 'restored',
  } as TState;
}
