import type { ActivityBreakdown } from '../../jsonlTypes';
import { emptyActivityBreakdown } from '../../jsonlTypes';
import { normalizeAntigravityModel } from './models';

export interface AntigravityUsageCall {
  cascadeId: string;
  executionId: string;
  stepIndices: number[];
  timestampMs: number;
  model: string;
  rawModel: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  thinkingTokens: number;
  responseTokens: number;
  toolNames: string[];
  contextMax?: number;
}

function int0(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
  return 0;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function callTimestampMs(gm: Record<string, unknown>, fallbackMs: number): number {
  const cm = (gm.chatModel || {}) as Record<string, unknown>;
  const csm = (cm.chatStartMetadata || {}) as Record<string, unknown>;
  for (const candidate of [csm.createdAt, csm.startTime, gm.createdAt, gm.timestamp]) {
    if (typeof candidate !== 'string') continue;
    const ts = new Date(candidate).getTime();
    if (Number.isFinite(ts)) return ts;
  }
  return fallbackMs;
}

function extractToolNames(cm: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const tools = cm.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool && typeof tool === 'object') {
        const name = stringValue((tool as Record<string, unknown>).name);
        if (name) names.add(name);
      }
    }
  }

  const messagePrompts = cm.messagePrompts;
  if (Array.isArray(messagePrompts)) {
    for (const prompt of messagePrompts) {
      if (!prompt || typeof prompt !== 'object') continue;
      const toolCalls = (prompt as Record<string, unknown>).toolCalls;
      if (!Array.isArray(toolCalls)) continue;
      for (const call of toolCalls) {
        if (!call || typeof call !== 'object') continue;
        const name = stringValue((call as Record<string, unknown>).name);
        if (name) names.add(name);
      }
    }
  }

  return [...names];
}

export function parseAntigravityGmEntry(
  cascadeId: string,
  gm: Record<string, unknown>,
  fallbackMs: number,
  labelMap?: Map<string, string>,
): AntigravityUsageCall | null {
  const cm = (gm.chatModel || {}) as Record<string, unknown>;
  const usage = (cm.usage || {}) as Record<string, unknown>;
  const csm = (cm.chatStartMetadata || {}) as Record<string, unknown>;
  const cwm = (csm.contextWindowMetadata || {}) as Record<string, unknown>;
  const plannerConfig = (gm.plannerConfig || {}) as Record<string, unknown>;

  const inputTokens = int0(usage.inputTokens);
  const explicitOutputTokens = int0(usage.outputTokens);
  const thinkingTokens = int0(usage.thinkingOutputTokens);
  const responseTokens = int0(usage.responseOutputTokens);
  const outputTokens = explicitOutputTokens > 0 ? explicitOutputTokens : thinkingTokens + responseTokens;
  const cacheReadTokens = int0(usage.cacheReadTokens);
  const cacheCreationTokens = int0(usage.cacheCreationTokens);
  if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens === 0) return null;

  const quotaModel = stringValue(usage.model) || stringValue(cm.model) || stringValue(gm.model);
  const responseModel = stringValue(cm.responseModel);
  const modelIdentity = quotaModel || responseModel || 'antigravity';
  const rawModel = [modelIdentity, responseModel]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(' ') || modelIdentity;
  const stepIndices = Array.isArray(gm.stepIndices)
    ? gm.stepIndices.filter((item): item is number => typeof item === 'number')
    : [];
  const timestampMs = callTimestampMs(gm, fallbackMs);
  const executionId = stringValue(gm.executionId)
    || `${cascadeId}:${stepIndices.join(',') || timestampMs}:${rawModel}`;

  return {
    cascadeId,
    executionId,
    stepIndices,
    timestampMs,
    model: normalizeAntigravityModel(modelIdentity, labelMap),
    rawModel,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    thinkingTokens,
    responseTokens,
    toolNames: extractToolNames(cm),
    contextMax: int0(plannerConfig.truncationThresholdTokens) || int0(cwm.maxTokens) || undefined,
  };
}

export function antigravityCallRequestId(call: AntigravityUsageCall): string {
  const stepKey = call.stepIndices.length > 0 ? call.stepIndices.join(',') : String(call.timestampMs);
  return `antigravity:${call.cascadeId}:${call.executionId}:${stepKey}`;
}

export function totalAntigravityCallTokens(call: AntigravityUsageCall): number {
  return call.inputTokens + call.outputTokens + call.cacheReadTokens + call.cacheCreationTokens;
}

export function antigravityCallKey(call: AntigravityUsageCall): string {
  if (call.executionId && call.stepIndices.length > 0) {
    return `exec:${call.executionId}|steps:${call.stepIndices.join(',')}`;
  }
  if (call.executionId) return `exec:${call.executionId}`;
  if (call.stepIndices.length > 0) return `steps:${call.stepIndices.join(',')}|model:${call.rawModel || call.model}`;
  return `time:${call.timestampMs}|model:${call.rawModel || call.model}`;
}

export function antigravityCallFingerprint(call: AntigravityUsageCall): string {
  return [
    call.timestampMs,
    call.model,
    call.rawModel,
    call.inputTokens,
    call.outputTokens,
    call.cacheCreationTokens,
    call.cacheReadTokens,
    call.thinkingTokens,
    call.responseTokens,
    call.contextMax ?? 0,
    call.toolNames.join(','),
  ].join('|');
}

export function shouldEnrichForTokens(params: {
  stepCount: number;
  rawGm: Record<string, unknown>[];
  calls: AntigravityUsageCall[];
}): boolean {
  if (params.rawGm.length === 0) return true;
  if (params.calls.length === 0 && params.stepCount > 0) return true;
  if (params.stepCount >= 350) return true;
  if (params.rawGm.some(gm => {
    const cm = (gm.chatModel || {}) as Record<string, unknown>;
    return !cm.responseModel;
  })) return true;
  return params.calls.some(call => totalAntigravityCallTokens(call) === 0);
}

export function parseAntigravityGmEntries(
  cascadeId: string,
  rawGm: Record<string, unknown>[],
  fallbackMs: number,
  labelMap?: Map<string, string>,
): AntigravityUsageCall[] {
  return rawGm
    .map(gm => parseAntigravityGmEntry(cascadeId, gm, fallbackMs, labelMap))
    .filter((call): call is AntigravityUsageCall => !!call)
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

export function mergeAntigravityCalls(
  primary: AntigravityUsageCall[],
  embedded: AntigravityUsageCall[],
): AntigravityUsageCall[] {
  const byKey = new Map<string, AntigravityUsageCall>();

  for (const call of primary) byKey.set(antigravityCallKey(call), call);

  for (const call of embedded) {
    const key = antigravityCallKey(call);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, call);
      continue;
    }
    if (totalAntigravityCallTokens(call) > totalAntigravityCallTokens(existing)) {
      byKey.set(key, { ...existing, ...call });
    }
  }

  return [...byKey.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

export function activityBreakdownFromCalls(calls: AntigravityUsageCall[]): ActivityBreakdown {
  const breakdown = emptyActivityBreakdown();

  for (const call of calls) {
    breakdown.thinking += call.thinkingTokens;
    breakdown.response += call.responseTokens > 0
      ? call.responseTokens
      : Math.max(0, call.outputTokens - call.thinkingTokens);
    for (const tool of call.toolNames) {
      const lower = tool.toLowerCase();
      if (lower.includes('grep') || lower.includes('search') || lower.includes('list')) breakdown.search += 1;
      else if (lower.includes('edit') || lower.includes('write') || lower.includes('code_action')) breakdown.editWrite += 1;
      else if (lower.includes('view') || lower.includes('read')) breakdown.read += 1;
      else if (lower.includes('command') || lower.includes('terminal')) breakdown.terminal += 1;
      else breakdown.terminal += 1;
    }
  }

  return breakdown;
}
