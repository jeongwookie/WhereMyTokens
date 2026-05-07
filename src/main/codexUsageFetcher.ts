import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

export const CODEX_USAGE_CACHE_SCHEMA_VERSION = 1;
export const CODEX_USAGE_MAX_BACKOFF_MS = 600_000;

const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_USER_AGENT = 'codex-cli';
const MAX_CODEX_USAGE_RESPONSE_BYTES = 128 * 1024;

export type CodexUsageStatusCode =
  | 'ok'
  | 'no-credentials'
  | 'timeout'
  | 'network'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'schema-changed'
  | 'http-error';

export type CodexResetMs = number | null;

export interface CodexCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexUsagePct {
  h5Available: boolean;
  weekAvailable: boolean;
  h5Pct: number;
  weekPct: number;
  h5ResetMs: CodexResetMs;
  weekResetMs: CodexResetMs;
  plan: string;
  credits: CodexCreditsSnapshot | null;
  limitReached: boolean;
  rateLimitReachedType: string | null;
}

export interface StoredCodexUsagePct extends CodexUsagePct {
  storedAt: number;
  schemaVersion: number;
  authMtimeMs: number | null;
}

export interface CodexUsageStatus {
  code: CodexUsageStatusCode;
  connected: boolean;
  label: string;
  detail: string;
  httpStatus?: number;
  retryAfterMs?: number;
  responseKeys?: string[];
}

export interface CodexUsageFetchResult {
  usage: CodexUsagePct | null;
  status: CodexUsageStatus;
  authMtimeMs: number | null;
}

interface CodexAuthCredentials {
  accessToken: string;
  accountId: string | null;
  authMtimeMs: number | null;
}

interface ParsedUsageWindow {
  pct: number;
  resetMs: CodexResetMs;
  windowMinutes: number | null;
}

class HttpResponseError extends Error {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;

  constructor(statusCode: number, headers: Record<string, string | string[] | undefined>) {
    super(`HTTP ${statusCode}`);
    this.name = 'HttpResponseError';
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function codexHomePath(): string {
  const configured = process.env.CODEX_HOME;
  return configured && configured.trim() ? configured.trim() : path.join(os.homedir(), '.codex');
}

export function codexAuthPath(): string {
  return path.join(codexHomePath(), 'auth.json');
}

export function getCodexAuthMtimeMs(): number | null {
  try {
    return fs.statSync(codexAuthPath()).mtimeMs;
  } catch {
    return null;
  }
}

function parseJwtPayload(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function accountIdFromIdToken(idToken: string | null): string | null {
  const payload = parseJwtPayload(idToken);
  const auth = asRecord(payload?.['https://api.openai.com/auth']);
  return stringValue(auth, 'chatgpt_account_id') || stringValue(payload, 'chatgpt_account_id');
}

function readCredentials(): CodexAuthCredentials | null {
  try {
    const authPath = codexAuthPath();
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as unknown;
    const root = asRecord(raw);
    const tokens = asRecord(root?.tokens);
    const accessToken = stringValue(tokens, 'access_token');
    if (!accessToken) return null;
    const stat = fs.statSync(authPath);
    const accountId = stringValue(tokens, 'account_id')
      || stringValue(root, 'account_id')
      || accountIdFromIdToken(stringValue(tokens, 'id_token'));
    return { accessToken, accountId, authMtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

export function hasCodexUsageCredentials(): boolean {
  return !!readCredentials();
}

function parseChatGptBaseUrlFromConfig(contents: string): string | null {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.split('#', 1)[0].trim();
    if (!line || !line.includes('=')) continue;
    const [rawKey, ...rest] = line.split('=');
    if (rawKey.trim() !== 'chatgpt_base_url') continue;
    let value = rest.join('=').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value.trim() || null;
  }
  return null;
}

function configuredBaseUrl(): string {
  try {
    const configPath = path.join(codexHomePath(), 'config.toml');
    const parsed = parseChatGptBaseUrlFromConfig(fs.readFileSync(configPath, 'utf-8'));
    return parsed || CODEX_DEFAULT_BASE_URL;
  } catch {
    return CODEX_DEFAULT_BASE_URL;
  }
}

export function normalizeCodexUsageBaseUrl(baseUrl: string): string {
  let base = baseUrl.trim();
  while (base.endsWith('/')) base = base.slice(0, -1);
  if (!base) base = CODEX_DEFAULT_BASE_URL;
  if ((base.startsWith('https://chatgpt.com') || base.startsWith('https://chat.openai.com')) && !base.includes('/backend-api')) {
    base += '/backend-api';
  }
  return base;
}

export function resolveCodexUsageUrl(baseUrl = configuredBaseUrl()): string {
  const base = normalizeCodexUsageBaseUrl(baseUrl);
  if (base.endsWith('/wham/usage') || base.endsWith('/api/codex/usage')) return base;
  return base.includes('/backend-api') ? `${base}/wham/usage` : `${base}/api/codex/usage`;
}

function buildStatus(
  code: CodexUsageStatusCode,
  connected: boolean,
  label: string,
  detail: string,
  extras: Omit<CodexUsageStatus, 'code' | 'connected' | 'label' | 'detail'> = {},
): CodexUsageStatus {
  return { code, connected, label, detail, ...extras };
}

function isDebugEnabled(): boolean {
  const proc = process as NodeJS.Process & { defaultApp?: boolean };
  return proc.defaultApp === true || process.env.WMT_DEBUG_CODEX_API === '1';
}

function logStatus(status: CodexUsageStatus): void {
  if (!isDebugEnabled()) return;
  console.info('[WhereMyTokens][codex-api]', {
    code: status.code,
    connected: status.connected,
    label: status.label,
    detail: status.detail,
    httpStatus: status.httpStatus,
    retryAfterMs: status.retryAfterMs,
    responseKeys: status.responseKeys,
  });
}

function httpsGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') {
      reject(new Error('insecure-url'));
      return;
    }

    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
      },
      (res) => {
        let body = '';
        let bodyBytes = 0;
        res.on('data', (chunk: Buffer | string) => {
          const chunkBytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
          bodyBytes += chunkBytes;
          if (bodyBytes > MAX_CODEX_USAGE_RESPONSE_BYTES) {
            fail(new Error('response-too-large'));
            req.destroy();
            return;
          }
          body += chunk;
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) {
            resolve(body);
            return;
          }
          reject(new HttpResponseError(statusCode, res.headers));
        });
      },
    );
    req.on('error', fail);
    req.setTimeout(8000, () => {
      req.destroy(new Error('timeout'));
    });
    req.end();
  });
}

function retryAfterMsFromHeader(header: string | string[] | undefined, now = Date.now()): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(CODEX_USAGE_MAX_BACKOFF_MS, Math.max(0, Math.round(seconds * 1000)));
  const timestamp = new Date(raw).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(CODEX_USAGE_MAX_BACKOFF_MS, Math.max(0, timestamp - now));
}

function classifyHttpError(error: HttpResponseError): CodexUsageStatus {
  switch (error.statusCode) {
    case 401:
      return buildStatus('unauthorized', false, 'auth failed', 'Codex usage token was rejected or expired.', { httpStatus: 401 });
    case 403:
      return buildStatus('forbidden', false, 'forbidden', 'Codex usage access was denied for this account.', { httpStatus: 403 });
    case 429:
      return buildStatus('rate-limited', false, 'rate limited', 'Codex usage endpoint returned HTTP 429.', {
        httpStatus: 429,
        retryAfterMs: retryAfterMsFromHeader(error.headers['retry-after']),
      });
    default:
      return buildStatus('http-error', false, 'api disconnected', `Codex usage endpoint returned HTTP ${error.statusCode}.`, {
        httpStatus: error.statusCode,
      });
  }
}

function classifyRuntimeError(error: unknown): CodexUsageStatus {
  if (error instanceof HttpResponseError) return classifyHttpError(error);
  if (error instanceof Error) {
    if (error.message === 'timeout') return buildStatus('timeout', false, 'api timeout', 'Codex usage request timed out.');
    if (error.message === 'response-too-large') return buildStatus('http-error', false, 'api disconnected', 'Codex usage response was too large.');
    if (error.message === 'insecure-url') return buildStatus('http-error', false, 'api disconnected', 'Codex usage URL must use HTTPS.');
    const code = (error as Error & { code?: string }).code;
    if (typeof code === 'string' && code.length > 0) {
      return buildStatus('network', false, 'api disconnected', `Codex usage network error (${code}).`);
    }
    return buildStatus('http-error', false, 'api disconnected', error.message || 'Codex usage request failed.');
  }
  return buildStatus('http-error', false, 'api disconnected', 'Codex usage request failed.');
}

function normalizePct(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function normalizeResetValue(value: unknown): CodexResetMs {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, value);
}

function numericValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function pctFromWindow(window: Record<string, unknown>): number | null {
  const usedPercent = numericValue(window.used_percent);
  if (usedPercent != null) return normalizePct(usedPercent);
  const remainingPercent = numericValue(window.remaining_percent);
  if (remainingPercent != null) return normalizePct(100 - remainingPercent);
  const utilization = numericValue(window.utilization);
  if (utilization == null) return null;
  return normalizePct(utilization <= 1 ? utilization * 100 : utilization);
}

function resetAtMsFromWindow(window: Record<string, unknown>, now: number): number | null {
  const resetAt = numericValue(window.reset_at) ?? numericValue(window.resets_at);
  if (resetAt != null) return resetAt > 10_000_000_000 ? resetAt : resetAt * 1000;
  const resetAfterSeconds = numericValue(window.reset_after_seconds);
  if (resetAfterSeconds != null) return now + Math.max(0, resetAfterSeconds * 1000);
  return null;
}

function windowMinutesFromWindow(window: Record<string, unknown>): number | null {
  const windowMinutes = numericValue(window.window_minutes);
  if (windowMinutes != null && windowMinutes > 0) return Math.round(windowMinutes);
  const seconds = numericValue(window.limit_window_seconds);
  if (seconds != null && seconds > 0) return Math.ceil(seconds / 60);
  return null;
}

function parseUsageWindow(value: unknown, now: number): ParsedUsageWindow | null {
  const window = asRecord(value);
  if (!window) return null;
  const pct = pctFromWindow(window);
  if (pct == null) return null;
  const resetAtMs = resetAtMsFromWindow(window, now);
  const resetMs = resetAtMs == null || !Number.isFinite(resetAtMs)
    ? null
    : Math.max(0, resetAtMs - now);
  return {
    pct,
    resetMs,
    windowMinutes: windowMinutesFromWindow(window),
  };
}

function roleForWindow(window: ParsedUsageWindow | null): 'session' | 'weekly' | 'unknown' {
  const minutes = window?.windowMinutes;
  if (minutes == null) return 'unknown';
  if (minutes >= 240 && minutes <= 360) return 'session';
  if (minutes >= 9_000 && minutes <= 11_000) return 'weekly';
  return 'unknown';
}

function normalizeWindowRoles(rateLimit: Record<string, unknown> | null, now: number): { h5: ParsedUsageWindow | null; week: ParsedUsageWindow | null } {
  if (!rateLimit) return { h5: null, week: null };
  const primary = parseUsageWindow(rateLimit.primary_window ?? rateLimit.primary, now);
  const secondary = parseUsageWindow(rateLimit.secondary_window ?? rateLimit.secondary, now);
  const primaryRole = roleForWindow(primary);
  const secondaryRole = roleForWindow(secondary);

  if (primary && secondary) {
    if (primaryRole === 'weekly' && secondaryRole !== 'weekly') return { h5: secondary, week: primary };
    if (secondaryRole === 'weekly') return { h5: primary, week: secondary };
    return { h5: primary, week: secondary };
  }

  if (primary) {
    return primaryRole === 'weekly' ? { h5: null, week: primary } : { h5: primary, week: null };
  }

  if (secondary) {
    return secondaryRole === 'weekly' ? { h5: null, week: secondary } : { h5: secondary, week: null };
  }

  return { h5: null, week: null };
}

function creditsSnapshot(value: unknown): CodexCreditsSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const balance = record.balance;
  return {
    hasCredits: record.has_credits === true || record.hasCredits === true,
    unlimited: record.unlimited === true,
    balance: typeof balance === 'string' || typeof balance === 'number' ? String(balance) : null,
  };
}

function rateLimitReachedType(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const record = asRecord(value);
  return stringValue(record, 'kind') || stringValue(record, 'type');
}

function isReachedType(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized !== 'unknown' && normalized !== 'none';
}

function boolValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function parseUsagePayload(payload: unknown, now: number): CodexUsagePct | null {
  const root = asRecord(payload);
  if (!root) return null;
  const status = asRecord(root.rate_limit_status);
  const source = status ?? root;
  const rateLimit = asRecord(source.rate_limit) ?? asRecord(root.rate_limit);
  const windows = normalizeWindowRoles(rateLimit, now);
  const reachedType = rateLimitReachedType(source.rate_limit_reached_type ?? root.rate_limit_reached_type);
  const limitReached = boolValue(rateLimit?.limit_reached) === true
    || boolValue(rateLimit?.allowed) === false
    || isReachedType(reachedType);
  const h5Pct = windows.h5 ? (limitReached ? 100 : windows.h5.pct) : 0;
  const weekPct = windows.week ? (limitReached ? 100 : windows.week.pct) : 0;

  if (!windows.h5 && !windows.week) return null;

  return {
    h5Available: !!windows.h5,
    weekAvailable: !!windows.week,
    h5Pct,
    weekPct,
    h5ResetMs: windows.h5?.resetMs ?? null,
    weekResetMs: windows.week?.resetMs ?? null,
    plan: stringValue(source, 'plan_type') || stringValue(root, 'plan_type') || '',
    credits: creditsSnapshot(source.credits ?? root.credits),
    limitReached,
    rateLimitReachedType: reachedType,
  };
}

function responseKeys(payload: unknown): string[] {
  const record = asRecord(payload);
  return record ? Object.keys(record).sort() : [];
}

function normalizeCredits(value: unknown): CodexCreditsSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    hasCredits: record.hasCredits === true || record.has_credits === true,
    unlimited: record.unlimited === true,
    balance: typeof record.balance === 'string' || typeof record.balance === 'number' ? String(record.balance) : null,
  };
}

export function normalizeStoredCodexUsagePct(
  value: unknown,
  currentAuthMtimeMs: number | null = getCodexAuthMtimeMs(),
): StoredCodexUsagePct | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.schemaVersion !== CODEX_USAGE_CACHE_SCHEMA_VERSION) return null;
  const storedAt = typeof record.storedAt === 'number' && Number.isFinite(record.storedAt)
    ? record.storedAt
    : null;
  if (storedAt == null || storedAt <= 0 || storedAt > Date.now()) return null;
  const authMtimeMs = typeof record.authMtimeMs === 'number' && Number.isFinite(record.authMtimeMs)
    ? record.authMtimeMs
    : null;
  if (currentAuthMtimeMs == null || authMtimeMs == null || Math.abs(authMtimeMs - currentAuthMtimeMs) > 1) return null;

  return {
    schemaVersion: CODEX_USAGE_CACHE_SCHEMA_VERSION,
    storedAt,
    authMtimeMs,
    h5Available: record.h5Available === true,
    weekAvailable: record.weekAvailable === true,
    h5Pct: normalizePct(record.h5Pct),
    weekPct: normalizePct(record.weekPct),
    h5ResetMs: normalizeResetValue(record.h5ResetMs),
    weekResetMs: normalizeResetValue(record.weekResetMs),
    plan: typeof record.plan === 'string' ? record.plan : '',
    credits: normalizeCredits(record.credits),
    limitReached: record.limitReached === true,
    rateLimitReachedType: typeof record.rateLimitReachedType === 'string' ? record.rateLimitReachedType : null,
  };
}

export async function fetchCodexUsagePct(): Promise<CodexUsageFetchResult> {
  const credentials = readCredentials();
  if (!credentials) {
    const status = buildStatus('no-credentials', false, 'local log', 'Codex auth.json with ChatGPT tokens was not found.');
    logStatus(status);
    return { usage: null, status, authMtimeMs: getCodexAuthMtimeMs() };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    Accept: 'application/json',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': CODEX_USER_AGENT,
  };
  if (credentials.accountId) headers['ChatGPT-Account-Id'] = credentials.accountId;

  try {
    const body = await httpsGet(resolveCodexUsageUrl(), headers);
    const parsed = JSON.parse(body) as unknown;
    const usage = parseUsagePayload(parsed, Date.now());
    if (!usage) {
      const status = buildStatus('schema-changed', false, 'schema changed', 'Codex usage response is missing expected limit windows.', {
        responseKeys: responseKeys(parsed),
      });
      logStatus(status);
      return { usage: null, status, authMtimeMs: credentials.authMtimeMs };
    }
    const status = buildStatus('ok', true, '', '', { responseKeys: responseKeys(parsed) });
    logStatus(status);
    return { usage, status, authMtimeMs: credentials.authMtimeMs };
  } catch (error) {
    const status = classifyRuntimeError(error);
    logStatus(status);
    return { usage: null, status, authMtimeMs: credentials.authMtimeMs };
  }
}
