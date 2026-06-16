import test from 'node:test';
import assert from 'node:assert/strict';
import mod from '../dist/shared/bucketKey.js';

const { dayKey, weekKey, monthKey, bucketDateRange } = mod;

test('day/week/month key formats', () => {
  assert.equal(dayKey('2026-06-10'), '2026-06-10');
  // 2026-06-10 is a Wednesday -> Monday-start week is 2026-06-08
  assert.equal(weekKey('2026-06-10'), '2026-06-08');
  assert.equal(weekKey('2026-06-08'), '2026-06-08'); // Monday maps to itself
  assert.equal(monthKey('2026-06-10'), '2026-06');
});

test('bucketDateRange round-trips the keys the producer emits', () => {
  assert.deepEqual(bucketDateRange('day', '2026-06-10'), { startDate: '2026-06-10', endDate: '2026-06-10' });
  assert.deepEqual(bucketDateRange('week', '2026-06-08'), { startDate: '2026-06-08', endDate: '2026-06-14' });
  assert.deepEqual(bucketDateRange('month', '2026-06'), { startDate: '2026-06-01', endDate: '2026-06-30' });
});

test('weekKey matches the renderer producer rule for every weekday', () => {
  // The producer (TrendCard.weekStartKey) and consumer (bucketDateRange) must agree.
  // Mon..Sun of one week all collapse to the same Monday key.
  for (const d of ['2026-06-08','2026-06-09','2026-06-10','2026-06-11','2026-06-12','2026-06-13','2026-06-14']) {
    assert.equal(weekKey(d), '2026-06-08');
  }
});
