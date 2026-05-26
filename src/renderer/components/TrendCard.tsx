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
}

const GRAINS: Grain[] = ['day', 'week', 'month'];
const METRICS: Metric[] = ['cost', 'tokens'];
const TREND_COST_COLOR = 'gpt4';
const CHART = { width: 330, height: 126, left: 14, right: 14, top: 12, bottom: 24 };

function TrendCard({ usageTrend, codeOutputStats, currency, usdToKrw }: Props) {
  const C = useTheme();
  const [grain, setGrain] = useState<Grain>('day');
  const [metric, setMetric] = useState<Metric>('cost');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const rows = useMemo(
    () => buildTrendRows(usageTrend, codeOutputStats.dailyAll ?? [], grain),
    [codeOutputStats.dailyAll, grain, usageTrend],
  );

  if (rows.length === 0) return null;

  const primaryValues = rows.map(row => metric === 'cost' ? row.costUSD : row.tokens);
  const outputValues = rows.map(row => row.netLines);
  const primaryScale = makeScale(primaryValues, true);
  const outputScale = makeScale(outputValues, true);
  const activeIndex = Math.max(0, Math.min(rows.length - 1, hoverIndex === null ? rows.length - 1 : hoverIndex));
  const activeRow = rows[activeIndex] ?? rows[rows.length - 1];
  const primaryColor = metric === 'cost' ? C[TREND_COST_COLOR] : C.input;
  const outputColor = C.active;
  const totalPrimary = primaryValues.reduce((sum, value) => sum + value, 0);
  const totalOutput = rows.reduce((sum, row) => sum + row.netLines, 0);
  const xLabels = labelIndexes(rows.length);

  const points = rows.map((row, index) => ({
    x: xFor(index, rows.length),
    primaryY: yFor(metric === 'cost' ? row.costUSD : row.tokens, primaryScale),
    outputY: yFor(row.netLines, outputScale),
  }));
  const primaryPath = pathFor(points.map(point => ({ x: point.x, y: point.primaryY })));
  const outputPath = pathFor(points.map(point => ({ x: point.x, y: point.outputY })));

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (rows.length <= 1) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = CHART.width / Math.max(rect.width, 1);
    const rawX = (e.clientX - rect.left) * scaleX;
    const plotWidth = CHART.width - CHART.left - CHART.right;
    const ratio = (rawX - CHART.left) / Math.max(plotWidth, 1);
    const nextIndex = Math.max(0, Math.min(rows.length - 1, Math.round(ratio * (rows.length - 1))));
    setHoverIndex(nextIndex);
  }

  function activateHitZone(e: React.MouseEvent<SVGRectElement>, index: number) {
    e.stopPropagation();
    setHoverIndex(index);
  }

  return (
    <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 10px 5px 12px', background: C.bgRow, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Trend</div>
          <div style={{ fontSize: 10, color: C.textMuted, fontFamily: C.fontMono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {formatPrimary(totalPrimary, metric, currency, usdToKrw)} - {fmtSignedCompact(totalOutput)} net lines
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <SegmentedControl items={METRICS} active={metric} onSelect={setMetric} C={C} />
          <SegmentedControl items={GRAINS} active={grain} onSelect={setGrain} C={C} />
        </div>
      </div>

      <div style={{ position: 'relative', padding: '8px 10px 6px' }}>
        <svg
          viewBox={`0 0 ${CHART.width} ${CHART.height}`}
          width="100%"
          height={CHART.height}
          role="img"
          aria-label="Trend"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIndex(null)}
          style={{ display: 'block', overflow: 'visible' }}
        >
          {[0, 0.5, 1].map(tick => {
            const y = CHART.top + tick * (CHART.height - CHART.top - CHART.bottom);
            return <line key={tick} x1={CHART.left} x2={CHART.width - CHART.right} y1={y} y2={y} stroke={C.borderSub} strokeWidth={1} />;
          })}
          <text x={2} y={CHART.top + 3} fill={C.textMuted} fontSize={8} fontFamily={C.fontMono}>{formatAxis(primaryScale.max, metric, currency, usdToKrw)}</text>
          <text x={2} y={CHART.height - CHART.bottom + 3} fill={C.textMuted} fontSize={8} fontFamily={C.fontMono}>{formatAxis(primaryScale.min, metric, currency, usdToKrw)}</text>
          <text x={CHART.width - 2} y={CHART.top + 3} fill={C.textMuted} fontSize={8} fontFamily={C.fontMono} textAnchor="end">{fmtSignedCompact(outputScale.max)}</text>
          <text x={CHART.width - 2} y={CHART.height - CHART.bottom + 3} fill={C.textMuted} fontSize={8} fontFamily={C.fontMono} textAnchor="end">{fmtSignedCompact(outputScale.min)}</text>
          {primaryPath && <path d={primaryPath} fill="none" stroke={primaryColor} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />}
          {outputPath && <path d={outputPath} fill="none" stroke={outputColor} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />}
          {points.map((point, index) => (
            <g key={rows[index].key}>
              <circle cx={point.x} cy={point.primaryY} r={index === activeIndex ? 3 : 2} fill={index === activeIndex ? primaryColor : C.bgCard} stroke={primaryColor} strokeWidth={1.2} />
              <circle cx={point.x} cy={point.outputY} r={index === activeIndex ? 3 : 2} fill={index === activeIndex ? outputColor : C.bgCard} stroke={outputColor} strokeWidth={1.2} />
            </g>
          ))}
          {points.map((_, index) => {
            const zone = hitZoneFor(index, rows.length);
            return (
              <rect
                key={`hit-${rows[index].key}`}
                x={zone.x}
                y={CHART.top}
                width={zone.width}
                height={CHART.height - CHART.top - CHART.bottom}
                fill="transparent"
                style={{ pointerEvents: 'all' }}
                onMouseEnter={(e) => activateHitZone(e, index)}
                onMouseMove={(e) => activateHitZone(e, index)}
              />
            );
          })}
          {rows.map((row, index) => xLabels.has(index) && (
            <text key={row.key} x={xFor(index, rows.length)} y={CHART.height - 5} fill={index === rows.length - 1 ? C.accent : C.textMuted} fontSize={8} fontFamily={C.fontMono} fontWeight={index === rows.length - 1 ? 700 : 400} textAnchor="middle">
              {row.axisLabel}
            </text>
          ))}
          {activeRow && points[activeIndex] && (
            <line x1={points[activeIndex].x} x2={points[activeIndex].x} y1={CHART.top} y2={CHART.height - CHART.bottom} stroke={C.border} strokeWidth={1} strokeDasharray="3 3" />
          )}
        </svg>

        {activeRow && (
          <div style={{
            position: 'absolute',
            top: 12,
            left: tooltipLeft(activeIndex, rows.length),
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
            <div><span style={{ color: primaryColor }}>{formatPrimary(metric === 'cost' ? activeRow.costUSD : activeRow.tokens, metric, currency, usdToKrw)}</span> / {activeRow.requestCount} calls</div>
            <div style={{ color: outputColor }}>{fmtSignedCompact(activeRow.netLines)} net lines</div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 3px 0', fontSize: 10, fontFamily: C.fontMono, color: C.textMuted }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <span style={{ width: 16, height: 2, background: primaryColor, display: 'inline-block', borderRadius: 999 }} />
            <span>{metric}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
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
  const limit = grain === 'day' ? 14 : grain === 'week' ? 12 : 12;
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
      };
    })
    .filter(row => row.tokens > 0 || row.costUSD > 0 || row.requestCount > 0 || row.commits > 0 || row.netLines !== 0);
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

function xFor(index: number, count: number): number {
  const plotWidth = CHART.width - CHART.left - CHART.right;
  if (count <= 1) return CHART.left + plotWidth / 2;
  return CHART.left + (index / (count - 1)) * plotWidth;
}

function hitZoneFor(index: number, count: number): { x: number; width: number } {
  if (count <= 1) return { x: CHART.left, width: CHART.width - CHART.left - CHART.right };
  const center = xFor(index, count);
  const previous = index === 0 ? CHART.left : (xFor(index - 1, count) + center) / 2;
  const next = index === count - 1 ? CHART.width - CHART.right : (center + xFor(index + 1, count)) / 2;
  return { x: previous, width: Math.max(1, next - previous) };
}

function yFor(value: number, scale: { min: number; max: number }): number {
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  return CHART.height - CHART.bottom - ((value - scale.min) / Math.max(scale.max - scale.min, 1)) * plotHeight;
}

function pathFor(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
}

function labelIndexes(length: number): Set<number> {
  if (length <= 3) return new Set(Array.from({ length }, (_, index) => index));
  return new Set([0, Math.floor((length - 1) / 2), length - 1]);
}

function tooltipLeft(index: number, count: number): number {
  const x = xFor(index, count);
  return Math.max(16, Math.min(CHART.width - 16, x + 12));
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
