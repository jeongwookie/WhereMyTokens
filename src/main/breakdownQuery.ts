import { bucketDateRange, type BreakdownGrain } from '../shared/bucketKey';
import {
  BREAKDOWN_KEYS,
  TOOL_CATEGORY_KEYS,
  TOOL_ACTIVITY_KEYS,
  TOOL_OUTPUT_ROW_KEY_BY_CATEGORY,
  emptyOutputComposition,
  emptyToolActivity,
  type BucketBreakdown,
  type OutputComposition,
  type ToolActivity,
} from '../shared/breakdownTypes';
import type { UsageAggregate, UsageLedgerProvider, UsageLedgerSnapshot, DailyBreakdownRow } from './usageLedgerTypes';
import { isUsageLedgerProvider } from './usageLedgerTypes';
import { modelMatchesFilter, type UsageLedgerVisibilityFilter } from './usageLedgerUsage';
import { buildCategoryNetLines, hasCommitsInRange, type GitOutputLedgerSnapshot } from './gitOutputLedger';

type ProviderAccumulator = {
  input: number;
  output: OutputComposition;
  tools: ToolActivity;
  firstSeenDate: string;
};

type DailyModelEntry = {
  date: string;
  provider: UsageLedgerProvider;
  model: string;
  aggregate: UsageAggregate;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function splitDailyBreakdownKey(key: string): { date: string; provider: string } {
  const pipe = key.indexOf('|');
  if (pipe === -1) return { date: key, provider: '' };
  return { date: key.slice(0, pipe), provider: key.slice(pipe + 1) };
}

function splitDailyModelKey(key: string, aggregate: UsageAggregate): DailyModelEntry {
  const [date, rawProvider, ...modelParts] = key.split('|');
  const model = modelParts.join('|');
  if (!date || rawProvider === undefined || !model) {
    throw new Error(`dirty dailyModel key ${key}`);
  }
  return {
    date,
    provider: parseBreakdownProvider(key, rawProvider),
    model,
    aggregate,
  };
}

function parseBreakdownProvider(key: string, rawProvider: string): UsageLedgerProvider {
  if (!isUsageLedgerProvider(rawProvider)) {
    throw new Error(`dirty breakdown key ${key}: illegal provider '${rawProvider}'`);
  }
  return rawProvider;
}

function inRange(date: string, startDate: string, endDate: string): boolean {
  return date >= startDate && date <= endDate;
}

function assertCleanDailyBreakdownRow(key: string, row: DailyBreakdownRow): void {
  for (const field of BREAKDOWN_KEYS) {
    const value = row[field];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`dirty dailyBreakdown row ${key}`);
    }
  }
  if (!DATE_RE.test(row.firstSeenDate)) {
    throw new Error(`dirty dailyBreakdown row ${key}`);
  }
}

function addRowOutput(target: OutputComposition, row: DailyBreakdownRow): void {
  target.thinking += row.thinking;
  target.response += row.response;
  for (const category of TOOL_CATEGORY_KEYS) {
    target.toolOutput[category] += row[TOOL_OUTPUT_ROW_KEY_BY_CATEGORY[category]];
  }
}

function outputTotal(output: OutputComposition): number {
  return output.thinking + output.response
    + TOOL_CATEGORY_KEYS.reduce((sum, category) => sum + output.toolOutput[category], 0);
}

function exactThinkingForProvider(provider: UsageLedgerProvider): boolean {
  return provider === 'codex' || provider === 'antigravity';
}

function ensureProviderAccumulator(
  byProvider: Map<UsageLedgerProvider, ProviderAccumulator>,
  provider: UsageLedgerProvider,
  firstSeenDate: string,
): ProviderAccumulator {
  let acc = byProvider.get(provider);
  if (!acc) {
    acc = {
      input: 0,
      output: emptyOutputComposition(),
      tools: emptyToolActivity(),
      firstSeenDate,
    };
    byProvider.set(provider, acc);
    return acc;
  }
  if (firstSeenDate < acc.firstSeenDate) acc.firstSeenDate = firstSeenDate;
  return acc;
}

export function assembleBucketBreakdown(
  grain: BreakdownGrain,
  bucketKey: string,
  usage: Pick<UsageLedgerSnapshot, 'dailyBreakdown'>,
  dailyModel: Record<string, UsageAggregate>,
  git: Pick<GitOutputLedgerSnapshot, 'dailyOutput'>,
  repoKeys: string[],
  breakdownStartedDate: string | null,
  filter: UsageLedgerVisibilityFilter,
): BucketBreakdown {
  if (!filter) throw new Error('assembleBucketBreakdown: visibility filter is required');
  const { startDate, endDate } = bucketDateRange(grain, bucketKey);
  if (breakdownStartedDate !== null && !DATE_RE.test(breakdownStartedDate)) {
    throw new Error(`dirty breakdownStartedDate ${breakdownStartedDate}`);
  }
  const coveredStart = breakdownStartedDate === null
    ? null
    : (breakdownStartedDate > startDate ? breakdownStartedDate : startDate);
  const isCovered = (date: string) => coveredStart !== null && date >= coveredStart && date <= endDate;

  const inRangeEntries = Object.entries(usage.dailyBreakdown)
    .map(([key, row]) => {
      const { date, provider: rawProvider } = splitDailyBreakdownKey(key);
      return { key, row, date, rawProvider };
    })
    .filter(entry => inRange(entry.date, startDate, endDate));

  const byProvider = new Map<UsageLedgerProvider, ProviderAccumulator>();
  const coveredBreakdownPairs = new Set<string>();
  for (const { key, row, date, rawProvider } of inRangeEntries) {
    assertCleanDailyBreakdownRow(key, row);
    const provider = parseBreakdownProvider(key, rawProvider);
    if (!modelMatchesFilter(provider, '', filter)) continue;
    if (!isCovered(date)) continue; // symmetric with the dailyModel side: reconcile/display covered dates only
    const acc = ensureProviderAccumulator(byProvider, provider, row.firstSeenDate);
    addRowOutput(acc.output, row);
    for (const field of TOOL_ACTIVITY_KEYS) {
      acc.tools[field] += row[field];
    }
    coveredBreakdownPairs.add(`${date}|${provider}`);
  }

  const dailyModelOutputByDateProvider = new Map<string, number>();
  const dailyModelInputByProvider = new Map<UsageLedgerProvider, number>();
  const dailyModelOutputByProvider = new Map<UsageLedgerProvider, number>();

  for (const [key, aggregate] of Object.entries(dailyModel)) {
    const entry = splitDailyModelKey(key, aggregate);
    if (!inRange(entry.date, startDate, endDate)) continue;
    if (!isCovered(entry.date)) continue;
    if (!modelMatchesFilter(entry.provider, entry.model, filter)) continue;

    const pairKey = `${entry.date}|${entry.provider}`;
    dailyModelOutputByDateProvider.set(
      pairKey,
      (dailyModelOutputByDateProvider.get(pairKey) ?? 0) + entry.aggregate.outputTokens,
    );
    dailyModelInputByProvider.set(
      entry.provider,
      (dailyModelInputByProvider.get(entry.provider) ?? 0) + entry.aggregate.inputTokens,
    );
    dailyModelOutputByProvider.set(
      entry.provider,
      (dailyModelOutputByProvider.get(entry.provider) ?? 0) + entry.aggregate.outputTokens,
    );
    if (entry.aggregate.inputTokens > 0 || entry.aggregate.outputTokens > 0) {
      ensureProviderAccumulator(byProvider, entry.provider, entry.date);
    }
  }

  for (const [provider, input] of dailyModelInputByProvider) {
    // loop above already created the accumulator (input>0 ⇒ ensureProviderAccumulator) with the
    // real date; only add input here — never backdate firstSeenDate to coveredStart.
    const acc = byProvider.get(provider);
    if (acc) acc.input += input;
  }

  for (const pairKey of coveredBreakdownPairs) {
    if (dailyModelOutputByDateProvider.get(pairKey) === undefined) {
      throw new Error(`breakdown reconciliation: covered ${pairKey} has a breakdown row but no dailyModel peer`);
    }
  }

  for (const [pairKey, output] of dailyModelOutputByDateProvider) {
    if (output > 0 && !coveredBreakdownPairs.has(pairKey)) {
      throw new Error(`breakdown reconciliation: covered ${pairKey} has dailyModel output ${output} but no breakdown row`);
    }
  }

  for (const [provider, acc] of byProvider) {
    const partsSum = outputTotal(acc.output);
    const authority = dailyModelOutputByProvider.get(provider);
    if (authority === undefined) {
      throw new Error(`breakdown reconciliation: provider ${provider} has no dailyModel output entry`);
    }
    if (partsSum !== authority) {
      throw new Error(`breakdown reconciliation: provider ${provider} parts ${partsSum} != dailyModel output ${authority}`);
    }
  }

  const providers = [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, acc]) => ({
      provider,
      input: acc.input,
      output: acc.output,
      thinkingExact: exactThinkingForProvider(provider),
      tools: acc.tools,
      firstSeenDate: acc.firstSeenDate,
    }));

  const categoryNetLines = buildCategoryNetLines(git as GitOutputLedgerSnapshot, repoKeys, startDate, endDate);
  const netLines = hasCommitsInRange(git, repoKeys, startDate, endDate) ? categoryNetLines : null;
  const partialSinceDate =
    breakdownStartedDate !== null && startDate < breakdownStartedDate
      ? breakdownStartedDate
      : undefined;

  return {
    grain,
    bucketKey,
    providers,
    netLines,
    ...(partialSinceDate ? { partialSinceDate } : {}),
  };
}
