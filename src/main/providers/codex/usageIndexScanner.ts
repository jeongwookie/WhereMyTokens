import { codexFunctionCallCategory } from '../../activityClassifier';
import { isSafeLocalCwd } from '../../pathSafety';
import { projectKeysForCwd } from '../shared/repoContext';
import { cloneSessionSnapshot } from '../shared/sessionSnapshot';
import { scanJsonlLines } from '../shared/jsonlLineScanner';
import { extractCodexUsageLine, inferCodexModel, normalizeModel } from '../../jsonlUsageExtractor';
import {
  emptySessionSnapshot,
  type SessionSnapshot,
} from '../../jsonlTypes';
import { compositionToDelta, splitOutput } from '../../outputSplitter';
import type {
  UsageEntry,
  UsageSessionProjection,
  UsageSourceBatch,
  UsageSourceScanPlan,
  UsageSourceScanner,
} from '../../usageIndex';
import { codexQuotaEntries } from './quota';
import { codexUsageDecision, newCodexAccountingState, type CodexAccountingState } from './accounting';
import { beginFileScan, checkpointFingerprint, usageTimestamp } from '../shared/fileCheckpoint';
import { validUsageRevision } from '../../usageIndex/executionIdentity';
import {
  emptyToolActivity,
  emptyToolOutput,
  TOOL_ACTIVITY_KEYS,
  type ToolActivity,
  type ToolCategory,
} from '../../../shared/breakdownTypes';

interface CodexSessionPayload extends Record<string, unknown> {
  sessionSnapshot: SessionSnapshot;
}

export interface CodexUsageIndexScannerOptions {
  now?: () => number;
  onPayloadBytesRead?: (byteCount: number) => void;
  onValidationBytesRead?: (byteCount: number) => void;
  endOffsetExclusive?: number;
}

interface PendingTurn {
  responseChars: number;
  toolChars: Record<ToolCategory, number>;
  toolCounts: ToolActivity;
  toolNames: Record<string, number>;
}

function newPendingTurn(): PendingTurn {
  return {
    responseChars: 0,
    toolChars: emptyToolOutput(),
    toolCounts: emptyToolActivity(),
    toolNames: {},
  };
}

function restoredSnapshot(projection: UsageSessionProjection | null): SessionSnapshot {
  const candidate = projection?.payload.sessionSnapshot as SessionSnapshot | undefined;
  if (!candidate) return emptySessionSnapshot('events');
  if (typeof candidate.rawModel !== 'string'
    || typeof candidate.modelName !== 'string'
    || !candidate.toolCounts
    || !candidate.activityBreakdown) {
    throw new Error(`Invalid Codex session projection for ${projection?.sourceId ?? 'unknown source'}`);
  }
  return cloneSessionSnapshot(candidate);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseRateLimits(
  payload: Record<string, unknown>,
  observedAt: number,
  position: number,
): SessionSnapshot['codexRateLimits'] {
  const rateLimits = payload.rate_limits as Record<string, unknown> | undefined;
  if (!rateLimits) return undefined;
  const windows: Array<{ durationMs: number; usedPct: number; resetsAt: number | null }> = [];
  for (const key of ['primary', 'secondary'] as const) {
    const window = rateLimits[key] as Record<string, unknown> | undefined;
    if (!window) continue;
    const windowMinutes = asNumber(window.window_minutes);
    const durationMs = windowMinutes === 300
      ? 5 * 60 * 60 * 1000
      : windowMinutes === 10_080
        ? 7 * 24 * 60 * 60 * 1000
        : null;
    if (durationMs == null) continue;
    const resetSeconds = asNumber(window.resets_at);
    windows.push({
      durationMs,
      usedPct: Math.max(0, Math.min(100, asNumber(window.used_percent))),
      resetsAt: resetSeconds > 0 ? resetSeconds * 1000 : null,
    });
  }
  return windows.length > 0
    ? { capturedAt: observedAt, position, sourceId: '', entries: codexQuotaEntries({ windows, plan: '', credits: null }) }
    : undefined;
}

function timestampMs(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assistantResponseChars(payload: Record<string, unknown>): number {
  if (payload.type !== 'message' || payload.role !== 'assistant' || !Array.isArray(payload.content)) return 0;
  let chars = 0;
  for (const block of payload.content) {
    const item = block as Record<string, unknown>;
    if ((item.type === 'output_text' || item.type === 'text') && typeof item.text === 'string') {
      chars += item.text.length;
    }
  }
  return chars;
}

export function createCodexUsageIndexScanner(
  filePath: string,
  options: CodexUsageIndexScannerOptions = {},
): UsageSourceScanner {
  return {
    async scan(plan: UsageSourceScanPlan): Promise<UsageSourceBatch> {
      if (plan.source.provider !== 'codex' || plan.source.kind !== 'file') {
        throw new Error('Codex scanner received an incompatible source');
      }
      const now = options.now?.() ?? Date.now();
      // Reject obsolete accounting state as a whole; replay only establishes context
      // through the retained checkpoint, it never recharges protected history.
      let checkpoint = plan.checkpoint;
      if (checkpoint?.resumeState) {
        try {
          if (JSON.parse(checkpoint.resumeState)?.accounting?.version !== 4) checkpoint = { ...checkpoint, resumeState: undefined };
        } catch { checkpoint = { ...checkpoint, resumeState: undefined }; }
      }
      const start = beginFileScan(filePath, { ...plan, checkpoint }, now, options.endOffsetExclusive, options.onValidationBytesRead);
      const resume = start.resume;
      const accounting: CodexAccountingState = resume?.accounting?.version === 4
        ? resume.accounting : newCodexAccountingState(start.generation);
      accounting.generation = start.generation;
      const snapshot = resume?.snapshot ? cloneSessionSnapshot(resume.snapshot) : restoredSnapshot(plan.previousSessionProjection);
      let rawModel = plan.checkpoint?.rawModel ?? snapshot.rawModel;
      let pending: PendingTurn = resume?.pending ?? newPendingTurn();
      let lastValidTimestampMs = Number(resume?.lastValidTimestampMs) || 0;
      let checkpointOffset = start.startOffset;
      let lastUsageTimestamp = plan.previousSessionProjection?.updatedAt ?? 0;
      let discoveredProjectKeys: string[] | undefined;
      const entries = new Map<string, UsageEntry>();
      const identitySeeds: NonNullable<UsageSourceBatch['identitySeeds']>[number][] = [];
      const identityLinks: NonNullable<UsageSourceBatch['identityLinks']>[number][] = [];
      const localIdentities = new Set<string>();
      const identitySource = (key: string): string | undefined => localIdentities.has(key) ? plan.source.sourceId : plan.identitySource?.(key);

      await scanJsonlLines(filePath, start.startOffset, options.onPayloadBytesRead, (line, offsetAfterLine) => {
        checkpointOffset = offsetAfterLine;
        let object: Record<string, unknown>;
        try { object = JSON.parse(line); } catch { return; }
        const payload = object.payload as Record<string, unknown> | undefined;
        if (!payload) return;
        const parsedTime = typeof object.timestamp === 'string' ? Date.parse(object.timestamp) : NaN;
        if (Number.isFinite(parsedTime) && parsedTime >= 0) lastValidTimestampMs = parsedTime;
        const isPrefix = offsetAfterLine <= start.accountedOffset;
        const physicalId = 'codex:position:' + plan.source.sourceId + ':' + start.generation + ':' + offsetAfterLine;
        const decision = codexUsageDecision(accounting, object, plan.source.sourceId, physicalId,
          isPrefix ? undefined : identitySource);
        if (object.type === 'event_msg' && payload.type === 'task_started') pending = newPendingTurn();
        const observedAt = usageTimestamp(object.timestamp, lastValidTimestampMs, accounting.createdMs, start.fallbackTimestampMs);
        const rateLimits = parseRateLimits(payload, observedAt, offsetAfterLine);
        if (rateLimits && (!snapshot.codexRateLimits || rateLimits.capturedAt > snapshot.codexRateLimits.capturedAt
          || rateLimits.capturedAt === snapshot.codexRateLimits.capturedAt && rateLimits.position >= snapshot.codexRateLimits.position)) {
          snapshot.codexRateLimits = rateLimits;
        }
        if (typeof payload.cwd === 'string' && isSafeLocalCwd(payload.cwd)) discoveredProjectKeys = projectKeysForCwd(payload.cwd);
        if (object.type === 'session_meta' || object.type === 'turn_context'
          || object.type === 'event_msg' && payload.type === 'task_started') {
          rawModel = inferCodexModel(payload) || rawModel;
          return;
        }
        if (object.type === 'response_item') {
          if (accounting.inherited) return;
          if ((payload.type === 'function_call' || payload.type === 'custom_tool_call') && typeof payload.name === 'string') {
            const category = codexFunctionCallCategory(payload.name, payload.arguments);
            pending.toolChars[category] += String(payload.arguments ?? '').length + payload.name.length;
            pending.toolCounts[category] += 1;
            if (Object.keys(pending.toolNames).length < 128 || payload.name in pending.toolNames) {
              pending.toolNames[payload.name] = (pending.toolNames[payload.name] ?? 0) + 1;
            }
          } else pending.responseChars += assistantResponseChars(payload);
          return;
        }
        if (!decision) return;
        if (decision.kind === 'alias') {
          for (const alias of new Set([decision.observationKey, decision.responseKey].filter((key): key is string => !!key && key !== decision.identityKey))) {
            identityLinks.push({ alias, target: decision.identityKey });
            if (identitySource(decision.identityKey)) localIdentities.add(alias);
          }
          return;
        }
        if (isPrefix) {
          for (const key of [decision.identityKey, decision.observationKey, decision.responseKey].filter((key): key is string => !!key)) {
            identitySeeds.push({ key, requestId: decision.requestId, timestampMs: observedAt });
            localIdentities.add(key);
          }
          pending = newPendingTurn();
          return;
        }
        const extracted = extractCodexUsageLine(physicalId, line, observedAt, rawModel, decision.usage);
        if (!extracted) return;
        rawModel = extracted.rawModel;
        const breakdown = compositionToDelta(splitOutput({ thinkingChars: 0,
          responseChars: pending.responseChars, toolChars: pending.toolChars,
        }, extracted.entry.outputTokens, extracted.reasoningOutputTokens));
        for (const key of TOOL_ACTIVITY_KEYS) breakdown[key] = pending.toolCounts[key];
        const entry: UsageEntry = { ...extracted.entry, provider: 'codex', requestId: decision.requestId,
          identityKey: decision.identityKey, identityOrigin: decision.identityOrigin,
          identityAliases: [decision.observationKey, decision.responseKey].filter((key): key is string => !!key), breakdown };
        const previous = entries.get(entry.requestId);
        if (previous) {
          if (!validUsageRevision(entry, previous, { sourceId: plan.source.sourceId, requestId: previous.requestId,
            timestampMs: previous.timestampMs, originId: previous.identityOrigin ?? '', fingerprint: '' })) return;
          entry.timestampMs = previous.timestampMs;
        }
        entries.set(entry.requestId, entry);
        for (const key of [entry.identityKey, ...(entry.identityAliases ?? [])]) if (key) localIdentities.add(key);
        snapshot.rawModel = rawModel;
        snapshot.modelName = normalizeModel(rawModel);
        snapshot.latestInputTokens = entry.inputTokens;
        snapshot.latestCacheCreationTokens = entry.cacheCreationTokens;
        snapshot.latestCacheReadTokens = entry.cacheReadTokens;
        if (extracted.contextMax) snapshot.contextMax = extracted.contextMax;
        for (const [name, count] of Object.entries(pending.toolNames)) {
          if (Object.keys(snapshot.toolCounts).length < 128 || name in snapshot.toolCounts) {
            snapshot.toolCounts[name] = (snapshot.toolCounts[name] ?? 0) + count;
          }
        }
        for (const key of TOOL_ACTIVITY_KEYS) snapshot.activityBreakdown[key] += pending.toolCounts[key];
        pending = newPendingTurn();
        lastUsageTimestamp = Math.max(lastUsageTimestamp, entry.timestampMs);
      }, start.endOffset);

      return {
        checkpoint: { byteOffset: checkpointOffset,
          fingerprint: checkpointFingerprint(filePath, checkpointOffset, options.onValidationBytesRead),
          generation: start.generation, fallbackTimestampMs: start.fallbackTimestampMs,
          resumeState: JSON.stringify({ version: 2, accounting, snapshot, pending, lastValidTimestampMs }),
          ...(rawModel ? { rawModel } : {}) },
        entries: [...entries.values()], identitySeeds, identityLinks,
        ...(start.rebased ? { rebased: true } : {}),
        ...(plan.mode === 'rebuild' ? { rebuildCoverage: { kind: 'full' as const } } : {}),
        ...(discoveredProjectKeys ? { projectKeys: discoveredProjectKeys } : {}),
        sessionProjection: { sourceId: plan.source.sourceId, provider: 'codex',
          updatedAt: lastUsageTimestamp || start.fallbackTimestampMs,
          byteSize: plan.source.version.size ?? checkpointOffset, payload: { sessionSnapshot: snapshot } },
      };
    },
  };
}
