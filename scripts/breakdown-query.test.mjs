import test from 'node:test';
import assert from 'node:assert/strict';

import q from '../dist/main/breakdownQuery.js';
import gol from '../dist/main/gitOutputLedger.js';
import agg from '../dist/main/usageLedgerAggregates.js';
import vf from '../dist/main/usageVisibilityFilter.js';

const { assembleBucketBreakdown } = q;
const { emptyGitOutputLedgerSnapshot, mergeGitDailyOutput } = gol;
const { emptyDailyBreakdownRow, emptyUsageAggregate } = agg;
const { buildUsageVisibilityFilter } = vf;

function usageWith(rows) {
  return { dailyBreakdown: rows };
}

function row(firstSeenDate, overrides = {}) {
  return { ...emptyDailyBreakdownRow(firstSeenDate), ...overrides };
}

function usageAgg(overrides = {}) {
  return { ...emptyUsageAggregate(), ...overrides };
}

function allVisibleFilter() {
  return buildUsageVisibilityFilter({ enabledProviders: ['claude', 'codex', 'antigravity'] });
}

function makeVisibilityFilter(overrides = {}) {
  const visible = { claude: true, codex: true, antigravity: true, ...overrides };
  return buildUsageVisibilityFilter({
    enabledProviders: Object.entries(visible)
      .filter(([, enabled]) => enabled)
      .map(([provider]) => provider),
  });
}

function emptyGit() {
  return emptyGitOutputLedgerSnapshot();
}

const claude08 = row('2026-06-08', {
  thinking: 100,
  response: 50,
  toolOutputRead: 25,
  read: 3,
  editWrite: 1,
});

const claude09 = row('2026-06-09', {
  thinking: 20,
  response: 30,
  toolOutputSearch: 10,
  read: 1,
  search: 2,
});

const codex10 = row('2026-06-10', {
  thinking: 0,
  response: 80,
  terminal: 2,
});

test('day grain assembles one provider block with no-cache tokens', () => {
  const dailyModel = {
    '2026-06-08|claude|Sonnet': usageAgg({ inputTokens: 900, outputTokens: 175 }),
  };
  const b = assembleBucketBreakdown(
    'day',
    '2026-06-08',
    usageWith({ '2026-06-08|claude': claude08 }),
    dailyModel,
    emptyGit(),
    [],
    '2026-06-01',
    allVisibleFilter(),
  );
  assert.equal(b.grain, 'day');
  assert.equal(b.bucketKey, '2026-06-08');
  assert.equal(b.providers.length, 1);
  assert.equal(b.providers[0].provider, 'claude');
  assert.equal(b.providers[0].input, 900);
  assert.equal(b.providers[0].thinkingExact, false);
  assert.equal(b.providers[0].output.thinking, 100);
  assert.equal(b.providers[0].output.response, 50);
  assert.equal(b.providers[0].output.toolOutput.read, 25);
  assert.equal(b.providers[0].tools.read, 3);
  assert.equal(b.providers[0].firstSeenDate, '2026-06-08');
});

test('week grain merges multiple days for the same provider', () => {
  const dailyModel = {
    '2026-06-08|claude|Sonnet': usageAgg({ inputTokens: 900, outputTokens: 175 }),
    '2026-06-09|claude|Sonnet': usageAgg({ inputTokens: 100, outputTokens: 60 }),
    '2026-06-10|codex|GPT-5-CODEX': usageAgg({ inputTokens: 10, outputTokens: 80 }),
  };
  const b = assembleBucketBreakdown(
    'week',
    '2026-06-08',
    usageWith({
      '2026-06-08|claude': claude08,
      '2026-06-09|claude': claude09,
      '2026-06-10|codex': codex10,
    }),
    dailyModel,
    emptyGit(),
    [],
    '2026-06-01',
    allVisibleFilter(),
  );
  assert.deepEqual(b.providers.map(p => p.provider), ['claude', 'codex']);
  assert.equal(b.providers[0].input, 1000);
  assert.equal(b.providers[0].output.thinking, 120);
  assert.equal(b.providers[0].output.response, 80);
  assert.equal(b.providers[0].output.toolOutput.read, 25);
  assert.equal(b.providers[0].output.toolOutput.search, 10);
  assert.equal(b.providers[0].tools.read, 4);
  assert.equal(b.providers[0].tools.search, 2);
  assert.equal(b.providers[0].firstSeenDate, '2026-06-08');
  assert.equal(b.providers[1].thinkingExact, true);
});

test('codex provider carries thinkingExact true', () => {
  const b = assembleBucketBreakdown(
    'day',
    '2026-06-10',
    usageWith({ '2026-06-10|codex': codex10 }),
    { '2026-06-10|codex|GPT-5-CODEX': usageAgg({ inputTokens: 10, outputTokens: 80 }) },
    emptyGit(),
    [],
    '2026-06-01',
    allVisibleFilter(),
  );
  assert.equal(b.providers[0].provider, 'codex');
  assert.equal(b.providers[0].output.thinking, 0);
  assert.equal(b.providers[0].output.response, 80);
  assert.equal(b.providers[0].thinkingExact, true);
});

test('thinkingExact true for antigravity', () => {
  const ag10 = row('2026-06-10', { thinking: 40, response: 60 });
  const b = assembleBucketBreakdown(
    'day',
    '2026-06-10',
    usageWith({ '2026-06-10|antigravity': ag10 }),
    { '2026-06-10|antigravity|Gemini': usageAgg({ inputTokens: 10, outputTokens: 100 }) },
    emptyGit(),
    [],
    '2026-06-01',
    allVisibleFilter(),
  );
  assert.equal(b.providers[0].provider, 'antigravity');
  assert.equal(b.providers[0].thinkingExact, true);
});

test('toolOutput accumulates into nested OutputComposition.toolOutput', () => {
  const usage = { dailyBreakdown: { '2026-06-10|claude': row('2026-06-10', { thinking: 10, response: 20, toolOutputEditWrite: 70 }) } };
  const dailyModel = { '2026-06-10|claude|Sonnet': usageAgg({ inputTokens: 0, outputTokens: 100 }) };
  const out = assembleBucketBreakdown('day', '2026-06-10', usage, dailyModel, emptyGit(), [], '2026-06-01', allVisibleFilter());
  assert.equal(out.providers[0].output.toolOutput.editWrite, 70);
});

test('half-bucket: partial when collection started inside the bucket (F4)', () => {
  const b = assembleBucketBreakdown(
    'week',
    '2026-06-08',
    usageWith({ '2026-06-10|codex': codex10 }),
    { '2026-06-10|codex|GPT-5-CODEX': usageAgg({ outputTokens: 80 }) },
    emptyGit(),
    [],
    '2026-06-10',
    allVisibleFilter(),
  );
  assert.equal(b.partialSinceDate, '2026-06-10');
});

test('not partial when collection started before the bucket even if usage is sparse (F4)', () => {
  const b = assembleBucketBreakdown(
    'week',
    '2026-06-08',
    usageWith({ '2026-06-10|codex': codex10 }),
    { '2026-06-10|codex|GPT-5-CODEX': usageAgg({ outputTokens: 80 }) },
    emptyGit(),
    [],
    '2026-06-01',
    allVisibleFilter(),
  );
  assert.equal(b.partialSinceDate, undefined);
});

test('pre-boundary bucket surfaces breakdown availability date', () => {
  const b = assembleBucketBreakdown(
    'day',
    '2026-06-08',
    usageWith({}),
    {},
    emptyGit(),
    [],
    '2026-06-10',
    allVisibleFilter(),
  );
  assert.equal(b.partialSinceDate, '2026-06-10');
  assert.deepEqual(b.providers, []);
});

test('netLines is null when the bucket has no commits in range', () => {
  const b = assembleBucketBreakdown(
    'day',
    '2026-06-08',
    usageWith({ '2026-06-08|claude': claude08 }),
    { '2026-06-08|claude|Sonnet': usageAgg({ outputTokens: 175 }) },
    emptyGit(),
    ['repo-a'],
    '2026-06-01',
    allVisibleFilter(),
  );
  assert.equal(b.netLines, null);
});

test('netLines returns a zeroed category map when commits exist but net lines are zero', () => {
  const git = emptyGit();
  mergeGitDailyOutput(git, 'repo-a', [{
    date: '2026-06-08',
    commits: 1,
    added: 0,
    removed: 0,
    byCategory: {},
  }]);
  const b = assembleBucketBreakdown('day', '2026-06-08', usageWith({}), {}, git, ['repo-a'], '2026-06-01', allVisibleFilter());
  assert.notEqual(b.netLines, null);
  assert.equal(b.netLines.product_code.added, 0);
  assert.equal(b.netLines.product_code.removed, 0);
  assert.deepEqual(b.providers, []);
});

test('fail-loud: a negative field throws (F5)', () => {
  const dirty = { ...claude08, read: -1 };
  assert.throws(
    () => assembleBucketBreakdown(
      'day',
      '2026-06-08',
      usageWith({ '2026-06-08|claude': dirty }),
      { '2026-06-08|claude|Sonnet': usageAgg({ outputTokens: 175 }) },
      emptyGit(),
      [],
      '2026-06-01',
      allVisibleFilter(),
    ),
    /dirty dailyBreakdown row 2026-06-08\|claude/,
  );
});

test('fail-loud: malformed firstSeenDate throws (F5)', () => {
  const dirty = { ...claude08, firstSeenDate: 'June 8' };
  assert.throws(
    () => assembleBucketBreakdown(
      'day',
      '2026-06-08',
      usageWith({ '2026-06-08|claude': dirty }),
      { '2026-06-08|claude|Sonnet': usageAgg({ outputTokens: 175 }) },
      emptyGit(),
      [],
      '2026-06-01',
      allVisibleFilter(),
    ),
    /dirty dailyBreakdown row 2026-06-08\|claude/,
  );
});

test('fail-loud: malformed breakdownStartedDate throws (F5)', () => {
  assert.throws(
    () => assembleBucketBreakdown(
      'day',
      '2026-06-08',
      usageWith({ '2026-06-08|claude': claude08 }),
      { '2026-06-08|claude|Sonnet': usageAgg({ outputTokens: 175 }) },
      emptyGit(),
      [],
      'June 1',
      allVisibleFilter(),
    ),
    /dirty breakdownStartedDate/,
  );
});

test('ZERO-tolerance per-provider reconciliation throws on mismatch (A6)', () => {
  const usage = { dailyBreakdown: { '2026-06-10|claude': row('2026-06-10', { thinking: 60, response: 40 }) } };
  const dailyModel = { '2026-06-10|claude|Sonnet': usageAgg({ inputTokens: 0, outputTokens: 101 }) };
  assert.throws(
    () => assembleBucketBreakdown('day', '2026-06-10', usage, dailyModel, emptyGit(), [], '2026-06-01', allVisibleFilter()),
    /breakdown reconciliation/,
  );
});

test('exact match passes with zero tolerance', () => {
  const usage = { dailyBreakdown: { '2026-06-10|claude': row('2026-06-10', { thinking: 60, response: 40 }) } };
  const dailyModel = { '2026-06-10|claude|Sonnet': usageAgg({ inputTokens: 0, outputTokens: 100 }) };
  assert.doesNotThrow(() => assembleBucketBreakdown('day', '2026-06-10', usage, dailyModel, emptyGit(), [], '2026-06-01', allVisibleFilter()));
});

test('breakdown date with NO dailyModel peer throws (A12)', () => {
  const usage = { dailyBreakdown: { '2026-06-10|claude': row('2026-06-10', { thinking: 60, response: 40 }) } };
  assert.throws(
    () => assembleBucketBreakdown('day', '2026-06-10', usage, {}, emptyGit(), [], '2026-06-01', allVisibleFilter()),
    /no dailyModel peer/,
  );
});

test('pre-boundary date with dailyModel output but no breakdown row is NOT reconciled (A5/B4)', () => {
  const usage = { dailyBreakdown: { '2026-06-10|claude': row('2026-06-10', { thinking: 60, response: 40 }) } };
  const dailyModel = {
    '2026-06-08|claude|Sonnet': usageAgg({ inputTokens: 5000, outputTokens: 7000 }),
    '2026-06-10|claude|Sonnet': usageAgg({ inputTokens: 0, outputTokens: 100 }),
  };
  assert.doesNotThrow(() => assembleBucketBreakdown('week', '2026-06-08', usage, dailyModel, emptyGit(), [], '2026-06-10', allVisibleFilter()));
});

test('POST-boundary covered date: dailyModel output present but breakdown ABSENT throws (B4)', () => {
  const usage = { dailyBreakdown: { '2026-06-10|claude': row('2026-06-10', { thinking: 60, response: 40 }) } };
  const dailyModel = {
    '2026-06-09|claude|Sonnet': usageAgg({ inputTokens: 1000, outputTokens: 500 }),
    '2026-06-10|claude|Sonnet': usageAgg({ inputTokens: 0, outputTokens: 100 }),
  };
  assert.throws(
    () => assembleBucketBreakdown('week', '2026-06-08', usage, dailyModel, emptyGit(), [], '2026-06-08', allVisibleFilter()),
    /has dailyModel output 500 but no breakdown row/,
  );
});

test('POST-boundary covered date with zero dailyModel output and no breakdown row passes (B4 boundary)', () => {
  const usage = { dailyBreakdown: { '2026-06-10|claude': row('2026-06-10', { thinking: 60, response: 40 }) } };
  const dailyModel = {
    '2026-06-09|claude|Sonnet': usageAgg({ inputTokens: 1000, outputTokens: 0 }),
    '2026-06-10|claude|Sonnet': usageAgg({ inputTokens: 0, outputTokens: 100 }),
  };
  assert.doesNotThrow(() => assembleBucketBreakdown('week', '2026-06-08', usage, dailyModel, emptyGit(), [], '2026-06-08', allVisibleFilter()));
});

test("'other' provider is EXCLUDED from the breakdown (D1)", () => {
  const usage = { dailyBreakdown: {} };
  const dailyModel = { '2026-06-10|other|some-model': usageAgg({ inputTokens: 700, outputTokens: 300 }) };
  let out;
  assert.doesNotThrow(() => {
    out = assembleBucketBreakdown('day', '2026-06-10', usage, dailyModel, emptyGit(), [], '2026-06-01', allVisibleFilter());
  });
  assert.equal(out.providers.find(p => p.provider === 'other'), undefined);
});

test('undefined filter THROWS at the query entry (E2 fail-loud)', () => {
  const usage = { dailyBreakdown: { '2026-06-10|claude': row('2026-06-10', { thinking: 60, response: 40 }) } };
  const dailyModel = { '2026-06-10|claude|Sonnet': usageAgg({ inputTokens: 0, outputTokens: 100 }) };
  assert.throws(
    () => assembleBucketBreakdown('day', '2026-06-10', usage, dailyModel, emptyGit(), [], '2026-06-01', undefined),
    /visibility filter is required/,
  );
});

test('dailyBreakdown key with an illegal provider segment THROWS (E3 dirty-key)', () => {
  const usage = { dailyBreakdown: { '2026-06-10|bogus': row('2026-06-10', { thinking: 60, response: 40 }) } };
  const dailyModel = { '2026-06-10|claude|Sonnet': usageAgg({ inputTokens: 0, outputTokens: 100 }) };
  assert.throws(
    () => assembleBucketBreakdown('day', '2026-06-10', usage, dailyModel, emptyGit(), [], '2026-06-01', allVisibleFilter()),
    /illegal provider/,
  );
});

test('dailyModel key with an illegal provider segment THROWS (E3 dirty-key)', () => {
  const dailyModel = { '2026-06-10|bogus|Sonnet': usageAgg({ inputTokens: 0, outputTokens: 100 }) };
  assert.throws(
    () => assembleBucketBreakdown('day', '2026-06-10', usageWith({}), dailyModel, emptyGit(), [], '2026-06-01', allVisibleFilter()),
    /illegal provider/,
  );
});

test('toggled-off tracked provider is excluded when a visibility filter is threaded (D1)', () => {
  const usage = { dailyBreakdown: { '2026-06-10|codex': row('2026-06-10', { thinking: 50, response: 50 }) } };
  const dailyModel = { '2026-06-10|codex|GPT-5-CODEX': usageAgg({ inputTokens: 10, outputTokens: 100 }) };
  let out;
  assert.doesNotThrow(() => {
    out = assembleBucketBreakdown('day', '2026-06-10', usage, dailyModel, emptyGit(), [], '2026-06-01', makeVisibilityFilter({ codex: false }));
  });
  assert.equal(out.providers.find(p => p.provider === 'codex'), undefined);
});

test('card total equals headline noCacheTokens by construction (D1)', () => {
  const usage = { dailyBreakdown: { '2026-06-10|claude': row('2026-06-10', { thinking: 60, response: 40 }) } };
  const dailyModel = {
    '2026-06-10|claude|Sonnet': usageAgg({ inputTokens: 900, outputTokens: 100 }),
    '2026-06-10|other|some-model': usageAgg({ inputTokens: 200, outputTokens: 300 }),
  };
  const out = assembleBucketBreakdown('day', '2026-06-10', usage, dailyModel, emptyGit(), [], '2026-06-01', allVisibleFilter());
  const cardTotal = out.providers.reduce(
    (sum, provider) => sum + provider.input + provider.output.thinking + provider.output.response
      + Object.values(provider.output.toolOutput).reduce((a, b) => a + b, 0),
    0,
  );
  assert.equal(cardTotal, 1000);
});
