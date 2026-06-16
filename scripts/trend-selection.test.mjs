import test from 'node:test';
import assert from 'node:assert/strict';
import sel from '../dist/renderer/trendSelection.js';

const { nextSelection, selectionAfterGrainChange } = sel;

test('clicking the same key clears selection (toggle collapse)', () => {
  assert.equal(nextSelection('2026-06-08', '2026-06-08'), null);
});

test('clicking a different key switches selection', () => {
  assert.equal(nextSelection('2026-06-08', '2026-06-09'), '2026-06-09');
});

test('clicking from empty selects', () => {
  assert.equal(nextSelection(null, '2026-06-08'), '2026-06-08');
});

test('grain change clears any selection', () => {
  assert.equal(selectionAfterGrainChange('2026-06-08'), null);
});
