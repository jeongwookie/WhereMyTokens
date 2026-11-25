import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { delimiter, isAbsolute, join } from 'path';
import { promisify } from 'util';
import type { AntigravityQuotaSummaryResponse } from './types';

const execFileAsync = promisify(execFile);
const CLI_CACHE_MS = 60_000;
const CLI_MIN_RETRY_MS = 15_000;
const MAX_CLI_OUTPUT_BYTES = 512 * 1024;

export interface AntigravityCliQuotaResult {
  summary: AntigravityQuotaSummaryResponse;
  capturedAt: number;
  fromCache: boolean;
  refreshFailed: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find(value => typeof value === 'string' && value.trim().length > 0) as string | undefined;
}

/** Parse only the public quota portion of `agy -p /usage --output-format json`. */
export function parseAgyUsageJson(value: unknown): AntigravityQuotaSummaryResponse | null {
  const root = record(value);
  const command = record(root?.command);
  if (!command || (root?.status != null && root.status !== 'SUCCESS') || (command.name != null && command.name !== 'usage')) return null;
  const data = record(command.data);
  if (!Array.isArray(data?.groups)) return null;

  const groups = data.groups.slice(0, 32).map(groupValue => {
    const group = record(groupValue);
    if (!group) return null;
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    return {
      displayName: stringValue(group.name, group.display_name, group.displayName, group.id),
      buckets: buckets.slice(0, 32).map(bucketValue => {
        const bucket = record(bucketValue);
        if (!bucket) return null;
        // Absence is unknown, not 100% used. An explicit numeric zero is valid.
        const fraction = bucket.remaining_fraction ?? bucket.remainingFraction;
        if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
        const identifier = stringValue(bucket.id, bucket.bucket_id, bucket.bucketId, bucket.name);
        const window = stringValue(bucket.window);
        const rawReset = bucket.reset_time ?? bucket.resetTime;
        const resetMs = typeof rawReset === 'string' ? Date.parse(rawReset) : rawReset;
        return {
          bucketId: identifier || window,
          displayName: stringValue(bucket.name, bucket.display_name, bucket.displayName),
          remainingFraction: fraction,
          // The CLI uses the Unix epoch as a placeholder for an unset reset time.
          resetTime: typeof resetMs === 'number' && Number.isFinite(resetMs) && resetMs > 0
            ? rawReset as string | number
            : undefined,
          ...(window ? { window } : {}),
        };
      }).filter(bucket => bucket !== null),
    };
  }).filter(group => group !== null);

  return { groups };
}

function executableCandidates(): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  const directories = [
    join(homedir(), '.gemini', 'bin'),
    ...(localAppData ? [join(localAppData, 'agy', 'bin')] : []),
    ...(process.env.PATH ?? '').split(delimiter).map(value => value.trim().replace(/^"|"$/g, '')),
  ];
  return [...new Set(directories.filter(directory => isAbsolute(directory)).map(directory => join(directory, 'agy.exe')))]
    .filter(file => existsSync(file));
}

async function queryAgyQuota(timeoutMs: number): Promise<AntigravityQuotaSummaryResponse | null> {
  if (process.platform !== 'win32' || timeoutMs <= 0) return null;
  const stopAt = Date.now() + timeoutMs;
  const args = ['-p', '/usage', '--output-format', 'json'];
  for (const executable of executableCandidates()) {
    if (Date.now() >= stopAt) break;
    try {
      const { stdout } = await execFileAsync(executable, args, {
        cwd: homedir(),
        timeout: Math.max(1, stopAt - Date.now()),
        maxBuffer: MAX_CLI_OUTPUT_BYTES,
        windowsHide: true,
      });
      const normalized = parseAgyUsageJson(JSON.parse(stdout.trim()));
      if (normalized?.groups?.some(group => group.buckets?.length)) return normalized;
    } catch {
      // No credentials, account details, CLI output, or errors are logged.
    }
  }
  return null;
}

/** A bounded, deduplicated CLI fetch; manual refresh skips cache TTL but not the retry guard. */
export function createAntigravityCliQuotaReader(query = queryAgyQuota, clock = Date.now) {
  let lastAttemptAt: number | null = null;
  let lastAttemptFailed = false;
  let cached: { at: number; value: AntigravityQuotaSummaryResponse } | null = null;
  let inFlight: Promise<AntigravityCliQuotaResult | null> | null = null;

  const cachedResult = (): AntigravityCliQuotaResult | null => cached && clock() - cached.at < CLI_CACHE_MS
    ? { summary: cached.value, capturedAt: cached.at, fromCache: true, refreshFailed: lastAttemptFailed }
    : null;

  return async (force = false, timeoutMs = 25_000): Promise<AntigravityCliQuotaResult | null> => {
    if (inFlight) return inFlight;
    const previous = cachedResult();
    if (!force && previous) return previous;
    const now = clock();
    if ((lastAttemptAt !== null && now - lastAttemptAt < CLI_MIN_RETRY_MS) || timeoutMs <= 0) return previous;

    lastAttemptAt = now;
    inFlight = Promise.resolve().then(() => query(timeoutMs)).catch(() => null).then(value => {
      lastAttemptFailed = !value;
      if (!value) return cachedResult();
      const capturedAt = clock();
      cached = { at: capturedAt, value };
      return { summary: value, capturedAt, fromCache: false, refreshFailed: false };
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
}

export const readAntigravityCliQuota = createAntigravityCliQuotaReader();
