export interface UsageTrendPoint {
  date?: string;
  weekStart?: string;
  month?: string;
  tokens: number;
  noCacheTokens: number;
  costUSD: number;
  requestCount: number;
}

export interface UsageTrendData {
  daily: UsageTrendPoint[];
  weekly: UsageTrendPoint[];
  monthly: UsageTrendPoint[];
}

export function emptyUsageTrendData(): UsageTrendData {
  return { daily: [], weekly: [], monthly: [] };
}
