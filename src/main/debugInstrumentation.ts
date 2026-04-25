import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as v8 from 'v8';
import { EventEmitter } from 'events';

const DEBUG_ENV_KEY = 'WMT_DEBUG_INSTRUMENTATION';
const DEBUG_FLAG = '--enable-debug-instrumentation';
const DEFAULT_LOG_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'WhereMyTokens');
const CRASH_LOG_PATH = path.join(DEFAULT_LOG_DIR, 'crash.log');
const MEMORY_LOG_PATH = path.join(DEFAULT_LOG_DIR, 'debug-mem.jsonl');
const MAX_LOG_BYTES = 50 * 1024 * 1024;
const ROTATION_COUNT = 2;

type ListenerTarget = {
  name: string;
  emitter: EventEmitter | null | undefined;
};

export interface DebugListenerCounts {
  total: number;
  byEmitter: Record<string, number>;
}

export interface RuntimeMemorySnapshot {
  pid: number;
  uptimeSeconds: number;
  memoryUsage: NodeJS.MemoryUsage;
  heapStatistics: ReturnType<typeof v8.getHeapStatistics>;
  activeHandles: number;
  activeRequests: number;
  listenerCounts: DebugListenerCounts;
}

let listenerTargetsProvider: (() => ListenerTarget[]) | null = null;

function ensureLogDir(): void {
  fs.mkdirSync(DEFAULT_LOG_DIR, { recursive: true });
}

function rotateLogIfNeeded(filePath: string): void {
  ensureLogDir();
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_LOG_BYTES) return;
  } catch {
    return;
  }

  const oldestPath = `${filePath}.${ROTATION_COUNT}`;
  try {
    if (fs.existsSync(oldestPath)) fs.rmSync(oldestPath, { force: true });
  } catch {
    // 로그 회전 실패는 계측 자체를 막지 않는다.
  }

  for (let i = ROTATION_COUNT - 1; i >= 1; i -= 1) {
    const src = `${filePath}.${i}`;
    const dest = `${filePath}.${i + 1}`;
    try {
      if (fs.existsSync(src)) fs.renameSync(src, dest);
    } catch {
      // 로그 회전 실패는 계측 자체를 막지 않는다.
    }
  }

  try {
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    // 로그 회전 실패는 계측 자체를 막지 않는다.
  }
}

function appendJsonLine(filePath: string, payload: Record<string, unknown>): void {
  if (!isDebugInstrumentationEnabled()) return;
  ensureLogDir();
  rotateLogIfNeeded(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function normalizeErrorLike(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    } catch {
      return { value: String(value) };
    }
  }
  return { value: String(value) };
}

export function isDebugInstrumentationEnabled(argv = process.argv, env = process.env): boolean {
  return env[DEBUG_ENV_KEY] === '1' || argv.includes(DEBUG_FLAG);
}

export function getCrashLogPath(): string {
  return CRASH_LOG_PATH;
}

export function getDebugMemLogPath(): string {
  return MEMORY_LOG_PATH;
}

export function setListenerTargetsProvider(provider: () => ListenerTarget[]): void {
  listenerTargetsProvider = provider;
}

export function getListenerCounts(): DebugListenerCounts {
  const counts: Record<string, number> = {};
  let total = 0;
  const targets = listenerTargetsProvider ? listenerTargetsProvider() : [];
  for (const target of targets) {
    if (!target.emitter) continue;
    const count = target.emitter.eventNames().reduce((sum, eventName) => sum + target.emitter!.listenerCount(eventName), 0);
    counts[target.name] = count;
    total += count;
  }
  return { total, byEmitter: counts };
}

export function collectRuntimeMemorySnapshot(): RuntimeMemorySnapshot {
  const proc = process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
  };
  return {
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime() * 10) / 10,
    memoryUsage: process.memoryUsage(),
    heapStatistics: v8.getHeapStatistics(),
    activeHandles: proc._getActiveHandles ? proc._getActiveHandles().length : 0,
    activeRequests: proc._getActiveRequests ? proc._getActiveRequests().length : 0,
    listenerCounts: getListenerCounts(),
  };
}

export function appendCrashLog(event: string, payload: Record<string, unknown> = {}): void {
  appendJsonLine(CRASH_LOG_PATH, {
    ts: new Date().toISOString(),
    event,
    ...payload,
  });
}

export function appendDebugMemoryLog(event: string, payload: Record<string, unknown> = {}): void {
  appendJsonLine(MEMORY_LOG_PATH, {
    ts: new Date().toISOString(),
    event,
    ...payload,
  });
}

export function buildQuitTrace(label: string): string {
  return new Error(label).stack || label;
}

export function buildErrorPayload(reason: unknown): Record<string, unknown> {
  return {
    reason: normalizeErrorLike(reason),
    runtime: collectRuntimeMemorySnapshot(),
  };
}
