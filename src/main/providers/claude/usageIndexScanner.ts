import { isSafeLocalCwd } from '../../pathSafety';
import { projectKeysForCwd } from '../shared/repoContext';
import { cloneSessionSnapshot } from '../shared/sessionSnapshot';
import { scanJsonlLines } from '../shared/jsonlLineScanner';
import {
  claudeBlockBreakdown,
  claudeLedgerBreakdown,
} from '../../activityClassifier';
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

interface AppliedClaudeRequest {
  requestId: string;
  toolNames: Record<string, number>;
  activityBreakdown: Partial<Record<keyof ActivityBreakdown, number>>;
}

interface ClaudeSessionPayload extends Record<string, unknown> {
  sessionSnapshot: SessionSnapshot;
  lastAppliedRequest?: AppliedClaudeRequest;
}

interface ClaudeCandidate {
  sequence: number;
  rawModel: string;
  entry: UsageEntry;
  toolNames: Record<string, number>;
  activityBreakdown: Partial<Record<keyof ActivityBreakdown, number>>;
}

export interface ClaudeUsageIndexScannerOptions {
  now?: () => number;
  onPayloadBytesRead?: (byteCount: number) => void;
  baseProjectKeys?: readonly string[];
}

function restoredPayload(projection: UsageSessionProjection | null): ClaudeSessionPayload {
  const payload = projection?.payload as ClaudeSessionPayload | undefined;
  const snapshot = payload?.sessionSnapshot;
  if (!snapshot) return { sessionSnapshot: emptySessionSnapshot('tokens') };
  if (typeof snapshot.rawModel !== 'string'
    || typeof snapshot.modelName !== 'string'
    || !snapshot.toolCounts
    || !snapshot.activityBreakdown) {
    throw new Error(`Invalid Claude session projection for ${projection?.sourceId ?? 'unknown source'}`);
  }
  return {
    sessionSnapshot: cloneSessionSnapshot(snapshot),
    ...(payload.lastAppliedRequest
      ? {
        lastAppliedRequest: {
          requestId: payload.lastAppliedRequest.requestId,
          toolNames: { ...payload.lastAppliedRequest.toolNames },
          activityBreakdown: { ...payload.lastAppliedRequest.activityBreakdown },
        },
      }
      : {}),
  };
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
      const startOffset = plan.checkpoint?.byteOffset ?? 0;
      const payload = plan.mode === 'tail'
        ? restoredPayload(plan.previousSessionProjection)
        : { sessionSnapshot: emptySessionSnapshot('tokens') };
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
        const extracted = extractClaudeUsageLine(line, now);
        if (!extracted) return;
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
          provider: 'claude',
          ...(breakdown ? { breakdown } : {}),
        };
        const candidate: ClaudeCandidate = {
          sequence: sequence++,
          rawModel: extracted.rawModel,
          entry,
          toolNames: toolNames(content),
          activityBreakdown,
        };
        const current = candidates.get(entry.requestId);
        if (!current || candidate.entry.outputTokens > current.entry.outputTokens) {
          candidates.set(entry.requestId, candidate);
        }
      });

      const ordered = [...candidates.values()].sort((left, right) => left.sequence - right.sequence);
      const entries = ordered.map(candidate => candidate.entry);
      for (const candidate of ordered) {
        if (payload.lastAppliedRequest?.requestId === candidate.entry.requestId) {
          applyRequest(payload.sessionSnapshot, payload.lastAppliedRequest, -1);
        }
        const applied: AppliedClaudeRequest = {
          requestId: candidate.entry.requestId,
          toolNames: candidate.toolNames,
          activityBreakdown: candidate.activityBreakdown,
        };
        applyRequest(payload.sessionSnapshot, applied, 1);
        payload.lastAppliedRequest = applied;
        payload.sessionSnapshot.rawModel = candidate.rawModel;
        payload.sessionSnapshot.modelName = normalizeModel(candidate.rawModel);
        payload.sessionSnapshot.latestInputTokens = candidate.entry.inputTokens;
        payload.sessionSnapshot.latestCacheCreationTokens = candidate.entry.cacheCreationTokens;
        payload.sessionSnapshot.latestCacheReadTokens = candidate.entry.cacheReadTokens;
        lastUsageTimestamp = Math.max(lastUsageTimestamp, candidate.entry.timestampMs);
      }

      return {
        checkpoint: {
          byteOffset: checkpointOffset,
          ...(payload.sessionSnapshot.rawModel ? { rawModel: payload.sessionSnapshot.rawModel } : {}),
        },
        entries,
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
