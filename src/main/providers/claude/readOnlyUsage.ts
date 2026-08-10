import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import type {
  ClaudeStatusLineRateLimitWindow,
  ClaudeStatusLineScopedWindow,
} from '../../../shared/claudeStatusLine';

export const CLAUDE_COMPATIBILITY_MIN_INTERVAL_MS = 15 * 60 * 1000;
export const CLAUDE_COMPATIBILITY_MAX_BACKOFF_MS = 60 * 60 * 1000;

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_USAGE_USER_AGENT = 'WhereMyTokens/1.24.1';
const MAX_RESPONSE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;

export type ClaudeCompatibilityStatusCode =
  | 'compatibility-api'
  | 'no-credentials'
  | 'credentials-expired'
  | 'timeout'
  | 'network'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'schema-changed'
  | 'http-error';

export interface ClaudeCompatibilityStatus {
  code: ClaudeCompatibilityStatusCode;
  connected: boolean;
  label: string;
  detail: string;
  httpStatus?: number;
  retryAfterMs?: number;
  responseKeys?: string[];
}

export interface ClaudeCompatibilityExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number;
  usedCredits: number;
  utilization: number;
}

export interface ClaudeCompatibilityUsage {
  fiveHour?: ClaudeStatusLineRateLimitWindow;
  sevenDay?: ClaudeStatusLineRateLimitWindow;
  modelScoped: ClaudeStatusLineScopedWindow[];
  planName: string;
  extraUsage: ClaudeCompatibilityExtraUsage | null;
}

export interface ClaudeCompatibilityFetchResult {
  usage: ClaudeCompatibilityUsage | null;
  status: ClaudeCompatibilityStatus;
  capturedAt: number;
  credentialMarker?: string | null;
}

interface ClaudeCredentials {
  accessToken: string;
  marker: string;
  planName: string;
  expiresAtMs: number | null;
}

interface UsageHttpResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

type UsageHttpGet = (headers: Record<string, string>) => Promise<UsageHttpResponse>;

interface CachedResult {
  marker: string;
  result: ClaudeCompatibilityFetchResult;
  nextAllowedAt: number;
}

let cachedResult: CachedResult | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizedPct(value: unknown): number | null {
  const numberValue = finiteNumber(value);
  return numberValue == null ? null : Math.max(0, Math.min(100, numberValue));
}

function resetAtMs(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseWindow(value: unknown): ClaudeStatusLineRateLimitWindow | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const usedPct = normalizedPct(record.utilization);
  const resetsAtMs = resetAtMs(record.resets_at);
  if (usedPct == null || resetsAtMs === undefined) return undefined;
  return { usedPct, resetsAtMs };
}

function scopedLabel(record: Record<string, unknown>): string {
  const scope = asRecord(record.scope);
  const model = asRecord(scope?.model);
  const label = typeof model?.display_name === 'string' ? model.display_name : '';
  return label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
}

function parseScopedWindows(value: unknown): ClaudeStatusLineScopedWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: ClaudeStatusLineScopedWindow[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (windows.length >= 8) break;
    const record = asRecord(raw);
    if (!record || record.kind !== 'weekly_scoped' || record.group !== 'weekly') continue;
    const label = scopedLabel(record);
    const usedPct = normalizedPct(record.percent);
    const resetsAtMs = resetAtMs(record.resets_at);
    const key = label.toLocaleLowerCase('en-US');
    if (!label || usedPct == null || resetsAtMs === undefined || seen.has(key)) continue;
    seen.add(key);
    windows.push({ label, usedPct, resetsAtMs });
  }
  return windows;
}

function parseExtraUsage(value: unknown): ClaudeCompatibilityExtraUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  const monthlyLimit = finiteNumber(record.monthly_limit) ?? finiteNumber(record.monthlyLimit) ?? 0;
  const usedCredits = finiteNumber(record.used_credits) ?? finiteNumber(record.usedCredits) ?? 0;
  const utilization = normalizedPct(record.utilization) ?? 0;
  return {
    isEnabled: record.is_enabled === true || record.isEnabled === true,
    monthlyLimit: Math.max(0, monthlyLimit),
    usedCredits: Math.max(0, usedCredits),
    utilization,
  };
}

export function parseClaudeCompatibilityUsage(
  value: unknown,
  planName = '',
): ClaudeCompatibilityUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  const fiveHour = parseWindow(record.five_hour);
  const sevenDay = parseWindow(record.seven_day);
  const modelScoped = parseScopedWindows(record.limits);
  if (!fiveHour && !sevenDay && modelScoped.length === 0) return null;
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    modelScoped,
    planName,
    extraUsage: parseExtraUsage(record.extra_usage),
  };
}

export function claudeCompatibilityCredentialsPath(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const directory = configured && configured.trim() ? configured.trim() : path.join(os.homedir(), '.claude');
  return path.join(directory, '.credentials.json');
}

function planFromCredentials(rateLimitTier: string, subscriptionType: string): string {
  const tier = rateLimitTier.toLowerCase();
  const subscription = subscriptionType.toLowerCase();
  if (tier.includes('max_5') || tier.includes('5x')) return 'Max 5x';
  if (tier.includes('max') || subscription === 'max') return 'Max';
  if (tier.includes('pro') || subscription === 'pro') return 'Pro';
  if (tier.includes('free') || subscription === 'free') return 'Free';
  return subscriptionType || rateLimitTier || '';
}

function readCredentials(): ClaudeCredentials | null {
  try {
    const raw = JSON.parse(fs.readFileSync(claudeCompatibilityCredentialsPath(), 'utf8')) as unknown;
    const oauth = asRecord(asRecord(raw)?.claudeAiOauth);
    const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken : '';
    if (!accessToken) return null;
    const rateLimitTier = typeof oauth?.rateLimitTier === 'string' ? oauth.rateLimitTier : '';
    const subscriptionType = typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : '';
    const expiresAt = finiteNumber(oauth?.expiresAt);
    const digest = crypto.createHash('sha256').update(accessToken).digest('hex').slice(0, 16);
    return {
      accessToken,
      marker: digest,
      planName: planFromCredentials(rateLimitTier, subscriptionType),
      expiresAtMs: expiresAt != null && expiresAt > 0 ? expiresAt : null,
    };
  } catch {
    return null;
  }
}

export function getClaudeCompatibilityCredentialMarker(): string | null {
  return readCredentials()?.marker ?? null;
}

function httpsGet(headers: Record<string, string>): Promise<UsageHttpResponse> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(CLAUDE_USAGE_URL);
    if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'api.anthropic.com') {
      reject(new Error('unsafe-endpoint'));
      return;
    }
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.request({
      protocol: 'https:',
      hostname: endpoint.hostname,
      port: 443,
      path: endpoint.pathname,
      method: 'GET',
      headers,
    }, response => {
      let body = '';
      let bodyBytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        bodyBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        if (bodyBytes > MAX_RESPONSE_BYTES) {
          fail(new Error('response-too-large'));
          request.destroy();
          return;
        }
        body += chunk;
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode ?? 0, body, headers: response.headers });
      });
    });
    request.on('error', fail);
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('timeout')));
    request.end();
  });
}

let httpsGetImpl: UsageHttpGet = httpsGet;

export function __setClaudeCompatibilityHttpForTest(impl: UsageHttpGet | null): void {
  httpsGetImpl = impl ?? httpsGet;
}

export function invalidateClaudeCompatibilityUsageCache(): void {
  cachedResult = null;
}

export function __resetClaudeCompatibilityStateForTest(): void {
  invalidateClaudeCompatibilityUsageCache();
}

function status(
  code: ClaudeCompatibilityStatusCode,
  connected: boolean,
  label: string,
  detail: string,
  extras: Omit<ClaudeCompatibilityStatus, 'code' | 'connected' | 'label' | 'detail'> = {},
): ClaudeCompatibilityStatus {
  return { code, connected, label, detail, ...extras };
}

function retryAfterMs(value: string | string[] | undefined, nowMs: number): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !raw.trim()) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.min(CLAUDE_COMPATIBILITY_MAX_BACKOFF_MS, Math.max(0, Math.round(seconds * 1000)));
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(CLAUDE_COMPATIBILITY_MAX_BACKOFF_MS, Math.max(0, timestamp - nowMs));
}

function failureFromResponse(response: UsageHttpResponse, nowMs: number): ClaudeCompatibilityStatus {
  if (response.status === 401) {
    return status(
      'unauthorized',
      false,
      'Claude login required',
      'Claude Code rejected the saved login. Open the official Claude Code login to continue quota tracking.',
      { httpStatus: 401 },
    );
  }
  if (response.status === 403) {
    return status('forbidden', false, 'compatibility unavailable', 'Anthropic denied the read-only compatibility request.', { httpStatus: 403 });
  }
  if (response.status === 429) {
    const retry = retryAfterMs(response.headers['retry-after'], nowMs);
    return status(
      'rate-limited',
      false,
      'retrying later',
      'Anthropic rate-limited the read-only compatibility request.',
      { httpStatus: 429, ...(retry != null ? { retryAfterMs: retry } : {}) },
    );
  }
  return status(
    'http-error',
    false,
    'compatibility unavailable',
    `Anthropic returned HTTP ${response.status} for the read-only compatibility request.`,
    { httpStatus: response.status },
  );
}

function failureFromError(error: unknown): ClaudeCompatibilityStatus {
  if (error instanceof Error && error.message === 'timeout') {
    return status('timeout', false, 'compatibility timeout', 'The read-only Claude compatibility request timed out.');
  }
  if (error instanceof Error && error.message === 'response-too-large') {
    return status('http-error', false, 'compatibility unavailable', 'The Claude compatibility response exceeded the safety limit.');
  }
  const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
  if (code) return status('network', false, 'compatibility offline', `Claude compatibility network error (${code}).`);
  return status('http-error', false, 'compatibility unavailable', 'The read-only Claude compatibility request failed.');
}

function nextDelayForStatus(resultStatus: ClaudeCompatibilityStatus): number {
  if (resultStatus.code === 'rate-limited') {
    return Math.max(CLAUDE_COMPATIBILITY_MIN_INTERVAL_MS, resultStatus.retryAfterMs ?? 0);
  }
  if (resultStatus.code === 'credentials-expired' || resultStatus.code === 'unauthorized' || resultStatus.code === 'forbidden') {
    return Number.POSITIVE_INFINITY;
  }
  if (resultStatus.code === 'schema-changed') {
    return CLAUDE_COMPATIBILITY_MAX_BACKOFF_MS;
  }
  return CLAUDE_COMPATIBILITY_MIN_INTERVAL_MS;
}

export async function fetchClaudeCompatibilityUsage(
  options: { nowMs?: number } = {},
): Promise<ClaudeCompatibilityFetchResult> {
  const nowMs = options.nowMs ?? Date.now();
  const credentials = readCredentials();
  if (!credentials) {
    return {
      usage: null,
      capturedAt: nowMs,
      credentialMarker: null,
      status: status('no-credentials', false, 'Claude Code required', 'Claude Code credentials were not found for the read-only compatibility check.'),
    };
  }

  if (credentials.expiresAtMs != null && credentials.expiresAtMs <= nowMs) {
    const result: ClaudeCompatibilityFetchResult = {
      usage: null,
      capturedAt: nowMs,
      credentialMarker: credentials.marker,
      status: status(
        'credentials-expired',
        false,
        'Claude login required',
        'The saved Claude Code access token expired. Continue in the official Claude Code login to restore quota tracking.',
      ),
    };
    cachedResult = {
      marker: credentials.marker,
      result,
      nextAllowedAt: Number.POSITIVE_INFINITY,
    };
    return result;
  }

  const sameCredentials = cachedResult?.marker === credentials.marker;
  if (sameCredentials && cachedResult && nowMs < cachedResult.nextAllowedAt) {
    return cachedResult.result;
  }

  let result: ClaudeCompatibilityFetchResult;
  try {
    const response = await httpsGetImpl({
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'User-Agent': CLAUDE_USAGE_USER_AGENT,
    });
    if (response.status < 200 || response.status >= 300) {
      const responseStatus = failureFromResponse(response, nowMs);
      result = { usage: null, status: responseStatus, capturedAt: nowMs };
    } else {
      let payload: unknown;
      try {
        payload = JSON.parse(response.body) as unknown;
      } catch {
        payload = null;
      }
      const usage = parseClaudeCompatibilityUsage(payload, credentials.planName);
      if (!usage) {
        const responseKeys = Object.keys(asRecord(payload) ?? {}).sort();
        result = {
          usage: null,
          capturedAt: nowMs,
          status: status(
            'schema-changed',
            false,
            'compatibility changed',
            'Anthropic returned no recognized Claude quota windows.',
            { responseKeys },
          ),
        };
      } else {
        result = {
          usage,
          capturedAt: nowMs,
          status: status(
            'compatibility-api',
            true,
            'compatibility',
            'Read-only Claude Desktop compatibility data; credentials are never refreshed or changed.',
            { responseKeys: Object.keys(asRecord(payload) ?? {}).sort() },
          ),
        };
      }
    }
  } catch (error) {
    result = { usage: null, status: failureFromError(error), capturedAt: nowMs };
  }

  result = { ...result, credentialMarker: credentials.marker };
  cachedResult = {
    marker: credentials.marker,
    result,
    nextAllowedAt: nowMs + nextDelayForStatus(result.status),
  };
  return result;
}

export function claudeCompatibilityUsageUrlForTest(): string {
  return CLAUDE_USAGE_URL;
}
