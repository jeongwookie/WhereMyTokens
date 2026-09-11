import type { ActivityBreakdown } from '../../jsonlTypes';
import { emptyActivityBreakdown } from '../../jsonlTypes';
import type { ToolCategory } from '../../../shared/breakdownTypes';
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
    if (Number.isFinite(ts) && ts >= 0) return ts;
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
  observationIndex = 0,
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
    ? [...new Set(gm.stepIndices.filter((item): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0))].sort((a, b) => a - b)
    : [observationIndex];
  const timestampMs = callTimestampMs(gm, fallbackMs);
  const executionId = stringValue(gm.executionId) || 'row:' + observationIndex;

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
  const stepKey = [...new Set(call.stepIndices)].sort((a, b) => a - b).join(',');
  return `antigravity:${call.cascadeId}:${call.executionId}:${stepKey}`;
}

export function totalAntigravityCallTokens(call: AntigravityUsageCall): number {
  return call.inputTokens + call.outputTokens + call.cacheReadTokens + call.cacheCreationTokens;
}

export function antigravityCallKey(call: AntigravityUsageCall): string {
  return antigravityCallRequestId(call);
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
  rawGm: unknown[];
  calls: AntigravityUsageCall[];
}): boolean {
  if (params.rawGm.length === 0) return true;
  if (params.calls.length === 0 && params.stepCount > 0) return true;
  if (params.stepCount >= 350) return true;
  if (params.rawGm.some(gm => {
    if (!gm || typeof gm !== 'object' || Array.isArray(gm)) return true;
    const cm = ((gm as Record<string, unknown>).chatModel || {}) as Record<string, unknown>;
    return !cm.responseModel;
  })) return true;
  return params.calls.some(call => totalAntigravityCallTokens(call) === 0);
}

export function parseAntigravityGmEntries(
  cascadeId: string,
  rawGm: unknown[],
  fallbackMs: number,
  labelMap?: Map<string, string>,
): AntigravityUsageCall[] {
  let precedingTimestampMs = fallbackMs;
  const parsed = rawGm
    .map((gm, index) => {
      if (!gm || typeof gm !== 'object' || Array.isArray(gm)) return null;
      const call = parseAntigravityGmEntry(cascadeId, gm as Record<string, unknown>, precedingTimestampMs, labelMap, index);
      if (call) precedingTimestampMs = call.timestampMs;
      return call;
    })
    .filter((call): call is AntigravityUsageCall => !!call)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  return mergeAntigravityCalls([], parsed);
}

export function mergeAntigravityCalls(
  primary: AntigravityUsageCall[],
  embedded: AntigravityUsageCall[],
): AntigravityUsageCall[] {
  const byKey = new Map<string, AntigravityUsageCall>();

  for (const call of [...primary, ...embedded]) {
    const key = antigravityCallKey(call);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, call);
      continue;
    }
    if (call.model === existing.model
      && (['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'] as const).every(k => call[k] >= existing[k])
      && totalAntigravityCallTokens(call) > totalAntigravityCallTokens(existing)) {
      byKey.set(key, { ...existing, ...call, timestampMs: existing.timestampMs });
    }
  }

  return [...byKey.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

export function classifyAntigravityToolName(name: string): ToolCategory {
  const lower = name.toLowerCase();
  if (lower.includes('grep') || lower.includes('search') || lower.includes('list')) return 'search';
  if (lower.includes('edit') || lower.includes('write') || lower.includes('replace') || lower.includes('code_action')) return 'editWrite';
  if (lower.includes('view') || lower.includes('read')) return 'read';
  if (lower.includes('command') || lower.includes('terminal')) return 'terminal';
  return 'terminal';
}

export function activityBreakdownFromCalls(calls: AntigravityUsageCall[]): ActivityBreakdown {
  const breakdown = emptyActivityBreakdown();

  for (const call of calls) {
    breakdown.thinking += call.thinkingTokens;
    breakdown.response += call.responseTokens > 0
      ? call.responseTokens
      : Math.max(0, call.outputTokens - call.thinkingTokens);
    for (const tool of call.toolNames) {
      breakdown[classifyAntigravityToolName(tool)] += 1;
    }
  }

  return breakdown;
}
