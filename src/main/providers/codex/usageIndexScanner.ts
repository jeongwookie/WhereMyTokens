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
        throw new Error(`Codex scanner cannot scan ${plan.source.provider}:${plan.source.kind}`);
      }

      const now = options.now?.() ?? Date.now();
      const startOffset = plan.checkpoint?.byteOffset ?? 0;
      const snapshot = plan.mode === 'tail'
        ? restoredSnapshot(plan.previousSessionProjection)
        : emptySessionSnapshot('events');
      let rawModel = plan.checkpoint?.rawModel ?? snapshot.rawModel;
      let pending = newPendingTurn();
      let checkpointOffset = startOffset;
      let lastUsageTimestamp = plan.previousSessionProjection?.updatedAt ?? 0;
      let discoveredProjectKeys: string[] | undefined;
      const entries = new Map<string, UsageEntry>();

      await scanJsonlLines(filePath, startOffset, options.onPayloadBytesRead, (line, offsetAfterLine) => {
        let object: Record<string, unknown>;
        try {
          object = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        const payload = object.payload as Record<string, unknown> | undefined;
        if (!payload) return;

        if (typeof payload.cwd === 'string' && isSafeLocalCwd(payload.cwd)) {
          discoveredProjectKeys = projectKeysForCwd(payload.cwd);
        }

        if (object.type === 'session_meta'
          || object.type === 'turn_context'
          || (object.type === 'event_msg' && payload.type === 'task_started')) {
          const model = inferCodexModel(payload);
          if (model) rawModel = model;
          return;
        }

        if (object.type === 'response_item' && payload.type === 'function_call' && typeof payload.name === 'string') {
          const category = codexFunctionCallCategory(payload.name, payload.arguments);
          const argumentChars = String(payload.arguments ?? '').length + payload.name.length;
          pending.toolChars[category] += argumentChars;
          pending.toolCounts[category] += 1;
          pending.toolNames[payload.name] = (pending.toolNames[payload.name] ?? 0) + 1;
          return;
        }

        if (object.type === 'response_item') {
          pending.responseChars += assistantResponseChars(payload);
          return;
        }

        const extracted = extractCodexUsageLine(plan.source.sourceId, line, now, rawModel);
        if (!extracted || extracted.entry.provider !== 'codex') return;
        if (entries.has(extracted.entry.requestId)) {
          checkpointOffset = offsetAfterLine;
          return;
        }
        rawModel = extracted.rawModel || rawModel;
        const breakdown = compositionToDelta(splitOutput({
          thinkingChars: 0,
          responseChars: pending.responseChars,
          toolChars: pending.toolChars,
        }, extracted.entry.outputTokens, extracted.reasoningOutputTokens));
        for (const key of TOOL_ACTIVITY_KEYS) breakdown[key] = pending.toolCounts[key];

        entries.set(extracted.entry.requestId, {
          ...extracted.entry,
          provider: 'codex',
          breakdown,
        });
        snapshot.rawModel = rawModel;
        snapshot.modelName = normalizeModel(rawModel);
        snapshot.latestInputTokens = extracted.entry.inputTokens;
        snapshot.latestCacheCreationTokens = 0;
        snapshot.latestCacheReadTokens = extracted.entry.cacheReadTokens;
        if ((extracted.contextMax ?? 0) > 0) snapshot.contextMax = extracted.contextMax;
        const observedAt = timestampMs(object.timestamp, now);
        const nextRateLimits = parseRateLimits(payload, observedAt, offsetAfterLine);
        if (nextRateLimits && (!snapshot.codexRateLimits
          || nextRateLimits.capturedAt > snapshot.codexRateLimits.capturedAt
          || (nextRateLimits.capturedAt === snapshot.codexRateLimits.capturedAt
            && nextRateLimits.position >= snapshot.codexRateLimits.position))) {
          snapshot.codexRateLimits = nextRateLimits;
        }
        for (const [name, count] of Object.entries(pending.toolNames)) {
          snapshot.toolCounts[name] = (snapshot.toolCounts[name] ?? 0) + count;
        }
        for (const key of TOOL_ACTIVITY_KEYS) {
          snapshot.activityBreakdown[key] += pending.toolCounts[key];
        }
        pending = newPendingTurn();
        checkpointOffset = offsetAfterLine;
        lastUsageTimestamp = Math.max(lastUsageTimestamp, extracted.entry.timestampMs);
      });

      const sessionPayload: CodexSessionPayload = { sessionSnapshot: snapshot };
      return {
        checkpoint: {
          byteOffset: checkpointOffset,
          ...(rawModel ? { rawModel } : {}),
        },
        entries: [...entries.values()],
        ...(plan.mode === 'rebuild'
          ? { projectKeys: discoveredProjectKeys ?? [] }
          : discoveredProjectKeys
            ? { projectKeys: discoveredProjectKeys }
            : {}),
        ...(plan.mode === 'rebuild' ? { rebuildCoverage: { kind: 'full' as const } } : {}),
        sessionProjection: entries.size > 0 || plan.previousSessionProjection
          ? {
            sourceId: plan.source.sourceId,
            provider: 'codex',
            updatedAt: lastUsageTimestamp || now,
            byteSize: plan.source.version.size ?? checkpointOffset,
            payload: sessionPayload,
          }
          : null,
      };
    },
  };
}
