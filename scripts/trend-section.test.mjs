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

test('TrendCard gives endpoint nodes hit zones and a distinct cost color', () => {
  const trendCard = fs.readFileSync('src/renderer/components/TrendCard.tsx', 'utf8');
  assert.match(trendCard, /TREND_COST_COLOR/);
  assert.match(trendCard, /hitZoneFor/);
  assert.match(trendCard, /onMouseMove=\{\(e\) => activateHitZone/);
});

test('history warmup banner explains changing totals during full-history sync', () => {
  const mainView = fs.readFileSync('src/renderer/views/MainView.tsx', 'utf8');
  assert.match(mainView, /Trend and totals may keep changing/);
  assert.match(mainView, /until this banner disappears/);
});

test('TrendCard uses the original output chart width with compact plot margins', () => {
  const trendCard = fs.readFileSync('src/renderer/components/TrendCard.tsx', 'utf8');
  assert.match(trendCard, /const CHART = \{ width: 330, height: 126, left: 14, right: 14, top: 12, bottom: 24 \}/);
  assert.match(trendCard, /function tooltipLeft\(index: number, count: number\): number \{[\s\S]*CHART\.width - 16/);
});
