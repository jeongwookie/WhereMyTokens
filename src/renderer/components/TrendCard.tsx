import React, { useMemo, useState } from 'react';
import { CodeOutputStats, GitDailyStats, UsageTrendData, UsageTrendPoint } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtCost, fmtTokens } from '../theme';

type Grain = 'day' | 'week' | 'month';
type Metric = 'cost' | 'tokens';

interface Props {
  usageTrend: UsageTrendData;
  codeOutputStats: CodeOutputStats;
  currency: string;
  usdToKrw: number;
}

interface OutputBucket {
  commits: number;
  added: number;
  removed: number;
}

interface TrendRow {
  key: string;
  label: string;
  axisLabel: string;
  tokens: number;
  costUSD: number;
  requestCount: number;
  netLines: number;
  commits: number;
  hasUsage: boolean;
  hasOutput: boolean;
}

const GRAINS: Grain[] = ['day', 'week', 'month'];
const METRICS: Metric[] = ['cost', 'tokens'];
const TREND_COST_COLOR = 'gpt4';
const CHART = { width: 330, height: 126, left: 12, right: 52, top: 12, bottom: 24 };
const GRAIN_WINDOWS: Record<Grain, { limit: number; label: string }> = {
  day: { limit: 14, label: '14d' },
  week: { limit: 12, label: '12w' },
  month: { limit: 12, label: '12m' },
};

function TrendCard({ usageTrend, codeOutputStats, currency, usdToKrw }: Props) {
  const C = useTheme();
  const [grain, setGrain] = useState<Grain>('day');
  const [metric, setMetric] = useState<Metric>('cost');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const rows = useMemo(
    () => buildTrendRows(usageTrend, codeOutputStats.dailyAll ?? [], grain),
    [codeOutputStats.dailyAll, grain, usageTrend],
  );

  const primaryValues = rows.filter(row => row.hasUsage).map(row => metric === 'cost' ? row.costUSD : row.tokens);
  const outputValues = rows.filter(row => row.hasOutput).map(row => row.netLines);
  const hasUsageSeries = rows.some(row => row.hasUsage);
  const hasOutputSeries = rows.some(row => row.hasOutput);
  const primaryScale = makeScale(primaryValues, true);
  const outputScale = makeScale(outputValues, true);
  const activeIndex = Math.max(0, Math.min(rows.length - 1, hoverIndex === null ? rows.length - 1 : hoverIndex));
  const activeRow = rows[activeIndex] ?? rows[rows.length - 1];
  const showHoverDetail = hoverIndex !== null;
  const primaryColor = metric === 'cost' ? C[TREND_COST_COLOR] : C.input;
  const outputColor = C.active;
  const totalPrimary = rows.reduce((sum, row) => sum + (metric === 'cost' ? row.costUSD : row.tokens), 0);
  const totalOutput = rows.reduce((sum, row) => sum + row.netLines, 0);
  const xLabels = labelIndexes(rows.length);

  const points = rows.map((row, index) => ({
    x: xFor(index, rows.length, CHART.width),
    primaryY: yFor(metric === 'cost' ? row.costUSD : row.tokens, primaryScale),
    outputY: yFor(row.netLines, outputScale),
  }));
  const primaryPaths = hasUsageSeries ? pathsForRows(rows, points, row => row.hasUsage, point => point.primaryY) : [];
  const outputPaths = hasOutputSeries ? pathsForRows(rows, points, row => row.hasOutput, point => point.outputY) : [];

  function selectHoverIndex(nextIndex: number) {
    setHoverIndex(prev => prev === nextIndex ? prev : nextIndex);
  }

  function handleMouseMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = CHART.width / Math.max(rect.width, 1);
    const rawX = (e.clientX - rect.left) * scaleX;
    const nextIndex = hoverIndexForX(rawX, rows.length, CHART.width);
    selectHoverIndex(nextIndex);
  }

  function handleMouseLeave() {
    setHoverIndex(prev => prev === null ? prev : null);
  }

  return (
    <div onMouseLeave={handleMouseLeave} style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 10px 5px 12px', background: C.bgRow, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Trend</div>
          <div style={{ fontSize: 10, color: C.textMuted, fontFamily: C.fontMono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {rows.length === 0
              ? `${GRAIN_WINDOWS[grain].label}: no trend data yet`
              : `${GRAIN_WINDOWS[grain].label}: ${hasUsageSeries ? formatPrimary(totalPrimary, metric, currency, usdToKrw) : 'usage pending'} / ${hasOutputSeries ? fmtSignedCompact(totalOutput) : 'output pending'} net`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <SegmentedControl items={METRICS} active={metric} onSelect={setMetric} C={C} />
          <SegmentedControl items={GRAINS} active={grain} onSelect={setGrain} C={C} />
        </div>
      </div>

      <div style={{ position: 'relative', padding: '8px 12px 6px' }}>
        <div style={{ position: 'relative' }}>
          <svg
            viewBox={`0 0 ${CHART.width} ${CHART.height}`}
            width={CHART.width}
            height={CHART.height}
            preserveAspectRatio="none"
            role="img"
            aria-label="Trend"
            style={{ width: '100%', display: 'block', overflow: 'visible' }}
          >
            {rows.length === 0 && (
              <text x={CHART.width / 2} y={CHART.height / 2} textAnchor="middle" fill={C.textMuted} fontSize={10} fontFamily={C.fontMono}>
                No trend data yet
              </text>
            )}
            {rows.length > 0 && [0, 0.5, 1].map(tick => {
              const y = CHART.top + tick * (CHART.height - CHART.top - CHART.bottom);
              return <line key={tick} x1={CHART.left} x2={CHART.width - CHART.right} y1={y} y2={y} stroke={C.borderSub} strokeWidth={1} />;
            })}
            {rows.length > 0 && hasUsageSeries && <text x={2} y={CHART.top + 3} fill={C.textMuted} fontSize={8} fontFamily={C.fontMono}>{formatAxis(primaryScale.max, metric, currency, usdToKrw)}</text>}
            {rows.length > 0 && hasUsageSeries && <text x={2} y={CHART.height - CHART.bottom + 3} fill={C.textMuted} fontSize={8} fontFamily={C.fontMono}>{formatAxis(primaryScale.min, metric, currency, usdToKrw)}</text>}
            {rows.length > 0 && hasOutputSeries && <text x={CHART.width - 2} y={CHART.top + 3} fill={C.textMuted} fontSize={8} fontFamily={C.fontMono} textAnchor="end">{fmtSignedCompact(outputScale.max)}</text>}
            {rows.length > 0 && hasOutputSeries && <text x={CHART.width - 2} y={CHART.height - CHART.bottom + 3} fill={C.textMuted} fontSize={8} fontFamily={C.fontMono} textAnchor="end">{fmtSignedCompact(outputScale.min)}</text>}
            {primaryPaths.map((path, index) => <path key={`primary-${index}`} d={path} fill="none" stroke={primaryColor} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />)}
            {outputPaths.map((path, index) => <path key={`output-${index}`} d={path} fill="none" stroke={outputColor} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />)}
            {points.map((point, index) => (
              <g key={rows[index].key}>
                {rows[index].hasUsage && <circle cx={point.x} cy={point.primaryY} r={index === activeIndex ? 3 : 2} fill={index === activeIndex ? primaryColor : C.bgCard} stroke={primaryColor} strokeWidth={1.2} />}
                {rows[index].hasOutput && <circle cx={point.x} cy={point.outputY} r={index === activeIndex ? 3 : 2} fill={index === activeIndex ? outputColor : C.bgCard} stroke={outputColor} strokeWidth={1.2} />}
              </g>
            ))}
            {rows.map((row, index) => xLabels.has(index) && (
              <text key={row.key} x={xFor(index, rows.length, CHART.width)} y={CHART.height - 5} fill={index === rows.length - 1 ? C.accent : C.textMuted} fontSize={8} fontFamily={C.fontMono} fontWeight={index === rows.length - 1 ? 700 : 400} textAnchor="middle">
                {row.axisLabel}
              </text>
            ))}
            {showHoverDetail && activeRow && points[activeIndex] && (
              <line x1={points[activeIndex].x} x2={points[activeIndex].x} y1={CHART.top} y2={CHART.height - CHART.bottom} stroke={C.border} strokeWidth={1} strokeDasharray="3 3" />
            )}
            <rect
              x={0}
              y={CHART.top}
              width={CHART.width}
              height={CHART.height - CHART.top - CHART.bottom}
              fill="transparent"
              style={{ pointerEvents: 'all' }}
              onMouseMove={handleMouseMove}
            />
          </svg>

            {showHoverDetail && activeRow && rows.length > 0 && (
            <div style={{
              position: 'absolute',
              top: 12,
              left: tooltipLeft(activeIndex, rows.length, CHART.width),
              transform: activeIndex > rows.length / 2 ? 'translateX(-100%)' : 'none',
              background: C.bgCard,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: '4px 6px',
              boxShadow: '0 3px 10px rgba(0,0,0,0.08)',
              fontSize: 10,
              fontFamily: C.fontMono,
              color: C.textDim,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}>
              <div style={{ color: C.text, fontWeight: 700 }}>{activeRow.label}</div>
              {activeRow.hasUsage && <div><span style={{ color: primaryColor }}>{formatPrimary(metric === 'cost' ? activeRow.costUSD : activeRow.tokens, metric, currency, usdToKrw)}</span> / {activeRow.requestCount} calls</div>}
              {activeRow.hasOutput && <div style={{ color: outputColor }}>{fmtSignedCompact(activeRow.netLines)} net lines</div>}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 3px 0', fontSize: 10, fontFamily: C.fontMono, color: C.textMuted }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, opacity: hasUsageSeries ? 1 : 0.45 }}>
            <span style={{ width: 16, height: 2, background: primaryColor, display: 'inline-block', borderRadius: 999 }} />
            <span>{metric}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, opacity: hasOutputSeries ? 1 : 0.45 }}>
            <span style={{ width: 16, height: 2, background: outputColor, display: 'inline-block', borderRadius: 999 }} />
            <span>net lines</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export default React.memo(TrendCard);

function SegmentedControl<T extends string>({
  items,
  active,
  onSelect,
  C,
}: {
  items: readonly T[];
  active: T;
  onSelect: (value: T) => void;
  C: ReturnType<typeof useTheme>;
}) {
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {items.map(item => (
        <button
          key={item}
          onClick={() => onSelect(item)}
          style={{
            padding: '2px 6px',
            fontSize: 10,
            borderRadius: 3,
            cursor: 'pointer',
            fontFamily: C.fontMono,
            border: active === item ? `1px solid ${C.accent}33` : '1px solid transparent',
            background: active === item ? `${C.accent}22` : 'none',
            color: active === item ? C.accent : C.textMuted,
            fontWeight: active === item ? 700 : 400,
            lineHeight: 1.3,
          }}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

function buildTrendRows(usageTrend: UsageTrendData, dailyOutput: GitDailyStats[], grain: Grain): TrendRow[] {
  const usagePoints = trendPointsForGrain(usageTrend, grain);
  const outputMap = buildOutputMap(dailyOutput, grain);
  const usageMap = new Map<string, UsageTrendPoint>();
  for (const point of usagePoints) {
    const key = keyForPoint(point, grain);
    if (key) usageMap.set(key, point);
  }

  const keys = new Set<string>([...usageMap.keys(), ...outputMap.keys()]);
  const limit = GRAIN_WINDOWS[grain].limit;
  return [...keys]
    .sort()
    .slice(-limit)
    .map(key => {
      const point = usageMap.get(key);
      const output = outputMap.get(key) ?? { commits: 0, added: 0, removed: 0 };
      return {
        key,
        label: labelForKey(key, grain),
        axisLabel: axisLabelForKey(key, grain),
        tokens: point?.tokens ?? 0,
        costUSD: point?.costUSD ?? 0,
        requestCount: point?.requestCount ?? 0,
        netLines: output.added - output.removed,
        commits: output.commits,
        hasUsage: !!point && (point.tokens > 0 || point.costUSD > 0 || point.requestCount > 0),
        hasOutput: output.commits > 0 || output.added !== 0 || output.removed !== 0,
      };
    })
    .filter(row => row.hasUsage || row.hasOutput);
}

function trendPointsForGrain(usageTrend: UsageTrendData, grain: Grain): UsageTrendPoint[] {
  if (grain === 'week') return usageTrend.weekly ?? [];
  if (grain === 'month') return usageTrend.monthly ?? [];
  return usageTrend.daily ?? [];
}

function keyForPoint(point: UsageTrendPoint, grain: Grain): string | null {
  if (grain === 'week') return point.weekStart ?? null;
  if (grain === 'month') return point.month ?? null;
  return point.date ?? null;
}

function buildOutputMap(dailyOutput: GitDailyStats[], grain: Grain): Map<string, OutputBucket> {
  const outputMap = new Map<string, OutputBucket>();
  for (const row of dailyOutput) {
    const key = grain === 'week' ? weekStartKey(row.date) : grain === 'month' ? row.date.slice(0, 7) : row.date;
    const current = outputMap.get(key) ?? { commits: 0, added: 0, removed: 0 };
    current.commits += row.commits;
    current.added += row.added;
    current.removed += row.removed;
    outputMap.set(key, current);
  }
  return outputMap;
}

function makeScale(values: number[], includeZero: boolean): { min: number; max: number } {
  const source = values.length ? values : [0];
  let min = Math.min(...source);
  let max = Math.max(...source);
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    const pad = Math.max(Math.abs(max) * 0.2, 1);
    min -= pad;
    max += pad;
  } else {
    const pad = (max - min) * 0.12;
    min -= pad;
    max += pad;
  }
  return { min, max };
}

function xFor(index: number, count: number, chartWidth: number): number {
  const plotWidth = chartWidth - CHART.left - CHART.right;
  if (count <= 1) return CHART.left + plotWidth / 2;
  return CHART.left + (index / (count - 1)) * plotWidth;
}

function hoverIndexForX(rawX: number, count: number, chartWidth: number): number {
  if (count <= 1) return 0;
  const x = Math.max(0, Math.min(chartWidth, rawX));
  for (let index = 0; index < count - 1; index++) {
    const boundary = (xFor(index, count, chartWidth) + xFor(index + 1, count, chartWidth)) / 2;
    if (x < boundary) return index;
  }
  return count - 1;
}

function yFor(value: number, scale: { min: number; max: number }): number {
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  return CHART.height - CHART.bottom - ((value - scale.min) / Math.max(scale.max - scale.min, 1)) * plotHeight;
}

function pathFor(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
}

function pathsForRows(
  rows: TrendRow[],
  points: Array<{ x: number; primaryY: number; outputY: number }>,
  hasValue: (row: TrendRow) => boolean,
  yValue: (point: { x: number; primaryY: number; outputY: number }) => number,
): string[] {
  const paths: string[] = [];
  let segment: Array<{ x: number; y: number }> = [];
  rows.forEach((row, index) => {
    if (hasValue(row)) {
      const point = points[index];
      segment.push({ x: point.x, y: yValue(point) });
      return;
    }
    if (segment.length > 1) paths.push(pathFor(segment));
    segment = [];
  });
  if (segment.length > 1) paths.push(pathFor(segment));
  return paths;
}

function labelIndexes(length: number): Set<number> {
  if (length <= 3) return new Set(Array.from({ length }, (_, index) => index));
  return new Set([0, Math.floor((length - 1) / 2), length - 1]);
}

function tooltipLeft(index: number, count: number, chartWidth: number): number {
  const x = xFor(index, count, chartWidth);
  if (index === 0) return 6;
  if (index === count - 1) return chartWidth - 6;
  return Math.max(6, Math.min(chartWidth - 6, x + 8));
}

function weekStartKey(dateKey: string): string {
  const date = dateFromKey(dateKey);
  const day = date.getDay();
  const offset = (day + 6) % 7;
  date.setDate(date.getDate() - offset);
  return keyFromDate(date);
}

function dateFromKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function keyFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function labelForKey(key: string, grain: Grain): string {
  if (grain === 'month') return key;
  if (grain === 'week') return `Week ${axisLabelForKey(key, grain)}`;
  return axisLabelForKey(key, grain);
}

function axisLabelForKey(key: string, grain: Grain): string {
  if (grain === 'month') {
    const [year, month] = key.split('-');
    return `${Number(month)}/${year.slice(2)}`;
  }
  const date = dateFromKey(key);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatPrimary(value: number, metric: Metric, currency: string, usdToKrw: number): string {
  return metric === 'cost' ? fmtCost(value, currency, usdToKrw) : fmtTokens(value);
}

function formatAxis(value: number, metric: Metric, currency: string, usdToKrw: number): string {
  if (metric === 'tokens') return fmtTokens(Math.max(0, Math.round(value)));
  return fmtCost(Math.max(0, value), currency, usdToKrw);
}

function fmtSignedCompact(value: number): string {
  const sign = value >= 0 ? '+' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}${(value / 1_000).toFixed(1)}K`;
  return `${sign}${value}`;
}
