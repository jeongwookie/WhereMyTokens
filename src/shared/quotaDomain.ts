import type {
  FixedPeriodQuotaSelection,
  ProviderCreditBalance,
  ProviderId,
  ProviderQuotaDisplayBadge,
  ProviderQuotaSnapshot,
  ProviderQuotaSource,
  ProviderQuotaStatus,
  ProviderResetCredit,
  ProviderResetCreditsData,
  QuotaDisplayMode,
  QuotaEntry,
  QuotaPeriod,
  QuotaScope,
  QuotaTarget,
  QuotaTargetGroup,
  QuotaUsageBinding,
} from './quotaTypes';

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
export const QUOTA_CACHE_WITHOUT_RESET_TTL_MS = 30 * 60 * 1000;

const PROVIDERS = new Set<ProviderId>(['claude', 'codex', 'antigravity']);
const SOURCES = new Set<ProviderQuotaSource>(['api', 'statusLine', 'localLog', 'localRpc', 'cache']);
const MODES = new Set<QuotaDisplayMode>(['rich', 'simple', 'none']);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const ABBREVIATION = /^[A-Z0-9]{1,3}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function normalizeQuotaPeriod(durationMs: number | null): QuotaPeriod | null {
  if (durationMs === FIVE_HOURS_MS) return '5h';
  if (durationMs === SEVEN_DAYS_MS) return '7d';
  return null;
}

function validateScope(value: unknown): QuotaScope | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'account') return { kind: 'account' };
  if (value.kind !== 'model' || typeof value.label !== 'string' || value.label.trim() === '') return null;
  return { kind: 'model', label: value.label.trim() };
}

function validateTarget(value: unknown): QuotaTarget | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !SAFE_ID.test(value.id)) return null;
  if (typeof value.label !== 'string' || value.label.trim() === '') return null;
  if (!MODES.has(value.defaultMode as QuotaDisplayMode)) return null;
  if (!isFiniteNumber(value.defaultOrder)) return null;
  if (typeof value.taskbarAbbreviation !== 'string' || !ABBREVIATION.test(value.taskbarAbbreviation)) return null;
  const badges = value.badges === undefined ? undefined : validateBadges(value.badges);
  if (value.badges !== undefined && !badges) return null;
  return {
    id: value.id,
    label: value.label.trim(),
    defaultMode: value.defaultMode as QuotaDisplayMode,
    defaultOrder: value.defaultOrder,
    taskbarAbbreviation: value.taskbarAbbreviation,
    ...(typeof value.accentColor === 'string' && value.accentColor ? { accentColor: value.accentColor } : {}),
    ...(badges ? { badges } : {}),
    ...(typeof value.cacheMetricTitle === 'string' && value.cacheMetricTitle ? { cacheMetricTitle: value.cacheMetricTitle } : {}),
    ...(value.hideCost === true ? { hideCost: true } : {}),
  };
}

function validateBadge(value: unknown): ProviderQuotaDisplayBadge | null {
  if (!isRecord(value) || typeof value.key !== 'string' || !SAFE_ID.test(value.key)) return null;
  if (typeof value.label !== 'string' || value.label.trim() === '') return null;
  if (value.tone !== undefined && value.tone !== 'good' && value.tone !== 'neutral' && value.tone !== 'warning') return null;
  return {
    key: value.key,
    label: value.label.trim(),
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(value.tone ? { tone: value.tone as ProviderQuotaDisplayBadge['tone'] } : {}),
  };
}

function validateBadges(value: unknown): ProviderQuotaDisplayBadge[] | null {
  if (!Array.isArray(value)) return null;
  const badges: ProviderQuotaDisplayBadge[] = [];
  for (const rawBadge of value) {
    const badge = validateBadge(rawBadge);
    if (!badge) return null;
    badges.push(badge);
  }
  return badges;
}

function validateBinding(value: unknown): QuotaUsageBinding | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'all-provider-models') return { kind: 'all-provider-models' };
  if (value.kind !== 'models' || !Array.isArray(value.matchers) || value.matchers.length === 0) return null;
  const matchers: Array<{ kind: 'exact' | 'contains'; value: string }> = [];
  for (const matcherValue of value.matchers) {
    if (!isRecord(matcherValue)) return null;
    if (matcherValue.kind !== 'exact' && matcherValue.kind !== 'contains') return null;
    if (typeof matcherValue.value !== 'string' || matcherValue.value.trim() === '') return null;
    matchers.push({ kind: matcherValue.kind, value: matcherValue.value.trim() });
  }
  return { kind: 'models', matchers };
}

function validateEntry(value: unknown): QuotaEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.key !== 'string' || !SAFE_ID.test(value.key)) return null;
  const target = validateTarget(value.target);
  const scope = validateScope(value.scope);
  if (!target || !scope) return null;
  if (value.state !== 'limited' && value.state !== 'unlimited') return null;
  if (value.resetsAt !== null && !isFiniteNumber(value.resetsAt)) return null;
  if (value.durationMs !== null && (!isFiniteNumber(value.durationMs) || value.durationMs <= 0)) return null;
  if (typeof value.durationInferred !== 'boolean') return null;
  if (value.durationInferred && value.durationMs === null) return null;
  if (value.period !== normalizeQuotaPeriod(value.durationMs as number | null)) return null;
  if (value.provisional !== undefined && typeof value.provisional !== 'boolean') return null;
  const usageBinding = value.usageBinding === undefined ? undefined : validateBinding(value.usageBinding);
  if (value.usageBinding !== undefined && !usageBinding) return null;
  if (value.state === 'limited' && (!isFiniteNumber(value.usedPct) || value.usedPct < 0 || value.usedPct > 100)) return null;
  if (value.state === 'unlimited' && Object.prototype.hasOwnProperty.call(value, 'usedPct')) return null;
  return {
    key: value.key,
    target,
    scope,
    state: value.state,
    ...(value.state === 'limited' ? { usedPct: value.usedPct as number } : {}),
    resetsAt: value.resetsAt as number | null,
    durationMs: value.durationMs as number | null,
    durationInferred: value.durationInferred,
    period: value.period as QuotaPeriod | null,
    ...(usageBinding ? { usageBinding } : {}),
    ...(value.provisional === true ? { provisional: true } : {}),
  } as QuotaEntry;
}

function validateStatus(value: unknown): ProviderQuotaStatus | null {
  if (!isRecord(value) || typeof value.connected !== 'boolean' || typeof value.code !== 'string' || value.code === '') return null;
  if (value.severity !== undefined && value.severity !== 'ok' && value.severity !== 'warning' && value.severity !== 'danger') return null;
  return {
    connected: value.connected,
    code: value.code,
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    ...(value.severity ? { severity: value.severity as ProviderQuotaStatus['severity'] } : {}),
  };
}

function validateCredit(value: unknown): ProviderCreditBalance | null {
  if (!isRecord(value) || !isFiniteNumber(value.available) || value.available < 0) return null;
  const optionalNumbers: Array<keyof Pick<ProviderCreditBalance, 'used' | 'total' | 'remainingPct'>> = ['used', 'total', 'remainingPct'];
  for (const key of optionalNumbers) {
    if (value[key] !== undefined && (!isFiniteNumber(value[key]) || (value[key] as number) < 0)) return null;
  }
  if (isFiniteNumber(value.remainingPct) && value.remainingPct > 100) return null;
  if (value.resetMs !== undefined && value.resetMs !== null && !isFiniteNumber(value.resetMs)) return null;
  return {
    available: value.available,
    ...(isFiniteNumber(value.used) ? { used: value.used } : {}),
    ...(isFiniteNumber(value.total) ? { total: value.total } : {}),
    ...(isFiniteNumber(value.remainingPct) ? { remainingPct: value.remainingPct } : {}),
    ...(value.resetMs === null || isFiniteNumber(value.resetMs) ? { resetMs: value.resetMs as number | null } : {}),
  };
}

function validateCredits(value: unknown): Record<string, ProviderCreditBalance> | null {
  if (!isRecord(value)) return null;
  const credits: Record<string, ProviderCreditBalance> = {};
  for (const [key, rawCredit] of Object.entries(value)) {
    if (!SAFE_ID.test(key)) return null;
    const credit = validateCredit(rawCredit);
    if (!credit) return null;
    credits[key] = credit;
  }
  return credits;
}

function validateResetCredit(value: unknown): ProviderResetCredit | null {
  if (!isRecord(value) || (value.idSuffix !== null && typeof value.idSuffix !== 'string')) return null;
  if (typeof value.status !== 'string' || (value.expiresAtUtc !== null && typeof value.expiresAtUtc !== 'string')) return null;
  return { idSuffix: value.idSuffix, status: value.status, expiresAtUtc: value.expiresAtUtc };
}

function validateResetCredits(value: unknown): ProviderResetCreditsData | null {
  if (!isRecord(value) || !Array.isArray(value.credits)) return null;
  const credits: ProviderResetCredit[] = [];
  for (const rawCredit of value.credits) {
    const credit = validateResetCredit(rawCredit);
    if (!credit) return null;
    credits.push(credit);
  }
  const status = validateStatus(value.status);
  if (!status || !isFiniteNumber(value.availableCount) || !isFiniteNumber(value.totalEarnedCount) || !isFiniteNumber(value.checkedAt)) return null;
  if (typeof value.countOnly !== 'boolean' || (value.source !== 'api' && value.source !== 'cache' && value.source !== 'usage')) return null;
  return {
    credits,
    availableCount: value.availableCount,
    totalEarnedCount: value.totalEarnedCount,
    checkedAt: value.checkedAt,
    countOnly: value.countOnly,
    source: value.source,
    status,
  };
}

export function validateProviderQuotaSnapshot(value: unknown): ProviderQuotaSnapshot | null {
  if (!isRecord(value)) return null;
  if (!PROVIDERS.has(value.provider as ProviderId) || !SOURCES.has(value.source as ProviderQuotaSource)) return null;
  if (!isFiniteNumber(value.capturedAt) || value.capturedAt <= 0 || !Array.isArray(value.entries)) return null;
  const entries: QuotaEntry[] = [];
  const keys = new Set<string>();
  const targets = new Map<string, { target: QuotaTarget; scope: QuotaScope }>();
  for (const rawEntry of value.entries) {
    const entry = validateEntry(rawEntry);
    if (!entry || keys.has(entry.key)) return null;
    keys.add(entry.key);
    const prior = targets.get(entry.target.id);
    if (prior && (!sameJson(prior.target, entry.target) || !sameJson(prior.scope, entry.scope))) return null;
    targets.set(entry.target.id, { target: entry.target, scope: entry.scope });
    entries.push(entry);
  }
  const status = value.status === undefined ? undefined : validateStatus(value.status);
  const credits = value.credits === undefined ? undefined : validateCredits(value.credits);
  const resetCredits = value.resetCredits === undefined || value.resetCredits === null
    ? value.resetCredits as null | undefined
    : validateResetCredits(value.resetCredits);
  if (value.status !== undefined && !status) return null;
  if (value.credits !== undefined && !credits) return null;
  if (value.resetCredits !== undefined && value.resetCredits !== null && !resetCredits) return null;
  return {
    provider: value.provider as ProviderId,
    source: value.source as ProviderQuotaSource,
    capturedAt: value.capturedAt,
    entries,
    ...(typeof value.accountLabel === 'string' ? { accountLabel: value.accountLabel } : {}),
    ...(typeof value.accountTooltip === 'string' ? { accountTooltip: value.accountTooltip } : {}),
    ...(typeof value.planName === 'string' ? { planName: value.planName } : {}),
    ...(credits ? { credits } : {}),
    ...(status ? { status } : {}),
    ...(resetCredits !== undefined ? { resetCredits } : {}),
  };
}

export function quotaElapsedPct(entry: QuotaEntry, now: number): number | null {
  if (entry.state !== 'limited' || entry.resetsAt == null || entry.durationMs == null || entry.durationMs <= 0) return null;
  const value = ((now - (entry.resetsAt - entry.durationMs)) / entry.durationMs) * 100;
  return Math.max(0, Math.min(100, value));
}

export function ageProviderQuotaSnapshot(snapshot: ProviderQuotaSnapshot, now: number): ProviderQuotaSnapshot {
  return {
    ...snapshot,
    entries: snapshot.entries.filter((entry) => entry.resetsAt != null
      ? now < entry.resetsAt
      : now < snapshot.capturedAt + QUOTA_CACHE_WITHOUT_RESET_TTL_MS),
  };
}

export function selectProviderQuotaSnapshot(
  candidates: Array<ProviderQuotaSnapshot | null | undefined>,
  now: number,
): ProviderQuotaSnapshot | null {
  for (const candidate of candidates) {
    const valid = validateProviderQuotaSnapshot(candidate);
    if (!valid) continue;
    return ageProviderQuotaSnapshot(valid, now);
  }
  return null;
}

export function groupQuotaEntries(entries: readonly QuotaEntry[]): QuotaTargetGroup[] {
  const groups = new Map<string, QuotaTargetGroup>();
  for (const entry of entries) {
    const group = groups.get(entry.target.id);
    if (group) group.entries.push(entry);
    else groups.set(entry.target.id, { target: entry.target, scope: entry.scope, entries: [entry] });
  }
  return [...groups.values()].sort((left, right) => (
    left.target.defaultOrder - right.target.defaultOrder
    || left.target.id.localeCompare(right.target.id)
  ));
}

export function selectFixedPeriodQuota(
  entries: readonly QuotaEntry[],
  period: QuotaPeriod,
): FixedPeriodQuotaSelection {
  const matching = entries.filter((entry) => entry.period === period);
  const limited = matching.filter((entry): entry is Extract<QuotaEntry, { state: 'limited' }> => (
    entry.state === 'limited' && entry.provisional !== true
  ));
  if (limited.length > 0) return { state: 'limited', usedPct: Math.max(...limited.map(entry => entry.usedPct)) };
  if (matching.some(entry => entry.provisional === true)) return { state: 'provisional', usedPct: null };
  if (matching.some(entry => entry.state === 'unlimited')) return { state: 'unlimited', usedPct: null };
  return { state: 'absent', usedPct: null };
}
