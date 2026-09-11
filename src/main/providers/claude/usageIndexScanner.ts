import { isSafeLocalCwd } from '../../pathSafety';
import { projectKeysForCwd } from '../shared/repoContext';
import { cloneSessionSnapshot } from '../shared/sessionSnapshot';
import { scanJsonlLines } from '../shared/jsonlLineScanner';
import { beginFileScan, checkpointFingerprint, usageTimestamp } from '../shared/fileCheckpoint';
import { estimateUsageCost } from '../../modelPricing';
import {
  claudeBlockBreakdown,
  claudeBlockWeights,
  claudeLedgerBreakdown,
} from '../../activityClassifier';
import { compositionToDelta, splitOutput, type OutputWeights } from '../../outputSplitter';
import { TOOL_CATEGORY_KEYS, TOOL_OUTPUT_ROW_KEY_BY_CATEGORY, emptyToolOutput } from '../../../shared/breakdownTypes';
import { extractClaudeUsageLine, normalizeModel } from '../../jsonlUsageExtractor';
import {
  emptySessionSnapshot,
  type ActivityBreakdown,
  type SessionSnapshot,
} from '../../jsonlTypes';
import type {
  UsageEntry,
  UsageSessionProjection,
  UsageSourceBatch,
  UsageSourceScanPlan,
  UsageSourceScanner,
} from '../../usageIndex';

export const CLAUDE_RECENT_REQUESTS = 128;
const MAX_REQUEST_BLOCKS = 256;

interface AppliedClaudeRequest {
  model: string;
  usage: [number, number, number, number];
  requestId: string;
  toolNames: Record<string, number>;
  activityBreakdown: Partial<Record<keyof ActivityBreakdown, number>>;
  blocks: Record<string, { weights: OutputWeights; toolNames: Record<string, number>; counts: Record<string, number> }>;
  originId?: string;
  timestampMs: number;
}

interface ClaudeSessionPayload extends Record<string, unknown> {
  sessionSnapshot: SessionSnapshot;
  appliedRequests: Record<string, AppliedClaudeRequest & { outputTokens: number }>;
  accountingIssues: string[];
}

interface ClaudeCandidate {
  sequence: number;
  rawModel: string;
  entry: UsageEntry;
  toolNames: Record<string, number>;
  activityBreakdown: Partial<Record<keyof ActivityBreakdown, number>>;
  blocks: AppliedClaudeRequest['blocks'];
  originId?: string;
}

export interface ClaudeUsageIndexScannerOptions {
  now?: () => number;
  onPayloadBytesRead?: (byteCount: number) => void;
  onValidationBytesRead?: (byteCount: number) => void;
  baseProjectKeys?: readonly string[];
  endOffsetExclusive?: number;
}

function toolNames(content: unknown[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const block of content) {
    const item = block as Record<string, unknown>;
    if (item.type === 'tool_use' && typeof item.name === 'string') {
      result[item.name] = (result[item.name] ?? 0) + 1;
    }
  }
  return result;
}

function applyRequest(snapshot: SessionSnapshot, request: AppliedClaudeRequest, sign: 1 | -1): void {
  for (const [name, count] of Object.entries(request.toolNames)) {
    snapshot.toolCounts[name] = Math.max(0, (snapshot.toolCounts[name] ?? 0) + sign * count);
    if (snapshot.toolCounts[name] === 0) delete snapshot.toolCounts[name];
  }
  for (const [key, value] of Object.entries(request.activityBreakdown)) {
    const field = key as keyof ActivityBreakdown;
    snapshot.activityBreakdown[field] = Math.max(0, snapshot.activityBreakdown[field] + sign * (value ?? 0));
  }
}

export function createClaudeUsageIndexScanner(
  filePath: string,
  options: ClaudeUsageIndexScannerOptions = {},
): UsageSourceScanner {
  return {
    async scan(plan: UsageSourceScanPlan): Promise<UsageSourceBatch> {
      if (plan.source.provider !== 'claude' || plan.source.kind !== 'file') {
        throw new Error(`Claude scanner cannot scan ${plan.source.provider}:${plan.source.kind}`);
      }

      const now = options.now?.() ?? Date.now();
      const start = beginFileScan(filePath, plan, now, options.endOffsetExclusive, options.onValidationBytesRead);
      const accountedOffset = start.accountedOffset;
      const startOffset = start.startOffset;
      const resume = start.resume;
      const oldSnapshot = plan.previousSessionProjection?.payload.sessionSnapshot as SessionSnapshot | undefined;
      const payload: ClaudeSessionPayload = resume?.payload ?? {
        sessionSnapshot: oldSnapshot ? cloneSessionSnapshot(oldSnapshot) : emptySessionSnapshot('tokens'),
        appliedRequests: {}, accountingIssues: [],
      };
      let lastValidTimestampMs = Number(resume?.lastValidTimestampMs) || 0;
      const prefixIds = new Set<string>();
      const issues = payload.accountingIssues;
      const candidates = new Map<string, ClaudeCandidate>();
      const projectKeys = new Set(options.baseProjectKeys ?? []);
      let discoveredCwd = false;
      let sequence = 0;
      let checkpointOffset = startOffset;
      let lastUsageTimestamp = plan.previousSessionProjection?.updatedAt ?? 0;

      await scanJsonlLines(filePath, startOffset, options.onPayloadBytesRead, (line, offsetAfterLine) => {
        checkpointOffset = offsetAfterLine;
        let object: Record<string, unknown>;
        try {
          object = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (typeof object.cwd === 'string' && isSafeLocalCwd(object.cwd)) {
          discoveredCwd = true;
          for (const key of projectKeysForCwd(object.cwd)) projectKeys.add(key);
        }
        const parsedTime = typeof object.timestamp === 'string' ? Date.parse(object.timestamp) : NaN;
        if (Number.isFinite(parsedTime) && parsedTime >= 0) lastValidTimestampMs = parsedTime;
        const observedAt = usageTimestamp(object.timestamp, lastValidTimestampMs, 0, start.fallbackTimestampMs);
        const physicalId = 'claude:position:' + plan.source.sourceId + ':' + start.generation + ':' + offsetAfterLine;
        const extracted = extractClaudeUsageLine(line, observedAt, physicalId);
        if (!extracted) {
          const msg = object.message as Record<string, unknown> | undefined;
          if (object.type === 'assistant' && (msg?.usage || object.usage)) issues.push('usage-identity-or-model-unresolved');
          return;
        }
        const message = object.message as Record<string, unknown> | undefined;
        const content = Array.isArray(message?.content) ? message.content : [];
        let breakdown: UsageEntry['breakdown'];
        try {
          breakdown = claudeLedgerBreakdown(content, extracted.entry.outputTokens);
        } catch {
          breakdown = undefined;
        }
        let activityBreakdown: Partial<Record<keyof ActivityBreakdown, number>> = {};
        try {
          activityBreakdown = claudeBlockBreakdown(content, extracted.entry.outputTokens);
        } catch {
          activityBreakdown = {};
        }
        const entry: UsageEntry = {
          ...extracted.entry,
          identityKey: `claude:message:${extracted.entry.requestId}`,
          identityOrigin: typeof object.uuid === 'string' ? object.uuid : undefined,
          provider: 'claude',
          ...(breakdown ? { breakdown } : {}),
        };
        const current = candidates.get(entry.requestId);
        const previous = payload.appliedRequests[entry.requestId];
        const currentUsage: [number, number, number, number] = [entry.inputTokens, entry.outputTokens, entry.cacheCreationTokens, entry.cacheReadTokens];
        const previousUsage = current ? [current.entry.inputTokens, current.entry.outputTokens, current.entry.cacheCreationTokens, current.entry.cacheReadTokens] : previous?.usage;
        const previousModel = current?.entry.model ?? previous?.model;
        if (previousUsage && (previousModel !== entry.model || currentUsage.some((n, i) => n < previousUsage[i]!))) {
          issues.push('identity-conflict'); return;
        }
        const previousOutput = current?.entry.outputTokens ?? previous?.outputTokens ?? -1;
        if (entry.outputTokens < previousOutput) return;
        entry.timestampMs = current?.entry.timestampMs ?? previous?.timestampMs ?? entry.timestampMs;
        const cost = estimateUsageCost({ model: extracted.rawModel, timestampMs: entry.timestampMs,
          inputTokens: entry.inputTokens, outputTokens: entry.outputTokens,
          cacheReadTokens: entry.cacheReadTokens, cacheCreationTokens: entry.cacheCreationTokens });
        entry.costUSD = cost.costUSD; entry.cacheSavingsUSD = cost.cacheSavingsUSD;
        const blocks = entry.outputTokens > previousOutput ? {} : structuredClone(current?.blocks ?? previous?.blocks ?? {});
        try {
          for (const [index, raw] of content.slice(0, MAX_REQUEST_BLOCKS).entries()) {
            const block = raw as Record<string, unknown>;
            const id = typeof block.id === 'string' ? `tool:${block.id}` : `${object.uuid ?? entry.requestId}:${index}`;
            const counts = claudeLedgerBreakdown([block], 0);
            blocks[id] = { weights: claudeBlockWeights([block]), toolNames: toolNames([block]),
              counts: Object.fromEntries(TOOL_CATEGORY_KEYS.map(k => [k, counts[k]])) };
          }
          for (const key of Object.keys(blocks).slice(MAX_REQUEST_BLOCKS)) delete blocks[key];
          const weights: OutputWeights = { thinkingChars: 0, responseChars: 0, toolChars: emptyToolOutput() };
          const names: Record<string, number> = {};
          for (const block of Object.values(blocks)) {
            weights.thinkingChars += block.weights.thinkingChars; weights.responseChars += block.weights.responseChars;
            for (const k of TOOL_CATEGORY_KEYS) weights.toolChars[k] += block.weights.toolChars[k];
            for (const [name, count] of Object.entries(block.toolNames)) names[name] = (names[name] ?? 0) + count;
          }
          const combined = compositionToDelta(splitOutput(weights, entry.outputTokens));
          for (const block of Object.values(blocks)) for (const k of TOOL_CATEGORY_KEYS) combined[k] += block.counts[k] ?? 0;
          entry.breakdown = combined;
          activityBreakdown = { thinking: combined.thinking, response: combined.response,
            ...Object.fromEntries(TOOL_CATEGORY_KEYS.map(k => [k, combined[TOOL_OUTPUT_ROW_KEY_BY_CATEGORY[k]]])) };
        } catch { issues.push('composition-unresolved'); }
        const originId = current?.originId ?? previous?.originId ?? (typeof object.uuid === 'string' ? object.uuid : undefined);
        entry.identityOrigin = originId;
        if (current && current.entry.outputTokens === entry.outputTokens) {
          entry.timestampMs = current.entry.timestampMs;
        }
        const candidate: ClaudeCandidate = {
          sequence: sequence++,
          rawModel: extracted.rawModel,
          entry,
          toolNames: toolNames(content),
          activityBreakdown,
          blocks,
          originId,
        };
        candidate.toolNames = {};
        for (const block of Object.values(blocks)) for (const [name, count] of Object.entries(block.toolNames)) candidate.toolNames[name] = (candidate.toolNames[name] ?? 0) + count;
        if (!current || candidate.entry.outputTokens >= current.entry.outputTokens) {
          candidates.set(entry.requestId, candidate);
          if (offsetAfterLine <= accountedOffset) prefixIds.add(entry.requestId);
          else prefixIds.delete(entry.requestId);
        }
      }, start.endOffset);

      const ordered = [...candidates.values()].sort((left, right) => left.sequence - right.sequence);
      const entries: UsageEntry[] = [];
      const identitySeeds: NonNullable<UsageSourceBatch['identitySeeds']>[number][] = [];
      for (const candidate of ordered) {
        const previous = payload.appliedRequests[candidate.entry.requestId];
        if (previous && candidate.entry.outputTokens < previous.outputTokens) continue;
        const preserveOldProjection = prefixIds.has(candidate.entry.requestId) && !!oldSnapshot && !resume;
        if (previous && !preserveOldProjection) applyRequest(payload.sessionSnapshot, previous, -1);
        const applied: AppliedClaudeRequest = {
          model: candidate.entry.model,
          usage: [candidate.entry.inputTokens, candidate.entry.outputTokens, candidate.entry.cacheCreationTokens, candidate.entry.cacheReadTokens],
          requestId: candidate.entry.requestId,
          toolNames: candidate.toolNames,
          activityBreakdown: candidate.activityBreakdown,
          blocks: candidate.blocks,
          originId: candidate.originId,
          timestampMs: candidate.entry.timestampMs,
        };
        if (!preserveOldProjection) applyRequest(payload.sessionSnapshot, applied, 1);
        payload.appliedRequests[candidate.entry.requestId] = { ...applied, outputTokens: candidate.entry.outputTokens };
        if (prefixIds.has(candidate.entry.requestId)) identitySeeds.push({ key: candidate.entry.identityKey!, requestId: candidate.entry.requestId, timestampMs: candidate.entry.timestampMs });
        else entries.push(candidate.entry);
        payload.sessionSnapshot.rawModel = candidate.rawModel;
        payload.sessionSnapshot.modelName = normalizeModel(candidate.rawModel);
        payload.sessionSnapshot.latestInputTokens = candidate.entry.inputTokens;
        payload.sessionSnapshot.latestCacheCreationTokens = candidate.entry.cacheCreationTokens;
        payload.sessionSnapshot.latestCacheReadTokens = candidate.entry.cacheReadTokens;
        lastUsageTimestamp = Math.max(lastUsageTimestamp, candidate.entry.timestampMs);
      }

      const retainedIds = Object.keys(payload.appliedRequests);
      for (const id of retainedIds.slice(0, Math.max(0, retainedIds.length - CLAUDE_RECENT_REQUESTS))) delete payload.appliedRequests[id];
      payload.accountingIssues = [...new Set(issues)].slice(0, 16);
      return {
        ...(start.rebased ? { rebased: true } : {}),
        checkpoint: {
          byteOffset: checkpointOffset,
          fingerprint: checkpointFingerprint(filePath, checkpointOffset, options.onValidationBytesRead),
          generation: start.generation, fallbackTimestampMs: start.fallbackTimestampMs,
          resumeState: JSON.stringify({ version: 2, payload, lastValidTimestampMs }),
          ...(payload.sessionSnapshot.rawModel ? { rawModel: payload.sessionSnapshot.rawModel } : {}),
        },
        entries,
        identitySeeds,
        providerMetadata: { accountingIssues: [...new Set(issues)] },
        ...(plan.mode === 'rebuild' || discoveredCwd ? { projectKeys: [...projectKeys] } : {}),
        ...(plan.mode === 'rebuild' ? { rebuildCoverage: { kind: 'full' as const } } : {}),
        sessionProjection: entries.length > 0 || plan.previousSessionProjection
          ? {
            sourceId: plan.source.sourceId,
            provider: 'claude',
            updatedAt: lastUsageTimestamp || now,
            byteSize: plan.source.version.size ?? checkpointOffset,
            payload,
          }
          : null,
      };
    },
  };
}
