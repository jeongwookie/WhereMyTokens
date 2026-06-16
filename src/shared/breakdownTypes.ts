import type { BreakdownGrain } from './bucketKey';

export type { BreakdownGrain };

export type PathCategory =
  | 'product_code' | 'test_code' | 'docs_spec' | 'config_build'
  | 'schema_migration' | 'vendor' | 'asset';

export const PATH_CATEGORIES: PathCategory[] = [
  'product_code', 'test_code', 'docs_spec', 'config_build', 'schema_migration', 'vendor', 'asset',
];

/** unit: call counts */
export interface ToolActivity {
  read: number;
  editWrite: number;
  search: number;
  git: number;
  buildTest: number;
  terminal: number;
  subagents: number;
  web: number;
}

export const TOOL_ACTIVITY_KEYS: (keyof ToolActivity)[] = [
  'read', 'editWrite', 'search', 'git', 'buildTest', 'terminal', 'subagents', 'web',
];

export type ToolCategory = keyof ToolActivity;

export const TOOL_CATEGORY_KEYS: ToolCategory[] = TOOL_ACTIVITY_KEYS;

/** unit: tokens, no-cache */
export interface OutputComposition {
  thinking: number;
  response: number;
  toolOutput: Record<ToolCategory, number>;
}

/** per-line ingest delta: output composition (tokens) + tool activity (counts). Declared ONCE here. */
export interface BreakdownDelta {
  thinking: number;
  response: number;
  toolOutputRead: number;
  toolOutputEditWrite: number;
  toolOutputSearch: number;
  toolOutputGit: number;
  toolOutputBuildTest: number;
  toolOutputTerminal: number;
  toolOutputSubagents: number;
  toolOutputWeb: number;
  read: number;
  editWrite: number;
  search: number;
  git: number;
  buildTest: number;
  terminal: number;
  subagents: number;
  web: number;
}

export const BREAKDOWN_KEYS: (keyof BreakdownDelta)[] = [
  'thinking', 'response',
  'toolOutputRead', 'toolOutputEditWrite', 'toolOutputSearch', 'toolOutputGit',
  'toolOutputBuildTest', 'toolOutputTerminal', 'toolOutputSubagents', 'toolOutputWeb',
  'read', 'editWrite', 'search', 'git', 'buildTest', 'terminal', 'subagents', 'web',
];

export const TOOL_OUTPUT_ROW_KEY_BY_CATEGORY: Record<ToolCategory, keyof BreakdownDelta> = {
  read: 'toolOutputRead',
  editWrite: 'toolOutputEditWrite',
  search: 'toolOutputSearch',
  git: 'toolOutputGit',
  buildTest: 'toolOutputBuildTest',
  terminal: 'toolOutputTerminal',
  subagents: 'toolOutputSubagents',
  web: 'toolOutputWeb',
};

export function emptyBreakdownDelta(): BreakdownDelta {
  return {
    thinking: 0,
    response: 0,
    toolOutputRead: 0,
    toolOutputEditWrite: 0,
    toolOutputSearch: 0,
    toolOutputGit: 0,
    toolOutputBuildTest: 0,
    toolOutputTerminal: 0,
    toolOutputSubagents: 0,
    toolOutputWeb: 0,
    read: 0,
    editWrite: 0,
    search: 0,
    git: 0,
    buildTest: 0,
    terminal: 0,
    subagents: 0,
    web: 0,
  };
}

/** unit: git lines, per category */
export type NetLinesByCategory = Record<PathCategory, { added: number; removed: number }>;

export function emptyNetLinesByCategory(): NetLinesByCategory {
  return Object.fromEntries(PATH_CATEGORIES.map(category => [category, { added: 0, removed: 0 }])) as NetLinesByCategory;
}

export interface ProviderBreakdown {
  provider: string;
  input: number;
  output: OutputComposition;
  thinkingExact: boolean;
  tools: ToolActivity;
  /** earliest YYYY-MM-DD that contributed (diagnostic; NOT the half-bucket trigger - see breakdownStartedDate) */
  firstSeenDate: string;
}

export interface BucketBreakdown {
  grain: BreakdownGrain;
  bucketKey: string;
  /** token blocks per provider (no-cache); empty array => "No token data" empty state */
  providers: ProviderBreakdown[];
  /** net lines by category, provider-agnostic; null => "No commits for this period" empty state */
  netLines: NetLinesByCategory | null;
  /** set when collection started inside this bucket (half-bucket); the date is breakdownStartedDate */
  partialSinceDate?: string;
}

export function emptyOutputComposition(): OutputComposition {
  return { thinking: 0, response: 0, toolOutput: emptyToolOutput() };
}

export function emptyToolOutput(): Record<ToolCategory, number> {
  return { read: 0, editWrite: 0, search: 0, git: 0, buildTest: 0, terminal: 0, subagents: 0, web: 0 };
}

export function emptyToolActivity(): ToolActivity {
  return { read: 0, editWrite: 0, search: 0, git: 0, buildTest: 0, terminal: 0, subagents: 0, web: 0 };
}
