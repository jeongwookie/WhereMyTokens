import { compositionToDelta, splitOutput } from '../../outputSplitter';
import { emptyToolOutput, TOOL_CATEGORY_KEYS } from '../../../shared/breakdownTypes';
import type { UsageEntry, UsageSourceBatch, UsageSourceScanner, UsageSourceScanPlan } from '../../usageIndex';
import { emptySessionSnapshot, type SessionSnapshot } from '../../jsonlTypes';
import { AntigravityLsClient } from './lsClient';
import { activityBreakdownFromCalls, classifyAntigravityToolName, parseAntigravityGmEntry } from './gmParser';
import { antigravityUsageEntryFromCall } from './summary';
import type { AntigravityServerInfo } from './types';

export interface AntigravityUsageScannerInput {
  server: AntigravityServerInfo;
  cascadeId: string;
  stepCount: number;
  lastModifiedMs: number;
  modelLabels: Map<string, string>;
  stopAt: number;
}

interface Cursor {
  metadataOffset: number;
  stepOffset: number;
  snapshot: SessionSnapshot;
  updatedAt: number;
  lastTimestampMs: number;
}
interface ScanState extends Cursor { replay?: Cursor }
interface StepTime { timestampMs?: number; status?: string }

function remainingTimeoutMs(stopAt: number): number {
  return Math.max(1, Math.min(8_000, stopAt - Date.now()));
}

class StepTimes {
  private iterator?: ReturnType<AntigravityLsClient['streamSteps']>;
  private cache = new Map<number, StepTime>();
  private nextIndex: number;
  error?: string;

  constructor(private client: AntigravityLsClient, private input: AntigravityUsageScannerInput, offset: number) {
    this.nextIndex = offset;
  }

  async get(indices: number[]): Promise<StepTime[]> {
    if (!indices.length || this.error) return [];
    try {
      const missing = indices.filter(i => !this.cache.has(i));
      const found = new Map(indices.filter(i => this.cache.has(i)).map(i => [i, this.cache.get(i)!]));
      const wanted = new Set(indices);
      if (missing.some(i => i < this.nextIndex)) {
        const offset = Math.min(...missing);
        const stream = this.client.streamSteps(this.input.cascadeId, offset, remainingTimeoutMs(this.input.stopAt));
        for await (const row of stream) {
          this.remember(offset + row.index, row.value);
          if (wanted.has(offset + row.index)) found.set(offset + row.index, this.cache.get(offset + row.index)!);
          if (offset + row.index >= Math.max(...missing)) break;
        }
      } else if (missing.length) {
        if (!this.iterator) this.iterator = this.client.streamSteps(this.input.cascadeId, this.nextIndex, remainingTimeoutMs(this.input.stopAt));
        while (this.nextIndex <= Math.max(...missing)) {
          const row = await this.iterator.next();
          if (row.done) break;
          this.remember(this.nextIndex, row.value.value);
          if (wanted.has(this.nextIndex)) found.set(this.nextIndex, this.cache.get(this.nextIndex)!);
          this.nextIndex += 1;
        }
      }
      return indices.map(i => found.get(i) ?? {});
    } catch (error) {
      this.error = `Antigravity step times: ${error instanceof Error ? error.message : String(error)}`;
      return [];
    }
  }

  async close(): Promise<void> { await this.iterator?.return(undefined); }

  private remember(index: number, value: Record<string, any>): void {
    const timestamp = typeof value.metadata?.createdAt === 'string' ? Date.parse(value.metadata.createdAt) : NaN;
    this.cache.set(index, { ...(Number.isFinite(timestamp) && timestamp >= 0 ? { timestampMs: timestamp } : {}), status: value.status });
    if (this.cache.size > 1024) this.cache.delete(this.cache.keys().next().value!);
  }
}

function breakdownFromCall(call: NonNullable<ReturnType<typeof parseAntigravityGmEntry>>) {
  const counts = activityBreakdownFromCalls([call]);
  const toolWeights = emptyToolOutput();
  for (const name of call.toolNames) toolWeights[classifyAntigravityToolName(name)] += 1;
  const delta = compositionToDelta(splitOutput({ thinkingChars: 0,
    responseChars: call.responseTokens > 0 ? call.responseTokens : 1, toolChars: toolWeights,
  }, call.outputTokens, call.thinkingTokens));
  for (const category of TOOL_CATEGORY_KEYS) delta[category] = counts[category];
  return delta;
}

async function* scanBatches(input: AntigravityUsageScannerInput, plan: UsageSourceScanPlan): AsyncIterable<UsageSourceBatch> {
  const candidate = plan.checkpoint?.fallbackTimestampMs ?? input.lastModifiedMs;
  const fallbackTimestampMs = Number.isFinite(candidate) && candidate >= 0 ? candidate : Date.now();
  const initial: ScanState = plan.checkpoint?.resumeState ? JSON.parse(plan.checkpoint.resumeState) : {
    metadataOffset: 0, stepOffset: 0, snapshot: emptySessionSnapshot('tokens'), updatedAt: 0, lastTimestampMs: fallbackTimestampMs,
  };
  const state: ScanState = structuredClone(initial);
  const client = new AntigravityLsClient(input.server);
  const times = new StepTimes(client, input, state.stepOffset);
  let entries: UsageEntry[] = [];
  let rows = 0;
  let lastBefore: Cursor | undefined;
  let stopped = Date.now() >= input.stopAt;
  const batch = (pending: boolean, cursor: ScanState): UsageSourceBatch => ({
    entries,
    pending,
    checkpoint: { cursor: plan.source.version.token, fallbackTimestampMs, resumeState: JSON.stringify(cursor) },
    ...(plan.mode === 'rebuild' ? { rebuildCoverage: entries.length ? { kind: 'range' as const,
      fromMs: Math.min(...entries.map(e => e.timestampMs)), toMs: Math.max(...entries.map(e => e.timestampMs)) + 1,
    } : { kind: 'none' as const } } : {}),
    ...(times.error ? { failure: times.error, providerMetadata: { collectionError: times.error } } : {}),
    sessionProjection: { sourceId: plan.source.sourceId, provider: 'antigravity',
      updatedAt: state.updatedAt || fallbackTimestampMs, byteSize: state.metadataOffset,
      payload: { sessionSnapshot: structuredClone(state.snapshot) } },
  });
  try {
    if (!stopped) {
      const offset = state.metadataOffset;
      for await (const row of client.streamGeneratorMetadata(input.cascadeId, offset, remainingTimeoutMs(input.stopAt))) {
        if (Date.now() >= input.stopAt) { stopped = true; break; }
        const index = offset + row.index;
        const gm = row.value;
        const indices: number[] = Array.isArray(gm.stepIndices) ? [...new Set<number>(gm.stepIndices.filter((i: unknown): i is number =>
          typeof i === 'number' && Number.isSafeInteger(i) && i >= 0))].sort((a, b) => a - b) : [];
        lastBefore = { metadataOffset: index, stepOffset: indices.length ? Math.min(...indices) : state.stepOffset,
          snapshot: structuredClone(state.snapshot), updatedAt: state.updatedAt, lastTimestampMs: state.lastTimestampMs };
        const call = parseAntigravityGmEntry(input.cascadeId, gm, state.lastTimestampMs, input.modelLabels, index);
        const stepTimes = call?.timestampSource === 'provider' ? [] : await times.get(indices);
        const actualTime = stepTimes.map(s => s.timestampMs).find((t): t is number => t !== undefined);
        if (call && actualTime !== undefined && call.timestampSource === 'estimated') {
          call.timestampMs = actualTime;
          call.timestampSource = 'step';
        }
        const unfinished = stepTimes.some(s => s.status && !/_(DONE|ERROR|CANCELED|CANCELLED|SKIPPED)$/.test(s.status))
          || !call && !gm.error;
        if (!state.replay && (unfinished || times.error || call?.timestampSource === 'estimated')) state.replay = lastBefore;
        if (call) {
          const entry = antigravityUsageEntryFromCall(call);
          entries.push({ ...entry, timestampSource: call.timestampSource,
            ...(call.timestampSource === 'step' ? { estimatedTimestampMs: fallbackTimestampMs } : {}),
            identityKey: `${plan.source.sourceId}:${entry.requestId}`, identityOrigin: 'antigravity:observation:' + entry.requestId,
            breakdown: breakdownFromCall(call) });
          const snapshot = state.snapshot;
          snapshot.modelName = call.model; snapshot.rawModel = call.rawModel;
          snapshot.latestInputTokens = call.inputTokens; snapshot.latestCacheCreationTokens = call.cacheCreationTokens;
          snapshot.latestCacheReadTokens = call.cacheReadTokens;
          if (call.contextMax) snapshot.contextMax = call.contextMax;
          else delete snapshot.contextMax;
          for (const name of call.toolNames) snapshot.toolCounts[name] = (snapshot.toolCounts[name] ?? 0) + 1;
          const activity = activityBreakdownFromCalls([call]);
          for (const key of Object.keys(activity) as Array<keyof typeof activity>) snapshot.activityBreakdown[key] += activity[key];
          state.updatedAt = Math.max(state.updatedAt, call.timestampMs);
          if (call.timestampSource !== 'estimated') state.lastTimestampMs = call.timestampMs;
        }
        state.metadataOffset = index + 1;
        state.stepOffset = indices.length ? Math.min(...indices) : state.stepOffset;
        rows += 1;
        if (rows % 128 === 0) {
          yield batch(true, state);
          entries = [];
        }
      }
    }
    yield batch(stopped || !!times.error || !!initial.replay, stopped ? state : state.replay ?? lastBefore ?? state);
  } finally {
    await times.close();
  }
}

export function createAntigravityUsageIndexScanner(input: AntigravityUsageScannerInput): UsageSourceScanner {
  return { scanBatches: plan => scanBatches(input, plan) };
}
