import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync('taskbar-helper/Program.cs', 'utf8');

test('native helper consumes exactly two physical Lines', () => {
  assert.match(source, /TaskbarQuotaDisplayLine\[\] Lines/);
  assert.match(source, /snapshot\.Lines is not \{ Length: 2 \}/);
  assert.doesNotMatch(source, /snapshot\.Rows/);
});

test('native helper accepts only canonical periods and permits repeated single-period lines', () => {
  const periodSet = source.match(/ValidTaskbarPeriods[^\n]*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(periodSet, /"5h"/);
  assert.match(periodSet, /"7d"/);
  assert.doesNotMatch(periodSet, /"1w"/);
  assert.match(source, /ValidTaskbarPeriods\.Contains\(row\.Period\)/);
  assert.doesNotMatch(source, /Lines\[0\].*5h/);
  assert.doesNotMatch(source, /Lines\[1\].*1w/);
});

test('native helper validates canonical limited and unlimited block states', () => {
  assert.match(source, /ValidQuotaStates/);
  assert.match(source, /block\.State == "limited"/);
  assert.match(source, /block\.State == "unlimited"/);
  assert.match(source, /double\? UsedPct/);
  assert.doesNotMatch(source, /QuotaPct/);
});

test('native helper omits missing elapsed and reset segments instead of drawing placeholders', () => {
  assert.match(source, /block\.ElapsedPct is null \? ""/);
  assert.match(source, /string\.IsNullOrWhiteSpace\(block\.ResetLabel\) \? ""/);
  assert.doesNotMatch(source, /StatusLabel/);
  assert.doesNotMatch(source, /\?\? "--"/);
});

test('native helper renders explicit unlimited as infinity', () => {
  assert.match(source, /block\.State == "unlimited" \? "∞"/);
});

test('native helper prefixes inferred elapsed with a compact estimate marker', () => {
  assert.match(source, /block\.DurationInferred \? "~" : ""/);
});

test('native helper retains measured overflow and hit-safe owner-drawn layout', () => {
  assert.match(source, /MeasureOverflowBadgeWidth/);
  assert.match(source, /HiddenCount/);
  assert.match(source, /TaskbarQuotaCanvas : Control/);
  assert.match(source, /TextRenderingHint\.AntiAliasGridFit/);
});

test('native helper keeps per-monitor DPI and taskbar attachment contracts', () => {
  assert.match(source, /HighDpiMode\.PerMonitorV2/);
  assert.match(source, /AttachToTaskbar/);
  assert.match(source, /GetDpiForWindow/);
});
