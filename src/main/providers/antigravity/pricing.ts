import type { AntigravityUsageCall } from './gmParser';

export interface AntigravityPrice {
  in: number;
  out: number;
  cw: number;
  cr: number;
}

export interface AntigravityPriceRule {
  key: string;
  pattern: RegExp;
  price: AntigravityPrice | ((promptTokens: number) => AntigravityPrice);
}

export const ANTIGRAVITY_PRICING: AntigravityPriceRule[] = [
  {
    key: 'gemini-3.1-pro',
    pattern: /gemini.*(3\.1|3).*pro|gemini.*pro/i,
    price: (promptTokens) => promptTokens > 200_000
      ? { in: 4.00, out: 18.00, cw: 4.00, cr: 0.40 }
      : { in: 2.00, out: 12.00, cw: 2.00, cr: 0.20 },
  },
  {
    key: 'gemini-3-pro-image',
    pattern: /gemini.*3.*pro.*image|nano.*banana.*pro/i,
    price: { in: 2.00, out: 12.00, cw: 2.00, cr: 0.20 },
  },
  {
    key: 'gemini-3.1-flash-image',
    pattern: /gemini.*3\.1.*flash.*image|flash.*image/i,
    price: { in: 0.50, out: 3.00, cw: 0.50, cr: 0.50 },
  },
  {
    key: 'gemini-3.5-flash',
    pattern: /gemini.*3\.5.*flash|gemini.*flash(?!.*lite)/i,
    price: { in: 1.50, out: 9.00, cw: 1.50, cr: 0.15 },
  },
  {
    key: 'gemini-3.1-flash-lite',
    pattern: /gemini.*3\.1.*flash.*lite|flash.*lite/i,
    price: { in: 0.25, out: 1.50, cw: 0.25, cr: 0.025 },
  },
  {
    key: 'gemini-3-flash',
    pattern: /gemini.*3.*flash/i,
    price: { in: 0.50, out: 3.00, cw: 0.50, cr: 0.05 },
  },
  {
    key: 'claude-opus-4.6+',
    pattern: /claude.*opus|opus/i,
    price: { in: 5.00, out: 25.00, cw: 6.25, cr: 0.50 },
  },
  {
    key: 'claude-sonnet-4.6',
    pattern: /claude.*sonnet|sonnet/i,
    price: { in: 3.00, out: 15.00, cw: 3.75, cr: 0.30 },
  },
  {
    key: 'claude-haiku-4.5',
    pattern: /claude.*haiku|haiku/i,
    price: { in: 1.00, out: 5.00, cw: 1.25, cr: 0.10 },
  },
  {
    key: 'gpt-oss-120b',
    pattern: /gpt[-\s_]*oss.*120b|120b/i,
    price: { in: 0.039, out: 0.18, cw: 0.039, cr: 0.039 },
  },
  {
    key: 'gpt-oss-20b',
    pattern: /gpt[-\s_]*oss.*20b|20b/i,
    price: { in: 0.029, out: 0.14, cw: 0.029, cr: 0.029 },
  },
];

export function estimateAntigravityPromptTokens(call: AntigravityUsageCall): number {
  return call.inputTokens + call.cacheCreationTokens + call.cacheReadTokens;
}

function resolveAntigravityPriceFromText(
  text: string,
  promptTokens: number,
): AntigravityPrice | null {
  for (const rule of ANTIGRAVITY_PRICING) {
    if (!rule.pattern.test(text)) continue;
    return typeof rule.price === 'function' ? rule.price(promptTokens) : rule.price;
  }

  return null;
}

export function resolveAntigravityPrice(call: AntigravityUsageCall): AntigravityPrice | null {
  const text = `${call.model} ${call.rawModel}`.toLowerCase();
  return resolveAntigravityPriceFromText(text, estimateAntigravityPromptTokens(call));
}

export function resolveAntigravityPriceForModel(model: string, rawModel = ''): AntigravityPrice | null {
  return resolveAntigravityPriceFromText(`${model} ${rawModel}`.toLowerCase(), 0);
}

export function estimateAntigravityCostUSD(call: AntigravityUsageCall): number {
  const price = resolveAntigravityPrice(call);
  if (!price) return 0;

  return (
    call.inputTokens * price.in +
    call.outputTokens * price.out +
    call.cacheCreationTokens * price.cw +
    call.cacheReadTokens * price.cr
  ) / 1_000_000;
}

export function estimateAntigravityCacheSavingsUSD(call: AntigravityUsageCall): number {
  const price = resolveAntigravityPrice(call);
  if (!price) return 0;

  return Math.max(0, price.in - price.cr) * call.cacheReadTokens / 1_000_000;
}
