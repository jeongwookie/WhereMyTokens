/**
 * Auto-detect usage limits
 * Primary: Anthropic API (Bearer token) → actual server values
 * Fallback: credentials.json rateLimitTier → plan-based estimates
 */
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as os from 'os';

export interface AutoLimits {
  h5: number;
  week: number;
  sonnetWeek: number;
  plan: string;
  source: 'credentials' | 'api' | 'default';
}

/** Actual usage percentage fetched directly from Anthropic API */
export interface ApiUsagePct {
  h5Pct: number;       // 0-100
  weekPct: number;
  soPct: number;       // 0 = no Sonnet-specific limit
  h5ResetMs: number;   // ms until reset
  weekResetMs: number;
  soResetMs: number;
  plan: string;
  extraUsage: {
    isEnabled: boolean;
    monthlyLimit: number;  // cent 단위 (÷100 = USD)
    usedCredits: number;   // cent 단위
    utilization: number;   // 0-100
  } | null;
}

function readCredentials() {
  try {
    const raw = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), '.claude', '.credentials.json'), 'utf-8'));
    const oauth = raw.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return { accessToken: oauth.accessToken as string, rateLimitTier: (oauth.rateLimitTier ?? '') as string, subscriptionType: (oauth.subscriptionType ?? '') as string };
  } catch { return null; }
}

export class RateLimitedError extends Error {
  constructor() { super('rate_limited'); this.name = 'RateLimitedError'; }
}

function httpsGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new RateLimitedError());
        return (res.statusCode && res.statusCode >= 200 && res.statusCode < 300)
          ? resolve(body)
          : reject(new Error(`HTTP ${res.statusCode}: ${body}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * Fetch actual usage percentage + reset time from Anthropic API
 * On success, returns accurate values provided directly by Claude
 */
export async function fetchApiUsagePct(): Promise<ApiUsagePct | null> {
  const cred = readCredentials();
  if (!cred) return null;

  try {
    const body = await httpsGet('https://api.anthropic.com/api/oauth/usage', {
      'Authorization': `Bearer ${cred.accessToken}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/1.0',
    });

    const data = JSON.parse(body) as {
      five_hour?: { utilization: number; resets_at: string } | null;
      seven_day?: { utilization: number; resets_at: string } | null;
      seven_day_sonnet?: { utilization: number; resets_at: string } | null;
      extra_usage?: {
        is_enabled: boolean;
        monthly_limit: number;
        used_credits: number;
        utilization: number;
      } | null;
    };

    const now = Date.now();
    const resetMs = (iso: string | undefined) =>
      iso ? Math.max(0, new Date(iso).getTime() - now) : 0;

    const plan = planFromTier(cred.rateLimitTier, cred.subscriptionType);

    // utilization: if in 0-1 range, multiply by 100 to convert to percentage
    const scalePct = (v: number | undefined) => {
      if (v == null) return 0;
      return v <= 1.0 ? Math.round(v * 100) : Math.round(v);
    };

    return {
      h5Pct: scalePct(data.five_hour?.utilization),
      weekPct: scalePct(data.seven_day?.utilization),
      soPct: scalePct(data.seven_day_sonnet?.utilization),
      h5ResetMs: resetMs(data.five_hour?.resets_at),
      weekResetMs: resetMs(data.seven_day?.resets_at),
      soResetMs: resetMs(data.seven_day_sonnet?.resets_at),
      plan,
      extraUsage: data.extra_usage ? {
        isEnabled: data.extra_usage.is_enabled,
        monthlyLimit: data.extra_usage.monthly_limit,
        usedCredits: data.extra_usage.used_credits,
        utilization: data.extra_usage.utilization,
      } : null,
    };
  } catch (e) {
    if (e instanceof RateLimitedError) throw e; // caller handles this
    return null;
  }
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
  if (t.includes('max_5') || t.includes('5x'))
    return { h5: 975, week: 7640, sonnetWeek: 1_280_000_000, plan: 'Max 5x', source: 'credentials' };
  if (t.includes('max') || s === 'max')
    return { h5: 195, week: 1528, sonnetWeek: 256_000_000, plan: 'Max 1x', source: 'credentials' };
  if (t.includes('pro') || s === 'pro')
    return { h5: 45, week: 180, sonnetWeek: 50_000_000, plan: 'Pro', source: 'credentials' };
  if (t.includes('free') || s === 'free')
    return { h5: 10, week: 50, sonnetWeek: 10_000_000, plan: 'Free', source: 'credentials' };
  return { h5: 100, week: 500, sonnetWeek: 100_000_000, plan: sub || tier || 'Unknown', source: 'default' };
}

export async function fetchAutoLimits(): Promise<AutoLimits | null> {
  const cred = readCredentials();
  if (!cred) return null;
  if (cred.rateLimitTier || cred.subscriptionType)
    return limitsFromTier(cred.rateLimitTier, cred.subscriptionType);
  return null;
}

export function getPlanName(): string {
  const cred = readCredentials();
  if (!cred) return '';
  return planFromTier(cred.rateLimitTier, cred.subscriptionType);
}
