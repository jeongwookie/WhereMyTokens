import {
  TOOL_CATEGORY_KEYS,
  type BucketBreakdown,
  type NetLinesByCategory,
  type OutputComposition,
  type ToolCategory,
} from '../shared/breakdownTypes';

export interface ProviderOutputBlock {
  provider: string;
  input: number;
  thinkingExact: boolean;
  output: OutputComposition;
  /** thinking + response + Σ toolOutput — the OUTPUT composition denominator (bar/pct). */
  outputTotal: number;
  /** input + outputTotal — the provider's no-cache total; Σ over providers == headline. */
  total: number;
}

export type ToolMerged = Record<ToolCategory, { count: number; tokens: number }>;

export interface BreakdownBlocks {
  perProviderOutput: ProviderOutputBlock[];
  toolMerged: ToolMerged;
  tokenEmpty: boolean;
  netLines: NetLinesByCategory | null;
  netLinesEmpty: boolean;
  partialSinceDate: string | null;
}

export function buildBreakdownBlocks(breakdown: BucketBreakdown | null): BreakdownBlocks {
  const providers = breakdown?.providers ?? [];
  const perProviderOutput = providers
    .map(provider => {
      const outputTotal = provider.output.thinking + provider.output.response
        + TOOL_CATEGORY_KEYS.reduce((sum, category) => sum + provider.output.toolOutput[category], 0);
      return {
        provider: provider.provider,
        input: provider.input,
        thinkingExact: provider.thinkingExact,
        output: provider.output,
        outputTotal,
        total: provider.input + outputTotal,
      };
    })
    .filter(provider => provider.total > 0);

  const toolMerged = emptyToolMerged();
  for (const provider of providers) {
    for (const key of TOOL_CATEGORY_KEYS) {
      toolMerged[key].count += provider.tools[key];
      toolMerged[key].tokens += provider.output.toolOutput[key];
    }
  }

  return {
    perProviderOutput,
    toolMerged,
    tokenEmpty: perProviderOutput.length === 0,
    netLines: breakdown?.netLines ?? null,
    netLinesEmpty: breakdown?.netLines === null || breakdown?.netLines === undefined,
    partialSinceDate: breakdown?.partialSinceDate ?? null,
  };
}

function emptyToolMerged(): ToolMerged {
  return TOOL_CATEGORY_KEYS.reduce((merged, key) => {
    merged[key] = { count: 0, tokens: 0 };
    return merged;
  }, {} as ToolMerged);
}
