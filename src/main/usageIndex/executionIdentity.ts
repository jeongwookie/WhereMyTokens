import type { UsageEntry, UsageSessionProjection } from './types';
import { createHash } from 'node:crypto';

export interface ExecutionIdentity { sourceId: string; requestId: string; timestampMs: number; originId: string; fingerprint: string }
export function executionFingerprint(e: UsageEntry): string {
  return createHash('sha256').update(JSON.stringify([e.provider, e.model, e.inputTokens, e.outputTokens,
    e.cacheCreationTokens, e.cacheReadTokens, e.costUSD, e.cacheSavingsUSD, e.breakdown ?? null])).digest('hex');
}
export function sameExecutionOrigin(e: UsageEntry, known: ExecutionIdentity): boolean {
  return !!e.identityOrigin && e.identityOrigin === known.originId;
}
export function validUsageRevision(e: UsageEntry, previous: UsageEntry, known: ExecutionIdentity, oldPayload: Record<string, any> = {}, incoming: Record<string, any> = {}): boolean {
  if (e.provider !== previous.provider || e.model !== previous.model
    || e.identityOrigin && known.originId && e.identityOrigin !== known.originId) return false;
  const fields = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'] as const;
  if (fields.some(k => e[k] < previous[k])) return false;
  if (fields.some(k => e[k] > previous[k])) return true;
  if (e.provider !== 'claude') return false;
  const before = oldPayload.appliedRequests?.[known.requestId]?.blocks;
  const after = incoming.appliedRequests?.[e.requestId]?.blocks;
  return !!before && !!after && Object.keys(after).length > Object.keys(before).length
    && Object.keys(before).every(k => JSON.stringify(before[k]) === JSON.stringify(after[k]));
}

export function reviseClaudePayload(payload: Record<string, any>, requestId: string, incoming: Record<string, any>): Record<string, any> | null {
  const previous = payload.appliedRequests?.[requestId], next = incoming.appliedRequests?.[requestId];
  if (!previous || !next || !payload.sessionSnapshot) return null;
  const result = structuredClone(payload);
  for (const [from, field] of [['toolNames', 'toolCounts'], ['activityBreakdown', 'activityBreakdown']]) {
    const counts = result.sessionSnapshot[field!];
    for (const key of new Set([...Object.keys(previous[from!] ?? {}), ...Object.keys(next[from!] ?? {})])) {
      counts[key] = (counts[key] ?? 0) - (previous[from!]?.[key] ?? 0) + (next[from!]?.[key] ?? 0);
      if (counts[key] < 0) throw new Error('Canonical session revision underflow');
    }
  }
  result.appliedRequests[requestId] = structuredClone(next);
  return result;
}

export function canonicalSessionProjection(
  projection: UsageSessionProjection,
  owner: (identityKey: string) => ExecutionIdentity | undefined,
): UsageSessionProjection {
  const result = structuredClone(projection);
  const payload = result.payload as Record<string, any>;
  if (projection.provider !== 'claude' || !payload.appliedRequests || !payload.sessionSnapshot) return result;
  for (const [id, value] of Object.entries(payload.appliedRequests)) {
    const origin = owner(`claude:message:${id}`);
    if (!origin || origin.sourceId === projection.sourceId) continue;
    const applied = value as { toolNames: Record<string, number>; activityBreakdown: Record<string, number> };
    for (const [key, n] of Object.entries(applied.toolNames)) {
      payload.sessionSnapshot.toolCounts[key] = Math.max(0, (payload.sessionSnapshot.toolCounts[key] ?? 0) - n);
    }
    for (const [key, n] of Object.entries(applied.activityBreakdown)) {
      payload.sessionSnapshot.activityBreakdown[key] = Math.max(0, (payload.sessionSnapshot.activityBreakdown[key] ?? 0) - n);
    }
    delete payload.appliedRequests[id];
  }
  return result;
}

export function identityAccepts(entry: UsageEntry, sourceId: string, known: ExecutionIdentity | undefined): boolean {
  return !known || (known.sourceId === sourceId && known.requestId === entry.requestId);
}
