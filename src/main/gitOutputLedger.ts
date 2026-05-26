import Store from 'electron-store';
import * as crypto from 'crypto';

export interface GitDailyOutputRow {
  date: string;
  repoKey: string;
  commits: number;
  added: number;
  removed: number;
  netLines: number;
}

export interface GitOutputLedgerSnapshot {
  schemaVersion: number;
  dailyOutput: Record<string, GitDailyOutputRow>;
}

export interface GitDailyInput {
  date: string;
  commits: number;
  added: number;
  removed: number;
}

export interface CodeOutputStatsLike {
  today: { commits: number; added: number; removed: number };
  all: { commits: number; added: number; removed: number };
  daily7d: GitDailyInput[];
  dailyAll: GitDailyInput[];
  repoCount: number;
  scopeLabel: string;
}

interface StoreLike {
  get(key: 'ledger'): GitOutputLedgerSnapshot | undefined;
  set(key: 'ledger', value: GitOutputLedgerSnapshot): void;
}

const SCHEMA_VERSION = 1;

export function emptyGitOutputLedgerSnapshot(): GitOutputLedgerSnapshot {
  return { schemaVersion: SCHEMA_VERSION, dailyOutput: {} };
}

function normalizeSnapshot(value: unknown): GitOutputLedgerSnapshot {
  if (!value || typeof value !== 'object') return emptyGitOutputLedgerSnapshot();
  const raw = value as Partial<GitOutputLedgerSnapshot>;
  if (raw.schemaVersion !== SCHEMA_VERSION || !raw.dailyOutput || typeof raw.dailyOutput !== 'object') {
    return emptyGitOutputLedgerSnapshot();
  }
  const dailyOutput: Record<string, GitDailyOutputRow> = {};
  for (const row of Object.values(raw.dailyOutput)) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Partial<GitDailyOutputRow>;
    if (typeof item.date !== 'string' || typeof item.repoKey !== 'string') continue;
    const commits = Number.isFinite(item.commits) ? item.commits as number : 0;
    const added = Number.isFinite(item.added) ? item.added as number : 0;
    const removed = Number.isFinite(item.removed) ? item.removed as number : 0;
    const repoKey = item.repoKey.startsWith('repo:') ? item.repoKey : repoLedgerKey(item.repoKey);
    dailyOutput[`${item.date}|${repoKey}`] = {
      date: item.date,
      repoKey,
      commits,
      added,
      removed,
      netLines: added - removed,
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    dailyOutput,
  };
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function repoLedgerKey(repoKey: string): string {
  return `repo:${crypto.createHash('sha256').update(repoKey).digest('base64url')}`;
}

function buildDaily7dWindow(today: string): GitDailyInput[] {
  const date = new Date(`${today}T00:00:00`);
  const days: GitDailyInput[] = [];
  for (let offset = 6; offset >= 0; offset--) {
    const item = new Date(date);
    item.setDate(date.getDate() - offset);
    days.push({ date: dateKey(item), commits: 0, added: 0, removed: 0 });
  }
  return days;
}

export function mergeGitDailyOutput(snapshot: GitOutputLedgerSnapshot, repoKey: string, days: GitDailyInput[]): void {
  if (!repoKey) return;
  const ledgerRepoKey = repoLedgerKey(repoKey);
  const incomingDates = new Set(days.map(day => day.date).filter(Boolean));
  if (incomingDates.size > 0) {
    for (const [key, row] of Object.entries(snapshot.dailyOutput)) {
      if (row.repoKey === ledgerRepoKey && !incomingDates.has(row.date)) delete snapshot.dailyOutput[key];
    }
  }
  for (const day of days) {
    if (!day.date) continue;
    snapshot.dailyOutput[`${day.date}|${ledgerRepoKey}`] = {
      date: day.date,
      repoKey: ledgerRepoKey,
      commits: Number.isFinite(day.commits) ? day.commits : 0,
      added: Number.isFinite(day.added) ? day.added : 0,
      removed: Number.isFinite(day.removed) ? day.removed : 0,
      netLines: (Number.isFinite(day.added) ? day.added : 0) - (Number.isFinite(day.removed) ? day.removed : 0),
    };
  }
}

export function buildCodeOutputFromGitLedger(
  snapshot: GitOutputLedgerSnapshot,
  repoKeys: string[],
  today = dateKey(new Date()),
  scopeLabel = repoKeys.length > 0 ? `Current session repos (${repoKeys.length})` : 'Current session repos',
): CodeOutputStatsLike {
  const allowed = new Set(repoKeys.filter(Boolean).map(repoLedgerKey));
  const rows = Object.values(snapshot.dailyOutput)
    .filter(row => allowed.size === 0 || allowed.has(row.repoKey))
    .sort((a, b) => a.date.localeCompare(b.date) || a.repoKey.localeCompare(b.repoKey));
  const todayStats = { commits: 0, added: 0, removed: 0 };
  const all = { commits: 0, added: 0, removed: 0 };
  const dailyAllMap = new Map<string, GitDailyInput>();
  const daily7dMap = new Map(buildDaily7dWindow(today).map(day => [day.date, { ...day }]));

  for (const row of rows) {
    if (row.date === today) {
      todayStats.commits += row.commits;
      todayStats.added += row.added;
      todayStats.removed += row.removed;
    }
    all.commits += row.commits;
    all.added += row.added;
    all.removed += row.removed;
    const allDay = dailyAllMap.get(row.date) ?? { date: row.date, commits: 0, added: 0, removed: 0 };
    allDay.commits += row.commits;
    allDay.added += row.added;
    allDay.removed += row.removed;
    dailyAllMap.set(row.date, allDay);
    const recentDay = daily7dMap.get(row.date);
    if (recentDay) {
      recentDay.commits += row.commits;
      recentDay.added += row.added;
      recentDay.removed += row.removed;
    }
  }

  return {
    today: todayStats,
    all,
    daily7d: [...daily7dMap.values()],
    dailyAll: [...dailyAllMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    repoCount: allowed.size,
    scopeLabel,
  };
}

export class GitOutputLedgerStore {
  private readonly store: StoreLike;

  constructor(store?: StoreLike) {
    this.store = store ?? new Store<{ ledger: GitOutputLedgerSnapshot }>({
      name: 'git-output-ledger',
      defaults: { ledger: emptyGitOutputLedgerSnapshot() },
    }) as unknown as StoreLike;
  }

  getSnapshot(): GitOutputLedgerSnapshot {
    return normalizeSnapshot(this.store.get('ledger'));
  }

  replaceSnapshot(snapshot: GitOutputLedgerSnapshot): void {
    this.store.set('ledger', normalizeSnapshot(snapshot));
  }

  mergeRepoDays(repoKey: string, days: GitDailyInput[]): GitOutputLedgerSnapshot {
    const snapshot = this.getSnapshot();
    mergeGitDailyOutput(snapshot, repoKey, days);
    this.replaceSnapshot(snapshot);
    return snapshot;
  }
}

let defaultStore: GitOutputLedgerStore | null = null;

export function getGitOutputLedgerStore(): GitOutputLedgerStore {
  if (!defaultStore) defaultStore = new GitOutputLedgerStore();
  return defaultStore;
}
