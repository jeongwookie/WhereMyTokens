import React, { useMemo, useState } from 'react';
import { useTheme } from '../ThemeContext';
import { fmtTokens } from '../theme';
import { buildBreakdownBlocks, type ProviderOutputBlock, type ToolMerged } from '../breakdownViewModel';
import {
  PATH_CATEGORIES,
  TOOL_CATEGORY_KEYS,
  type BucketBreakdown,
  type NetLinesByCategory,
  type PathCategory,
  type ToolCategory,
} from '../../shared/breakdownTypes';

interface Props {
  breakdown: BucketBreakdown | null;
  loading?: boolean;
  error?: unknown;
}

const INPUT_COLOR = '#0f766e';  // level-1 input segment + label
const OUTPUT_COLOR = '#4f46e5'; // level-1 output segment + funnel + label
const THINKING_COLOR = '#2dd4bf';
const RESPONSE_COLOR = '#94a3b8';
// Pinned output rows always render even when small; the rest collapse behind a toggle.
const PINNED_TOOL_KEYS = new Set<ToolCategory>(['editWrite']);
const DEFAULT_TOOL_ROWS = 3; // tool rows shown before expansion

const TOOL_META: Array<{ key: ToolCategory; label: string; color: string }> = [
  { key: 'read', label: 'Read', color: '#60a5fa' },
  { key: 'editWrite', label: 'Edit / Write', color: '#a78bfa' },
  { key: 'search', label: 'Search', color: '#38bdf8' },
  { key: 'git', label: 'Git', color: '#4ade80' },
  { key: 'buildTest', label: 'Build / Test', color: '#fb923c' },
  { key: 'terminal', label: 'Terminal', color: '#fbbf24' },
  { key: 'subagents', label: 'Subagents', color: '#f472b6' },
  { key: 'web', label: 'Web', color: '#c084fc' },
];

const PATH_META: Record<PathCategory, { label: string; color: string }> = {
  product_code: { label: 'Product code', color: '#34d399' },
  test_code: { label: 'Tests', color: '#60a5fa' },
  docs_spec: { label: 'Docs / Spec', color: '#a78bfa' },
  config_build: { label: 'Config / Build', color: '#fbbf24' },
  schema_migration: { label: 'Schema / Migration', color: '#fb923c' },
  vendor: { label: 'Vendor', color: '#94a3b8' },
  asset: { label: 'Assets', color: '#38bdf8' },
};

function TrendBreakdownCard({ breakdown, loading = false, error = null }: Props) {
  const C = useTheme();
  const blocks = useMemo(() => buildBreakdownBlocks(breakdown), [breakdown]);
  const providerNames = breakdown?.providers.map(provider => provider.provider) ?? [];

  if (error) {
    return (
      <div style={shellStyle(C)}>
        <div style={{ color: C.barRed, fontSize: 11, fontFamily: C.fontMono }}>
          Breakdown unavailable
        </div>
      </div>
    );
  }

  if (loading && !breakdown) {
    return (
      <div style={shellStyle(C)}>
        <div style={{ fontSize: 10, color: C.textMuted, fontFamily: C.fontMono }}>Loading breakdown...</div>
      </div>
    );
  }

  return (
    <div style={shellStyle(C)}>
      {loading && <div style={{ fontSize: 10, color: C.textMuted, fontFamily: C.fontMono, marginBottom: 8 }}>Loading breakdown...</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {blocks.partialSinceDate && (
            <div style={{ fontSize: 10, color: C.waiting, fontFamily: C.fontMono }}>
              Breakdown data since {blocks.partialSinceDate}
            </div>
          )}
          {providerNames.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {providerNames.map(provider => (
                <span key={provider} style={{
                  fontSize: 10,
                  color: C.accent,
                  background: `${C.accent}14`,
                  border: `1px solid ${C.accent}33`,
                  borderRadius: 4,
                  padding: '1px 5px',
                  fontFamily: C.fontMono,
                }}>
                  {providerLabel(provider)}
                </span>
              ))}
            </div>
          )}

          <SectionTitle title="Token panorama" unit="input + output · no-cache" />
          {blocks.tokenEmpty ? (
            <EmptyRow label="No token data" />
          ) : (
            <OutputCompositionBlock providers={blocks.perProviderOutput} />
          )}

          <SectionTitle title={providerNames.length > 1 ? 'Tool usage · all providers' : 'Tool usage'} unit="calls · ≈tok" />
          <MergedToolBlock tools={blocks.toolMerged} />
        </div>

        <div style={{ borderTop: `1px solid ${C.borderSub}`, paddingTop: 9 }}>
          <SectionTitle title="Net lines committed" unit="git · lines" />
          {blocks.netLinesEmpty ? <EmptyRow label="No commits for this period" /> : <NetLinesBlock netLines={blocks.netLines} />}
        </div>
      </div>
    </div>
  );
}

export default React.memo(TrendBreakdownCard);

function providerLabel(provider: string): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  if (provider === 'antigravity') return 'Antigravity';
  return provider;
}

function SectionTitle({ title, unit }: { title: string; unit: string }) {
  const C = useTheme();
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: C.textDim }}>{title}</span>
      <span style={{ fontSize: 10, color: C.textMuted, fontFamily: C.fontMono }}>{unit}</span>
    </div>
  );
}

function OutputCompositionBlock({ providers }: { providers: ProviderOutputBlock[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {providers.map(provider => (
        <div key={provider.provider}>
          <ProviderCompositionRows provider={provider} />
        </div>
      ))}
    </div>
  );
}

function ProviderCompositionRows({ provider }: { provider: ProviderOutputBlock }) {
  const C = useTheme();
  const [expanded, setExpanded] = useState(false);

  // Level 1 — input : output split (denominator = provider.total).
  const inputPct = pctOf(provider.input, provider.total);
  const ioSegments = [
    { key: 'input', label: 'Input', color: INPUT_COLOR, value: provider.input },
    { key: 'output', label: 'Output', color: OUTPUT_COLOR, value: provider.outputTotal },
  ].filter(seg => seg.value > 0);

  // Level 2 — flat output composition (denominator = provider.outputTotal).
  // thinking + response + Σ tool categories == outputTotal exactly (no aggregate row → no double-count).
  const headRows = [
    { key: 'thinking', label: 'Thinking', color: THINKING_COLOR, value: provider.output.thinking, marker: provider.thinkingExact ? '' : '≈' },
    { key: 'response', label: 'Response', color: RESPONSE_COLOR, value: provider.output.response, marker: '≈' as const },
  ].filter(row => row.value > 0);
  const toolRows = TOOL_META
    .map(meta => ({ ...meta, value: provider.output.toolOutput[meta.key], marker: '≈' as const }))
    .filter(row => row.value > 0)
    .sort((a, b) => b.value - a.value);

  // Default-visible tools: the largest few, plus any pinned key (edit/write) even when small.
  const defaultToolKeys = new Set(toolRows.slice(0, DEFAULT_TOOL_ROWS).map(row => row.key));
  for (const row of toolRows) if (PINNED_TOOL_KEYS.has(row.key)) defaultToolKeys.add(row.key);
  const visibleToolRows = expanded ? toolRows : toolRows.filter(row => defaultToolKeys.has(row.key));
  const hiddenCount = toolRows.length - visibleToolRows.length;

  // The bar always shows every segment so it sums to the full output regardless of collapse.
  const barSegments = [...headRows, ...toolRows].map(row => ({ key: row.key, label: row.label, color: row.color, value: row.value }));

  return (
    <div>
      <TotalLine value={fmtTokens(Math.round(provider.total))} label={providerLabel(provider.provider)} />
      {ioSegments.length > 0 && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            {provider.input > 0 && (
              <span style={{ fontSize: 11, fontFamily: C.fontMono, color: INPUT_COLOR }}>
                Input {fmtTokens(Math.round(provider.input))} · {Math.round(inputPct)}%
              </span>
            )}
            {provider.outputTotal > 0 && (
              <span style={{ fontSize: 11, fontFamily: C.fontMono, color: OUTPUT_COLOR, marginLeft: 'auto' }}>
                Output {fmtTokens(Math.round(provider.outputTotal))} · {Math.round(pctOf(provider.outputTotal, provider.total))}%
              </span>
            )}
          </div>
          <StackedBar active={ioSegments} total={provider.total} height={9} marginBottom={0} />
        </>
      )}
      {provider.outputTotal > 0 && (
        <div>
          <OutputFunnel inputPct={inputPct} color={OUTPUT_COLOR} />
          <StackedBar active={barSegments} total={provider.outputTotal} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {[...headRows, ...visibleToolRows].map(row => (
              <MetricRow
                key={row.key}
                label={row.label}
                color={row.color}
                value={`${row.marker}${fmtTokens(Math.round(row.value))}`}
                pct={pctOf(row.value, provider.outputTotal)}
                mutedColor={C.textMuted}
              />
            ))}
            {(hiddenCount > 0 || expanded) && (
              <button type="button" onClick={() => setExpanded(prev => !prev)} style={expandToggleStyle(C)}>
                {expanded ? 'Collapse' : `Show ${hiddenCount} more`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function expandToggleStyle(C: ReturnType<typeof useTheme>): React.CSSProperties {
  return {
    alignSelf: 'flex-start',
    marginLeft: 12,
    marginTop: 1,
    background: 'transparent',
    border: 'none',
    padding: 0,
    fontSize: 10,
    fontFamily: C.fontMono,
    color: C.accent,
    cursor: 'pointer',
  };
}

function MergedToolBlock({ tools }: { tools: ToolMerged }) {
  const totalTokens = TOOL_CATEGORY_KEYS.reduce((sum, key) => sum + tools[key].tokens, 0);
  const totalCount = TOOL_CATEGORY_KEYS.reduce((sum, key) => sum + tools[key].count, 0);
  const active = TOOL_META
    .map(meta => ({ ...meta, count: tools[meta.key].count, tokens: tools[meta.key].tokens }))
    .filter(row => row.count > 0 || row.tokens > 0)
    .sort((a, b) => (b.tokens + b.count) - (a.tokens + a.count));

  if (active.length === 0) return <EmptyRow label="No tool data" />;

  return (
    <div>
      <TotalLine value={`${Math.round(totalCount)} calls`} label={`Tool calls · ≈${fmtTokens(Math.round(totalTokens))} tok`} />
      <StackedBar active={active.filter(row => row.tokens > 0).map(row => ({ ...row, value: row.tokens }))} total={totalTokens} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {active.map(row => (
          <MetricRow
            key={row.key}
            label={row.label}
            color={row.color}
            value={`${row.count} calls · ≈${fmtTokens(Math.round(row.tokens))} tok`}
            pct={pctOf(row.tokens, totalTokens)}
            valueWidth={124}
          />
        ))}
      </div>
    </div>
  );
}

function NetLinesBlock({ netLines }: { netLines: NetLinesByCategory | null }) {
  const C = useTheme();
  if (!netLines) return <EmptyRow label="No commits for this period" />;

  const rows = PATH_CATEGORIES
    .map(category => ({ category, ...netLines[category] }))
    .filter(row => row.added > 0 || row.removed > 0)
    .sort((a, b) => (b.added + b.removed) - (a.added + a.removed));
  if (rows.length === 0) return <EmptyRow label="No commits for this period" />;

  const totalAdded = rows.reduce((sum, row) => sum + row.added, 0);
  const totalRemoved = rows.reduce((sum, row) => sum + row.removed, 0);
  const maxMagnitude = Math.max(1, ...rows.map(row => Math.max(row.added, row.removed)));

  return (
    <div>
      <TotalLine value={fmtSigned(totalAdded - totalRemoved)} label={`${totalAdded} added / ${totalRemoved} removed`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {rows.map(row => {
          const meta = PATH_META[row.category];
          const addedPct = (row.added / maxMagnitude) * 100;
          const removedPct = (row.removed / maxMagnitude) * 100;
          return (
            <div key={row.category}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <span style={{ fontSize: 11, color: C.textDim, justifySelf: 'start', minWidth: 0 }}>{meta.label}</span>
                <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 3, justifySelf: 'center', fontSize: 10, fontFamily: C.fontMono }}>
                  <span style={{ color: C.barRed }}>-{row.removed}</span>
                  <span style={{ color: C.textMuted }}>|</span>
                  <span style={{ color: C.active }}>+{row.added}</span>
                </span>
                <span style={{ fontSize: 10, fontFamily: C.fontMono, fontWeight: 700, color: C.text, justifySelf: 'end' }}>Net:{fmtSigned(row.added - row.removed)}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, height: 5 }}>
                <div style={{ background: `${C.barRed}18`, borderRadius: 3, overflow: 'hidden', display: 'flex', justifyContent: 'flex-end' }}>
                  <div style={{ width: `${removedPct}%`, background: C.barRed, height: '100%' }} />
                </div>
                <div style={{ background: `${meta.color}18`, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${addedPct}%`, background: meta.color, height: '100%' }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TotalLine({ value, label }: { value: string; label: string }) {
  const C = useTheme();
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
      <span style={{ fontSize: 14, fontWeight: 800, color: C.text, fontFamily: C.fontMono, lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 10, color: C.textMuted }}>{label}</span>
    </div>
  );
}

// Visual drill-down cue: the level-1 output segment (right of inputPct%) flares out
// to the full-width level-2 composition bar below, so the breakdown reads as "output, expanded".
function OutputFunnel({ inputPct, color }: { inputPct: number; color: string }) {
  return (
    <svg viewBox="0 0 100 16" preserveAspectRatio="none" style={{ width: '100%', height: 13, display: 'block' }}>
      <polygon points={`${inputPct},0 100,0 100,16 0,16`} fill={color} opacity={0.14} />
      <line x1={inputPct} y1={0} x2={0} y2={16} stroke={color} strokeWidth={0.6} opacity={0.55} />
    </svg>
  );
}

function StackedBar({
  active,
  total,
  height = 8,
  marginBottom = 8,
}: {
  active: Array<{ key: string; label: string; color: string; value: number }>;
  total: number;
  height?: number;
  marginBottom?: number;
}) {
  return (
    <div style={{ display: 'flex', height, borderRadius: 4, overflow: 'hidden', gap: 1, marginBottom }}>
      {active.map(item => {
        const pct = pctOf(item.value, total);
        return (
          <div
            key={item.key}
            title={`${item.label}: ${Math.round(pct)}%`}
            style={{ flex: item.value, background: item.color, minWidth: pct > 2 ? 2 : 0 }}
          />
        );
      })}
    </div>
  );
}

function MetricRow({
  label,
  color,
  value,
  pct,
  mutedColor,
  hidePct = false,
  valueWidth = 64,
}: {
  label: string;
  color: string;
  value: string;
  pct: number;
  mutedColor?: string;
  hidePct?: boolean;
  valueWidth?: number;
}) {
  const C = useTheme();
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
        <span style={{ width: 7, height: 7, borderRadius: 2, background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: C.textDim, flex: 1 }}>{label}</span>
        <span
          title={value}
          style={{
            fontSize: 10,
            fontFamily: C.fontMono,
            color: mutedColor ?? C.textMuted,
            width: valueWidth,
            textAlign: 'right',
            flexShrink: 0,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {value}
        </span>
        {!hidePct && <span style={{ fontSize: 10, fontFamily: C.fontMono, color: C.textMuted, width: 26, textAlign: 'right', flexShrink: 0 }}>{Math.round(pct)}%</span>}
      </div>
      {!hidePct && (
        <div style={{ marginLeft: 12, height: 3, background: `${color}18`, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
        </div>
      )}
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  const C = useTheme();
  return (
    <div style={{
      fontSize: 11,
      color: C.textMuted,
      background: C.bgRow,
      border: `1px solid ${C.borderSub}`,
      borderRadius: 5,
      padding: '6px 8px',
    }}>
      {label}
    </div>
  );
}

function shellStyle(C: ReturnType<typeof useTheme>): React.CSSProperties {
  return {
    margin: '0 12px 10px',
    background: C.bgCard,
    border: `1px solid ${C.border}`,
    borderTop: 'none',
    borderRadius: '0 0 8px 8px',
    padding: '9px 10px 10px',
  };
}

function pctOf(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

function fmtSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value}`;
}
