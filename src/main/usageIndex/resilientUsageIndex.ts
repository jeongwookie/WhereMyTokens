import * as fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderId } from '../providers/types';
import { emptyBreakdownDelta } from '../../shared/breakdownTypes';
import { DefaultUsageIndex } from './usageIndex';
import { SqliteUsageIndexStorage } from './sqliteUsageIndexStorage';
import { emptyUsageMetrics } from './types';
import type {
  UsageBreakdownQuery,
  UsageBreakdownResult,
  UsageEntry,
  UsageEntryQuery,
  UsageIndex,
  UsageIndexCoverage,
  UsageIndexHealth,
  UsageQuery,
  UsageQueryResult,
  UsageSessionProjection,
  UsageSourceDescriptor,
  UsageSourceRefreshResult,
  UsageSourceScanner,
} from './types';

type UnavailableSourceStatus = 'queued' | 'failed';

interface UnavailableProviderCoverage {
  discoveryComplete: boolean;
  sources: Map<string, UnavailableSourceStatus>;
}

interface RecoverySuccess {
  index: DefaultUsageIndex;
  preservedPath: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function moveDatabaseFamily(sourcePath: string, targetPath: string): void {
  fs.renameSync(sourcePath, targetPath);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${sourcePath}${suffix}`)) fs.renameSync(`${sourcePath}${suffix}`, `${targetPath}${suffix}`);
  }
}

function removeRecoveryFamily(databasePath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${databasePath}${suffix}`, { force: true }); } catch { /* best-effort temporary cleanup */ }
  }
}

function assertIntegrity(databasePath: string): void {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare('PRAGMA integrity_check').all() as unknown as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
      throw new Error(`Recovered UsageIndex failed integrity check: ${rows.map(row => row.integrity_check).join('; ')}`);
    }
  } finally {
    database.close();
  }
}

async function tryRecoverDatabase(databasePath: string): Promise<RecoverySuccess | null> {
  if (!fs.existsSync(databasePath)) return null;
  const recoveryPath = `${databasePath}.recovery-${process.pid}-${Date.now()}`;
  const preservedPath = `${databasePath}.damaged-${timestampSuffix()}`;
  let source: DatabaseSync | null = null;
  try {
    source = new DatabaseSync(databasePath);
    const escapedRecoveryPath = recoveryPath.replace(/'/g, "''");
    source.exec(`VACUUM INTO '${escapedRecoveryPath}'`);
    source.close();
    source = null;

    const validationStorage = new SqliteUsageIndexStorage(recoveryPath);
    await validationStorage.close();
    assertIntegrity(recoveryPath);

    moveDatabaseFamily(databasePath, preservedPath);
    try {
      moveDatabaseFamily(recoveryPath, databasePath);
    } catch (error) {
      if (!fs.existsSync(databasePath) && fs.existsSync(preservedPath)) {
        moveDatabaseFamily(preservedPath, databasePath);
      }
      throw error;
    }
    return {
      index: new DefaultUsageIndex(new SqliteUsageIndexStorage(databasePath)),
      preservedPath,
    };
  } catch {
    try { source?.close(); } catch { /* preserve recovery failure */ }
    removeRecoveryFamily(recoveryPath);
    return null;
  }
}

export class ResilientUsageIndex implements UsageIndex {
  private readonly unavailableCoverage = new Map<ProviderId, UnavailableProviderCoverage>();

  constructor(
    private readonly databasePath: string,
    private delegate: DefaultUsageIndex | null,
    private health: UsageIndexHealth,
  ) {}

  getHealth(): UsageIndexHealth {
    return { ...this.health };
  }

  declareSources(
    provider: ProviderId,
    sources: readonly UsageSourceDescriptor[],
    discoveryComplete: boolean,
  ): void {
    if (this.delegate) {
      this.delegate.declareSources(provider, sources, discoveryComplete);
      return;
    }
    this.unavailableCoverage.set(provider, {
      discoveryComplete,
      sources: new Map(sources.map(source => [source.sourceId, 'queued'])),
    });
  }

  async refreshSource(
    source: UsageSourceDescriptor,
    scanner: UsageSourceScanner,
  ): Promise<UsageSourceRefreshResult> {
    if (this.delegate) return this.delegate.refreshSource(source, scanner);
    const coverage = this.unavailableCoverage.get(source.provider) ?? {
      discoveryComplete: false,
      sources: new Map<string, UnavailableSourceStatus>(),
    };
    coverage.sources.set(source.sourceId, 'failed');
    this.unavailableCoverage.set(source.provider, coverage);
    throw new Error(this.health.message ?? 'Usage history database is unavailable');
  }

  async queryUsage(request: UsageQuery): Promise<UsageQueryResult> {
    if (this.delegate) return this.delegate.queryUsage(request);
    return {
      grain: request.grain,
      aggregate: emptyUsageMetrics(),
      byProvider: {},
      models: [],
      buckets: [],
      coverage: this.coverageFor(request.providers),
    };
  }

  async queryBreakdown(request: UsageBreakdownQuery): Promise<UsageBreakdownResult> {
    if (this.delegate) return this.delegate.queryBreakdown(request);
    return {
      grain: request.grain,
      aggregate: emptyBreakdownDelta(),
      buckets: [],
      coverage: this.coverageFor(request.providers),
    };
  }

  async readProjectionEntries(request: UsageEntryQuery): Promise<UsageEntry[]> {
    return this.delegate ? this.delegate.readProjectionEntries(request) : [];
  }

  async readSessionProjections(sourceIds?: readonly string[]): Promise<UsageSessionProjection[]> {
    return this.delegate ? this.delegate.readSessionProjections(sourceIds) : [];
  }

  async reset(): Promise<void> {
    if (this.delegate) {
      await this.delegate.reset();
      this.health = { state: 'ready' };
      return;
    }

    const preservedPath = `${this.databasePath}.damaged-${timestampSuffix()}`;
    let moved = false;
    if (fs.existsSync(this.databasePath)) {
      moveDatabaseFamily(this.databasePath, preservedPath);
      moved = true;
    }
    try {
      this.delegate = new DefaultUsageIndex(new SqliteUsageIndexStorage(this.databasePath));
      this.health = {
        state: 'ready',
        ...(moved ? { preservedPath } : {}),
      };
      this.unavailableCoverage.clear();
    } catch (error) {
      if (moved && !fs.existsSync(this.databasePath) && fs.existsSync(preservedPath)) {
        moveDatabaseFamily(preservedPath, this.databasePath);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.delegate?.close();
  }

  private coverageFor(providers: ReadonlySet<ProviderId> | undefined): UsageIndexCoverage {
    const selected = providers ? [...providers] : [...this.unavailableCoverage.keys()];
    let requiredSourceCount = 0;
    let failedSourceCount = 0;
    let pendingSourceCount = 0;
    for (const provider of selected) {
      for (const status of this.unavailableCoverage.get(provider)?.sources.values() ?? []) {
        requiredSourceCount += 1;
        if (status === 'failed') failedSourceCount += 1;
        else pendingSourceCount += 1;
      }
    }
    return {
      state: 'incomplete',
      requiredSourceCount,
      indexedSourceCount: 0,
      pendingSourceCount,
      failedSourceCount,
    };
  }
}

export async function openUsageIndex(databasePath: string): Promise<ResilientUsageIndex> {
  try {
    return new ResilientUsageIndex(
      databasePath,
      new DefaultUsageIndex(new SqliteUsageIndexStorage(databasePath)),
      { state: 'ready' },
    );
  } catch (openError) {
    const recovered = await tryRecoverDatabase(databasePath);
    if (recovered) {
      return new ResilientUsageIndex(databasePath, recovered.index, {
        state: 'recovered',
        message: 'Usage history was recovered; the damaged database was preserved.',
        preservedPath: recovered.preservedPath,
      });
    }
    return new ResilientUsageIndex(databasePath, null, {
      state: 'unavailable',
      message: `Usage history database could not be opened or recovered: ${errorMessage(openError)}`,
      preservedPath: fs.existsSync(databasePath) ? databasePath : undefined,
    });
  }
}
