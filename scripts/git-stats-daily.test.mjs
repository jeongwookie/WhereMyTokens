import test from 'node:test';
import assert from 'node:assert/strict';

import gitStatsCollector from '../dist/main/gitStatsCollector.js';

const { aggregateDailyAllStats, aggregateDailyStats, parseDaily7dLog, parseDailyAllLog } = gitStatsCollector;

const CATEGORIES = ['product_code', 'test_code', 'docs_spec', 'config_build', 'schema_migration', 'vendor', 'asset'];

function zeroCategories() {
  return Object.fromEntries(CATEGORIES.map(category => [category, { added: 0, removed: 0 }]));
}

function categories(overrides = {}) {
  const out = zeroCategories();
  for (const [category, lines] of Object.entries(overrides)) {
    out[category] = { ...out[category], ...lines };
  }
  return out;
}

function day(overrides) {
  return { byCategory: zeroCategories(), ...overrides };
}

const DAYS = [
  '2026-04-17',
  '2026-04-18',
  '2026-04-19',
  '2026-04-20',
  '2026-04-21',
  '2026-04-22',
  '2026-04-23',
].map(date => day({ date, commits: 0, added: 0, removed: 0 }));

test('daily git log parser fills all seven dates', () => {
  const parsed = parseDaily7dLog('', DAYS);

  assert.deepEqual(parsed, DAYS);
});

test('daily git log parser counts commit-only days', () => {
  const parsed = parseDaily7dLog('__WMT_DAY__2026-04-20\n', DAYS);
  const day = parsed.find(d => d.date === '2026-04-20');

  assert.deepEqual(day, { date: '2026-04-20', commits: 1, added: 0, removed: 0, byCategory: zeroCategories() });
});

test('daily git log parser sums added and removed lines', () => {
  const parsed = parseDaily7dLog([
    '__WMT_DAY__2026-04-21',
    '10\t3\tsrc/a.ts',
    '4\t0\tsrc/b.ts',
  ].join('\n'), DAYS);
  const day = parsed.find(d => d.date === '2026-04-21');

  assert.deepEqual(day, { date: '2026-04-21', commits: 1, added: 14, removed: 3, byCategory: categories({ product_code: { added: 14, removed: 3 } }) });
});

test('daily git log parser ignores binary numstat lines', () => {
  const parsed = parseDaily7dLog([
    '__WMT_DAY__2026-04-22',
    '-\t-\tassets/icon.png',
    '2\t5\tsrc/c.ts',
  ].join('\n'), DAYS);
  const day = parsed.find(d => d.date === '2026-04-22');

  assert.deepEqual(day, { date: '2026-04-22', commits: 1, added: 2, removed: 5, byCategory: categories({ product_code: { added: 2, removed: 5 } }) });
});

test('daily git log parser preserves negative net days', () => {
  const parsed = parseDaily7dLog([
    '__WMT_DAY__2026-04-23',
    '1\t9\tsrc/remove.ts',
  ].join('\n'), DAYS);
  const day = parsed.find(d => d.date === '2026-04-23');

  assert.equal((day?.added ?? 0) - (day?.removed ?? 0), -8);
});

test('daily git stats aggregate same-date data across repos', () => {
  const repoA = {
    daily7d: parseDaily7dLog([
      '__WMT_DAY__2026-04-21',
      '10\t3\tsrc/a.ts',
    ].join('\n'), DAYS),
  };
  const repoB = {
    daily7d: parseDaily7dLog([
      '__WMT_DAY__2026-04-21',
      '2\t8\tsrc/b.ts',
    ].join('\n'), DAYS),
  };

  const merged = aggregateDailyStats([repoA, repoB], DAYS);
  const day = merged.find(d => d.date === '2026-04-21');

  assert.deepEqual(day, { date: '2026-04-21', commits: 2, added: 12, removed: 11, byCategory: categories({ product_code: { added: 12, removed: 11 } }) });
});

test('all-time daily parser returns sorted cumulative source buckets', () => {
  const parsed = parseDailyAllLog([
    '__WMT_DAY__2026-04-22',
    '7\t2\tsrc/newer.ts',
    '__WMT_DAY__2026-04-20',
    '3\t9\tsrc/older.ts',
  ].join('\n'));

  assert.deepEqual(parsed, [
    { date: '2026-04-20', commits: 1, added: 3, removed: 9, byCategory: categories({ product_code: { added: 3, removed: 9 } }) },
    { date: '2026-04-22', commits: 1, added: 7, removed: 2, byCategory: categories({ product_code: { added: 7, removed: 2 } }) },
  ]);
});

test('all-time daily parser classifies numstat paths by category', () => {
  const parsed = parseDailyAllLog([
    '__WMT_DAY__2026-04-24',
    '7\t1\tsrc/main/x.ts',
    '3\t0\tscripts/x.test.mjs',
  ].join('\n'));
  const day = parsed.find(d => d.date === '2026-04-24');

  assert.deepEqual(day?.byCategory.product_code, { added: 7, removed: 1 });
  assert.equal(day?.byCategory.test_code.added, 3);
});

test('all-time daily parser classifies renamed files by post-rename path', () => {
  const parsed = parseDailyAllLog([
    '__WMT_DAY__2026-04-25',
    '2\t1\tsrc/{old.ts => renamed.test.ts}',
  ].join('\n'));
  const day = parsed.find(d => d.date === '2026-04-25');

  assert.deepEqual(day?.byCategory.test_code, { added: 2, removed: 1 });
});

test('all-time daily stats aggregate dates across repos', () => {
  const merged = aggregateDailyAllStats([
    { dailyAll: [day({ date: '2026-04-20', commits: 1, added: 3, removed: 1 })] },
    { dailyAll: [day({ date: '2026-04-20', commits: 2, added: 5, removed: 4 })] },
    { dailyAll: [day({ date: '2026-04-21', commits: 1, added: 9, removed: 0 })] },
  ]);

  assert.deepEqual(merged, [
    { date: '2026-04-20', commits: 3, added: 8, removed: 5, byCategory: zeroCategories() },
    { date: '2026-04-21', commits: 1, added: 9, removed: 0, byCategory: zeroCategories() },
  ]);
});
