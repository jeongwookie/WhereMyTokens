import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 8000;
const OAUTH_REFRESH_COOLDOWN_KEY = '_oauthRefreshCooldown';
const RATE_LIMIT_BACKOFF_LADDER_MIN = [30, 120, 360, 1440] as const;
const KILL_SWITCH_RETRY_MS = 60 * 60 * 1000;

export type RefreshOutcome =
  | { kind: 'ok'; accessToken: string; expiresAt: number }
  | { kind: 'invalid-grant'; serverMessage?: string }
  | {
      kind: 'rate-limited';
      serverMessage?: string;
      retryAfterMs?: number;
      retryAt?: number;
      reason?: OAuthRefreshCooldownReason;
      consecutiveCount?: number;
      serverRetryAfterMs?: number;
    }
  | { kind: 'network'; reason: string }
  | { kind: 'unexpected'; status: number; body: string };

export type OAuthRefreshCooldownReason = 'http-429' | 'invalid-grant' | 'kill-switch';

export interface OAuthRefreshCooldown {
  until: number;
  reason: OAuthRefreshCooldownReason;
  consecutiveCount: number;
  recordedAt: number;
  serverMessage?: string;
  retryAfterMs?: number;
  credentialMarker?: string;
}

export interface OAuthCredentialState {
  hasCredentials: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  expiresAt: number | null;
  isExpired: boolean;
  shouldRefresh: boolean;
  msUntilExpiry: number | null;
}

export interface OAuthCredentialFileState extends OAuthCredentialState {
  mtimeMs: number | null;
  size: number | null;
}

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

type PostForm = (
  url: string,
  params: Record<string, string>,
  userAgent: string,
) => Promise<{ status: number; body: string; headers?: Record<string, string | string[] | undefined> }>;

interface OAuthRefreshStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

interface RefreshAttemptResult {
  outcome: RefreshOutcome;
  networkAttempted: boolean;
  httpStatus?: number;
}

let inflight: Promise<RefreshAttemptResult> | null = null;
let postFormImpl: PostForm = postForm;
let refreshStore: OAuthRefreshStore | null = null;
let memoryCooldown: OAuthRefreshCooldown | null = null;

export function initOAuthRefresh(store: OAuthRefreshStore): void {
  refreshStore = store;
  memoryCooldown = readPersistedCooldown();
}

function credentialsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return path.join(configDir && configDir.trim() ? configDir : path.join(os.homedir(), '.claude'), '.credentials.json');
}

function readCredentialsFile(): CredentialsFile | null {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(), 'utf-8')) as CredentialsFile;
  } catch {
    return null;
  }
}

export function writeCredentialsAtomic(updated: CredentialsFile): void {
  const target = credentialsPath();
  const backup = `${target}.bak`;
  const tmp = `${target}.tmp.${process.pid}`;
  let fd: number | null = null;

  try {
    try {
      fs.copyFileSync(target, backup);
    } catch {
      // A missing backup should not block a successful refresh write.
    }

    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, JSON.stringify(updated, null, 2), 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // Best effort cleanup.
    }
  }
}

function killSwitchEngaged(): boolean {
  return process.env.WMT_DISABLE_REFRESH === '1';
}

function isCooldownReason(value: unknown): value is OAuthRefreshCooldownReason {
  return value === 'http-429' || value === 'invalid-grant' || value === 'kill-switch';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function currentCredentialMarker(): string | null {
  const state = getOAuthCredentialFileState();
  if (!state.hasCredentials) return null;
  return [
    state.mtimeMs ?? 'no-mtime',
    state.size ?? 'no-size',
    state.expiresAt ?? 'no-expiry',
    state.hasAccessToken ? 'access' : 'no-access',
    state.hasRefreshToken ? 'refresh' : 'no-refresh',
  ].join(':');
}

function normalizeCooldown(value: unknown): OAuthRefreshCooldown | null {
  const record = asRecord(value);
  if (!record) return null;
  const until = typeof record.until === 'number' && Number.isFinite(record.until) ? record.until : null;
  const recordedAt = typeof record.recordedAt === 'number' && Number.isFinite(record.recordedAt) ? record.recordedAt : null;
  const rawCount = typeof record.consecutiveCount === 'number' && Number.isFinite(record.consecutiveCount)
    ? record.consecutiveCount
    : 0;
  const retryAfterMs = typeof record.retryAfterMs === 'number' && Number.isFinite(record.retryAfterMs)
    ? record.retryAfterMs
    : undefined;
  if (until == null || recordedAt == null || !isCooldownReason(record.reason)) return null;
  return {
    until,
    reason: record.reason,
    consecutiveCount: Math.max(0, Math.floor(rawCount)),
    recordedAt,
    serverMessage: typeof record.serverMessage === 'string' ? record.serverMessage : undefined,
    retryAfterMs,
    credentialMarker: typeof record.credentialMarker === 'string' && record.credentialMarker.length > 0
      ? record.credentialMarker
      : undefined,
  };
}

function cooldownMatchesCurrentCredential(cooldown: OAuthRefreshCooldown): boolean {
  if (!cooldown.credentialMarker) return true;
  const credentialMarker = currentCredentialMarker();
  return !credentialMarker || credentialMarker === cooldown.credentialMarker;
}

function readPersistedCooldown(): OAuthRefreshCooldown | null {
  if (!refreshStore) return memoryCooldown;
  try {
    const normalized = normalizeCooldown(refreshStore.get(OAUTH_REFRESH_COOLDOWN_KEY));
    if (!normalized) {
      try {
        refreshStore.delete(OAUTH_REFRESH_COOLDOWN_KEY);
      } catch {
        // Memory fallback still handles the current process.
      }
      return null;
    }
    if (!cooldownMatchesCurrentCredential(normalized)) {
      try {
        refreshStore.delete(OAUTH_REFRESH_COOLDOWN_KEY);
      } catch {
        // The current credentials should be allowed to refresh anyway.
      }
      return null;
    }
    return normalized;
  } catch {
    return memoryCooldown;
  }
}

function getCooldown(): OAuthRefreshCooldown | null {
  const cooldown = readPersistedCooldown();
  memoryCooldown = cooldown;
  return cooldown;
}

function setCooldown(cooldown: OAuthRefreshCooldown): void {
  memoryCooldown = cooldown;
  if (!refreshStore) return;
  try {
    refreshStore.set(OAUTH_REFRESH_COOLDOWN_KEY, cooldown);
  } catch {
    // Memory fallback still protects the current process.
  }
}

function clearCooldown(): void {
  memoryCooldown = null;
  if (!refreshStore) return;
  try {
    refreshStore.delete(OAUTH_REFRESH_COOLDOWN_KEY);
  } catch {
    // Ignore store cleanup failures after a successful refresh.
  }
}

function nextCooldownMs(serverRetryAfterMs: number | undefined, consecutiveCount: number): number {
  const idx = Math.min(Math.max(0, consecutiveCount - 1), RATE_LIMIT_BACKOFF_LADDER_MIN.length - 1);
  return Math.max(serverRetryAfterMs ?? 0, RATE_LIMIT_BACKOFF_LADDER_MIN[idx] * 60_000);
}

function rateLimitedFromCooldown(cooldown: OAuthRefreshCooldown, now: number): Extract<RefreshOutcome, { kind: 'rate-limited' }> {
  return {
    kind: 'rate-limited',
    serverMessage: cooldown.serverMessage,
    retryAfterMs: Math.max(0, cooldown.until - now),
    retryAt: cooldown.until,
    reason: cooldown.reason,
    consecutiveCount: cooldown.consecutiveCount,
    serverRetryAfterMs: cooldown.retryAfterMs,
  };
}

function recordHttp429Cooldown(serverMessage: string | undefined, serverRetryAfterMs: number | undefined): Extract<RefreshOutcome, { kind: 'rate-limited' }> {
  const previous = getCooldown();
  const credentialMarker = currentCredentialMarker();
  const sameCredential = !!credentialMarker
    && previous?.reason === 'http-429'
    && previous.credentialMarker === credentialMarker;
  const consecutiveCount = sameCredential ? previous.consecutiveCount + 1 : 1;
  const retryAfterMs = nextCooldownMs(serverRetryAfterMs, consecutiveCount);
  const now = Date.now();
  const cooldown: OAuthRefreshCooldown = {
    until: now + retryAfterMs,
    reason: 'http-429',
    consecutiveCount,
    recordedAt: now,
    serverMessage,
    retryAfterMs: serverRetryAfterMs,
    credentialMarker: credentialMarker ?? undefined,
  };
  setCooldown(cooldown);
  return {
    kind: 'rate-limited',
    serverMessage,
    retryAfterMs,
    retryAt: cooldown.until,
    reason: 'http-429',
    consecutiveCount,
    serverRetryAfterMs,
  };
}

export function getOAuthCredentialState(): OAuthCredentialState {
  const cred = readCredentialsFile();
  const oauth = cred?.claudeAiOauth;
  const accessToken = oauth?.accessToken;
  const refreshToken = oauth?.refreshToken;
  const expiresAt = oauth?.expiresAt;
  const hasAccessToken = typeof accessToken === 'string' && accessToken.length > 0;
  const hasRefreshToken = typeof refreshToken === 'string' && refreshToken.length > 0;
  const normalizedExpiresAt = typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : null;
  const msUntilExpiry = normalizedExpiresAt == null ? null : normalizedExpiresAt - Date.now();
  return {
    hasCredentials: !!cred,
    hasAccessToken,
    hasRefreshToken,
    expiresAt: normalizedExpiresAt,
    isExpired: typeof msUntilExpiry === 'number' ? msUntilExpiry <= 0 : false,
    shouldRefresh: typeof msUntilExpiry === 'number' ? msUntilExpiry < REFRESH_LEEWAY_MS : false,
    msUntilExpiry,
  };
}

export function getOAuthCredentialFileState(): OAuthCredentialFileState {
  const state = getOAuthCredentialState();
  let mtimeMs: number | null = null;
  let size: number | null = null;
  try {
    const stat = fs.statSync(credentialsPath());
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    // Credential parsing above remains the source of truth.
  }
  return { ...state, mtimeMs, size };
}

export async function refreshNow(userAgent: string, _trigger = 'unknown'): Promise<RefreshOutcome> {
  const now = Date.now();
  const cooldownBefore = getCooldown();
  if (killSwitchEngaged()) {
    return {
      kind: 'rate-limited',
      serverMessage: 'disabled by WMT_DISABLE_REFRESH',
      retryAfterMs: KILL_SWITCH_RETRY_MS,
      retryAt: now + KILL_SWITCH_RETRY_MS,
      reason: 'kill-switch',
      consecutiveCount: cooldownBefore?.consecutiveCount ?? 0,
    };
  }
  if (cooldownBefore && now < cooldownBefore.until) {
    return rateLimitedFromCooldown(cooldownBefore, now);
  }
  if (inflight) {
    const joined = await inflight;
    return joined.outcome;
  }
  inflight = doRefresh(userAgent).finally(() => {
    inflight = null;
  });
  const result = await inflight;
  return result.outcome;
}

async function doRefresh(userAgent: string): Promise<RefreshAttemptResult> {
  const cred = readCredentialsFile();
  const oauth = cred?.claudeAiOauth;
  const refreshToken = oauth?.refreshToken;
  if (!cred || !oauth || typeof refreshToken !== 'string' || refreshToken.length === 0) {
    return { outcome: { kind: 'invalid-grant' }, networkAttempted: false };
  }

  let resp: { status: number; body: string; headers?: Record<string, string | string[] | undefined> };
  try {
    resp = await postFormImpl(TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }, userAgent);
  } catch (error) {
    return { outcome: { kind: 'network', reason: String((error as Error)?.message ?? error) }, networkAttempted: true };
  }

  if (resp.status === 400 || resp.status === 401) {
    return {
      outcome: { kind: 'invalid-grant', serverMessage: refreshErrorMessage(resp.body) },
      networkAttempted: true,
      httpStatus: resp.status,
    };
  }

  if (resp.status === 429) {
    return {
      outcome: recordHttp429Cooldown(refreshErrorMessage(resp.body), retryAfterMsFromHeader(resp.headers?.['retry-after'])),
      networkAttempted: true,
      httpStatus: resp.status,
    };
  }

  if (resp.status < 200 || resp.status >= 300) {
    return {
      outcome: { kind: 'unexpected', status: resp.status, body: resp.body.slice(0, 500) },
      networkAttempted: true,
      httpStatus: resp.status,
    };
  }

  let parsed: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(resp.body) as typeof parsed;
  } catch {
    return {
      outcome: { kind: 'unexpected', status: resp.status, body: resp.body.slice(0, 500) },
      networkAttempted: true,
      httpStatus: resp.status,
    };
  }

  if (typeof parsed.access_token !== 'string' || typeof parsed.expires_in !== 'number' || !Number.isFinite(parsed.expires_in)) {
    return {
      outcome: { kind: 'unexpected', status: resp.status, body: resp.body.slice(0, 500) },
      networkAttempted: true,
      httpStatus: resp.status,
    };
  }

  const expiresAt = Date.now() + parsed.expires_in * 1000;
  const updated: CredentialsFile = {
    ...cred,
    claudeAiOauth: {
      ...oauth,
      accessToken: parsed.access_token,
      refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0
        ? parsed.refresh_token
        : refreshToken,
      expiresAt,
    },
  };
  writeCredentialsAtomic(updated);
  clearCooldown();

  return { outcome: { kind: 'ok', accessToken: parsed.access_token, expiresAt }, networkAttempted: true, httpStatus: resp.status };
}

function refreshErrorMessage(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const record = asRecord(parsed);
    if (!record) return trimmed.slice(0, 500);
    if (typeof record.error === 'string') return record.error;
    const error = asRecord(record.error);
    if (error && typeof error.message === 'string') return error.message;
    if (typeof record.message === 'string') return record.message;
  } catch {
    return trimmed.slice(0, 500);
  }
  return undefined;
}

function retryAfterMsFromHeader(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const timestamp = new Date(raw).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

async function postForm(
  url: string,
  params: Record<string, string>,
  userAgent: string,
): Promise<{ status: number; body: string; headers?: Record<string, string | string[] | undefined> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': userAgent,
      },
      body: new URLSearchParams(params),
      signal: controller.signal,
    });
    const headers: Record<string, string | undefined> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: res.status, body: await res.text(), headers };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function __setOAuthRefreshPostForTest(impl: PostForm | null): void {
  postFormImpl = impl ?? postForm;
  inflight = null;
}

export function __clearOAuthRefreshForTest(): void {
  postFormImpl = postForm;
  inflight = null;
  clearCooldown();
  refreshStore = null;
  memoryCooldown = null;
}
