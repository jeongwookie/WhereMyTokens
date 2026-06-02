export interface CacheMetricTokens {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export function cacheEfficiencyDenominator(provider: string, aggregate: CacheMetricTokens): number {
  if (provider === 'claude') return aggregate.cacheReadTokens + aggregate.cacheCreationTokens;
  return aggregate.inputTokens + aggregate.cacheCreationTokens + aggregate.cacheReadTokens;
}

export function cacheEfficiencyPct(provider: string, aggregate: CacheMetricTokens): number {
  const denominator = cacheEfficiencyDenominator(provider, aggregate);
  return denominator > 0 ? (aggregate.cacheReadTokens / denominator) * 100 : 0;
}
