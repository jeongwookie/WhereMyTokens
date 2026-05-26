import Store from 'electron-store';
import { compactUsageLedgerSnapshot, emptyUsageLedgerSnapshot } from './usageLedgerAggregates';
import { USAGE_LEDGER_SCHEMA_VERSION, UsageLedgerSnapshot, UsageLedgerStoreShape } from './usageLedgerTypes';

interface StoreLike {
  get(key: 'ledger'): UsageLedgerSnapshot | undefined;
  set(key: 'ledger', value: UsageLedgerSnapshot): void;
}

function objectRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, T>
    : {};
}

function normalizeSnapshot(value: unknown): UsageLedgerSnapshot {
  if (!value || typeof value !== 'object') return emptyUsageLedgerSnapshot();
  const raw = value as Partial<UsageLedgerSnapshot>;
  if (raw.schemaVersion !== USAGE_LEDGER_SCHEMA_VERSION) return emptyUsageLedgerSnapshot();
  return {
    schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
    minuteRecent: objectRecord(raw.minuteRecent),
    recentRequestIndex: objectRecord(raw.recentRequestIndex),
    hourlyActivity: objectRecord(raw.hourlyActivity),
    dailyModel: objectRecord(raw.dailyModel),
    monthlyModel: objectRecord(raw.monthlyModel),
    sourceCheckpoints: objectRecord(raw.sourceCheckpoints),
    sourceRepairRollup: objectRecord(raw.sourceRepairRollup),
    lastCompactedAt: typeof raw.lastCompactedAt === 'number' ? raw.lastCompactedAt : 0,
  };
}

export class UsageLedgerStore {
  private readonly store: StoreLike;

  constructor(store?: StoreLike) {
    this.store = store ?? new Store<UsageLedgerStoreShape>({
      name: 'usage-ledger',
      defaults: { ledger: emptyUsageLedgerSnapshot() },
    }) as unknown as StoreLike;
  }

  getSnapshot(): UsageLedgerSnapshot {
    return normalizeSnapshot(this.store.get('ledger'));
  }

  replaceSnapshot(snapshot: UsageLedgerSnapshot): void {
    this.store.set('ledger', normalizeSnapshot(snapshot));
  }

  compact(nowMs = Date.now()): UsageLedgerSnapshot {
    const next = compactUsageLedgerSnapshot(this.getSnapshot(), nowMs);
    this.replaceSnapshot(next);
    return next;
  }

  reset(): void {
    this.replaceSnapshot(emptyUsageLedgerSnapshot());
  }
}
