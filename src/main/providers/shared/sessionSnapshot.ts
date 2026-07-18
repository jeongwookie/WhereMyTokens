import type { SessionSnapshot } from '../../jsonlTypes';

export function cloneSessionSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    ...snapshot,
    toolCounts: { ...snapshot.toolCounts },
    activityBreakdown: { ...snapshot.activityBreakdown },
    codexRateLimits: snapshot.codexRateLimits
      ? {
        ...snapshot.codexRateLimits,
        entries: snapshot.codexRateLimits.entries.map(entry => ({
          ...entry,
          target: { ...entry.target },
          scope: { ...entry.scope },
          ...(entry.usageBinding ? { usageBinding: JSON.parse(JSON.stringify(entry.usageBinding)) } : {}),
        })),
      }
      : undefined,
  };
}
