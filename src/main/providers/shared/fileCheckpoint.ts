import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { UsageSourceScanPlan } from '../../usageIndex/types';

/** Verify the entire committed prefix; the callback makes this I/O visible in measurements. */
export function checkpointFingerprint(filePath: string, offset: number, onBytesRead?: (bytes: number) => void): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    if (fs.fstatSync(fd).size < offset) throw new Error('Usage source is shorter than its committed checkpoint');
    const hash = createHash('sha256');
    const bytes = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, offset)));
    for (let start = 0; start < offset;) {
      const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, offset - start), start);
      if (!count) throw new Error('Source changed while validating checkpoint');
      hash.update(bytes.subarray(0, count));
      onBytesRead?.(count);
      start += count;
    }
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

export interface FileScanStart {
  startOffset: number;
  accountedOffset: number;
  endOffset: number;
  rebased: boolean;
  generation: number;
  fallbackTimestampMs: number;
  resume: Record<string, any> | null;
}

/** Freeze the readable boundary before scanning; invalidated files only establish new state. */
export function beginFileScan(
  filePath: string,
  plan: UsageSourceScanPlan,
  nowMs: number,
  endOffsetExclusive?: number,
  onValidationBytesRead?: (bytes: number) => void,
): FileScanStart {
  const size = fs.statSync(filePath).size;
  const endOffset = Math.min(size, endOffsetExclusive ?? plan.source.version.size ?? size);
  if (!Number.isSafeInteger(endOffset) || endOffset < 0) throw new Error('Invalid frozen source boundary');
  const checkpoint = plan.checkpoint;
  const previousOffset = checkpoint?.byteOffset ?? 0;
  let resume: Record<string, any> | null = null;
  if (checkpoint?.resumeState) {
    try {
      const parsed = JSON.parse(checkpoint.resumeState);
      // Old parser state is discarded, never interpreted as a compatibility shape.
      if (parsed?.version === 2) resume = parsed;
    } catch { /* A state-only failure bootstraps at the durable observation boundary. */ }
  }
  const fingerprint = checkpoint?.fingerprint;
  const rebased = !!checkpoint && (previousOffset > endOffset
    || !!fingerprint && checkpointFingerprint(filePath, previousOffset, onValidationBytesRead) !== fingerprint);
  const fallback = checkpoint?.fallbackTimestampMs ?? plan.source.version.mtimeMs ?? nowMs;
  return {
    startOffset: resume && !rebased ? previousOffset : 0,
    accountedOffset: rebased ? endOffset : previousOffset,
    endOffset,
    rebased,
    generation: (checkpoint?.generation ?? 0) + (rebased ? 1 : 0),
    fallbackTimestampMs: Math.trunc(Number.isFinite(fallback) && fallback >= 0 ? fallback : nowMs),
    resume: rebased ? null : resume,
  };
}

export function usageTimestamp(value: unknown, previous: number, created: number, fallback: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : previous || created || fallback;
}
