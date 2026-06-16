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

test('TrendCard gives endpoint hover coverage and a distinct cost color', () => {
  const trendCard = fs.readFileSync('src/renderer/components/TrendCard.tsx', 'utf8');
  assert.match(trendCard, /TREND_COST_COLOR/);
  assert.match(trendCard, /hoverIndexForX/);
  assert.match(trendCard, /x=\{0\}/);
  assert.match(trendCard, /width=\{CHART\.width\}/);
});

test('TrendCard hover uses one full-width overlay and skips redundant hover updates', () => {
  const trendCard = fs.readFileSync('src/renderer/components/TrendCard.tsx', 'utf8');
  assert.match(trendCard, /function hoverIndexForX\(rawX: number, count: number, chartWidth: number\): number/);
  assert.match(trendCard, /setHoverIndex\(prev => prev === nextIndex \? prev : nextIndex\)/);
  assert.match(trendCard, /<rect[\s\S]*x=\{0\}[\s\S]*width=\{CHART\.width\}[\s\S]*onMouseMove=\{handleMouseMove\}/);
  assert.doesNotMatch(trendCard, /points\.map\(\(_, index\) => \{[\s\S]*hitZoneFor/);
});

test('TrendCard hides tooltip when the pointer leaves the chart', () => {
  const trendCard = fs.readFileSync('src/renderer/components/TrendCard.tsx', 'utf8');
  assert.match(trendCard, /const showHoverDetail = hoverIndex !== null/);
  assert.match(trendCard, /function handleMouseLeave\(\)/);
  assert.match(trendCard, /setHoverIndex\(prev => prev === null \? prev : null\)/);
  assert.match(trendCard, /onMouseLeave=\{handleMouseLeave\}/);
  assert.match(trendCard, /\{showHoverDetail && activeRow && points\[activeIndex\] && \(/);
  assert.match(trendCard, /\{showHoverDetail && activeRow && rows\.length > 0 && \(/);
});

test('history warmup banner explains changing totals during full-history sync', () => {
  const mainView = fs.readFileSync('src/renderer/views/MainView.tsx', 'utf8');
  assert.match(mainView, /Trend and totals may keep changing/);
  assert.match(mainView, /until this banner disappears/);
});

test('TrendCard uses Code Output-style fixed chart coordinates with CSS scaling', () => {
  const trendCard = fs.readFileSync('src/renderer/components/TrendCard.tsx', 'utf8');
  assert.match(trendCard, /const CHART = \{ width: 330, height: 126, left: 12, right: 52, top: 12, bottom: 24 \}/);
  assert.match(trendCard, /viewBox=\{`0 0 \$\{CHART\.width\} \$\{CHART\.height\}`\}/);
  assert.match(trendCard, /width=\{CHART\.width\}/);
  assert.match(trendCard, /preserveAspectRatio="none"/);
  assert.match(trendCard, /style=\{\{ width: '100%', display: 'block', overflow: 'visible', cursor: rows\.length > 0 \? 'pointer' : 'default' \}\}/);
  assert.match(trendCard, /xFor\(index, rows\.length, CHART\.width\)/);
  assert.match(trendCard, /function tooltipLeft\(index: number, count: number, chartWidth: number\): number \{[\s\S]*chartWidth - 6/);
});

test('TrendCard does not depend on mount-time measured widths', () => {
  const trendCard = fs.readFileSync('src/renderer/components/TrendCard.tsx', 'utf8');
  assert.doesNotMatch(trendCard, /ResizeObserver/);
  assert.doesNotMatch(trendCard, /chartHostRef/);
  assert.doesNotMatch(trendCard, /setChartWidth/);
  assert.doesNotMatch(trendCard, /scheduleMeasurement/);
});

test('TrendCard labels title totals with the visible grain window', () => {
  const trendCard = fs.readFileSync('src/renderer/components/TrendCard.tsx', 'utf8');
  assert.match(trendCard, /day: \{ limit: 14, label: '14d' \}/);
  assert.match(trendCard, /week: \{ limit: 12, label: '12w' \}/);
  assert.match(trendCard, /month: \{ limit: 12, label: '12m' \}/);
  assert.match(trendCard, /rows\.length === 0/);
  assert.match(trendCard, /\`\$\{GRAIN_WINDOWS\[grain\]\.label\}: no trend data yet\`/);
  assert.match(trendCard, /hasUsageSeries \? formatPrimary\(totalPrimary, metric, currency, usdToKrw\) : 'usage pending'/);
  assert.match(trendCard, /hasOutputSeries \? fmtSignedCompact\(totalOutput\) : 'output pending'/);
  assert.match(trendCard, /\/ \$\{hasOutputSeries \? fmtSignedCompact\(totalOutput\) : 'output pending'\} net/);
  assert.doesNotMatch(trendCard, /total \{formatPrimary\(totalPrimary, metric, currency, usdToKrw\)\}/);
  assert.match(trendCard, /const limit = GRAIN_WINDOWS\[grain\]\.limit/);
});

test('TrendCard offers work and billing cache views for token trends', () => {
  const trendCard = fs.readFileSync('src/renderer/components/TrendCard.tsx', 'utf8');
  assert.match(trendCard, /cacheView/);
  assert.match(trendCard, /'work'/);
  assert.match(trendCard, /'billing'/);
  assert.match(trendCard, /useState<CacheView>\('work'\)/);
  assert.match(trendCard, /work: 'Work'/);
  assert.match(trendCard, /billing: 'Billing'/);
  assert.match(trendCard, /labels=\{CACHE_VIEW_LABELS\}/);
  assert.match(trendCard, /cacheView === 'work' \? row\.noCacheTokens : row\.tokens/);
});

test('TrendCard labels request count in English and subordinates cache controls to tokens', () => {
  const trendCard = fs.readFileSync('src/renderer/components/TrendCard.tsx', 'utf8');
  assert.match(trendCard, /activeRow\.requestCount\} requests/);
  const legacyRequestLabel = String.fromCharCode(35831, 27714);
  assert.doesNotMatch(trendCard, new RegExp(`activeRow\\.requestCount\\} ${legacyRequestLabel}`));
  assert.match(trendCard, /Metric/);
  assert.match(trendCard, /Cache/);
  assert.match(trendCard, /Range/);
  assert.match(trendCard, /metric === 'tokens' && \(/);
  assert.match(trendCard, /cacheModifier/);
  assert.match(trendCard, /CACHE_VIEWS/);
  assert.match(trendCard, /work: 'Work'/);
  assert.match(trendCard, /billing: 'Billing'/);
});

test('TrendCard wires click selection to the inline breakdown card', () => {
  const trendCard = fs.readFileSync('src/renderer/components/TrendCard.tsx', 'utf8');
  assert.match(trendCard, /window\.wmt\.getBreakdown/);
  assert.match(trendCard, /<TrendBreakdownCard/);
  assert.match(trendCard, /role="button"/);
  assert.match(trendCard, /handleChartKeyDown/);
});

test('TrendCard does not draw missing usage or output buckets as zero-value trend lines', () => {
  const trendCard = fs.readFileSync('src/renderer/components/TrendCard.tsx', 'utf8');
  assert.match(trendCard, /const primaryValues = rows\.filter\(row => row\.hasUsage\)\.map/);
  assert.match(trendCard, /const outputValues = rows\.filter\(row => row\.hasOutput\)\.map/);
  assert.match(trendCard, /const primaryPaths = hasUsageSeries \? pathsForRows\(rows, points, row => row\.hasUsage, point => point\.primaryY\) : \[\]/);
  assert.match(trendCard, /const outputPaths = hasOutputSeries \? pathsForRows\(rows, points, row => row\.hasOutput, point => point\.outputY\) : \[\]/);
  assert.match(trendCard, /function pathsForRows\(/);
  assert.doesNotMatch(trendCard, /pathFor\(points\.map\(point => \(\{ x: point\.x, y: point\.primaryY \}\)\)\)/);
  assert.doesNotMatch(trendCard, /pathFor\(points\.map\(point => \(\{ x: point\.x, y: point\.outputY \}\)\)\)/);
  assert.match(trendCard, /No trend data yet/);
  assert.doesNotMatch(trendCard, /Syncing history/);
});
