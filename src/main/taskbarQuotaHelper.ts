import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { EventEmitter } from 'events';
import type { AppState } from './stateManager';
import { buildTaskbarQuotaSnapshot, type TaskbarQuotaSnapshot } from './taskbarQuotaSnapshot';

const RUNTIME_DISABLE_FAILURE_LIMIT = 3;
const DEFAULT_BACKPRESSURE_TIMEOUT_MS = 5000;
const DEFAULT_RENDER_ACK_TIMEOUT_MS = 5000;

interface WritableLike extends EventEmitter {
  write: (value: string) => boolean;
  end?: () => void;
  destroy?: () => void;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'drain', listener: () => void): this;
}

interface ReadableLike extends EventEmitter {
  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

interface ChildLike extends EventEmitter {
  stdin?: WritableLike | null;
  stdout?: ReadableLike | null;
  kill?: () => void;
  on(event: 'exit', listener: (code: number | null, signal?: string | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface TaskbarQuotaHelperManagerOptions {
  platform?: NodeJS.Platform | string;
  resolveHelperPath?: () => string | null;
  helperExists?: (helperPath: string) => boolean;
  allowDevHelperFallback?: boolean;
  spawnHelper?: (helperPath: string) => ChildLike;
  buildSnapshot?: (state: AppState) => TaskbarQuotaSnapshot | null;
  openDashboard?: () => void;
  onRuntimeDisabled?: () => void;
  backpressureTimeoutMs?: number;
  renderAckTimeoutMs?: number;
}

export interface TaskbarQuotaHelperManager {
  syncTaskbarQuotaHelper: (state: AppState) => void;
  stopTaskbarQuotaHelper: () => void;
  isTaskbarQuotaHelperDisabledForRuntime: () => boolean;
}

function shouldAllowDevHelperFallback(): boolean {
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const electronProcess = process as NodeJS.Process & { defaultApp?: boolean };
  return !resourcesPath || electronProcess.defaultApp === true;
}

function defaultResolveHelperPath(
  helperExists: (helperPath: string) => boolean = fs.existsSync,
  allowDevHelperFallback = shouldAllowDevHelperFallback(),
): string | null {
  const fileName = 'WhereMyTokens.Taskbar.exe';
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (resourcesPath) {
    const packagedPath = path.join(resourcesPath, 'taskbar-helper', fileName);
    if (helperExists(packagedPath)) return packagedPath;
    // 패키징된 앱에서는 작업 디렉터리의 임의 EXE로 대체하지 않는다.
    if (!allowDevHelperFallback) return null;
  }
  return path.resolve(process.cwd(), 'taskbar-helper', 'bin', fileName);
}

function defaultSpawnHelper(helperPath: string): ChildLike {
  return spawn(helperPath, [], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

export function createTaskbarQuotaHelperManager(options: TaskbarQuotaHelperManagerOptions = {}): TaskbarQuotaHelperManager {
  const platform = options.platform ?? process.platform;
  const helperExists = options.helperExists ?? fs.existsSync;
  const resolveHelperPath = options.resolveHelperPath ?? (() => defaultResolveHelperPath(helperExists, options.allowDevHelperFallback));
  const spawnHelper = options.spawnHelper ?? defaultSpawnHelper;
  const snapshotBuilder = options.buildSnapshot ?? buildTaskbarQuotaSnapshot;
  const openDashboard = options.openDashboard ?? (() => {});
  const onRuntimeDisabled = options.onRuntimeDisabled ?? (() => {});
  const backpressureTimeoutMs = options.backpressureTimeoutMs ?? DEFAULT_BACKPRESSURE_TIMEOUT_MS;
  const renderAckTimeoutMs = options.renderAckTimeoutMs ?? DEFAULT_RENDER_ACK_TIMEOUT_MS;

  let child: ChildLike | null = null;
  let stdoutBuffer = '';
  let consecutiveFailures = 0;
  let runtimeDisabled = false;
  let waitingForDrain = false;
  let waitingForRenderAck = false;
  let pendingSnapshotLine: string | null = null;
  let backpressureTimer: NodeJS.Timeout | null = null;
  let renderAckTimer: NodeJS.Timeout | null = null;
  const stoppingChildren = new WeakSet<object>();

  function resetFailureState(): void {
    consecutiveFailures = 0;
    runtimeDisabled = false;
  }

  function clearConsecutiveFailures(): void {
    consecutiveFailures = 0;
  }

  function clearBackpressureTimer(): void {
    if (!backpressureTimer) return;
    clearTimeout(backpressureTimer);
    backpressureTimer = null;
  }

  function clearRenderAckTimer(): void {
    if (!renderAckTimer) return;
    clearTimeout(renderAckTimer);
    renderAckTimer = null;
  }

  function resetBackpressureState(): void {
    waitingForDrain = false;
    pendingSnapshotLine = null;
    clearBackpressureTimer();
  }

  function resetRenderAckState(): void {
    waitingForRenderAck = false;
    clearRenderAckTimer();
  }

  function resetWriteState(): void {
    resetBackpressureState();
    resetRenderAckState();
  }

  function stopActive(): void {
    if (!child) return;
    const current = child;
    child = null;
    stdoutBuffer = '';
    resetWriteState();
    stoppingChildren.add(current as object);
    try {
      current.stdin?.end?.();
      current.kill?.();
    } catch {
      // 다음 동기화 시도에서 새 helper를 다시 띄운다.
    }
  }

  function recordFailure(): void {
    consecutiveFailures += 1;
    if (consecutiveFailures < RUNTIME_DISABLE_FAILURE_LIMIT || runtimeDisabled) return;
    runtimeDisabled = true;
    stopActive();
    try {
      onRuntimeDisabled();
    } catch {
      // 알림/설정 저장 실패가 helper manager 상태를 다시 흔들지 않도록 분리한다.
    }
  }

  function failActiveHelper(owner: ChildLike): void {
    if (child !== owner) return;
    recordFailure();
    if (child === owner) stopActive();
  }

  function flushPendingSnapshot(owner: ChildLike): void {
    if (child !== owner || waitingForDrain || waitingForRenderAck) return;
    const line = pendingSnapshotLine;
    pendingSnapshotLine = null;
    if (line) writeLine(owner, line);
  }

  function handleSnapshotRendered(owner: ChildLike): void {
    if (child !== owner || !waitingForRenderAck) return;
    resetRenderAckState();
    clearConsecutiveFailures();
    flushPendingSnapshot(owner);
  }

  function handleEventLine(owner: ChildLike, line: string): void {
    if (child !== owner) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      failActiveHelper(owner);
      return;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      failActiveHelper(owner);
      return;
    }
    const type = (event as { type?: unknown }).type;
    if (type === 'snapshot-rendered') {
      handleSnapshotRendered(owner);
      return;
    }
    if (type === 'snapshot-rejected') {
      failActiveHelper(owner);
      return;
    }
    if (type === 'open-dashboard') {
      openDashboard();
      return;
    }
    failActiveHelper(owner);
  }

  function handleStdout(owner: ChildLike, chunk: Buffer | string): void {
    if (child !== owner) return;
    stdoutBuffer += String(chunk);
    while (stdoutBuffer.includes('\n')) {
      const lineEnd = stdoutBuffer.indexOf('\n');
      const line = stdoutBuffer.slice(0, lineEnd).trim();
      stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
      if (line) handleEventLine(owner, line);
      if (!child) return;
      if (child !== owner) return;
    }
  }

  function scheduleRenderAckTimeout(owner: ChildLike): void {
    clearRenderAckTimer();
    renderAckTimer = setTimeout(() => {
      if (child !== owner || !waitingForRenderAck) return;
      failActiveHelper(owner);
    }, Math.max(1, renderAckTimeoutMs));
    renderAckTimer.unref?.();
  }

  function scheduleBackpressureTimeout(owner: ChildLike): void {
    clearBackpressureTimer();
    backpressureTimer = setTimeout(() => {
      if (child !== owner || !waitingForDrain) return;
      failActiveHelper(owner);
    }, Math.max(1, backpressureTimeoutMs));
    backpressureTimer.unref?.();
  }

  function writeLine(owner: ChildLike, line: string): void {
    if (child !== owner || !owner.stdin) return;
    try {
      const drained = owner.stdin.write(line);
      waitingForRenderAck = true;
      if (!drained) {
        waitingForDrain = true;
        scheduleBackpressureTimeout(owner);
        return;
      }
      scheduleRenderAckTimeout(owner);
    } catch {
      failActiveHelper(owner);
    }
  }

  function handleDrain(owner: ChildLike): void {
    if (child !== owner || !waitingForDrain) return;
    clearBackpressureTimer();
    waitingForDrain = false;
    if (waitingForRenderAck) {
      scheduleRenderAckTimeout(owner);
      return;
    }
    flushPendingSnapshot(owner);
  }

  function start(): boolean {
    if (child) return true;
    const helperPath = resolveHelperPath();
    if (!helperPath || !helperExists(helperPath)) {
      recordFailure();
      return false;
    }
    try {
      const nextChild = spawnHelper(helperPath);
      child = nextChild;
      nextChild.stdout?.on('data', chunk => handleStdout(nextChild, chunk));
      nextChild.stdin?.on('drain', () => handleDrain(nextChild));
      nextChild.stdout?.on('error', () => {
        failActiveHelper(nextChild);
      });
      nextChild.stdin?.on('error', () => {
        failActiveHelper(nextChild);
      });
      nextChild.on('exit', (code) => {
        if (child === nextChild) {
          child = null;
          stdoutBuffer = '';
          resetWriteState();
          if (!stoppingChildren.has(nextChild as object) && code !== 0) recordFailure();
        }
      });
      nextChild.on('error', () => {
        failActiveHelper(nextChild);
      });
      return true;
    } catch {
      recordFailure();
      return false;
    }
  }

  function writeSnapshot(snapshot: TaskbarQuotaSnapshot): void {
    const current = child;
    if (!current?.stdin) {
      stopActive();
      return;
    }
    const line = `${JSON.stringify(snapshot)}\n`;
    if (waitingForDrain || waitingForRenderAck) {
      pendingSnapshotLine = line;
      return;
    }
    writeLine(current, line);
  }

  return {
    syncTaskbarQuotaHelper(state: AppState) {
      if (platform !== 'win32' || state.settings.taskbarQuotaEnabled !== true) {
        stopActive();
        resetFailureState();
        return;
      }
      if (runtimeDisabled) return;
      const snapshot = snapshotBuilder(state);
      if (snapshot == null) {
        stopActive();
        return;
      }
      if (!start()) return;
      writeSnapshot(snapshot);
    },

    stopTaskbarQuotaHelper() {
      stopActive();
    },

    isTaskbarQuotaHelperDisabledForRuntime() {
      return runtimeDisabled;
    },
  };
}

const defaultManager = createTaskbarQuotaHelperManager();

export function syncTaskbarQuotaHelper(state: AppState): void {
  defaultManager.syncTaskbarQuotaHelper(state);
}

export function stopTaskbarQuotaHelper(): void {
  defaultManager.stopTaskbarQuotaHelper();
}

export function isTaskbarQuotaHelperDisabledForRuntime(): boolean {
  return defaultManager.isTaskbarQuotaHelperDisabledForRuntime();
}
