import * as fs from 'fs';
import { JsonlCache, CacheEntry } from './jsonlCache';

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
  cacheSavingsUSD: number;
}

export interface CodexRateLimitWindow {
  pct: number;
  resetsAt: number;
  observedAt: number;
}

// 모델별 토큰 단가(USD / 1M). cached input은 cacheReadTokens 단가로 계산한다.
const PRICING: Record<string, { in: number; out: number; cw: number; cr: number }> = {
  // OpenAI / Codex
  'gpt-5.4-mini':       { in: 0.75, out: 4.50, cw: 0.75, cr: 0.075 },
  'gpt-5.4-nano':       { in: 0.20, out: 1.25, cw: 0.20, cr: 0.02  },
  'gpt-5.4':            { in: 2.50, out: 15,   cw: 2.50, cr: 0.25  },
  'gpt-5.3-codex':      { in: 1.75, out: 14,   cw: 1.75, cr: 0.175 },
  'gpt-5.2-codex':      { in: 1.75, out: 14,   cw: 1.75, cr: 0.175 },
  'gpt-5.1-codex-mini': { in: 0.25, out: 2,    cw: 0.25, cr: 0.025 },
  'gpt-5.1-codex-max':  { in: 1.25, out: 10,   cw: 1.25, cr: 0.125 },
  'gpt-5.1-codex':      { in: 1.25, out: 10,   cw: 1.25, cr: 0.125 },
  'gpt-5-codex':        { in: 1.25, out: 10,   cw: 1.25, cr: 0.125 },
  'codex-mini-latest':  { in: 1.50, out: 6,    cw: 1.50, cr: 0.375 },
  // Claude 4.x
  'claude-opus-4':   { in: 5,   out: 25,  cw: 6.25,  cr: 0.50 },
  'claude-sonnet-4': { in: 3,   out: 15,  cw: 3.75,  cr: 0.30 },
  'claude-haiku-4':  { in: 1,   out: 5,   cw: 1.25,  cr: 0.10 },
  // Claude 3.x 레거시 fallback
  'claude-opus':     { in: 15,  out: 75,  cw: 18.75, cr: 1.50 },
  'claude-sonnet':   { in: 3,   out: 15,  cw: 3.75,  cr: 0.30 },
  'claude-haiku':    { in: 0.8, out: 4,   cw: 1.0,   cr: 0.08 },
  // Non-Claude
  'gpt-4':           { in: 2,   out: 8,   cw: 0,     cr: 0.5  },
  'gpt-4o':          { in: 2.5, out: 10,  cw: 0,     cr: 1.25 },
};
const DEFAULT_PRICE = { in: 3, out: 15, cw: 3.75, cr: 0.30 };

function getPrice(model: string) {
  const lower = model.toLowerCase();
  for (const [key, val] of Object.entries(PRICING).sort((a, b) => b[0].length - a[0].length)) {
    if (lower.includes(key)) return val;
  }
  return DEFAULT_PRICE;
}

function normalizeModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('gpt-5'))   return model.toUpperCase();
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

function calcCacheSavings(model: string, cr: number): number {
  const p = getPrice(model);
  return Math.max(0, p.in - p.cr) * cr / 1_000_000;
}

export interface ActivityBreakdown {
  read: number;       // Read 툴 호출에 귀속된 output 토큰 (비례 배분)
  editWrite: number;  // Edit / Write / MultiEdit / NotebookEdit
  search: number;     // Grep / Glob / LS / TodoRead
  git: number;        // Bash — git 명령
  buildTest: number;  // Bash — npm/tsc/test/build 등
  terminal: number;   // Bash — 기타 / mcp__*
  thinking: number;   // thinking 블록
  response: number;   // text 블록 (최종 응답)
  subagents: number;  // Agent 툴
  web: number;        // WebFetch / WebSearch
}

export type ActivityBreakdownKind = 'tokens' | 'events';

export interface ParsedFile {
  entries: ParsedEntry[];
  modelName: string;        // normalized model name of latest entry
  rawModel: string;         // raw model string
  latestInputTokens: number;
  latestCacheCreationTokens: number;
  latestCacheReadTokens: number;
  contextMax?: number;
  codexRateLimits?: {
    h5?: CodexRateLimitWindow;
    week?: CodexRateLimitWindow;
  };
  toolCounts: Record<string, number>;
  activityBreakdown: ActivityBreakdown;
  activityBreakdownKind: ActivityBreakdownKind;
}

function classifyToolUse(name: string, input: unknown): keyof ActivityBreakdown {
  switch (name) {
    case 'Read':                                    return 'read';
    case 'Edit': case 'Write':
    case 'MultiEdit': case 'NotebookEdit':          return 'editWrite';
    case 'Grep': case 'Glob': case 'LS':
    case 'TodoRead': case 'TodoWrite':              return 'search';
    case 'Agent':                                   return 'subagents';
    case 'WebFetch': case 'WebSearch':              return 'web';
    case 'Bash': {
      const cmd = ((input as Record<string, unknown>)?.command as string ?? '').trimStart();
      if (/^git\b/.test(cmd))                       return 'git';
      if (/\b(npm|yarn|pnpm|bun|tsc|tsx|ts-node|cargo|python|pytest|jest|vitest|make|cmake|gradle|mvn|dotnet|go\s+build|go\s+test)\b/.test(cmd))
                                                    return 'buildTest';
      return 'terminal';
    }
    case 'shell_command': {
      let cmd = '';
      if (typeof input === 'string') {
        try {
          const parsed = JSON.parse(input) as Record<string, unknown>;
          cmd = (parsed.command as string ?? '').trimStart();
        } catch {
          cmd = input.trimStart();
        }
      } else {
        cmd = ((input as Record<string, unknown>)?.command as string ?? '').trimStart();
      }
      if (/^git\b/.test(cmd))                       return 'git';
      if (/\b(npm|yarn|pnpm|bun|tsc|tsx|ts-node|cargo|python|pytest|jest|vitest|make|cmake|gradle|mvn|dotnet|go\s+build|go\s+test)\b/.test(cmd))
                                                    return 'buildTest';
      return 'terminal';
    }
    default:
      if (name.startsWith('mcp__'))                return 'terminal';
      return 'terminal';
  }
}

function emptyBreakdown(): ActivityBreakdown {
  return { read: 0, editWrite: 0, search: 0, git: 0, buildTest: 0, terminal: 0, thinking: 0, response: 0, subagents: 0, web: 0 };
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
  const activityBreakdown = emptyBreakdown();

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }

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
      // output_tokens가 더 큰 엔트리(최종 청크)로 교체 — toolCounts/breakdown은 재산정 안 함
      const prevIdx = seen.get(id)!;
      if (out > entries[prevIdx].outputTokens) {
        const updatedCost = calcCost(rawModel, inp, out, cw, cr);
        const updatedSavings = calcCacheSavings(rawModel, cr);
        entries[prevIdx] = { ...entries[prevIdx], outputTokens: out, costUSD: updatedCost, cacheSavingsUSD: updatedSavings };
      }
      continue;
    }
    seen.set(id, entries.length); // push 직전 인덱스 저장

    // ── 첫 등장 엔트리만: toolCounts + activityBreakdown 집계 ──
    const content = (obj.message as Record<string, unknown>)?.content as unknown[];
    if (Array.isArray(content)) {
      // 툴 호출 횟수
      for (const c of content) {
        const item = c as Record<string, unknown>;
        if (item?.type === 'tool_use' && typeof item.name === 'string') {
          toolCounts[item.name] = (toolCounts[item.name] ?? 0) + 1;
        }
      }

      // Activity breakdown: content 블록 char 길이 비례로 output 토큰 배분
      if (out > 0) {
        const blockData: Array<{ cat: keyof ActivityBreakdown; chars: number }> = [];
        for (const c of content) {
          const item = c as Record<string, unknown>;
          let chars = 0;
          let cat: keyof ActivityBreakdown = 'response';
          if (item.type === 'thinking') {
            chars = (item.thinking as string ?? '').length;
            cat = 'thinking';
          } else if (item.type === 'text') {
            chars = (item.text as string ?? '').length;
            cat = 'response';
          } else if (item.type === 'tool_use' && typeof item.name === 'string') {
            chars = JSON.stringify(item.input ?? {}).length + item.name.length;
            cat = classifyToolUse(item.name, item.input);
          }
          if (chars > 0) blockData.push({ cat, chars });
        }
        const totalChars = blockData.reduce((s, b) => s + b.chars, 0);
        if (totalChars > 0) {
          for (const { cat, chars } of blockData) {
            activityBreakdown[cat] += Math.round((chars / totalChars) * out);
          }
        }
      }
    }

    const cost = calcCost(rawModel, inp, out, cw, cr);
    const cacheSavingsUSD = calcCacheSavings(rawModel, cr);
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
      cacheSavingsUSD,
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

  return {
    entries,
    modelName: latestModel,
    rawModel: latestRawModel,
    latestInputTokens,
    latestCacheCreationTokens,
    latestCacheReadTokens,
    toolCounts,
    activityBreakdown,
    activityBreakdownKind: 'tokens',
  };
}

function emptyResult(): ParsedFile {
  return {
    entries: [],
    modelName: '',
    rawModel: '',
    latestInputTokens: 0,
    latestCacheCreationTokens: 0,
    latestCacheReadTokens: 0,
    toolCounts: {},
    activityBreakdown: emptyBreakdown(),
    activityBreakdownKind: 'tokens',
  };
}

/**
 * mtime 기반 캐시 + 증분 파싱 지원 버전.
 * - mtime 동일 → 캐시 반환 (I/O 제로)
 * - 파일 커짐 → 새 바이트만 읽어서 기존 결과에 merge
 * - 파일 줄어듦 → 캐시 무효화 후 전체 재파싱
 */
export function parseJsonlCached(filePath: string, cache: JsonlCache): ParsedFile {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return emptyResult();
  } catch {
    cache.invalidate(filePath);
    return emptyResult();
  }

  const cached = cache.get(filePath);

  // 캐시 히트: mtime 동일 → 즉시 반환
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.parsed;
  }

  // 파일이 줄어들었거나 캐시 없음 → 전체 재파싱
  if (!cached || stat.size < cached.byteOffset) {
    const result = parseJsonlFile(filePath);
    // 전체 파싱 후 캐시 저장 (seen map 재구축)
    const seenMap = new Map<string, number>();
    for (let i = 0; i < result.entries.length; i++) {
      seenMap.set(result.entries[i].requestId, i);
    }
    cache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      fileSize: stat.size,
      byteOffset: stat.size,
      parsed: result,
      seenMap,
    });
    return result;
  }

  // 증분 파싱: 새 바이트만 읽기
  if (stat.size > cached.byteOffset) {
    const newSize = stat.size - cached.byteOffset;
    const buf = Buffer.alloc(newSize);
    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, newSize, cached.byteOffset);
      fs.closeSync(fd);
    } catch {
      // 읽기 실패 시 전체 재파싱 fallback
      cache.invalidate(filePath);
      return parseJsonlCached(filePath, cache);
    }

    const newText = buf.toString('utf-8');
    // byteOffset은 항상 완전한 줄 끝(\n) 위치이므로 전체 newText 파싱
    // 불완전 줄은 JSON.parse catch로 자동 스킵됨
    const textToParse = newText;

    if (textToParse.trim()) {
      // 기존 결과를 복사하여 merge
      const entries = [...cached.parsed.entries];
      const seenMap = new Map(cached.seenMap);
      const toolCounts = { ...cached.parsed.toolCounts };
      const activityBreakdown = { ...cached.parsed.activityBreakdown };
      let latestModel = cached.parsed.modelName;
      let latestRawModel = cached.parsed.rawModel;
      let latestInputTokens = cached.parsed.latestInputTokens;
      let latestCacheCreationTokens = cached.parsed.latestCacheCreationTokens;
      let latestCacheReadTokens = cached.parsed.latestCacheReadTokens;

      const lines = textToParse.split('\n').filter(l => l.trim());
      for (const line of lines) {
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(line) as Record<string, unknown>; }
        catch { continue; }

        if (obj.type !== 'assistant') continue;

        const msgUsage = (obj.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
        const msgModel = (obj.message as Record<string, unknown>)?.model as string | undefined;
        const reqId = (obj.message as Record<string, unknown>)?.id as string | undefined;
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
        if (seenMap.has(id)) {
          const prevIdx = seenMap.get(id)!;
          if (out > entries[prevIdx].outputTokens) {
            const updatedCost = calcCost(rawModel, inp, out, cw, cr);
            const updatedSavings = calcCacheSavings(rawModel, cr);
            entries[prevIdx] = { ...entries[prevIdx], outputTokens: out, costUSD: updatedCost, cacheSavingsUSD: updatedSavings };
          }
          continue;
        }
        seenMap.set(id, entries.length);

        // toolCounts + activityBreakdown 집계
        const content = (obj.message as Record<string, unknown>)?.content as unknown[];
        if (Array.isArray(content)) {
          for (const c of content) {
            const item = c as Record<string, unknown>;
            if (item?.type === 'tool_use' && typeof item.name === 'string') {
              toolCounts[item.name] = (toolCounts[item.name] ?? 0) + 1;
            }
          }
          if (out > 0) {
            const blockData: Array<{ cat: keyof typeof activityBreakdown; chars: number }> = [];
            for (const c of content) {
              const item = c as Record<string, unknown>;
              let chars = 0;
              let cat: keyof typeof activityBreakdown = 'response';
              if (item.type === 'thinking') {
                chars = (item.thinking as string ?? '').length;
                cat = 'thinking';
              } else if (item.type === 'text') {
                chars = (item.text as string ?? '').length;
                cat = 'response';
              } else if (item.type === 'tool_use' && typeof item.name === 'string') {
                chars = JSON.stringify(item.input ?? {}).length + item.name.length;
                cat = classifyToolUse(item.name, item.input);
              }
              if (chars > 0) blockData.push({ cat, chars });
            }
            const totalChars = blockData.reduce((s, b) => s + b.chars, 0);
            if (totalChars > 0) {
              for (const { cat, chars } of blockData) {
                activityBreakdown[cat] += Math.round((chars / totalChars) * out);
              }
            }
          }
        }

        const cost = calcCost(rawModel, inp, out, cw, cr);
        const cacheSavingsUSD = calcCacheSavings(rawModel, cr);
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
          cacheSavingsUSD,
        });

        latestModel = normalizeModel(rawModel);
        latestRawModel = rawModel;
        latestInputTokens = inp;
        latestCacheCreationTokens = cw;
        latestCacheReadTokens = cr;
      }

      // 마지막 엔트리 기준으로 latest 갱신
      if (entries.length > 0) {
        const last = entries[entries.length - 1];
        latestModel = last.model;
        latestRawModel = entries[entries.length - 1]?.model ?? '';
        latestInputTokens = last.inputTokens;
        latestCacheCreationTokens = last.cacheCreationTokens;
        latestCacheReadTokens = last.cacheReadTokens;
      }

      const result: ParsedFile = {
        entries, modelName: latestModel, rawModel: latestRawModel,
        latestInputTokens, latestCacheCreationTokens, latestCacheReadTokens,
        toolCounts, activityBreakdown, activityBreakdownKind: 'tokens',
      };
      cache.set(filePath, {
        mtimeMs: stat.mtimeMs,
        fileSize: stat.size,
        byteOffset: stat.size,
        parsed: result,
        seenMap,
      });
      return result;
    }
  }

  // 새 데이터 없음 — mtime만 갱신하고 캐시 반환
  cache.set(filePath, { ...cached, mtimeMs: stat.mtimeMs, fileSize: stat.size });
  return cached.parsed;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseCodexRateLimits(payload: Record<string, unknown>, observedAt: number): ParsedFile['codexRateLimits'] {
  const rateLimits = payload.rate_limits as Record<string, unknown> | undefined;
  if (!rateLimits) return undefined;

  const result: ParsedFile['codexRateLimits'] = {};
  for (const key of ['primary', 'secondary'] as const) {
    const win = rateLimits[key] as Record<string, unknown> | undefined;
    if (!win) continue;
    const windowMinutes = asNumber(win.window_minutes);
    const value = {
      pct: asNumber(win.used_percent),
      resetsAt: asNumber(win.resets_at),
      observedAt,
    };
    if (windowMinutes === 300) result.h5 = value;
    else if (windowMinutes === 10080) result.week = value;
  }
  return result;
}

function mergeCodexRateLimits(
  current: ParsedFile['codexRateLimits'],
  next: ParsedFile['codexRateLimits'],
): ParsedFile['codexRateLimits'] {
  if (!next?.h5 && !next?.week) return current;
  const merged: ParsedFile['codexRateLimits'] = { ...(current ?? {}) };
  if (next.h5 && (!merged.h5 || next.h5.observedAt >= merged.h5.observedAt)) merged.h5 = next.h5;
  if (next.week && (!merged.week || next.week.observedAt >= merged.week.observedAt)) merged.week = next.week;
  return merged;
}

export function parseCodexJsonlFile(filePath: string): ParsedFile {
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
  let latestModel = '';
  let latestRawModel = '';
  let latestInputTokens = 0;
  let latestCacheCreationTokens = 0;
  let latestCacheReadTokens = 0;
  let contextMax = 0;
  let codexRateLimits: ParsedFile['codexRateLimits'] = undefined;
  const toolCounts: Record<string, number> = {};
  const activityBreakdown = emptyBreakdown();

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }

    const timestamp = obj.timestamp as string | undefined;
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (!payload) continue;

    if (obj.type === 'turn_context') {
      const model = payload.model as string | undefined;
      if (model) {
        latestRawModel = model;
        latestModel = normalizeModel(model);
      }
      continue;
    }

    if (obj.type === 'event_msg' && payload.type === 'task_started') {
      contextMax = asNumber(payload.model_context_window);
      continue;
    }

    if (obj.type === 'response_item' && payload.type === 'function_call') {
      const name = payload.name as string | undefined;
      if (name) {
        toolCounts[name] = (toolCounts[name] ?? 0) + 1;
        const cat = classifyToolUse(name, payload.arguments);
        activityBreakdown[cat] += 1;
      }
      continue;
    }

    if (obj.type !== 'event_msg' || payload.type !== 'token_count') continue;

    const observedMs = timestamp ? new Date(timestamp).getTime() : NaN;
    const observedAt = Number.isFinite(observedMs) ? Math.floor(observedMs / 1000) : Math.floor(Date.now() / 1000);
    const nextRateLimits = parseCodexRateLimits(payload, observedAt);
    if (nextRateLimits?.h5 && (!codexRateLimits?.h5 || nextRateLimits.h5.observedAt >= codexRateLimits.h5.observedAt)) {
      codexRateLimits = { ...(codexRateLimits ?? {}), h5: nextRateLimits.h5 };
    }
    if (nextRateLimits?.week && (!codexRateLimits?.week || nextRateLimits.week.observedAt >= codexRateLimits.week.observedAt)) {
      codexRateLimits = { ...(codexRateLimits ?? {}), week: nextRateLimits.week };
    }

    const info = payload.info as Record<string, unknown> | null | undefined;
    const usage = info?.last_token_usage as Record<string, unknown> | undefined;
    if (!usage) continue;

    const rawInput = asNumber(usage.input_tokens);
    const cached = Math.min(rawInput, asNumber(usage.cached_input_tokens));
    const inp = Math.max(0, rawInput - cached);
    const out = asNumber(usage.output_tokens);
    const cw = 0;
    const cr = cached;

    if (inp + out + cr === 0) continue;

    const rawModel = latestRawModel || 'codex';
    const ts = timestamp ? new Date(timestamp) : new Date(0);
    const id = `${filePath}-${timestamp ?? entries.length}-${entries.length}`;
    const cost = calcCost(rawModel, inp, out, cw, cr);
    const cacheSavingsUSD = calcCacheSavings(rawModel, cr);

    entries.push({
      requestId: id,
      timestamp: ts,
      model: normalizeModel(rawModel),
      provider: 'codex',
      inputTokens: inp,
      outputTokens: out,
      cacheCreationTokens: cw,
      cacheReadTokens: cr,
      costUSD: cost,
      cacheSavingsUSD,
    });

    latestModel = normalizeModel(rawModel);
    latestInputTokens = inp;
    latestCacheCreationTokens = cw;
    latestCacheReadTokens = cr;
    contextMax = contextMax || asNumber(info?.model_context_window);
  }

  return {
    entries,
    modelName: latestModel,
    rawModel: latestRawModel,
    latestInputTokens,
    latestCacheCreationTokens,
    latestCacheReadTokens,
    contextMax,
    codexRateLimits,
    toolCounts,
    activityBreakdown,
    activityBreakdownKind: 'events',
  };
}

export function parseCodexJsonlCached(filePath: string, cache: JsonlCache): ParsedFile {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return emptyResult();
  } catch {
    cache.invalidate(filePath);
    return emptyResult();
  }

  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.parsed;
  }

  if (cached && stat.size >= cached.byteOffset) {
    const newSize = stat.size - cached.byteOffset;
    if (newSize === 0) {
      cache.set(filePath, { ...cached, mtimeMs: stat.mtimeMs, fileSize: stat.size });
      return cached.parsed;
    }

    let fd: number | null = null;
    try {
      const buf = Buffer.alloc(newSize);
      fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, newSize, cached.byteOffset);
      const newText = buf.toString('utf-8');

      if (!newText.trim()) {
        cache.set(filePath, { ...cached, mtimeMs: stat.mtimeMs, fileSize: stat.size });
        return cached.parsed;
      }

      const entries = [...cached.parsed.entries];
      const seenMap = new Map(cached.seenMap);
      let latestModel = cached.parsed.modelName;
      let latestRawModel = cached.parsed.rawModel;
      let latestInputTokens = cached.parsed.latestInputTokens;
      let latestCacheCreationTokens = cached.parsed.latestCacheCreationTokens;
      let latestCacheReadTokens = cached.parsed.latestCacheReadTokens;
      let contextMax = cached.parsed.contextMax ?? 0;
      let codexRateLimits = cached.parsed.codexRateLimits;
      const toolCounts = { ...cached.parsed.toolCounts };
      const activityBreakdown = { ...cached.parsed.activityBreakdown };

      const lines = newText.split('\n').filter(l => l.trim());
      for (const line of lines) {
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(line) as Record<string, unknown>; }
        catch { continue; }

        const timestamp = obj.timestamp as string | undefined;
        const payload = obj.payload as Record<string, unknown> | undefined;
        if (!payload) continue;

        if (obj.type === 'turn_context') {
          const model = payload.model as string | undefined;
          if (model) {
            latestRawModel = model;
            latestModel = normalizeModel(model);
          }
          continue;
        }

        if (obj.type === 'event_msg' && payload.type === 'task_started') {
          contextMax = asNumber(payload.model_context_window);
          continue;
        }

        if (obj.type === 'response_item' && payload.type === 'function_call') {
          const name = payload.name as string | undefined;
          if (name) {
            toolCounts[name] = (toolCounts[name] ?? 0) + 1;
            const cat = classifyToolUse(name, payload.arguments);
            activityBreakdown[cat] += 1;
          }
          continue;
        }

        if (obj.type !== 'event_msg' || payload.type !== 'token_count') continue;

        const observedMs = timestamp ? new Date(timestamp).getTime() : NaN;
        const observedAt = Number.isFinite(observedMs) ? Math.floor(observedMs / 1000) : Math.floor(Date.now() / 1000);
        codexRateLimits = mergeCodexRateLimits(codexRateLimits, parseCodexRateLimits(payload, observedAt));

        const info = payload.info as Record<string, unknown> | null | undefined;
        const usage = info?.last_token_usage as Record<string, unknown> | undefined;
        if (!usage) continue;

        const rawInput = asNumber(usage.input_tokens);
        const cachedInput = Math.min(rawInput, asNumber(usage.cached_input_tokens));
        const inp = Math.max(0, rawInput - cachedInput);
        const out = asNumber(usage.output_tokens);
        const cw = 0;
        const cr = cachedInput;

        if (inp + out + cr === 0) continue;

        const rawModel = latestRawModel || 'codex';
        const ts = timestamp ? new Date(timestamp) : new Date(0);
        const id = `${filePath}-${timestamp ?? entries.length}-${entries.length}`;
        if (seenMap.has(id)) continue;
        seenMap.set(id, entries.length);

        entries.push({
          requestId: id,
          timestamp: ts,
          model: normalizeModel(rawModel),
          provider: 'codex',
          inputTokens: inp,
          outputTokens: out,
          cacheCreationTokens: cw,
          cacheReadTokens: cr,
          costUSD: calcCost(rawModel, inp, out, cw, cr),
          cacheSavingsUSD: calcCacheSavings(rawModel, cr),
        });

        latestModel = normalizeModel(rawModel);
        latestInputTokens = inp;
        latestCacheCreationTokens = cw;
        latestCacheReadTokens = cr;
        contextMax = contextMax || asNumber(info?.model_context_window);
      }

      const result: ParsedFile = {
        entries,
        modelName: latestModel,
        rawModel: latestRawModel,
        latestInputTokens,
        latestCacheCreationTokens,
        latestCacheReadTokens,
        contextMax,
        codexRateLimits,
        toolCounts,
        activityBreakdown,
        activityBreakdownKind: 'events',
      };
      cache.set(filePath, {
        mtimeMs: stat.mtimeMs,
        fileSize: stat.size,
        byteOffset: stat.size,
        parsed: result,
        seenMap,
      });
      return result;
    } catch {
      cache.invalidate(filePath);
      return parseCodexJsonlCached(filePath, cache);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  const result = parseCodexJsonlFile(filePath);
  const seenMap = new Map<string, number>();
  for (let i = 0; i < result.entries.length; i++) {
    seenMap.set(result.entries[i].requestId, i);
  }
  cache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    fileSize: stat.size,
    byteOffset: stat.size,
    parsed: result,
    seenMap,
  });
  return result;
}

export { normalizeModel, getProvider };
