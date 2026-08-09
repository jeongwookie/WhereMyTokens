export const CLAUDE_STATUS_LINE_SCHEMA_VERSION = 1;
export const CLAUDE_STATUS_LINE_FRESH_MS = 5 * 60 * 1000;
export const CLAUDE_STATUS_LINE_CACHE_MAX_MS = 30 * 60 * 1000;

export interface ClaudeStatusLineRateLimitWindow {
  usedPct: number;
  resetsAtMs: number | null;
}

export interface ClaudeStatusLineScopedWindow extends ClaudeStatusLineRateLimitWindow {
  label: string;
}

export interface ClaudeStatusLineSnapshot {
  schemaVersion: typeof CLAUDE_STATUS_LINE_SCHEMA_VERSION;
  capturedAt: number;
  rateLimits: {
    fiveHour?: ClaudeStatusLineRateLimitWindow;
    sevenDay?: ClaudeStatusLineRateLimitWindow;
    modelScoped: ClaudeStatusLineScopedWindow[];
  };
}

interface NormalizeOptions {
  nowMs?: number;
  capturedAtMs?: number;
  fallbackCapturedAtMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeResetMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numberValue = finiteNumber(value);
  if (numberValue == null || numberValue <= 0) return null;
  // Claude statusLine은 Unix epoch seconds를 전달한다. 기존 ms 파일도 함께 수용한다.
  return numberValue < 1_000_000_000_000 ? numberValue * 1000 : numberValue;
}

function normalizeWindow(value: unknown, canonical: boolean): ClaudeStatusLineRateLimitWindow | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const usedPct = finiteNumber(canonical ? record.usedPct : record.used_percentage);
  if (usedPct == null) return undefined;
  return {
    usedPct: Math.max(0, Math.min(100, usedPct)),
    resetsAtMs: normalizeResetMs(canonical ? record.resetsAtMs : record.resets_at),
  };
}

function normalizeScopedWindows(value: unknown, canonical: boolean): ClaudeStatusLineScopedWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: ClaudeStatusLineScopedWindow[] = [];
  for (const raw of value) {
    if (windows.length >= 8) break;
    const record = asRecord(raw);
    if (!record) continue;
    const labelValue = canonical ? record.label : record.display_name;
    const label = typeof labelValue === 'string'
      ? labelValue.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64)
      : '';
    const usedPct = finiteNumber(canonical ? record.usedPct : record.utilization);
    if (!label || usedPct == null) continue;
    const rawReset = canonical ? record.resetsAtMs : record.resets_at;
    const resetsAtMs = typeof rawReset === 'string'
      ? (() => {
          const timestamp = Date.parse(rawReset);
          return Number.isFinite(timestamp) ? timestamp : null;
        })()
      : normalizeResetMs(rawReset);
    windows.push({
      label,
      usedPct: Math.max(0, Math.min(100, usedPct)),
      resetsAtMs,
    });
  }
  return windows;
}

export function normalizeClaudeStatusLineSnapshot(
  value: unknown,
  options: NormalizeOptions = {},
): ClaudeStatusLineSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const nowMs = options.nowMs ?? Date.now();
  const canonical = record.schemaVersion === CLAUDE_STATUS_LINE_SCHEMA_VERSION;
  const rawCapturedAt = options.capturedAtMs
    ?? finiteNumber(canonical ? record.capturedAt : record._ts)
    ?? options.fallbackCapturedAtMs
    ?? null;
  if (rawCapturedAt == null || rawCapturedAt <= 0 || rawCapturedAt > nowMs + 60_000) return null;

  const rawLimits = asRecord(canonical ? record.rateLimits : record.rate_limits) ?? {};
  const fiveHour = normalizeWindow(canonical ? rawLimits.fiveHour : rawLimits.five_hour, canonical);
  const sevenDay = normalizeWindow(canonical ? rawLimits.sevenDay : rawLimits.seven_day, canonical);
  const modelScoped = normalizeScopedWindows(
    canonical ? rawLimits.modelScoped : rawLimits.model_scoped,
    canonical,
  );
  if (!fiveHour && !sevenDay && modelScoped.length === 0) return null;
  return {
    schemaVersion: CLAUDE_STATUS_LINE_SCHEMA_VERSION,
    capturedAt: rawCapturedAt,
    rateLimits: {
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {}),
      modelScoped,
    },
  };
}
