import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

export interface AutoLimits {
  h5: number;
  week: number;
  sonnetWeek: number;
  plan: string;
  source: 'credentials' | 'api' | 'default';
}

export type ApiResetMs = number | null;

export interface ApiExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number;
  usedCredits: number;
  utilization: number;
  currency: string | null;
}

export interface ApiUsagePct {
  h5Pct: number;
  weekPct: number;
  soPct: number;
  h5ResetMs: ApiResetMs;
  weekResetMs: ApiResetMs;
  soResetMs: ApiResetMs;
  plan: string;
  extraUsage: ApiExtraUsage | null;
}

export interface StoredApiUsagePct extends ApiUsagePct {
  storedAt?: number;
}

export type ClaudeApiStatusCode =
  | 'ok'
  | 'no-credentials'
  | 'timeout'
  | 'network'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'schema-changed'
  | 'http-error'
  | 'reset-unavailable';

export type ResetFieldState = 'present' | 'null' | 'missing';

export interface ClaudeApiStatus {
  code: ClaudeApiStatusCode;
  connected: boolean;
  label: string;
  detail: string;
  httpStatus?: number;
  retryAfterMs?: number;
  serverMessage?: string;
  responseKeys?: string[];
  resetFields?: {
    fiveHour: ResetFieldState;
    sevenDay: ResetFieldState;
    sevenDaySonnet: ResetFieldState;
  };
}

export interface ApiUsageFetchResult {
  usage: ApiUsagePct | null;
  status: ClaudeApiStatus;
}

interface Credentials {
  accessToken: string;
  rateLimitTier: string;
  subscriptionType: string;
}

interface UsageWindowResponse {
  utilization?: unknown;
  resets_at?: unknown;
}

class HttpResponseError extends Error {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;

  constructor(statusCode: number, body: string, headers: Record<string, string | string[] | undefined>) {
    super(`HTTP ${statusCode}`);
    this.name = 'HttpResponseError';
    this.statusCode = statusCode;
    this.body = body;
    this.headers = headers;
  }
}

let cachedClaudeUserAgent: string | null = null;

function credentialsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return path.join(configDir && configDir.trim() ? configDir : path.join(os.homedir(), '.claude'), '.credentials.json');
}

function readCredentials(): Credentials | null {
  try {
    const raw = JSON.parse(fs.readFileSync(
      credentialsPath(),
      'utf-8',
    )) as { claudeAiOauth?: { accessToken?: unknown; rateLimitTier?: unknown; subscriptionType?: unknown } };
    const oauth = raw.claudeAiOauth;
    if (!oauth?.accessToken || typeof oauth.accessToken !== 'string') return null;
    return {
      accessToken: oauth.accessToken,
      rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : '',
      subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : '',
    };
  } catch {
    return null;
  }
}

export function hasClaudeCredentials(): boolean {
  return !!readCredentials();
}

function isDebugEnabled(): boolean {
  const proc = process as NodeJS.Process & { defaultApp?: boolean };
  return proc.defaultApp === true || process.env.WMT_DEBUG_CLAUDE_API === '1';
}

function logStatus(status: ClaudeApiStatus): void {
  if (!isDebugEnabled()) return;
  console.info('[WhereMyTokens][claude-api]', {
    code: status.code,
    connected: status.connected,
    label: status.label,
    detail: status.detail,
    httpStatus: status.httpStatus,
    retryAfterMs: status.retryAfterMs,
    serverMessage: status.serverMessage,
    responseKeys: status.responseKeys,
    resetFields: status.resetFields,
  });
}

function getClaudeUserAgent(): string {
  if (cachedClaudeUserAgent !== null) return cachedClaudeUserAgent;
  try {
    const output = execFileSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 1000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const version = output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
    cachedClaudeUserAgent = version ? `claude-code/${version}` : 'claude-code/1.0';
  } catch {
    cachedClaudeUserAgent = 'claude-code/1.0';
  }
  return cachedClaudeUserAgent;
}

function httpsGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) {
            resolve(body);
            return;
          }
          reject(new HttpResponseError(statusCode, body, res.headers));
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error('timeout'));
    });
    req.end();
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asUsageWindow(value: unknown): UsageWindowResponse | null {
  const record = asRecord(value);
  if (!record) return null;
  return record;
}

function normalizePct(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function resetMs(iso: unknown, now: number): ApiResetMs {
  if (typeof iso !== 'string' || !iso) return null;
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - now);
}

function resetFieldState(window: UsageWindowResponse | null): ResetFieldState {
  if (!window || !Object.prototype.hasOwnProperty.call(window, 'resets_at')) return 'missing';
  if (window.resets_at === null) return 'null';
  return typeof window.resets_at === 'string' && window.resets_at ? 'present' : 'missing';
}

function hasValidUtilization(window: UsageWindowResponse | null): boolean {
  return !!window && typeof window.utilization === 'number' && Number.isFinite(window.utilization);
}

function hasValidResetField(window: UsageWindowResponse | null): boolean {
  return !!window
    && Object.prototype.hasOwnProperty.call(window, 'resets_at')
    && (window.resets_at === null || (typeof window.resets_at === 'string' && window.resets_at.length > 0));
}

function extraUsageSnapshot(value: unknown): ApiExtraUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  const monthlyLimitRaw = typeof record.monthly_limit === 'number' && Number.isFinite(record.monthly_limit)
    ? record.monthly_limit
    : (typeof record.monthlyLimit === 'number' && Number.isFinite(record.monthlyLimit) ? record.monthlyLimit : 0);
  const usedCreditsRaw = typeof record.used_credits === 'number' && Number.isFinite(record.used_credits)
    ? record.used_credits
    : (typeof record.usedCredits === 'number' && Number.isFinite(record.usedCredits) ? record.usedCredits : 0);
  const utilizationValue = normalizePct(record.utilization);
  const currency = typeof record.currency === 'string' ? record.currency : null;
  return {
    isEnabled: record.is_enabled === true || record.isEnabled === true,
    monthlyLimit: Math.max(0, monthlyLimitRaw),
    usedCredits: Math.max(0, usedCreditsRaw),
    utilization: utilizationValue,
    currency,
  };
}

function normalizeResetValue(value: unknown): ApiResetMs {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, value);
}

export function normalizeStoredApiUsagePct(value: unknown): StoredApiUsagePct | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.plan !== 'string') return null;

  const storedAt = typeof record.storedAt === 'number' && Number.isFinite(record.storedAt)
    ? record.storedAt
    : undefined;

  return {
    h5Pct: normalizePct(record.h5Pct),
    weekPct: normalizePct(record.weekPct),
    soPct: normalizePct(record.soPct),
    h5ResetMs: normalizeResetValue(record.h5ResetMs),
    weekResetMs: normalizeResetValue(record.weekResetMs),
    soResetMs: normalizeResetValue(record.soResetMs),
    plan: record.plan,
    extraUsage: extraUsageSnapshot(record.extraUsage),
    storedAt,
  };
}

function buildStatus(
  code: ClaudeApiStatusCode,
  connected: boolean,
  label: string,
  detail: string,
  extras: Omit<ClaudeApiStatus, 'code' | 'connected' | 'label' | 'detail'> = {},
): ClaudeApiStatus {
  return { code, connected, label, detail, ...extras };
}

function cleanServerMessage(message: string): string {
  return message
    .replace(/\s*Please try again later\.?\s*$/i, '')
    .trim();
}

function serverMessageFromBody(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const record = asRecord(parsed);
    if (!record) return cleanServerMessage(trimmed) || undefined;
    const error = record.error;
    if (typeof error === 'string') return cleanServerMessage(error) || undefined;
    const errorRecord = asRecord(error);
    const message = errorRecord && typeof errorRecord.message === 'string'
      ? errorRecord.message
      : (typeof record.message === 'string' ? record.message : '');
    return cleanServerMessage(message) || undefined;
  } catch {
    return cleanServerMessage(trimmed) || undefined;
  }
}

function withServerMessage(base: string, message: string | undefined): string {
  return message ? `${base} ${message}` : base;
}

function retryAfterMsFromHeader(header: string | string[] | undefined, now = Date.now()): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const timestamp = new Date(raw).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

function classifyHttpError(error: HttpResponseError): ClaudeApiStatus {
  const serverMessage = serverMessageFromBody(error.body);
  switch (error.statusCode) {
    case 401:
      return buildStatus(
        'unauthorized',
        false,
        'auth failed',
        withServerMessage('Claude CLI token was rejected or expired.', serverMessage),
        { httpStatus: 401, serverMessage },
      );
    case 403:
      return buildStatus(
        'forbidden',
        false,
        'forbidden',
        withServerMessage('Claude API denied this account or beta surface.', serverMessage),
        { httpStatus: 403, serverMessage },
      );
    case 429: {
      const retryAfterMs = retryAfterMsFromHeader(error.headers['retry-after']);
      return buildStatus(
        'rate-limited',
        false,
        'rate limited',
        withServerMessage('Claude API returned HTTP 429.', serverMessage),
        { httpStatus: 429, retryAfterMs, serverMessage },
      );
    }
    default:
      return buildStatus(
        'http-error',
        false,
        'api disconnected',
        withServerMessage(`Claude API returned HTTP ${error.statusCode}.`, serverMessage),
        { httpStatus: error.statusCode, serverMessage },
      );
  }
}

function classifyRuntimeError(error: unknown): ClaudeApiStatus {
  if (error instanceof HttpResponseError) return classifyHttpError(error);

  if (error instanceof Error) {
    if (error.message === 'timeout') {
      return buildStatus('timeout', false, 'api timeout', 'Claude API request timed out.');
    }

    const code = (error as Error & { code?: string }).code;
    if (typeof code === 'string' && code.length > 0) {
      return buildStatus('network', false, 'api disconnected', `Claude API network error (${code}).`);
    }

    return buildStatus('http-error', false, 'api disconnected', error.message || 'Claude API request failed.');
  }

  return buildStatus('http-error', false, 'api disconnected', 'Claude API request failed.');
}

function missingCoreWindowStatus(responseKeys: string[], resetFields: ClaudeApiStatus['resetFields']): ClaudeApiStatus {
  return buildStatus(
    'schema-changed',
    false,
    'schema changed',
    'Claude API response is missing expected usage windows.',
    { responseKeys, resetFields },
  );
}

function invalidCoreWindowStatus(
  responseKeys: string[],
  resetFields: ClaudeApiStatus['resetFields'],
  invalidFields: string[],
): ClaudeApiStatus {
  return buildStatus(
    'schema-changed',
    false,
    'schema changed',
    `Claude API response has invalid core usage fields: ${invalidFields.join(', ')}.`,
    { responseKeys, resetFields },
  );
}

function planFromTier(tier: string, sub: string): string {
  const t = tier.toLowerCase();
  const s = sub.toLowerCase();
  if (t.includes('max_5') || t.includes('5x')) return 'Max 5x';
  if (t.includes('max') || s === 'max') return 'Max 1x';
  if (t.includes('pro') || s === 'pro') return 'Pro';
  if (t.includes('free') || s === 'free') return 'Free';
  return sub || tier || 'Unknown';
}

function limitsFromTier(tier: string, sub: string): AutoLimits {
  const t = tier.toLowerCase();
  const s = sub.toLowerCase();
  if (t.includes('max_5') || t.includes('5x')) {
    return { h5: 975, week: 7640, sonnetWeek: 1_280_000_000, plan: 'Max 5x', source: 'credentials' };
  }
  if (t.includes('max') || s === 'max') {
    return { h5: 195, week: 1528, sonnetWeek: 256_000_000, plan: 'Max 1x', source: 'credentials' };
  }
  if (t.includes('pro') || s === 'pro') {
    return { h5: 45, week: 180, sonnetWeek: 50_000_000, plan: 'Pro', source: 'credentials' };
  }
  if (t.includes('free') || s === 'free') {
    return { h5: 10, week: 50, sonnetWeek: 10_000_000, plan: 'Free', source: 'credentials' };
  }
  return { h5: 100, week: 500, sonnetWeek: 100_000_000, plan: sub || tier || 'Unknown', source: 'default' };
}

export async function fetchApiUsagePct(): Promise<ApiUsageFetchResult> {
  const cred = readCredentials();
  if (!cred) {
    const status = buildStatus('no-credentials', false, 'local only', 'Claude credentials were not found.');
    logStatus(status);
    return { usage: null, status };
  }

  try {
    const body = await httpsGet('https://api.anthropic.com/api/oauth/usage', {
      Authorization: `Bearer ${cred.accessToken}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': getClaudeUserAgent(),
    });

    const parsed = JSON.parse(body) as unknown;
    const data = asRecord(parsed);
    if (!data) {
      const status = buildStatus('schema-changed', false, 'schema changed', 'Claude API returned a non-object response.');
      logStatus(status);
      return { usage: null, status };
    }

    const fiveHour = asUsageWindow(data.five_hour);
    const sevenDay = asUsageWindow(data.seven_day);
    const sevenDaySonnet = asUsageWindow(data.seven_day_sonnet);
    const responseKeys = Object.keys(data).sort();
    const resetFields = {
      fiveHour: resetFieldState(fiveHour),
      sevenDay: resetFieldState(sevenDay),
      sevenDaySonnet: resetFieldState(sevenDaySonnet),
    } satisfies NonNullable<ClaudeApiStatus['resetFields']>;

    if (!fiveHour || !sevenDay) {
      const status = missingCoreWindowStatus(responseKeys, resetFields);
      logStatus(status);
      return { usage: null, status };
    }

    const invalidCoreFields: string[] = [];
    if (!hasValidUtilization(fiveHour)) invalidCoreFields.push('five_hour.utilization');
    if (!hasValidUtilization(sevenDay)) invalidCoreFields.push('seven_day.utilization');
    if (!hasValidResetField(fiveHour)) invalidCoreFields.push('five_hour.resets_at');
    if (!hasValidResetField(sevenDay)) invalidCoreFields.push('seven_day.resets_at');
    if (invalidCoreFields.length > 0) {
      const status = invalidCoreWindowStatus(responseKeys, resetFields, invalidCoreFields);
      logStatus(status);
      return { usage: null, status };
    }

    const validSonnetWindow = sevenDaySonnet && hasValidUtilization(sevenDaySonnet) && hasValidResetField(sevenDaySonnet)
      ? sevenDaySonnet
      : null;
    const now = Date.now();
    const usage: ApiUsagePct = {
      h5Pct: normalizePct(fiveHour?.utilization),
      weekPct: normalizePct(sevenDay?.utilization),
      soPct: normalizePct(validSonnetWindow?.utilization),
      h5ResetMs: resetMs(fiveHour?.resets_at, now),
      weekResetMs: resetMs(sevenDay?.resets_at, now),
      soResetMs: resetMs(validSonnetWindow?.resets_at, now),
      plan: planFromTier(cred.rateLimitTier, cred.subscriptionType),
      extraUsage: extraUsageSnapshot(data.extra_usage),
    };

    const unknownResetFields = [
      resetFields.fiveHour === 'null' ? 'five_hour' : null,
      resetFields.sevenDay === 'null' ? 'seven_day' : null,
      sevenDaySonnet && !validSonnetWindow ? 'seven_day_sonnet' : (resetFields.sevenDaySonnet === 'null' ? 'seven_day_sonnet' : null),
    ].filter((field): field is string => !!field);

    const status = unknownResetFields.length > 0
      ? buildStatus(
          'reset-unavailable',
          true,
          'reset partial',
          `${unknownResetFields.join(', ')} reset is unavailable.`,
          { responseKeys, resetFields },
        )
      : buildStatus('ok', true, '', '', { responseKeys, resetFields });

    logStatus(status);
    return { usage, status };
  } catch (error) {
    const status = classifyRuntimeError(error);
    logStatus(status);
    return { usage: null, status };
  }
}

export async function fetchAutoLimits(): Promise<AutoLimits | null> {
  const cred = readCredentials();
  if (!cred) return null;
  if (cred.rateLimitTier || cred.subscriptionType) {
    return limitsFromTier(cred.rateLimitTier, cred.subscriptionType);
  }
  return null;
}

export function getPlanName(): string {
  const cred = readCredentials();
  if (!cred) return '';
  return planFromTier(cred.rateLimitTier, cred.subscriptionType);
}
