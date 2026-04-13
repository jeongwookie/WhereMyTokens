import * as fs from 'fs';

export interface ParsedEntry {
  requestId: string;
  timestamp: Date;
  model: string;
  provider: 'claude' | 'codex' | 'other';
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUSD: number;
}

// Per-model pricing (USD / 1M tokens)
const PRICING: Record<string, { in: number; out: number; cw: number; cr: number }> = {
  'claude-opus':    { in: 15,   out: 75,  cw: 18.75, cr: 1.50 },
  'claude-sonnet':  { in: 3,    out: 15,  cw: 3.75,  cr: 0.30 },
  'claude-haiku':   { in: 0.8,  out: 4,   cw: 1.0,   cr: 0.08 },
  'gpt-4':          { in: 2,    out: 8,   cw: 0,     cr: 0.5  },
  'gpt-4o':         { in: 2.5,  out: 10,  cw: 0,     cr: 1.25 },
};
const DEFAULT_PRICE = { in: 3, out: 15, cw: 3.75, cr: 0.30 };

function getPrice(model: string) {
  const lower = model.toLowerCase();
  for (const [key, val] of Object.entries(PRICING)) {
    if (lower.includes(key)) return val;
  }
  return DEFAULT_PRICE;
}

function normalizeModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus'))   return 'Opus';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('haiku'))  return 'Haiku';
  if (lower.includes('gpt-4o')) return 'GPT-4o';
  if (lower.includes('gpt-4'))  return 'GPT-4';
  if (lower.includes('glm'))    return 'GLM';
  return model;
}

function getProvider(model: string): 'claude' | 'codex' | 'other' {
  const lower = model.toLowerCase();
  if (lower.startsWith('claude')) return 'claude';
  if (lower.startsWith('gpt') || lower.startsWith('text-davinci') || lower.startsWith('codex')) return 'codex';
  return 'other';
}

function calcCost(model: string, inp: number, out: number, cw: number, cr: number): number {
  const p = getPrice(model);
  return (inp * p.in + out * p.out + cw * p.cw + cr * p.cr) / 1_000_000;
}

export interface ParsedFile {
  entries: ParsedEntry[];
  modelName: string;        // normalized model name of latest entry
  rawModel: string;         // raw model string
  latestInputTokens: number;
  latestCacheCreationTokens: number;
  latestCacheReadTokens: number;
  toolCounts: Record<string, number>;
}

export function parseJsonlFile(filePath: string): ParsedFile {
  let raw: string;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return emptyResult();
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return emptyResult();
  }

  const lines = raw.split('\n').filter(l => l.trim());
  const entries: ParsedEntry[] = [];
  // key: message id, value: entries 배열 인덱스
  // Set 대신 Map을 써서 동일 id 중 output_tokens 최대값 보존
  const seen = new Map<string, number>();
  let latestModel = '';
  let latestRawModel = '';
  let latestInputTokens = 0;
  let latestCacheCreationTokens = 0;
  let latestCacheReadTokens = 0;
  const toolCounts: Record<string, number> = {};

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }

    // Tally tool call counts
    if (obj.type === 'tool_use' || (obj.type === 'assistant' && Array.isArray((obj.message as Record<string, unknown>)?.content))) {
      const content = (obj.message as Record<string, unknown>)?.content as unknown[];
      if (Array.isArray(content)) {
        for (const c of content) {
          const item = c as Record<string, unknown>;
          if (item?.type === 'tool_use' && typeof item.name === 'string') {
            toolCounts[item.name] = (toolCounts[item.name] ?? 0) + 1;
          }
        }
      }
    }

    if (obj.type !== 'assistant') continue;

    // Format A: Claude Code native (message.usage)
    const msgUsage = (obj.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
    const msgModel = (obj.message as Record<string, unknown>)?.model as string | undefined;
    const reqId = (obj.message as Record<string, unknown>)?.id as string | undefined;

    // Format B: top-level usage (other providers)
    const topUsage = obj.usage as Record<string, number> | undefined;
    const topModel = obj.model as string | undefined;

    const usage = msgUsage ?? topUsage;
    const rawModel = msgModel ?? topModel ?? '';
    const timestamp = obj.timestamp as string | undefined;

    if (!usage || !rawModel) continue;

    const inp = (usage.input_tokens ?? 0) + 0;
    const out = usage.output_tokens ?? 0;
    const cw  = usage.cache_creation_input_tokens ?? 0;
    const cr  = usage.cache_read_input_tokens ?? usage.cached_prompt_tokens ?? 0;

    if (inp + out + cw + cr === 0) continue;

    const id = reqId ?? `${rawModel}-${timestamp}-${inp}-${out}`;
    if (seen.has(id)) {
      // 스트리밍 중 동일 message_id가 여러 번 기록될 수 있음
      // output_tokens가 더 큰 엔트리(최종 청크)로 교체
      const prevIdx = seen.get(id)!;
      if (out > entries[prevIdx].outputTokens) {
        const updatedCost = calcCost(rawModel, inp, out, cw, cr);
        entries[prevIdx] = { ...entries[prevIdx], outputTokens: out, costUSD: updatedCost };
      }
      continue;
    }
    seen.set(id, entries.length); // push 직전 인덱스 저장

    const cost = calcCost(rawModel, inp, out, cw, cr);
    const ts = timestamp ? new Date(timestamp) : new Date(0);

    entries.push({
      requestId: id,
      timestamp: ts,
      model: normalizeModel(rawModel),
      provider: getProvider(rawModel),
      inputTokens: inp,
      outputTokens: out,
      cacheCreationTokens: cw,
      cacheReadTokens: cr,
      costUSD: cost,
    });

    // Track latest entry (for context)
    if (!latestModel || ts.getTime() > 0) {
      latestModel = normalizeModel(rawModel);
      latestRawModel = rawModel;
      latestInputTokens = inp;
      latestCacheReadTokens = cr;
    }
  }

  // Verify the latest entry is actually the most recent by timestamp
  if (entries.length > 0) {
    const last = entries[entries.length - 1];
    latestModel = last.model;
    latestRawModel = entries[entries.length - 1]?.model ?? '';
    latestInputTokens = last.inputTokens;
    latestCacheCreationTokens = last.cacheCreationTokens;
    latestCacheReadTokens = last.cacheReadTokens;
  }

  return { entries, modelName: latestModel, rawModel: latestRawModel, latestInputTokens, latestCacheCreationTokens, latestCacheReadTokens, toolCounts };
}

function emptyResult(): ParsedFile {
  return { entries: [], modelName: '', rawModel: '', latestInputTokens: 0, latestCacheCreationTokens: 0, latestCacheReadTokens: 0, toolCounts: {} };
}

export { normalizeModel, getProvider };
