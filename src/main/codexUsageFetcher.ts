import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export const CODEX_USAGE_CACHE_SCHEMA_VERSION = 3;
export const CODEX_USAGE_MAX_BACKOFF_MS = 600_000;

const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_ALLOWED_USAGE_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
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
  h5Unlimited: boolean;
  weekUnlimited: boolean;
  h5Unreported: boolean;
  weekUnreported: boolean;
  unlimited: boolean;
  h5Pct: number;
  weekPct: number;
  h5ResetMs: CodexResetMs;
  weekResetMs: CodexResetMs;
  h5LimitReached: boolean;
  weekLimitReached: boolean;
  plan: string;
  credits: CodexCreditsSnapshot | null;
  limitReached: boolean;
  rateLimitReachedType: string | null;
}

export interface StoredCodexUsagePct extends CodexUsagePct {
  storedAt: number;
  schemaVersion: number;
  authMtimeMs: number | null;
  authIdentityHash: string | null;
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
  authIdentityHash: string | null;
  rawPayload?: unknown;
}

interface CodexAuthCredentials {
  accessToken: string;
  accountId: string | null;
  authMtimeMs: number | null;
  authIdentityHash: string | null;
}

interface ParsedUsageWindow {
  pct: number;
  resetMs: CodexResetMs;
  windowMinutes: number | null;
}

type CodexLimitWindowRole = 'h5' | 'week' | 'unknown';

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

function codexAuthIdentityHash(accessToken: string, accountId: string | null): string {
  const material = accountId ? `account:${accountId}` : `token:${accessToken}`;
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

export function getCodexAuthIdentityHash(): string | null {
  return readCredentials()?.authIdentityHash ?? null;
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
    return { accessToken, accountId, authMtimeMs: stat.mtimeMs, authIdentityHash: codexAuthIdentityHash(accessToken, accountId) };
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

function configuredBaseUrlInfo(): { baseUrl: string; customConfigured: boolean } {
  try {
    const configPath = path.join(codexHomePath(), 'config.toml');
    const parsed = parseChatGptBaseUrlFromConfig(fs.readFileSync(configPath, 'utf-8'));
    return { baseUrl: parsed || CODEX_DEFAULT_BASE_URL, customConfigured: !!parsed };
  } catch {
    return { baseUrl: CODEX_DEFAULT_BASE_URL, customConfigured: false };
  }
}

function configuredBaseUrl(): string {
  return configuredBaseUrlInfo().baseUrl;
}

function isAllowedCodexUsageBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl.trim());
    return parsed.protocol === 'https:' && CODEX_ALLOWED_USAGE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function unsupportedCustomBaseUrlStatus(): CodexUsageStatus | null {
  const { baseUrl, customConfigured } = configuredBaseUrlInfo();
  if (!customConfigured || isAllowedCodexUsageBaseUrl(baseUrl)) return null;
  return buildStatus(
    'schema-changed',
    false,
    'unsupported endpoint',
    'Codex custom chatgpt_base_url must use chatgpt.com or chat.openai.com; custom proxies are not used for token safety.',
  );
}

export function normalizeCodexUsageBaseUrl(baseUrl: string): string {
  let base = baseUrl.trim();
  while (base.endsWith('/')) base = base.slice(0, -1);
  if (!base) base = CODEX_DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    base = CODEX_DEFAULT_BASE_URL;
    parsed = new URL(base);
  }
  if (parsed.protocol !== 'https:' || !CODEX_ALLOWED_USAGE_HOSTS.has(parsed.hostname.toLowerCase())) {
    base = CODEX_DEFAULT_BASE_URL;
    parsed = new URL(base);
  }
  if (CODEX_ALLOWED_USAGE_HOSTS.has(parsed.hostname.toLowerCase()) && !parsed.pathname.includes('/backend-api') && !parsed.pathname.includes('/api/codex')) {
    base += '/backend-api';
  }
  return base;
}

export function resolveCodexUsageUrl(baseUrl = configuredBaseUrl()): string {
  const base = normalizeCodexUsageBaseUrl(baseUrl);
  if (base.endsWith('/wham/usage') || base.endsWith('/api/codex/usage')) return base;
  if (base.endsWith('/api/codex')) return `${base}/usage`;
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

function nonNegativeInteger(value: unknown): number | null {
  const numberValue = numericValue(value);
  return numberValue == null ? null : Math.max(0, Math.round(numberValue));
}

function validIsoOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : undefined;
}

function pctFromWindow(window: Record<string, unknown>): number | null {
  const remainingPercent = numericValue(window.remaining_percent) ?? numericValue(window.remaining_percentage);
  if (remainingPercent != null) return normalizePct(100 - remainingPercent);
  const usedPercent = numericValue(window.used_percent) ?? numericValue(window.used_percentage);
  if (usedPercent != null) return normalizePct(usedPercent);
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

function roleForWindowMinutes(minutes: number | null | undefined): CodexLimitWindowRole {
  if (minutes == null) return 'unknown';
  if (minutes >= 240 && minutes <= 360) return 'h5';
  if (minutes >= 9_000 && minutes <= 11_000) return 'week';
  return 'unknown';
}

function roleForWindow(window: ParsedUsageWindow | null): CodexLimitWindowRole {
  return roleForWindowMinutes(window?.windowMinutes);
}

function normalizeWindowRoles(rateLimit: Record<string, unknown> | null, now: number): { h5: ParsedUsageWindow | null; week: ParsedUsageWindow | null } {
  if (!rateLimit) return { h5: null, week: null };
  const primary = parseUsageWindow(rateLimit.primary_window ?? rateLimit.primary, now);
  const secondary = parseUsageWindow(rateLimit.secondary_window ?? rateLimit.secondary, now);
  const primaryRole = roleForWindow(primary);
  const secondaryRole = roleForWindow(secondary);

  if (primary && secondary) {
    if (primaryRole === 'week' && secondaryRole !== 'week') return { h5: secondary, week: primary };
    if (secondaryRole === 'week') return { h5: primary, week: secondary };
    return { h5: primary, week: secondary };
  }

  if (primary) {
    return primaryRole === 'week' ? { h5: null, week: primary } : { h5: primary, week: null };
  }

  if (secondary) {
    return secondaryRole === 'week' ? { h5: null, week: secondary } : { h5: secondary, week: null };
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

function reachedRoleForType(value: string | null): CodexLimitWindowRole {
  if (!value) return 'unknown';
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'unknown' || normalized === 'none') return 'unknown';
  const compact = normalized.replace(/[\s_-]+/g, '');
  const h5Matched = compact.includes('primary')
    || compact === '5h'
    || compact.includes('fivehour')
    || compact.includes('5hour');
  const weekMatched = compact.includes('secondary')
    || compact === '1w'
    || compact === '7d'
    || compact.includes('week')
    || compact.includes('weekly')
    || compact.includes('sevenday')
    || compact.includes('7day');
  if (h5Matched === weekMatched) return 'unknown';
  return h5Matched ? 'h5' : 'week';
}

function reachedRoleFromValues(values: unknown[]): CodexLimitWindowRole {
  let reachedRole: CodexLimitWindowRole = 'unknown';
  for (const value of values) {
    const role = reachedRoleForType(rateLimitReachedType(value));
    if (role === 'unknown') continue;
    if (reachedRole !== 'unknown' && reachedRole !== role) return 'unknown';
    reachedRole = role;
  }
  return reachedRole;
}

function firstReachedType(values: unknown[]): string | null {
  for (const value of values) {
    const reachedType = rateLimitReachedType(value);
    if (reachedType) return reachedType;
  }
  return null;
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
  const credits = creditsSnapshot(source.credits ?? root.credits);
  const unlimited = credits?.unlimited === true;
  const h5Unlimited = unlimited && !windows.h5;
  const weekUnlimited = unlimited && !windows.week;
  const h5Unreported = !unlimited && !windows.h5 && !!windows.week;
  const weekUnreported = !unlimited && !windows.week && !!windows.h5;
  const reachedTypeValues = [
    source.rate_limit_reached_type,
    root.rate_limit_reached_type,
    rateLimit?.rate_limit_reached_type,
  ];
  const reachedType = firstReachedType(reachedTypeValues);
  const reachedRole = reachedRoleFromValues(reachedTypeValues);
  const h5LimitReached = !!windows.h5 && (reachedRole === 'h5' || windows.h5.pct >= 100);
  const weekLimitReached = !!windows.week && (reachedRole === 'week' || windows.week.pct >= 100);
  const limitReached = boolValue(rateLimit?.limit_reached) === true
    || boolValue(rateLimit?.allowed) === false
    || isReachedType(reachedType)
    || h5LimitReached
    || weekLimitReached;
  const h5Pct = windows.h5 ? (h5LimitReached ? 100 : windows.h5.pct) : 0;
  const weekPct = windows.week ? (weekLimitReached ? 100 : windows.week.pct) : 0;

  if (!windows.h5 && !windows.week && !unlimited) return null;

  return {
    h5Available: !!windows.h5 || h5Unlimited || h5Unreported,
    weekAvailable: !!windows.week || weekUnlimited || weekUnreported,
    h5Unlimited,
    weekUnlimited,
    h5Unreported,
    weekUnreported,
    unlimited,
    h5Pct,
    weekPct,
    h5ResetMs: windows.h5?.resetMs ?? null,
    weekResetMs: windows.week?.resetMs ?? null,
    h5LimitReached,
    weekLimitReached,
    plan: stringValue(source, 'plan_type') || stringValue(root, 'plan_type') || '',
    credits,
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
  currentAuthIdentityHash: string | null = getCodexAuthIdentityHash(),
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
  const authIdentityHash = typeof record.authIdentityHash === 'string' && record.authIdentityHash ? record.authIdentityHash : null;
  if (!authIdentityHash || !currentAuthIdentityHash || authIdentityHash !== currentAuthIdentityHash) return null;

  return {
    schemaVersion: CODEX_USAGE_CACHE_SCHEMA_VERSION,
    storedAt,
    authMtimeMs,
    authIdentityHash,
    h5Available: record.h5Available === true,
    weekAvailable: record.weekAvailable === true,
    h5Unlimited: record.h5Unlimited === true,
    weekUnlimited: record.weekUnlimited === true,
    h5Unreported: record.h5Unreported === true,
    weekUnreported: record.weekUnreported === true,
    unlimited: record.unlimited === true,
    h5Pct: normalizePct(record.h5Pct),
    weekPct: normalizePct(record.weekPct),
    h5ResetMs: normalizeResetValue(record.h5ResetMs),
    weekResetMs: normalizeResetValue(record.weekResetMs),
    h5LimitReached: record.h5LimitReached === true,
    weekLimitReached: record.weekLimitReached === true,
    plan: typeof record.plan === 'string' ? record.plan : '',
    credits: normalizeCredits(record.credits),
    limitReached: record.limitReached === true,
    rateLimitReachedType: typeof record.rateLimitReachedType === 'string' ? record.rateLimitReachedType : null,
  };
}

export interface StoredCodexResetCredits {
  schemaVersion: number;
  storedAt: number;
  authMtimeMs: number | null;
  authIdentityHash: string | null;
  data: CodexResetCreditsData;
}

function normalizeStoredCredit(value: unknown): CodexResetCredit | null {
  const r = asRecord(value);
  if (!r) return null;
  const expiresAtUtc = validIsoOrNull(r.expiresAtUtc);
  if (expiresAtUtc === undefined) return null;
  return {
    idSuffix: null,
    status: typeof r.status === 'string' ? r.status : 'available',
    expiresAtUtc,
  };
}

export function normalizeStoredCodexResetCredits(
  value: unknown,
  currentAuthMtimeMs: number | null = getCodexAuthMtimeMs(),
  currentAuthIdentityHash: string | null = getCodexAuthIdentityHash(),
): StoredCodexResetCredits | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.schemaVersion !== CODEX_RESET_CREDITS_CACHE_SCHEMA_VERSION) return null;
  const storedAt = typeof record.storedAt === 'number' && Number.isFinite(record.storedAt) ? record.storedAt : null;
  if (storedAt == null || storedAt <= 0 || storedAt > Date.now()) return null;
  const authMtimeMs = typeof record.authMtimeMs === 'number' && Number.isFinite(record.authMtimeMs) ? record.authMtimeMs : null;
  if (currentAuthMtimeMs == null || authMtimeMs == null || Math.abs(authMtimeMs - currentAuthMtimeMs) > 1) return null;
  const authIdentityHash = typeof record.authIdentityHash === 'string' && record.authIdentityHash ? record.authIdentityHash : null;
  if (!authIdentityHash || !currentAuthIdentityHash || authIdentityHash !== currentAuthIdentityHash) return null;
  const data = asRecord(record.data);
  if (!data) return null;
  if (data.countOnly === true) return null;
  const credits = (Array.isArray(data.credits) ? data.credits : []).map(normalizeStoredCredit).filter((c): c is CodexResetCredit => !!c);
  const availableCount = nonNegativeInteger(data.availableCount);
  const totalEarnedCount = nonNegativeInteger(data.totalEarnedCount);
  return {
    schemaVersion: CODEX_RESET_CREDITS_CACHE_SCHEMA_VERSION,
    storedAt,
    authMtimeMs,
    authIdentityHash,
    data: {
      credits,
      availableCount: availableCount ?? credits.length,
      totalEarnedCount: totalEarnedCount ?? 0,
      checkedAt: numericValue(data.checkedAt) ?? storedAt,
      countOnly: data.countOnly === true,
      source: 'cache',
      status: buildStatus('ok', false, '', ''),
    },
  };
}

export async function fetchCodexUsagePct(): Promise<CodexUsageFetchResult> {
  const credentials = readCredentials();
  if (!credentials) {
    const status = buildStatus('no-credentials', false, 'local log', 'Codex auth.json with ChatGPT tokens was not found.');
    logStatus(status);
    return { usage: null, status, authMtimeMs: getCodexAuthMtimeMs(), authIdentityHash: getCodexAuthIdentityHash() };
  }
  const unsupportedStatus = unsupportedCustomBaseUrlStatus();
  if (unsupportedStatus) {
    logStatus(unsupportedStatus);
    return { usage: null, status: unsupportedStatus, authMtimeMs: credentials.authMtimeMs, authIdentityHash: credentials.authIdentityHash };
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
      return { usage: null, status, authMtimeMs: credentials.authMtimeMs, authIdentityHash: credentials.authIdentityHash, rawPayload: parsed };
    }
    const status = buildStatus('ok', true, '', '', { responseKeys: responseKeys(parsed) });
    logStatus(status);
    return { usage, status, authMtimeMs: credentials.authMtimeMs, authIdentityHash: credentials.authIdentityHash, rawPayload: parsed };
  } catch (error) {
    const status = classifyRuntimeError(error);
    logStatus(status);
    return { usage: null, status, authMtimeMs: credentials.authMtimeMs, authIdentityHash: credentials.authIdentityHash };
  }
}

export const CODEX_RESET_CREDITS_CACHE_SCHEMA_VERSION = 2;

export interface CodexResetCredit {
  idSuffix: string | null;
  status: string;
  expiresAtUtc: string | null;
}

export interface CodexResetCreditsData {
  credits: CodexResetCredit[];
  availableCount: number;
  totalEarnedCount: number;
  checkedAt: number;
  countOnly: boolean;
  source: 'api' | 'cache' | 'usage';
  status: CodexUsageStatus;
}

function expiresSortKey(value: string | null): number {
  if (value == null) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

export function parseCodexResetCreditsPayload(payload: unknown, checkedAt: number): CodexResetCreditsData | null {
  const root = asRecord(payload);
  const hasCreditsArray = Array.isArray(root?.credits);
  const hasCount = numericValue(root?.available_count) != null;
  if (!hasCreditsArray && !hasCount) return null;
  const rawCredits = hasCreditsArray ? (root!.credits as unknown[]) : [];
  const availableRecords = rawCredits
    .map(asRecord)
    .filter((c): c is Record<string, unknown> => !!c && stringValue(c, 'status') === 'available');
  const credits: CodexResetCredit[] = [];
  for (const c of availableRecords) {
    const expiresAtUtc = validIsoOrNull(c.expires_at);
    if (expiresAtUtc === undefined) return null;
    credits.push({
      idSuffix: null,
      status: stringValue(c, 'status') || 'available',
      expiresAtUtc,
    });
  }
  credits.sort((a, b) => expiresSortKey(a.expiresAtUtc) - expiresSortKey(b.expiresAtUtc));
  const declaredCount = nonNegativeInteger(root?.available_count);
  const availableCount = declaredCount != null ? declaredCount : credits.length;
  const countOnly = !hasCreditsArray || (declaredCount != null && declaredCount !== credits.length);
  const publicCredits = countOnly ? [] : credits;
  const earned = nonNegativeInteger(root?.total_earned_count);
  return {
    credits: publicCredits,
    availableCount,
    totalEarnedCount: earned ?? 0,
    checkedAt,
    countOnly,
    source: 'api',
    status: buildStatus('ok', true, '', ''),
  };
}

export function resetCreditsFromUsagePayload(
  payload: unknown,
  checkedAt: number,
  status: CodexUsageStatus,
): CodexResetCreditsData | null {
  const root = asRecord(payload);
  const embedded = asRecord(root?.rate_limit_reset_credits);
  const count = numericValue(embedded?.available_count);
  if (count == null) return null;
  return {
    credits: [],
    availableCount: Math.max(0, Math.round(count)),
    totalEarnedCount: 0,
    checkedAt,
    countOnly: true,
    source: 'usage',
    status,
  };
}

export function resolveCodexResetCreditsUrl(baseUrl = configuredBaseUrl()): string {
  const base = normalizeCodexUsageBaseUrl(baseUrl);
  if (base.endsWith('/wham/usage')) return base.replace(/\/wham\/usage$/, '/wham/rate-limit-reset-credits');
  if (base.endsWith('/api/codex/usage')) return base.replace(/\/api\/codex\/usage$/, '/api/codex/rate-limit-reset-credits');
  if (base.endsWith('/api/codex')) return `${base}/rate-limit-reset-credits`;
  return base.includes('/backend-api')
    ? `${base}/wham/rate-limit-reset-credits`
    : `${base}/api/codex/rate-limit-reset-credits`;
}

export interface CodexResetCreditsFetchResult {
  data: CodexResetCreditsData | null;
  status: CodexUsageStatus;
  authMtimeMs: number | null;
  authIdentityHash: string | null;
}

export async function fetchCodexResetCredits(): Promise<CodexResetCreditsFetchResult> {
  const credentials = readCredentials();
  if (!credentials) {
    const status = buildStatus('no-credentials', false, 'local log', 'Codex auth.json with ChatGPT tokens was not found.');
    logStatus(status);
    return { data: null, status, authMtimeMs: getCodexAuthMtimeMs(), authIdentityHash: getCodexAuthIdentityHash() };
  }
  const unsupportedStatus = unsupportedCustomBaseUrlStatus();
  if (unsupportedStatus) {
    logStatus(unsupportedStatus);
    return { data: null, status: unsupportedStatus, authMtimeMs: credentials.authMtimeMs, authIdentityHash: credentials.authIdentityHash };
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
    const body = await httpsGet(resolveCodexResetCreditsUrl(), headers);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      const status = buildStatus('schema-changed', false, 'schema changed', 'Codex reset-credits response was not valid JSON.');
      logStatus(status);
      return { data: null, status, authMtimeMs: credentials.authMtimeMs, authIdentityHash: credentials.authIdentityHash };
    }
    const data = parseCodexResetCreditsPayload(parsed, Date.now());
    if (!data) {
      const status = buildStatus('schema-changed', false, 'schema changed', 'Codex reset-credits response is missing the expected credits list / count.', {
        responseKeys: responseKeys(parsed),
      });
      logStatus(status);
      return { data: null, status, authMtimeMs: credentials.authMtimeMs, authIdentityHash: credentials.authIdentityHash };
    }
    const status = buildStatus('ok', true, '', '', { responseKeys: responseKeys(parsed) });
    logStatus(status);
    return { data, status, authMtimeMs: credentials.authMtimeMs, authIdentityHash: credentials.authIdentityHash };
  } catch (error) {
    let status = classifyRuntimeError(error);
    if (status.httpStatus === 404) {
      status = buildStatus('schema-changed', false, 'schema changed', 'Codex reset-credits endpoint returned HTTP 404 (removed or moved).', { httpStatus: 404 });
    }
    logStatus(status);
    return { data: null, status, authMtimeMs: credentials.authMtimeMs, authIdentityHash: credentials.authIdentityHash };
  }
}
