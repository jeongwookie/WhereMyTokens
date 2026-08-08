import { createHash } from 'node:crypto';
import { CompactRecentEntry, UsageProvider } from './jsonlTypes';
import { estimateUsageCost } from './modelPricing';

export interface ExtractedUsageLine {
  entry: CompactRecentEntry;
  rawModel: string;
  contextMax?: number;
  reasoningOutputTokens?: number;
  toolNames: string[];
}

export function normalizeModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('gpt-5')) return model.toUpperCase();
  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('haiku')) return 'Haiku';
  if (lower.includes('gpt-4o')) return 'GPT-4o';
  if (lower.includes('gpt-4')) return 'GPT-4';
  if (lower.includes('glm')) return 'GLM';
  return model;
}

export function getProvider(model: string): UsageProvider {
  const lower = model.toLowerCase();
  if (lower.startsWith('claude')) return 'claude';
  if (lower.startsWith('gpt') || lower.startsWith('text-davinci') || lower.startsWith('codex')) return 'codex';
  return 'other';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function inferCodexModel(...records: Array<Record<string, unknown> | null | undefined>): string {
  const keys = ['model', 'model_name', 'model_slug', 'model_id', 'requested_model', 'default_model'];
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = asString(record[key]);
      if (value) return value;
    }
  }
  return '';
}

export function codexEntryId(sourceKey: string, line: string, timestamp?: string): string {
  return createHash('sha256')
    .update(sourceKey)
    .update('\0')
    .update(timestamp ?? 'no-ts')
    .update('\0')
    .update(line)
    .digest('hex')
    .slice(0, 32);
}

function parseTimestampMs(timestamp: unknown, fallbackMs: number): number {
  if (typeof timestamp !== 'string') return fallbackMs;
  const timestampMs = new Date(timestamp).getTime();
  return Number.isFinite(timestampMs) ? timestampMs : fallbackMs;
}

function finiteToken(value: unknown): number {
  return Math.max(0, asNumber(value));
}

export function extractClaudeUsageLine(line: string, now: number): ExtractedUsageLine | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (obj.type !== 'assistant') return null;

  const message = obj.message as Record<string, unknown> | undefined;
  const msgUsage = message?.usage as Record<string, number> | undefined;
  const msgModel = message?.model as string | undefined;
  const reqId = message?.id as string | undefined;
  const topUsage = obj.usage as Record<string, number> | undefined;
  const topModel = obj.model as string | undefined;

  const usage = msgUsage ?? topUsage;
  const rawModel = msgModel ?? topModel ?? '';
  const timestamp = obj.timestamp as string | undefined;
  if (!usage || !rawModel) return null;

  const inp = finiteToken(usage.input_tokens);
  const out = finiteToken(usage.output_tokens);
  const cw = finiteToken(usage.cache_creation_input_tokens);
  const cr = finiteToken(usage.cache_read_input_tokens ?? usage.cached_prompt_tokens);
  if (inp + out + cw + cr === 0) return null;

  const timestampMs = timestamp ? parseTimestampMs(timestamp, now) : 0;
  const estimate = estimateUsageCost({
    model: rawModel,
    timestampMs,
    inputTokens: inp,
    outputTokens: out,
    cacheCreationTokens: cw,
    cacheReadTokens: cr,
  });
  const toolNames: string[] = [];
  const content = message?.content as unknown[] | undefined;
  if (Array.isArray(content)) {
    for (const block of content) {
      const item = block as Record<string, unknown>;
      if (item?.type === 'tool_use' && typeof item.name === 'string') {
        toolNames.push(item.name);
      }
    }
  }

  return {
    rawModel,
    entry: {
      requestId: reqId ?? `${rawModel}-${timestamp}-${inp}-${out}`,
      timestampMs,
      model: normalizeModel(rawModel),
      provider: getProvider(rawModel),
      inputTokens: inp,
      outputTokens: out,
      cacheCreationTokens: cw,
      cacheReadTokens: cr,
      costUSD: estimate.costUSD,
      cacheSavingsUSD: estimate.cacheSavingsUSD,
    },
    toolNames,
  };
}

export function extractCodexUsageLine(
  sourceKey: string,
  line: string,
  now: number,
  fallbackRawModel = '',
): ExtractedUsageLine | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const timestamp = obj.timestamp as string | undefined;
  const timestampMs = timestamp ? parseTimestampMs(timestamp, now) : 0;
  const payload = obj.payload as Record<string, unknown> | undefined;
  if (!payload) return null;

  if (obj.type === 'event_msg' && payload.type === 'token_count') {
    const info = payload.info as Record<string, unknown> | null | undefined;
    const usage = info?.last_token_usage as Record<string, unknown> | undefined;
    if (!usage) return null;

    const rawInput = finiteToken(usage.input_tokens);
    const cachedInput = Math.min(rawInput, finiteToken(usage.cached_input_tokens));
    const inp = Math.max(0, rawInput - cachedInput);
    const out = finiteToken(usage.output_tokens);
    const reasoningOutputTokens = finiteToken(usage.reasoning_output_tokens);
    const cr = cachedInput;
    if (inp + out + cr === 0) return null;

    const rawModel = fallbackRawModel || inferCodexModel(payload, info, usage);
    if (!rawModel) return null;
    const estimate = estimateUsageCost({
      model: rawModel,
      timestampMs,
      inputTokens: inp,
      outputTokens: out,
      cacheCreationTokens: 0,
      cacheReadTokens: cr,
    });

    return {
      rawModel,
      contextMax: asNumber(info?.model_context_window),
      reasoningOutputTokens,
      entry: {
        requestId: codexEntryId(sourceKey, line, timestamp),
        timestampMs,
        model: normalizeModel(rawModel),
        provider: 'codex',
        inputTokens: inp,
        outputTokens: out,
        cacheCreationTokens: 0,
        cacheReadTokens: cr,
        costUSD: estimate.costUSD,
        cacheSavingsUSD: estimate.cacheSavingsUSD,
      },
      toolNames: [],
    };
  }

  const usage = (payload.usage ?? payload) as Record<string, unknown>;
  if (payload.type !== 'usage' && !payload.usage) return null;

  const rawInput = finiteToken(usage.input_tokens ?? usage.inputTokens);
  const out = finiteToken(usage.output_tokens ?? usage.outputTokens);
  const cr = finiteToken(usage.cached_input_tokens ?? usage.cacheReadTokens);
  if (rawInput + out + cr === 0) return null;

  const rawModel = fallbackRawModel || inferCodexModel(payload, usage) || 'gpt-5-codex';
  const estimate = estimateUsageCost({
    model: rawModel,
    timestampMs,
    inputTokens: rawInput,
    outputTokens: out,
    cacheCreationTokens: 0,
    cacheReadTokens: cr,
  });
  return {
    rawModel,
    contextMax: asNumber(usage.model_context_window ?? payload.model_context_window),
    entry: {
      requestId: codexEntryId(sourceKey, line, timestamp),
      timestampMs,
      model: normalizeModel(rawModel),
      provider: 'codex',
      inputTokens: rawInput,
      outputTokens: out,
      cacheCreationTokens: 0,
      cacheReadTokens: cr,
      costUSD: estimate.costUSD,
      cacheSavingsUSD: estimate.cacheSavingsUSD,
    },
    toolNames: [],
  };
}
