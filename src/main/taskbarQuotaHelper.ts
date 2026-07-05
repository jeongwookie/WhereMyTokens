import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { EventEmitter } from 'events';
import type { AppState } from './stateManager';
import { buildTaskbarQuotaSnapshot, type TaskbarQuotaSnapshot } from './taskbarQuotaSnapshot';

interface WritableLike extends EventEmitter {
  write: (value: string) => boolean;
  end?: () => void;
  destroy?: () => void;
  on(event: 'error', listener: (error: Error) => void): this;
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
  spawnHelper?: (helperPath: string) => ChildLike;
  buildSnapshot?: (state: AppState) => TaskbarQuotaSnapshot;
  openDashboard?: () => void;
}

export interface TaskbarQuotaHelperManager {
  syncTaskbarQuotaHelper: (state: AppState) => void;
  stopTaskbarQuotaHelper: () => void;
  isTaskbarQuotaHelperDisabledForRuntime: () => boolean;
}

function defaultResolveHelperPath(helperExists: (helperPath: string) => boolean = fs.existsSync): string | null {
  const fileName = 'WhereMyTokens.Taskbar.exe';
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (resourcesPath) {
    const packagedPath = path.join(resourcesPath, 'taskbar-helper', fileName);
    if (helperExists(packagedPath)) return packagedPath;
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
  const resolveHelperPath = options.resolveHelperPath ?? (() => defaultResolveHelperPath(helperExists));
  const spawnHelper = options.spawnHelper ?? defaultSpawnHelper;
  const snapshotBuilder = options.buildSnapshot ?? buildTaskbarQuotaSnapshot;
  const openDashboard = options.openDashboard ?? (() => {});

  let child: ChildLike | null = null;
  let stdoutBuffer = '';

  function stopActive(): void {
    if (!child) return;
    const current = child;
    child = null;
    stdoutBuffer = '';
    try {
      current.stdin?.end?.();
      current.kill?.();
    } catch {
      // The next sync tick will try to spawn a fresh helper.
    }
  }

  function handleEventLine(line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      stopActive();
      return;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      stopActive();
      return;
    }
    const type = (event as { type?: unknown }).type;
    if (type === 'open-dashboard') {
      openDashboard();
      return;
    }
    stopActive();
  }

  function handleStdout(chunk: Buffer | string): void {
    stdoutBuffer += String(chunk);
    while (stdoutBuffer.includes('\n')) {
      const lineEnd = stdoutBuffer.indexOf('\n');
      const line = stdoutBuffer.slice(0, lineEnd).trim();
      stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
      if (line) handleEventLine(line);
      if (!child) return;
    }
  }

  function start(): boolean {
    if (child) return true;
    const helperPath = resolveHelperPath();
    if (!helperPath || !helperExists(helperPath)) {
      return false;
    }
    try {
      const nextChild = spawnHelper(helperPath);
      child = nextChild;
      nextChild.stdout?.on('data', handleStdout);
      nextChild.stdout?.on('error', () => {
        stopActive();
      });
      nextChild.stdin?.on('error', () => {
        stopActive();
      });
      nextChild.on('exit', () => {
        child = null;
      });
      nextChild.on('error', () => {
        stopActive();
      });
      return true;
    } catch {
      return false;
    }
  }

  function writeSnapshot(state: AppState): void {
    if (!child?.stdin) {
      stopActive();
      return;
    }
    const snapshot = snapshotBuilder(state);
    const ok = child.stdin.write(`${JSON.stringify(snapshot)}\n`);
    if (!ok) stopActive();
  }

  return {
    syncTaskbarQuotaHelper(state: AppState) {
      if (platform !== 'win32' || state.settings.taskbarQuotaEnabled !== true) {
        stopActive();
        return;
      }
      if (!start()) return;
      writeSnapshot(state);
    },

    stopTaskbarQuotaHelper() {
      stopActive();
    },

    isTaskbarQuotaHelperDisabledForRuntime() {
      return false;
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
