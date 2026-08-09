import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  ClaudeStatusLineSnapshot,
  normalizeClaudeStatusLineSnapshot,
} from '../shared/claudeStatusLine';

export const MAX_CLAUDE_STATUS_LINE_BYTES = 256 * 1024;
const STATUS_LINE_LOCK_RETRY_COUNT = 25;
const STATUS_LINE_LOCK_RETRY_MS = 10;
const STATUS_LINE_LOCK_STALE_MS = 10_000;
const STATUS_LINE_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
let temporaryFileSequence = 0;

interface ReadSnapshotResult {
  snapshot: ClaudeStatusLineSnapshot;
  needsMigration: boolean;
}

export function claudeStatusLineFilePath(): string {
  const roaming = process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'WhereMyTokens', 'live-session.json');
}

function readSnapshot(filePath: string, nowMs: number): ReadSnapshotResult | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size <= 0 || stat.size > MAX_CLAUDE_STATUS_LINE_BYTES) {
      fs.rmSync(filePath, { force: true });
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    } catch {
      fs.rmSync(filePath, { force: true });
      return null;
    }
    const snapshot = normalizeClaudeStatusLineSnapshot(parsed, {
      nowMs,
      fallbackCapturedAtMs: stat.mtimeMs,
    });
    if (!snapshot) {
      fs.rmSync(filePath, { force: true });
      return null;
    }
    return {
      snapshot,
      needsMigration: JSON.stringify(parsed) !== JSON.stringify(snapshot),
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function canRecoverStatusLineLock(lockPath: string): boolean {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const tokenMatch = /^(\d+):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(raw);
    const ownerPid = tokenMatch ? Number.parseInt(tokenMatch[1], 10) : null;
    if (ownerPid !== null && Number.isInteger(ownerPid) && ownerPid > 0) {
      return !isProcessAlive(ownerPid);
    }
    return Date.now() - fs.statSync(lockPath).mtimeMs > STATUS_LINE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function withStatusLineLock<T>(
  filePath: string,
  work: (ownsLock: () => boolean) => T,
): T | undefined {
  const lockPath = `${filePath}.lock`;
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch { return undefined; }

  for (let attempt = 0; attempt < STATUS_LINE_LOCK_RETRY_COUNT; attempt++) {
    let descriptor: number | null = null;
    let lockToken = '';
    const ownsLock = () => {
      if (!lockToken) return false;
      try { return fs.readFileSync(lockPath, 'utf-8') === lockToken; } catch { return false; }
    };
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      lockToken = `${process.pid}:${randomUUID()}`;
      const tokenBytes = Buffer.from(lockToken, 'utf-8');
      let writtenBytes = 0;
      while (writtenBytes < tokenBytes.length) {
        const count = fs.writeSync(
          descriptor,
          tokenBytes,
          writtenBytes,
          tokenBytes.length - writtenBytes,
        );
        if (count <= 0) throw new Error('Claude statusLine lock token write did not progress.');
        writtenBytes += count;
      }
      fs.fsyncSync(descriptor);
      return work(ownsLock);
    } catch (error) {
      if (descriptor !== null || (error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
      if (canRecoverStatusLineLock(lockPath)) {
        try { fs.rmSync(lockPath, { force: true }); } catch { /* 다른 writer가 먼저 회수했을 수 있다. */ }
        continue;
      }
      Atomics.wait(STATUS_LINE_LOCK_WAIT, 0, 0, STATUS_LINE_LOCK_RETRY_MS);
    } finally {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch { /* lock 해제를 계속 진행한다. */ }
        if (ownsLock()) {
          try { fs.rmSync(lockPath, { force: true }); } catch { /* 다음 호출이 dead-owner lock을 정리한다. */ }
        }
      }
    }
  }
  return undefined;
}

export function readClaudeStatusLineFile(
  filePath = claudeStatusLineFilePath(),
  nowMs = Date.now(),
): ClaudeStatusLineSnapshot | null {
  const result = withStatusLineLock(filePath, (ownsLock) => {
    const current = readSnapshot(filePath, nowMs);
    if (!current) return null;
    if (current.needsMigration && ownsLock()) replaceClaudeStatusLineFile(current.snapshot, filePath);
    return current.snapshot;
  });
  return result ?? null;
}

function replaceClaudeStatusLineFile(snapshot: ClaudeStatusLineSnapshot, filePath: string): boolean {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${temporaryFileSequence++}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify(snapshot), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* 임시 파일 정리는 최선만 다한다. */ }
  }
}

export function writeClaudeStatusLineFile(
  value: unknown,
  filePath = claudeStatusLineFilePath(),
  capturedAtMs = Date.now(),
  validationNowMs = Date.now(),
): boolean {
  const snapshot = normalizeClaudeStatusLineSnapshot(value, {
    nowMs: validationNowMs,
    capturedAtMs,
  });
  if (!snapshot) return false;
  const written = withStatusLineLock(filePath, (ownsLock) => {
    const current = readSnapshot(filePath, validationNowMs)?.snapshot ?? null;
    if (current && current.capturedAt > snapshot.capturedAt) return false;
    if (!ownsLock()) return false;
    return replaceClaudeStatusLineFile(snapshot, filePath);
  });
  return written ?? false;
}
