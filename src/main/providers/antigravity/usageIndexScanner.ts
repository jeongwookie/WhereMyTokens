import { compositionToDelta, splitOutput } from '../../outputSplitter';
import { emptyToolOutput, TOOL_CATEGORY_KEYS } from '../../../shared/breakdownTypes';
import type { UsageEntry, UsageSourceBatch, UsageSourceScanner } from '../../usageIndex';
import { emptySessionSnapshot } from '../../jsonlTypes';
import { AntigravityLsClient } from './lsClient';
import {
  activityBreakdownFromCalls,
  classifyAntigravityToolName,
  mergeAntigravityCalls,
  parseAntigravityGmEntries,
  shouldEnrichForTokens,
  type AntigravityUsageCall,
} from './gmParser';
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

function remainingTimeoutMs(stopAt: number): number {
  return Math.max(1, Math.min(8_000, stopAt - Date.now()));
}

function breakdownFromCall(call: AntigravityUsageCall) {
  const counts = activityBreakdownFromCalls([call]);
  const toolWeights = emptyToolOutput();
  for (const name of call.toolNames) {
    toolWeights[classifyAntigravityToolName(name)] += 1;
  }
  const composition = splitOutput({
    thinkingChars: 0,
    responseChars: call.responseTokens > 0 ? call.responseTokens : 1,
    toolChars: toolWeights,
  }, call.outputTokens, call.thinkingTokens);
  const delta = compositionToDelta(composition);
  for (const category of TOOL_CATEGORY_KEYS) delta[category] = counts[category];
  return delta;
}

function sessionSnapshot(calls: readonly AntigravityUsageCall[]) {
  const snapshot = emptySessionSnapshot('tokens');
  const latest = calls[calls.length - 1];
  if (latest) {
    snapshot.modelName = latest.model;
    snapshot.rawModel = latest.rawModel;
    snapshot.latestInputTokens = latest.inputTokens;
    snapshot.latestCacheCreationTokens = latest.cacheCreationTokens;
    snapshot.latestCacheReadTokens = latest.cacheReadTokens;
    if (latest.contextMax) snapshot.contextMax = latest.contextMax;
  }
  for (const call of calls) {
    for (const tool of call.toolNames) snapshot.toolCounts[tool] = (snapshot.toolCounts[tool] ?? 0) + 1;
  }
  snapshot.activityBreakdown = activityBreakdownFromCalls([...calls]);
  return snapshot;
}

async function fetchCalls(input: AntigravityUsageScannerInput): Promise<AntigravityUsageCall[]> {
  if (Date.now() >= input.stopAt) throw new Error(`Antigravity usage scan deadline reached before ${input.cascadeId}`);
  const client = new AntigravityLsClient(input.server);
  const lightweight = await client.getCascadeTrajectoryGeneratorMetadata(
    input.cascadeId,
    remainingTimeoutMs(input.stopAt),
  );
  const rawGm = Array.isArray(lightweight.generatorMetadata) ? lightweight.generatorMetadata : [];
  let calls = parseAntigravityGmEntries(input.cascadeId, rawGm, input.lastModifiedMs, input.modelLabels);
  if (shouldEnrichForTokens({ stepCount: input.stepCount, rawGm, calls }) && Date.now() < input.stopAt) {
    const full = await client.getCascadeTrajectory(input.cascadeId, remainingTimeoutMs(input.stopAt));
    const embeddedCalls = parseAntigravityGmEntries(
      input.cascadeId,
      Array.isArray(full.trajectory?.generatorMetadata) ? full.trajectory.generatorMetadata : [],
      input.lastModifiedMs,
      input.modelLabels,
    );
    calls = mergeAntigravityCalls(calls, embeddedCalls);
  }
  return calls.sort((a, b) => a.timestampMs - b.timestampMs);
}

export function createAntigravityUsageIndexScanner(input: AntigravityUsageScannerInput): UsageSourceScanner {
  return {
    async scan(plan): Promise<UsageSourceBatch> {
      const calls = await fetchCalls(input);
      const entries: UsageEntry[] = calls.map(call => ({
        ...antigravityUsageEntryFromCall(call),
        breakdown: breakdownFromCall(call),
      }));
      const rebuildCoverage = entries.length > 0
        ? {
          kind: 'range' as const,
          fromMs: Math.min(...entries.map(entry => entry.timestampMs)),
          toMs: Math.max(...entries.map(entry => entry.timestampMs)) + 1,
        }
        : { kind: 'none' as const };
      const updatedAt = entries.length > 0
        ? Math.max(...entries.map(entry => entry.timestampMs))
        : input.lastModifiedMs;
      return {
        checkpoint: { cursor: plan.source.version.token },
        entries,
        ...(plan.mode === 'rebuild' ? { rebuildCoverage } : {}),
        sessionProjection: {
          sourceId: plan.source.sourceId,
          provider: 'antigravity',
          updatedAt,
          byteSize: entries.length,
          payload: { sessionSnapshot: sessionSnapshot(calls) },
        },
      };
    },
  };
}
