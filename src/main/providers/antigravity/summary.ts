import type { CompactRecentEntry } from '../../jsonlTypes';
import type { AntigravityUsageCall } from './gmParser';
import { antigravityCallRequestId } from './gmParser';
import { estimateAntigravityCacheSavingsUSD, estimateAntigravityCostUSD } from './pricing';

type AntigravityRecentEntry = CompactRecentEntry & { provider: 'antigravity' };

export function antigravityUsageEntryFromCall(call: AntigravityUsageCall): AntigravityRecentEntry {
  return {
    requestId: antigravityCallRequestId(call),
    timestampMs: call.timestampMs,
    model: call.model,
    provider: 'antigravity',
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    cacheCreationTokens: call.cacheCreationTokens,
    cacheReadTokens: call.cacheReadTokens,
    costUSD: estimateAntigravityCostUSD(call),
    cacheSavingsUSD: estimateAntigravityCacheSavingsUSD(call),
  };
}
