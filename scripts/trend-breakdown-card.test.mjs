import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildBreakdownBlocks } from '../dist/renderer/breakdownViewModel.js';

const emptyToolOutput = () => ({
  read: 0,
  editWrite: 0,
  search: 0,
  git: 0,
  buildTest: 0,
  terminal: 0,
  subagents: 0,
  web: 0,
});

function provider(provider, output, tools = {}, overrides = {}) {
  return {
    provider,
    input: 0,
    thinkingExact: true,
    output,
    tools: {
      read: 0,
      editWrite: 0,
      search: 0,
      git: 0,
      buildTest: 0,
      terminal: 0,
      subagents: 0,
      web: 0,
      ...tools,
    },
    firstSeenDate: '2026-06-15',
    ...overrides,
  };
}

function breakdown(overrides) {
  return {
    grain: 'day',
    bucketKey: '2026-06-15',
    providers: [],
    netLines: null,
    ...overrides,
  };
}

test('buildBreakdownBlocks exposes per-provider input + 3-layer output + thinkingExact + merged tools', () => {
  const vm = buildBreakdownBlocks(breakdown({
    providers: [
      provider(
        'claude',
        { thinking: 1_100_000, response: 400_000, toolOutput: { ...emptyToolOutput(), editWrite: 1_000_000 } },
        { editWrite: 290 },
        { input: 6_900_000, thinkingExact: false },
      ),
      provider(
        'codex',
        { thinking: 208_000, response: 30_000, toolOutput: { ...emptyToolOutput(), editWrite: 200_000, terminal: 50_000 } },
        { editWrite: 10, terminal: 2 },
        { input: 800_000, thinkingExact: true },
      ),
    ],
  }));

  const [claude, codex] = vm.perProviderOutput;
  assert.equal(claude.input, 6_900_000);
  assert.equal(claude.output.thinking, 1_100_000);
  assert.equal(claude.output.response, 400_000);
  assert.equal(claude.output.toolOutput.editWrite, 1_000_000);
  assert.equal(claude.thinkingExact, false);
  assert.equal(claude.outputTotal, 2_500_000);          // output-only (bar/pct denominator)
  assert.equal(claude.total, 9_400_000);                // input + output (headline-matching)

  assert.equal(codex.input, 800_000);
  assert.equal(codex.thinkingExact, true);
  assert.equal(codex.outputTotal, 488_000);
  assert.equal(codex.total, 1_288_000);

  assert.deepEqual(vm.toolMerged.editWrite, { count: 300, tokens: 1_200_000 });
  assert.deepEqual(vm.toolMerged.terminal, { count: 2, tokens: 50_000 });
});

test('view-model exposes only toolMerged and never the v1 toolActivity field', () => {
  const vm = buildBreakdownBlocks(breakdown({
    providers: [
      provider(
        'claude',
        { thinking: 10, response: 20, toolOutput: { ...emptyToolOutput(), editWrite: 70 } },
        { editWrite: 3 },
        { thinkingExact: false },
      ),
    ],
  }));

  assert.equal('toolActivity' in vm, false);
  assert.deepEqual(vm.toolMerged.editWrite, { count: 3, tokens: 70 });
});

test('buildBreakdownBlocks marks token empty when there are no providers', () => {
  const vm = buildBreakdownBlocks(breakdown({ providers: [] }));
  assert.equal(vm.tokenEmpty, true);
  assert.deepEqual(vm.perProviderOutput, []);
});

test('buildBreakdownBlocks marks net lines empty when netLines is null', () => {
  const vm = buildBreakdownBlocks(breakdown({ netLines: null }));
  assert.equal(vm.netLinesEmpty, true);
  assert.equal(vm.netLines, null);
});

test('buildBreakdownBlocks surfaces partialSinceDate', () => {
  const vm = buildBreakdownBlocks(breakdown({ partialSinceDate: '2026-06-10' }));
  assert.equal(vm.partialSinceDate, '2026-06-10');
});

test('TrendBreakdownCard carries the three unit labels (source guard, unavoidable)', () => {
  const src = fs.readFileSync('src/renderer/components/TrendBreakdownCard.tsx', 'utf8');
  for (const label of ['input + output · no-cache', 'calls · ≈tok', 'git · lines']) {
    assert.match(src, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('TrendBreakdownCard uses precision-driven markers and only the merged tool block', () => {
  const src = fs.readFileSync('src/renderer/components/TrendBreakdownCard.tsx', 'utf8');
  assert.match(src, /Input \{fmtTokens\(Math\.round\(provider\.input\)\)\}/);
  assert.match(src, /thinkingExact \? '' : '≈'/);
  assert.match(src, /response[\s\S]*marker: '≈'/);
  assert.match(src, /toolOutput[\s\S]*marker: '≈'/);
  assert.match(src, /\$\{row\.count\} calls · ≈\$\{fmtTokens\(Math\.round\(row\.tokens\)\)\} tok/);
  assert.doesNotMatch(src, /function ToolActivityBlock/);
  assert.doesNotMatch(src, /No tool calls/);
  assert.doesNotMatch(src, /outputSegmented/);
});

test('TrendBreakdownCard leads with an on-bar input:output split and an output funnel', () => {
  const src = fs.readFileSync('src/renderer/components/TrendBreakdownCard.tsx', 'utf8');
  // Level-1 split: values + % labelled directly on the bar (no separate detail rows).
  assert.match(src, /const inputPct = pctOf\(provider\.input, provider\.total\)/);
  assert.match(src, /Output \{fmtTokens\(Math\.round\(provider\.outputTotal\)\)\}/);
  assert.match(src, /pctOf\(provider\.outputTotal, provider\.total\)/);
  // Funnel drill-down cue from the output segment down to the full-width composition bar.
  assert.match(src, /function OutputFunnel/);
  assert.match(src, /<OutputFunnel inputPct=\{inputPct\} color=\{OUTPUT_COLOR\}/);
  assert.match(src, /points=\{`\$\{inputPct\},0 100,0 100,16 0,16`\}/);
  // Chosen palette B + the synthetic "Tool-call" aggregate row stays gone.
  assert.match(src, /INPUT_COLOR = '#34C9BE'/);
  assert.match(src, /OUTPUT_COLOR = '#6176DD'/);
  assert.doesNotMatch(src, /label: 'Tool-call'/);
});

test('TrendBreakdownCard collapses the output tail behind a per-provider toggle', () => {
  const src = fs.readFileSync('src/renderer/components/TrendBreakdownCard.tsx', 'utf8');
  assert.match(src, /useState\(false\)/);
  assert.match(src, /PINNED_TOOL_KEYS = new Set<ToolCategory>\(\['editWrite'\]\)/);
  assert.match(src, /Show \$\{hiddenCount\} more/);
  assert.match(src, /Collapse/);
});

test('NetLinesBlock shows title, centered delta pair, and right-aligned Net value', () => {
  const src = fs.readFileSync('src/renderer/components/TrendBreakdownCard.tsx', 'utf8');
  assert.match(src, /gridTemplateColumns: '1fr auto 1fr'/);
  assert.match(src, /justifySelf: 'start'[\s\S]*>\{meta\.label\}/);
  assert.match(src, /justifySelf: 'center'[\s\S]*color: C\.barRed[\s\S]*>-\{row\.removed\}/);
  assert.match(src, /<span style=\{\{ color: C\.textMuted \}\}>\|<\/span>/);
  assert.match(src, /color: C\.active[\s\S]*>\+\{row\.added\}/);
  assert.match(src, /justifySelf: 'end'[\s\S]*>Net:\{fmtSigned\(row\.added - row\.removed\)\}/);
  assert.ok(src.indexOf('>-{row.removed}') < src.indexOf('>+{row.added}'));
  assert.doesNotMatch(src, /Net:\{fmtSigned\(row\.added - row\.removed\)\} lines/);
});
