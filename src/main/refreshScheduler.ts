export type RefreshMode = 'fast' | 'heavy';

export type RefreshReason =
  | 'startup'
  | 'foreground'
  | 'history-warmup'
  | 'timer'
  | 'watcher'
  | 'ui-idle'
  | 'manual'
  | 'settings';

export interface RefreshRequest {
  mode: RefreshMode;
  reason: RefreshReason;
  changedFiles?: Iterable<string>;
  force?: boolean;
  includeFullHistory?: boolean;
  allowStartupBudget?: boolean;
  allowHiddenFullScan?: boolean;
  scanBudgetMs?: number | null;
}

export interface RefreshWork {
  mode: RefreshMode;
  reasons: RefreshReason[];
  changedFiles?: Set<string>;
  force: boolean;
  includeFullHistory: boolean;
  allowStartupBudget: boolean;
  allowHiddenFullScan: boolean;
  scanBudgetMs: number | null;
}

export interface RefreshSchedulerState {
  uiVisible: boolean;
  uiBusy: boolean;
}

interface PendingRefresh {
  mode: RefreshMode;
  reasons: Set<RefreshReason>;
  changedFiles: Set<string>;
  force: boolean;
  includeFullHistory: boolean;
  allowStartupBudget: boolean;
  allowHiddenFullScan: boolean;
  scanBudgetMs: number | null | undefined;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

export interface RefreshSchedulerOptions {
  foregroundScanBudgetMs: number;
  getState: () => RefreshSchedulerState;
  execute: (work: RefreshWork) => Promise<void>;
}

export class RefreshScheduler {
  private pending: PendingRefresh | null = null;
  private running = false;
  private drainScheduled = false;

  constructor(private readonly options: RefreshSchedulerOptions) {}

  request(request: RefreshRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending = this.mergePending(this.pending, request, { resolve, reject });
      this.scheduleDrain();
    });
  }

  notifyStateChanged(): void {
    this.scheduleDrain();
  }

  isRunning(): boolean {
    return this.running;
  }

  getPendingChangedFileCount(): number {
    return this.pending?.changedFiles.size ?? 0;
  }

  private mergePending(
    current: PendingRefresh | null,
    request: RefreshRequest,
    waiter: { resolve: () => void; reject: (error: unknown) => void },
  ): PendingRefresh {
    const changedFiles = current?.changedFiles ?? new Set<string>();
    for (const file of request.changedFiles ?? []) changedFiles.add(file);

    const reasons = current?.reasons ?? new Set<RefreshReason>();
    reasons.add(request.reason);

    return {
      mode: current?.mode === 'heavy' || request.mode === 'heavy' ? 'heavy' : 'fast',
      reasons,
      changedFiles,
      force: (current?.force ?? false) || request.force === true,
      includeFullHistory: (current?.includeFullHistory ?? false) || request.includeFullHistory === true,
      allowStartupBudget: (current?.allowStartupBudget ?? false) || request.allowStartupBudget === true,
      allowHiddenFullScan: (current?.allowHiddenFullScan ?? false) || request.allowHiddenFullScan === true,
      scanBudgetMs: this.mergeScanBudget(current?.scanBudgetMs, request.scanBudgetMs),
      waiters: [...(current?.waiters ?? []), waiter],
    };
  }

  private mergeScanBudget(current: number | null | undefined, next: number | null | undefined): number | null | undefined {
    if (next === undefined) return current;
    if (current === undefined) return next;
    if (current === null || next === null) return null;
    return Math.min(current, next);
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;

    while (this.pending) {
      const work = this.takeRunnableWork();
      if (!work) return;

      this.running = true;
      try {
        await this.options.execute(work.work);
        for (const waiter of work.waiters) waiter.resolve();
      } catch (error) {
        for (const waiter of work.waiters) waiter.reject(error);
      } finally {
        this.running = false;
      }
    }
  }

  private takeRunnableWork(): { work: RefreshWork; waiters: PendingRefresh['waiters'] } | null {
    const pending = this.pending;
    if (!pending) return null;

    const state = this.options.getState();
    if (state.uiBusy && !pending.force) return null;

    this.pending = null;
    const scanBudgetMs = this.resolveScanBudget(pending, state);
    return {
      work: {
        mode: pending.mode,
        reasons: [...pending.reasons],
        changedFiles: pending.changedFiles.size > 0 ? new Set(pending.changedFiles) : undefined,
        force: pending.force,
        includeFullHistory: pending.includeFullHistory,
        allowStartupBudget: pending.allowStartupBudget,
        allowHiddenFullScan: !state.uiVisible && pending.allowHiddenFullScan,
        scanBudgetMs,
      },
      waiters: pending.waiters,
    };
  }

  private resolveScanBudget(pending: PendingRefresh, state: RefreshSchedulerState): number | null {
    if (pending.mode === 'fast') return null;
    if (pending.force) return null;
    if (pending.scanBudgetMs !== undefined) return pending.scanBudgetMs;
    return this.options.foregroundScanBudgetMs;
  }
}
