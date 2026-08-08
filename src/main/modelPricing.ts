export interface UsageCostInput {
  model: string;
  timestampMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface UsageCostEstimate {
  costUSD: number;
  cacheSavingsUSD: number;
}

interface TokenRates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

interface ResolvedPrice {
  rates: TokenRates;
  longContext: boolean;
}

const PER_MILLION = 1_000_000;
const GPT_5_6_LONG_CONTEXT_THRESHOLD = 272_000;
const GPT_5_6_PRICE_CUT_MS = Date.UTC(2026, 6, 30);
const SONNET_5_STANDARD_PRICE_START_MS = Date.UTC(2026, 8, 1);

const RATE = {
  gpt56Sol: { input: 5, output: 30, cacheWrite: 6.25, cacheRead: 0.5 },
  gpt56Terra: { input: 2, output: 12, cacheWrite: 2.5, cacheRead: 0.2 },
  gpt56TerraLaunch: { input: 2.5, output: 15, cacheWrite: 3.125, cacheRead: 0.25 },
  gpt56Luna: { input: 0.2, output: 1.2, cacheWrite: 0.25, cacheRead: 0.02 },
  gpt56LunaLaunch: { input: 1, output: 6, cacheWrite: 1.25, cacheRead: 0.1 },
  gpt54Mini: { input: 0.75, output: 4.5, cacheWrite: 0.75, cacheRead: 0.075 },
  gpt54Nano: { input: 0.2, output: 1.25, cacheWrite: 0.2, cacheRead: 0.02 },
  gpt54: { input: 2.5, output: 15, cacheWrite: 2.5, cacheRead: 0.25 },
  gpt53Codex: { input: 1.75, output: 14, cacheWrite: 1.75, cacheRead: 0.175 },
  gpt52Codex: { input: 1.75, output: 14, cacheWrite: 1.75, cacheRead: 0.175 },
  gpt51CodexMini: { input: 0.25, output: 2, cacheWrite: 0.25, cacheRead: 0.025 },
  gpt51Codex: { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 },
  codexMiniLatest: { input: 1.5, output: 6, cacheWrite: 1.5, cacheRead: 0.375 },
  claudeFable5: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  claudeOpusCurrent: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  claudeOpusLegacy: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  claudeSonnet5Promo: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  claudeSonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  claudeHaiku4: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  claudeHaikuLegacy: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  gpt4o: { input: 2.5, output: 10, cacheWrite: 0, cacheRead: 1.25 },
  gpt4: { input: 2, output: 8, cacheWrite: 0, cacheRead: 0.5 },
  fallback: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
} satisfies Record<string, TokenRates>;

function isCurrentOpus4(model: string): boolean {
  return /claude-opus-4-(?:5|6|7|8)(?:\b|-)/.test(model);
}

function resolvePrice(model: string, timestampMs: number): ResolvedPrice {
  const lower = model.trim().toLowerCase();
  const beforeGpt56PriceCut = timestampMs > 0 && timestampMs < GPT_5_6_PRICE_CUT_MS;

  if (lower.includes('gpt-5.6-luna')) {
    return { rates: beforeGpt56PriceCut ? RATE.gpt56LunaLaunch : RATE.gpt56Luna, longContext: true };
  }
  if (lower.includes('gpt-5.6-terra')) {
    return { rates: beforeGpt56PriceCut ? RATE.gpt56TerraLaunch : RATE.gpt56Terra, longContext: true };
  }
  if (lower.includes('gpt-5.6-sol') || lower === 'gpt-5.6') {
    return { rates: RATE.gpt56Sol, longContext: true };
  }
  if (lower.includes('gpt-5.4-mini')) return { rates: RATE.gpt54Mini, longContext: false };
  if (lower.includes('gpt-5.4-nano')) return { rates: RATE.gpt54Nano, longContext: false };
  if (lower.includes('gpt-5.4')) return { rates: RATE.gpt54, longContext: false };
  if (lower.includes('gpt-5.3-codex')) return { rates: RATE.gpt53Codex, longContext: false };
  if (lower.includes('gpt-5.2-codex')) return { rates: RATE.gpt52Codex, longContext: false };
  if (lower.includes('gpt-5.1-codex-mini')) return { rates: RATE.gpt51CodexMini, longContext: false };
  if (lower.includes('gpt-5.1-codex-max') || lower.includes('gpt-5.1-codex')) {
    return { rates: RATE.gpt51Codex, longContext: false };
  }
  if (lower.includes('gpt-5-codex')) return { rates: RATE.gpt51Codex, longContext: false };
  if (lower.includes('codex-mini-latest')) return { rates: RATE.codexMiniLatest, longContext: false };

  if (lower.includes('claude-fable-5')) return { rates: RATE.claudeFable5, longContext: false };
  if (lower.includes('claude-opus-5') || isCurrentOpus4(lower)) {
    return { rates: RATE.claudeOpusCurrent, longContext: false };
  }
  if (lower.includes('claude-opus')) return { rates: RATE.claudeOpusLegacy, longContext: false };
  if (lower.includes('claude-sonnet-5')) {
    const promoApplies = timestampMs > 0 && timestampMs < SONNET_5_STANDARD_PRICE_START_MS;
    return {
      rates: promoApplies ? RATE.claudeSonnet5Promo : RATE.claudeSonnet,
      longContext: false,
    };
  }
  if (lower.includes('claude-sonnet-4') || lower.includes('claude-sonnet')) {
    return { rates: RATE.claudeSonnet, longContext: false };
  }
  if (lower.includes('claude-haiku-4')) return { rates: RATE.claudeHaiku4, longContext: false };
  if (lower.includes('claude-haiku')) return { rates: RATE.claudeHaikuLegacy, longContext: false };
  if (lower.includes('gpt-4o')) return { rates: RATE.gpt4o, longContext: false };
  if (lower.includes('gpt-4')) return { rates: RATE.gpt4, longContext: false };
  return { rates: RATE.fallback, longContext: false };
}

function assertTokenCount(value: number, field: keyof UsageCostInput): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Cannot price usage with invalid ${field}: ${value}`);
  }
}

export function estimateUsageCost(input: UsageCostInput): UsageCostEstimate {
  assertTokenCount(input.inputTokens, 'inputTokens');
  assertTokenCount(input.outputTokens, 'outputTokens');
  assertTokenCount(input.cacheCreationTokens, 'cacheCreationTokens');
  assertTokenCount(input.cacheReadTokens, 'cacheReadTokens');

  const resolved = resolvePrice(input.model, input.timestampMs);
  const promptTokens = input.inputTokens + input.cacheCreationTokens + input.cacheReadTokens;
  const longContext = resolved.longContext && promptTokens > GPT_5_6_LONG_CONTEXT_THRESHOLD;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const inputRate = resolved.rates.input * inputMultiplier;
  const cacheWriteRate = resolved.rates.cacheWrite * inputMultiplier;
  const cacheReadRate = resolved.rates.cacheRead * inputMultiplier;
  const outputRate = resolved.rates.output * outputMultiplier;

  return {
    costUSD: (
      input.inputTokens * inputRate
      + input.outputTokens * outputRate
      + input.cacheCreationTokens * cacheWriteRate
      + input.cacheReadTokens * cacheReadRate
    ) / PER_MILLION,
    cacheSavingsUSD: Math.max(0, inputRate - cacheReadRate) * input.cacheReadTokens / PER_MILLION,
  };
}
