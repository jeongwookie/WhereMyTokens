import { usageBucketStart } from './usageBucketAggregation';

const DAY_MS = 24 * 60 * 60 * 1000;

export const REQUEST_DETAIL_RETENTION_MS = 8 * DAY_MS;
export const HOURLY_RETENTION_MS = 35 * DAY_MS;
export const DAILY_RETENTION_MS = 180 * DAY_MS;

export interface UsageRetentionCutoffs {
  requestMs: number;
  hourMs: number;
  dayMs: number;
}

export function usageRetentionCutoffs(nowMs: number): UsageRetentionCutoffs {
  return {
    requestMs: nowMs - REQUEST_DETAIL_RETENTION_MS,
    hourMs: usageBucketStart(nowMs - HOURLY_RETENTION_MS, 'hour'),
    dayMs: usageBucketStart(nowMs - DAILY_RETENTION_MS, 'day'),
  };
}
