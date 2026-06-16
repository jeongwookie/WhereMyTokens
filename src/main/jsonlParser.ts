import * as fs from 'fs';
import { JsonlCache } from './jsonlCache';
import {
  ActivityBreakdown,
  CompactRecentEntry,
  FileUsageSummary,
  HistoricalAggregate,
  HistoricalBucket,
  HistoricalRollup,
  RequestIndexEntry,
  SessionSnapshot,
  emptyHistoricalAggregate,
  emptyHistoricalRollup,
  emptySessionSnapshot,
} from './jsonlTypes';
import { extractClaudeUsageLine, extractCodexUsageLine } from './jsonlUsageExtractor';
import { claudeBlockBreakdown, codexFunctionCallCategory } from './activityClassifier';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 8 * DAY_MS;
const HOURLY_BUCKET_WINDOW_MS = 150 * DAY_MS;

const pendingScans = new Map<string, Promise<FileUsageSummary>>();

function scanKey(filePath: string): string {
  const resolved = fs.realpathSync.native?.(filePath) ?? filePath;
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// 모델별 토큰 단가(USD / 1M). cached input은 cacheReadTokens 단가로 계산한다.
const PRICING: Record<string, { in: number; out: number; cw: number; cr: number }> = {
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
  'claude-opus-4':      { in: 5,    out: 25,   cw: 6.25, cr: 0.50  },
  'claude-sonnet-4':    { in: 3,    out: 15,   cw: 3.75, cr: 0.30  },
  'claude-haiku-4':     { in: 1,    out: 5,    cw: 1.25, cr: 0.10  },
  'claude-opus':        { in: 15,   out: 75,   cw: 18.75, cr: 1.50 },
  'claude-sonnet':      { in: 3,    out: 15,   cw: 3.75, cr: 0.30  },
  'claude-haiku':       { in: 0.8,  out: 4,    cw: 1.0,  cr: 0.08  },
  'gpt-4':              { in: 2,    out: 8,    cw: 0,    cr: 0.5   },
  'gpt-4o':             { in: 2.5,  out: 10,   cw: 0,    cr: 1.25  },
};

const DEFAULT_PRICE = { in: 3, out: 15, cw: 3.75, cr: 0.30 };

function getPrice(model: string) {
  const lower = model.toLowerCase();
  for (const [key, val] of Object.entries(PRICING).sort((a, b) => b[0].length - a[0].length)) {
    if (lower.includes(key)) return val;
  }
  return DEFAULT_PRICE;
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

export function getProvider(model: string): 'claude' | 'codex' | 'other' {
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

function cloneAggregate(aggregate: HistoricalAggregate): HistoricalAggregate {
  return { ...aggregate };
}

function cloneRollup(rollup: HistoricalRollup): HistoricalRollup {
  return {
    aggregate: cloneAggregate(rollup.aggregate),
    modelTotals: Object.fromEntries(Object.entries(rollup.modelTotals).map(([key, value]) => [key, { ...value }])),
    hourlyBuckets: Object.fromEntries(Object.entries(rollup.hourlyBuckets).map(([key, value]) => [key, { ...value }])),
  };
}

function cloneSummary(summary: FileUsageSummary): FileUsageSummary {
  return {
    ...summary,
    sessionSnapshot: {
      ...summary.sessionSnapshot,
      toolCounts: { ...summary.sessionSnapshot.toolCounts },
      activityBreakdown: { ...summary.sessionSnapshot.activityBreakdown },
      codexRateLimits: summary.sessionSnapshot.codexRateLimits
        ? {
          ...(summary.sessionSnapshot.codexRateLimits.h5 ? { h5: { ...summary.sessionSnapshot.codexRateLimits.h5 } } : {}),
          ...(summary.sessionSnapshot.codexRateLimits.week ? { week: { ...summary.sessionSnapshot.codexRateLimits.week } } : {}),
        }
        : undefined,
    },
    recentEntries: summary.recentEntries.map(entry => ({ ...entry })),
    historicalRollup: cloneRollup(summary.historicalRollup),
    requestIndex: summary.requestIndex
      ? Object.fromEntries(Object.entries(summary.requestIndex).map(([key, value]) => [key, { ...value }]))
      : undefined,
  };
}

function makeEmptySummary(provider: 'claude' | 'codex', mtimeMs = 0, size = 0): FileUsageSummary {
  return {
    provider,
    sessionSnapshot: emptySessionSnapshot(provider === 'codex' ? 'events' : 'tokens'),
    recentEntries: [],
    historicalRollup: emptyHistoricalRollup(),
    byteOffset: 0,
    pendingBytes: 0,
    mtimeMs,
    size,
    lastAccessedAt: Date.now(),
    ...(provider === 'claude' ? { requestIndex: {} } : {}),
  };
}

function modelKey(entry: Pick<CompactRecentEntry, 'provider' | 'model'>): string {
  return `${entry.provider}:${entry.model}`;
}

function addToAggregate(aggregate: HistoricalAggregate, entry: CompactRecentEntry): void {
  aggregate.requestCount += 1;
  aggregate.inputTokens += entry.inputTokens;
  aggregate.outputTokens += entry.outputTokens;
  aggregate.cacheCreationTokens += entry.cacheCreationTokens;
  aggregate.cacheReadTokens += entry.cacheReadTokens;
  aggregate.totalTokens += entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
  aggregate.costUSD += entry.costUSD;
  aggregate.cacheSavingsUSD += entry.cacheSavingsUSD;
}

function removeFromAggregate(aggregate: HistoricalAggregate, entry: CompactRecentEntry): void {
  aggregate.requestCount -= 1;
  aggregate.inputTokens -= entry.inputTokens;
  aggregate.outputTokens -= entry.outputTokens;
  aggregate.cacheCreationTokens -= entry.cacheCreationTokens;
  aggregate.cacheReadTokens -= entry.cacheReadTokens;
  aggregate.totalTokens -= entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
  aggregate.costUSD -= entry.costUSD;
  aggregate.cacheSavingsUSD -= entry.cacheSavingsUSD;
}

function addToHistoricalRollup(rollup: HistoricalRollup, entry: CompactRecentEntry, now = Date.now()): void {
  addToAggregate(rollup.aggregate, entry);

  const nextModel = rollup.modelTotals[modelKey(entry)] ?? {
    model: entry.model,
    provider: entry.provider,
    tokens: 0,
    costUSD: 0,
  };
  nextModel.tokens += entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
  nextModel.costUSD += entry.costUSD;
  rollup.modelTotals[modelKey(entry)] = nextModel;

  if (entry.timestampMs < now - HOURLY_BUCKET_WINDOW_MS) return;
  const bucketStartMs = entry.timestampMs - (entry.timestampMs % (60 * 60 * 1000));
  const bucketKey = String(bucketStartMs);
  const bucket: HistoricalBucket = rollup.hourlyBuckets[bucketKey] ?? {
    timestampMs: bucketStartMs,
    ...emptyHistoricalAggregate(),
  };
  addToAggregate(bucket, entry);
  rollup.hourlyBuckets[bucketKey] = bucket;
}

function removeFromHistoricalRollup(rollup: HistoricalRollup, entry: CompactRecentEntry): void {
  removeFromAggregate(rollup.aggregate, entry);

  const key = modelKey(entry);
  const currentModel = rollup.modelTotals[key];
  if (currentModel) {
    currentModel.tokens -= entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
    currentModel.costUSD -= entry.costUSD;
    if (currentModel.tokens <= 0 && currentModel.costUSD <= 0) delete rollup.modelTotals[key];
    else rollup.modelTotals[key] = currentModel;
  }

  const bucketStartMs = entry.timestampMs - (entry.timestampMs % (60 * 60 * 1000));
  const bucketKey = String(bucketStartMs);
  const bucket = rollup.hourlyBuckets[bucketKey];
  if (!bucket) return;
  removeFromAggregate(bucket, entry);
  if (bucket.requestCount <= 0 || bucket.totalTokens <= 0) delete rollup.hourlyBuckets[bucketKey];
  else rollup.hourlyBuckets[bucketKey] = bucket;
}

function pruneHistoricalBuckets(rollup: HistoricalRollup, now = Date.now()): void {
  const cutoff = now - HOURLY_BUCKET_WINDOW_MS;
  for (const [bucketKey, bucket] of Object.entries(rollup.hourlyBuckets)) {
    if (bucket.timestampMs < cutoff) delete rollup.hourlyBuckets[bucketKey];
  }
}

function normalizeSummaryWindow(summary: FileUsageSummary, now = Date.now()): FileUsageSummary {
  const next = cloneSummary(summary);
  const cutoff = now - RECENT_WINDOW_MS;
  const keptRecent: CompactRecentEntry[] = [];

  for (const entry of next.recentEntries) {
    if (entry.timestampMs >= cutoff) {
      keptRecent.push(entry);
      continue;
    }

    addToHistoricalRollup(next.historicalRollup, entry, now);
    if (next.requestIndex?.[entry.requestId]) {
      next.requestIndex[entry.requestId] = { ...entry, region: 'historical' };
    }
  }

  next.recentEntries = keptRecent;
  pruneHistoricalBuckets(next.historicalRollup, now);
  next.lastAccessedAt = now;
  return next;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function inferCodexModel(...records: Array<Record<string, unknown> | null | undefined>): string {
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

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function codexEntryId(filePath: string, line: string, timestamp?: string): string {
  return `${filePath}-${timestamp ?? 'no-ts'}-${hashString(line)}`;
}

function parseCodexRateLimits(payload: Record<string, unknown>, observedAt: number): SessionSnapshot['codexRateLimits'] {
  const rateLimits = payload.rate_limits as Record<string, unknown> | undefined;
  if (!rateLimits) return undefined;

  const result: SessionSnapshot['codexRateLimits'] = {};
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
  current: SessionSnapshot['codexRateLimits'],
  next: SessionSnapshot['codexRateLimits'],
): SessionSnapshot['codexRateLimits'] {
  if (!next?.h5 && !next?.week) return current;
  const merged: SessionSnapshot['codexRateLimits'] = { ...(current ?? {}) };
  if (next.h5 && (!merged.h5 || next.h5.observedAt >= merged.h5.observedAt)) merged.h5 = next.h5;
  if (next.week && (!merged.week || next.week.observedAt >= merged.week.observedAt)) merged.week = next.week;
  return merged;
}

export async function scanCodexRateLimitsOnly(filePath: string): Promise<SessionSnapshot['codexRateLimits']> {
  let merged: SessionSnapshot['codexRateLimits'] = undefined;
  await scanJsonlLines(filePath, 0, undefined, (line) => {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const payload = obj.payload as Record<string, unknown> | undefined;
    if (obj.type !== 'event_msg' || payload?.type !== 'token_count') return;
    const observedMs = typeof obj.timestamp === 'string' ? new Date(obj.timestamp).getTime() : NaN;
    const observedAt = Number.isFinite(observedMs) ? observedMs : Date.now();
    merged = mergeCodexRateLimits(merged, parseCodexRateLimits(payload, observedAt));
  });
  return merged;
}

async function scanJsonlLines(
  filePath: string,
  startOffset: number,
  initialPendingText: string | undefined,
  onLine: (line: string) => void,
): Promise<string> {
  const stream = fs.createReadStream(filePath, {
    encoding: 'utf8',
    start: startOffset,
  });

  let buffer = initialPendingText ?? '';

  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex < 0) break;
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) onLine(line);
      }
    });

    stream.on('error', reject);

    stream.on('end', () => {
      const trailing = buffer.replace(/\r$/, '');
      if (!trailing.trim()) {
        resolve('');
        return;
      }

      try {
        JSON.parse(trailing);
        onLine(trailing);
        resolve('');
      } catch {
        resolve(trailing);
      }
    });
  });
}

function updateClaudeSnapshot(summary: FileUsageSummary, rawModel: string, inp: number, cw: number, cr: number): void {
  summary.sessionSnapshot.modelName = normalizeModel(rawModel);
  summary.sessionSnapshot.rawModel = rawModel;
  summary.sessionSnapshot.latestInputTokens = inp;
  summary.sessionSnapshot.latestCacheCreationTokens = cw;
  summary.sessionSnapshot.latestCacheReadTokens = cr;
}

function updateCodexSnapshot(
  summary: FileUsageSummary,
  rawModel: string,
  inp: number,
  cr: number,
  contextMax: number,
  codexRateLimits: SessionSnapshot['codexRateLimits'],
): void {
  summary.sessionSnapshot.modelName = normalizeModel(rawModel);
  summary.sessionSnapshot.rawModel = rawModel;
  summary.sessionSnapshot.latestInputTokens = inp;
  summary.sessionSnapshot.latestCacheCreationTokens = 0;
  summary.sessionSnapshot.latestCacheReadTokens = cr;
  if (contextMax > 0) summary.sessionSnapshot.contextMax = contextMax;
  if (codexRateLimits) {
    summary.sessionSnapshot.codexRateLimits = mergeCodexRateLimits(summary.sessionSnapshot.codexRateLimits, codexRateLimits);
  }
}

function replaceClaudeEntry(summary: FileUsageSummary, previous: RequestIndexEntry, nextEntry: CompactRecentEntry): void {
  if (previous.region === 'historical') {
    removeFromHistoricalRollup(summary.historicalRollup, previous);
    addToHistoricalRollup(summary.historicalRollup, nextEntry);
    if (summary.requestIndex) summary.requestIndex[nextEntry.requestId] = { ...nextEntry, region: 'historical' };
    return;
  }

  const recentIndex = summary.recentEntries.findIndex(entry => entry.requestId === previous.requestId);
  if (recentIndex >= 0) summary.recentEntries[recentIndex] = nextEntry;
  if (summary.requestIndex) summary.requestIndex[nextEntry.requestId] = { ...nextEntry, region: 'recent' };
}

function addSummaryEntry(summary: FileUsageSummary, entry: CompactRecentEntry, now: number): void {
  if (entry.timestampMs >= now - RECENT_WINDOW_MS) {
    summary.recentEntries.push(entry);
    if (summary.requestIndex) summary.requestIndex[entry.requestId] = { ...entry, region: 'recent' };
    return;
  }

  addToHistoricalRollup(summary.historicalRollup, entry, now);
  if (summary.requestIndex) summary.requestIndex[entry.requestId] = { ...entry, region: 'historical' };
}

function processClaudeLine(summary: FileUsageSummary, line: string, now: number): void {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (obj.type !== 'assistant') return;

  const extracted = extractClaudeUsageLine(line, now);
  if (!extracted) return;
  const nextEntry = extracted.entry;
  const rawModel = extracted.rawModel;
  const inp = nextEntry.inputTokens;
  const out = nextEntry.outputTokens;
  const cw = nextEntry.cacheCreationTokens;
  const cr = nextEntry.cacheReadTokens;

  updateClaudeSnapshot(summary, rawModel, inp, cw, cr);

  const previous = summary.requestIndex?.[nextEntry.requestId];
  if (previous) {
    if (out > previous.outputTokens) replaceClaudeEntry(summary, previous, nextEntry);
    return;
  }

  const content = (obj.message as Record<string, unknown>)?.content as unknown[];
  if (Array.isArray(content)) {
    for (const block of content) {
      const item = block as Record<string, unknown>;
      if (item?.type === 'tool_use' && typeof item.name === 'string') {
        summary.sessionSnapshot.toolCounts[item.name] = (summary.sessionSnapshot.toolCounts[item.name] ?? 0) + 1;
      }
    }

    const delta = claudeBlockBreakdown(content, out);
    for (const [cat, value] of Object.entries(delta)) {
      summary.sessionSnapshot.activityBreakdown[cat as keyof ActivityBreakdown] += value ?? 0;
    }
  }

  addSummaryEntry(summary, nextEntry, now);
}

function processCodexLine(summary: FileUsageSummary, filePath: string, line: string, now: number): void {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  const timestamp = obj.timestamp as string | undefined;
  const payload = obj.payload as Record<string, unknown> | undefined;
  if (!payload) return;

  if (obj.type === 'session_meta' || obj.type === 'turn_context') {
    const model = inferCodexModel(payload);
    if (model) {
      summary.sessionSnapshot.rawModel = model;
      summary.sessionSnapshot.modelName = normalizeModel(model);
    }
    return;
  }

  if (obj.type === 'event_msg' && payload.type === 'task_started') {
    const model = inferCodexModel(payload);
    if (model) {
      summary.sessionSnapshot.rawModel = model;
      summary.sessionSnapshot.modelName = normalizeModel(model);
    }
    const contextMax = asNumber(payload.model_context_window);
    if (contextMax > 0) summary.sessionSnapshot.contextMax = contextMax;
    return;
  }

  if (obj.type === 'response_item' && payload.type === 'function_call') {
    const name = payload.name as string | undefined;
    if (!name) return;
    summary.sessionSnapshot.toolCounts[name] = (summary.sessionSnapshot.toolCounts[name] ?? 0) + 1;
    const cat = codexFunctionCallCategory(name, payload.arguments);
    summary.sessionSnapshot.activityBreakdown[cat] += 1;
    return;
  }

  if (obj.type !== 'event_msg' || payload.type !== 'token_count') return;

  const observedMs = timestamp ? new Date(timestamp).getTime() : NaN;
  const observedAt = Number.isFinite(observedMs) ? observedMs : Date.now();
  const nextRateLimits = parseCodexRateLimits(payload, observedAt);

  const info = payload.info as Record<string, unknown> | null | undefined;
  const extracted = extractCodexUsageLine(filePath, line, now, summary.sessionSnapshot.rawModel);
  if (!extracted) return;
  const entry = extracted.entry;

  updateCodexSnapshot(
    summary,
    extracted.rawModel,
    entry.inputTokens,
    entry.cacheReadTokens,
    extracted.contextMax ?? asNumber(info?.model_context_window),
    nextRateLimits,
  );
  addSummaryEntry(summary, entry, now);
}

async function scanSummaryFromScratch(
  filePath: string,
  provider: 'claude' | 'codex',
  stat: fs.Stats,
  now: number,
): Promise<FileUsageSummary> {
  const summary = makeEmptySummary(provider, stat.mtimeMs, stat.size);
  const processLine = provider === 'claude'
    ? (line: string) => processClaudeLine(summary, line, now)
    : (line: string) => processCodexLine(summary, filePath, line, now);
  const pendingText = await scanJsonlLines(filePath, 0, undefined, processLine);
  summary.byteOffset = stat.size;
  summary.pendingText = pendingText || undefined;
  summary.pendingBytes = pendingText ? Buffer.byteLength(pendingText, 'utf8') : 0;
  summary.mtimeMs = stat.mtimeMs;
  summary.size = stat.size;
  summary.rehydratedFromPersistence = false;
  return normalizeSummaryWindow(summary, now);
}

async function scanSummaryIncrementally(
  filePath: string,
  provider: 'claude' | 'codex',
  existing: FileUsageSummary,
  stat: fs.Stats,
  now: number,
): Promise<FileUsageSummary> {
  const summary = normalizeSummaryWindow(existing, now);
  const processLine = provider === 'claude'
    ? (line: string) => processClaudeLine(summary, line, now)
    : (line: string) => processCodexLine(summary, filePath, line, now);
  const pendingStartOffset = !summary.pendingText && (summary.pendingBytes ?? 0) > 0
    ? Math.max(0, summary.byteOffset - (summary.pendingBytes ?? 0))
    : summary.byteOffset;
  const pendingText = await scanJsonlLines(filePath, pendingStartOffset, summary.pendingText, processLine);
  summary.byteOffset = stat.size;
  summary.pendingText = pendingText || undefined;
  summary.pendingBytes = pendingText ? Buffer.byteLength(pendingText, 'utf8') : 0;
  summary.mtimeMs = stat.mtimeMs;
  summary.size = stat.size;
  summary.rehydratedFromPersistence = false;
  return normalizeSummaryWindow(summary, now);
}

export async function scanJsonlSummaryCached(
  filePath: string,
  provider: 'claude' | 'codex',
  cache: JsonlCache,
  force = false,
): Promise<FileUsageSummary> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      cache.invalidate(filePath);
      return makeEmptySummary(provider);
    }
  } catch {
    cache.invalidate(filePath);
    return makeEmptySummary(provider);
  }

  if (!force) {
    const fresh = cache.getFresh(filePath, stat.mtimeMs, stat.size);
    if (fresh) {
      const normalized = normalizeSummaryWindow(fresh);
      return normalized;
    }
  }

  const key = `${provider}:${scanKey(filePath)}`;
  const pending = pendingScans.get(key);
  if (pending) return pending;

  const task = (async () => {
    try {
      const cached = !force ? cache.get(filePath) : null;
      const canIncremental = !!(cached
        && !cached.rehydratedFromPersistence
        && stat.size >= cached.byteOffset
        && (provider !== 'claude' || !!cached.requestIndex));
      const next = canIncremental
        ? await scanSummaryIncrementally(filePath, provider, cached, stat, Date.now())
        : await scanSummaryFromScratch(filePath, provider, stat, Date.now());
      cache.set(filePath, next);
      return next;
    } catch {
      const fallback = await scanSummaryFromScratch(filePath, provider, stat, Date.now()).catch(() => makeEmptySummary(provider));
      cache.set(filePath, fallback);
      return fallback;
    } finally {
      pendingScans.delete(key);
    }
  })();

  pendingScans.set(key, task);
  return task;
}
