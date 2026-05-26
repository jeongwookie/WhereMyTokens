import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Trend is a normalized main section between Code Output and Sessions', () => {
  const sections = fs.readFileSync('src/renderer/mainSections.ts', 'utf8');
  assert.match(sections, /'trend'/);
  assert.match(sections, /trend: 'Trend'/);
  const orderMatch = sections.match(/MAIN_SECTION_IDS = \[(.*?)\]/s);
  assert.ok(orderMatch);
  const order = orderMatch[1];
  assert.ok(order.indexOf("'codeOutput'") < order.indexOf("'trend'"));
  assert.ok(order.indexOf("'trend'") < order.indexOf("'sessions'"));
});

test('MainView renders TrendCard with usage and code output data', () => {
  const mainView = fs.readFileSync('src/renderer/views/MainView.tsx', 'utf8');
  assert.match(mainView, /TrendCard/);
  assert.match(mainView, /usageTrend/);
  assert.match(mainView, /codeOutputStats/);
});
