import type { SessionSnapshot } from '../../jsonlTypes';

export function cloneSessionSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    ...snapshot,
    toolCounts: { ...snapshot.toolCounts },
    activityBreakdown: { ...snapshot.activityBreakdown },
    codexRateLimits: snapshot.codexRateLimits
      ? {
        ...(snapshot.codexRateLimits.h5 ? { h5: { ...snapshot.codexRateLimits.h5 } } : {}),
        ...(snapshot.codexRateLimits.week ? { week: { ...snapshot.codexRateLimits.week } } : {}),
      }
      : undefined,
  };
}
