export const STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION = 1;
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

export function makeStartupStateSnapshot<TState extends StartupSnapshotState>(
  state: TState,
  savedAt = Date.now(),
): StartupStateSnapshot<TState> {
  return {
    schemaVersion: STARTUP_STATE_SNAPSHOT_SCHEMA_VERSION,
    savedAt,
    state: {
      ...state,
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

  return {
    ...fallbackState,
    ...(state as Partial<TState>),
    initialRefreshComplete: true,
    historyWarmupPending: false,
    historyWarmupStartsAt: null,
    codeOutputLoading: false,
    stateFreshness: 'restored',
  } as TState;
}
