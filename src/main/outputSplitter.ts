import {
  type OutputComposition, type ToolCategory, type BreakdownDelta,
  TOOL_CATEGORY_KEYS, TOOL_OUTPUT_ROW_KEY_BY_CATEGORY,
  emptyOutputComposition, emptyBreakdownDelta,
} from '../shared/breakdownTypes';

export const CALIB = 2.4;

export function signatureProxyThinkingChars(signatureLength: number): number {
  return signatureLength > 0 ? signatureLength / CALIB : 0;
}

export interface OutputWeights {
  thinkingChars: number;
  responseChars: number;
  toolChars: Record<ToolCategory, number>;
}

function assertWeight(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`splitOutput: invalid weight ${name}=${value}`);
  }
}

function distribute(total: number, parts: Array<{ chars: number; assign: (v: number) => void }>): void {
  if (total <= 0) return;
  const pos = parts.filter(part => part.chars > 0);
  if (pos.length === 0) return;
  const totalChars = pos.reduce((sum, part) => sum + part.chars, 0);
  let assigned = 0;
  const withRemainder = pos.map(part => {
    const exact = (part.chars / totalChars) * total;
    const floor = Math.floor(exact);
    part.assign(floor);
    assigned += floor;
    return { part, remainder: exact - floor };
  });

  const leftover = total - assigned;
  withRemainder.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < leftover; i++) {
    withRemainder[i % withRemainder.length].part.assign(1);
  }
}

export function splitOutput(weights: OutputWeights, outputTokens: number, exactThinkingTokens?: number): OutputComposition {
  const out = emptyOutputComposition();
  if (!Number.isFinite(outputTokens) || outputTokens < 0) {
    throw new Error(`splitOutput: non-finite/negative outputTokens ${outputTokens}`);
  }

  // Validate exactThinking BEFORE the zero-output early return: reasoning is a subset of
  // output by source contract, so a contradictory (output=0, thinking>0/NaN) is dirty and
  // must fail loud, not silently return all-zero.
  let remaining = outputTokens;
  if (exactThinkingTokens !== undefined) {
    if (!Number.isFinite(exactThinkingTokens) || exactThinkingTokens < 0) {
      throw new Error(`splitOutput: non-finite/negative exactThinkingTokens ${exactThinkingTokens}`);
    }
    const exactThinking = Math.round(exactThinkingTokens);
    if (exactThinking > outputTokens) {
      throw new Error(`splitOutput: exactThinkingTokens ${exactThinking} exceeds outputTokens ${outputTokens} - upstream drift`);
    }
    out.thinking = exactThinking;
    remaining = outputTokens - out.thinking;
  }

  if (outputTokens === 0) return out;

  // Weights are char masses; a non-finite/negative weight is dirty upstream state, not a
  // legitimate zero. Assert (fail-loud) rather than coercing it into the no-char branch.
  assertWeight(weights.thinkingChars, 'thinkingChars');
  assertWeight(weights.responseChars, 'responseChars');
  for (const category of TOOL_CATEGORY_KEYS) assertWeight(weights.toolChars[category], `toolChars.${category}`);

  const parts: Array<{ chars: number; assign: (v: number) => void }> = [];
  if (exactThinkingTokens === undefined) {
    parts.push({ chars: weights.thinkingChars, assign: value => { out.thinking += value; } });
  }
  parts.push({ chars: weights.responseChars, assign: value => { out.response += value; } });
  for (const category of TOOL_CATEGORY_KEYS) {
    parts.push({ chars: weights.toolChars[category], assign: value => { out.toolOutput[category] += value; } });
  }

  const totalChars = parts.reduce((sum, part) => sum + part.chars, 0);
  if (totalChars <= 0) {
    out.response += remaining;
    return out;
  }

  distribute(remaining, parts);
  return out;
}

export function compositionToDelta(comp: OutputComposition): BreakdownDelta {
  const delta = emptyBreakdownDelta();
  delta.thinking = comp.thinking;
  delta.response = comp.response;
  for (const category of TOOL_CATEGORY_KEYS) {
    delta[TOOL_OUTPUT_ROW_KEY_BY_CATEGORY[category]] = comp.toolOutput[category];
  }
  return delta;
}
