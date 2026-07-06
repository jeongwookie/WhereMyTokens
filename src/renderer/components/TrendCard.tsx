import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BucketBreakdown, CodeOutputStats, GitDailyStats, UsageTrendData, UsageTrendPoint } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtCost, fmtTokens } from '../theme';
import { weekKey } from '../../shared/bucketKey';
import { nextSelection, selectionAfterGrainChange } from '../trendSelection';
import TrendBreakdownCard from './TrendBreakdownCard';

type Grain = 'day' | 'week' | 'month';
type Metric = 'cost' | 'tokens';
type CacheView = 'work' | 'billing';

interface Props {
  usageTrend: UsageTrendData;
  codeOutputStats: CodeOutputStats;
  lastUpdated: number;
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
  noCacheTokens: number;
  costUSD: number;
  requestCount: number;
  netLines: number;
  commits: number;
  hasUsage: boolean;
  hasOutput: boolean;
}

const GRAINS: Grain[] = ['day', 'week', 'month'];
const METRICS: Metric[] = ['cost', 'tokens'];
const CACHE_VIEWS: CacheView[] = ['work', 'billing'];
const CACHE_VIEW_LABELS: Record<CacheView, string> = {
  work: 'Work',
  billing: 'Billing',
};
const TREND_COST_COLOR = 'gpt4';
const CHART = { width: 330, height: 126, left: 12, right: 52, top: 12, bottom: 24 };
const BREAKDOWN_REFRESH_THROTTLE_MS = 30_000;
const GRAIN_WINDOWS: Record<Grain, { limit: number; label: string }> = {
  day: { limit: 14, label: '14d' },
  week: { limit: 12, label: '12w' },
  month: { limit: 12, label: '12m' },
};

function TrendCard({ usageTrend, codeOutputStats, lastUpdated, currency, usdToKrw }: Props) {
  const C = useTheme();
  const [grain, setGrain] = useState<Grain>('day');
  const [metric, setMetric] = useState<Metric>('cost');
  const [cacheView, setCacheView] = useState<CacheView>('work');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [breakdown, setBreakdown] = useState<BucketBreakdown | null>(null);
  const [breakdownError, setBreakdownError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const breakdownRef = useRef<BucketBreakdown | null>(null);
  const breakdownRequestKeyRef = useRef<string | null>(null);
  const breakdownRefreshDueAtRef = useRef(0);
  const breakdownTrailingTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const breakdownRequestSeqRef = useRef(0);

  const rows = useMemo(
    () => buildTrendRows(usageTrend, codeOutputStats.dailyAll ?? [], grain),
    [codeOutputStats.dailyAll, grain, usageTrend],
  );

  const primaryValues = rows.filter(row => row.hasUsage).map(row => trendPrimaryValue(row, metric, cacheView));
  const outputValues = rows.filter(row => row.hasOutput).map(row => row.netLines);
  const hasUsageSeries = rows.some(row => row.hasUsage);
  const hasOutputSeries = rows.some(row => row.hasOutput);
  const primaryScale = makeScale(primaryValues, true);
  const outputScale = makeScale(outputValues, true);
  const activeIndex = Math.max(0, Math.min(rows.length - 1, hoverIndex === null ? rows.length - 1 : hoverIndex));
  const activeRow = rows[activeIndex] ?? rows[rows.length - 1];
  const selectedIndex = selectedKey === null ? -1 : rows.findIndex(row => row.key === selectedKey);
  const selectedExists = selectedKey !== null && selectedIndex >= 0;
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : null;
  const selectedSignature = selectedRow
    ? [
        selectedRow.tokens,
        selectedRow.noCacheTokens,
        selectedRow.costUSD,
        selectedRow.requestCount,
        selectedRow.netLines,
        selectedRow.commits,
      ].join('|')
    : '';
  const showHoverDetail = hoverIndex !== null;
  const primaryColor = metric === 'cost' ? C[TREND_COST_COLOR] : C.input;
  const outputColor = C.active;
  const totalPrimary = rows.reduce((sum, row) => sum + trendPrimaryValue(row, metric, cacheView), 0);
  const totalOutput = rows.reduce((sum, row) => sum + row.netLines, 0);
  const xLabels = labelIndexes(rows.length);

  const points = rows.map((row, index) => ({
    x: xFor(index, rows.length, CHART.width),
    primaryY: yFor(trendPrimaryValue(row, metric, cacheView), primaryScale),
    outputY: yFor(row.netLines, outputScale),
  }));
  const primaryPaths = hasUsageSeries ? pathsForRows(rows, points, row => row.hasUsage, point => point.primaryY) : [];
  const outputPaths = hasOutputSeries ? pathsForRows(rows, points, row => row.hasOutput, point => point.outputY) : [];

  useEffect(() => {
    const clearTrailingRefresh = () => {
      if (breakdownTrailingTimerRef.current !== null) {
        window.clearTimeout(breakdownTrailingTimerRef.current);
        breakdownTrailingTimerRef.current = null;
      }
    };
    const refreshBreakdown = (requestKey: string, bucketKey: string, showLoading: boolean) => {
      clearTrailingRefresh();
      breakdownRequestKeyRef.current = requestKey;
      breakdownRefreshDueAtRef.current = Date.now() + BREAKDOWN_REFRESH_THROTTLE_MS;
      const requestSeq = ++breakdownRequestSeqRef.current;
      setLoading(showLoading);
      setBreakdownError(null);
      window.wmt.getBreakdown(grain, bucketKey)
        .then(nextBreakdown => {
          if (breakdownRequestSeqRef.current === requestSeq) {
            breakdownRef.current = nextBreakdown;
            setBreakdown(nextBreakdown);
          }
        })
        .catch(err => {
          // Surface a fail-loud query error (e.g. dirty-state throw) rather than masking it as an empty state.
          if (breakdownRequestSeqRef.current === requestSeq) {
            breakdownRef.current = null;
            setBreakdown(null);
            setBreakdownError(err);
          }
        })
        .finally(() => {
          if (breakdownRequestSeqRef.current === requestSeq) setLoading(false);
        });
    };

    if (selectedKey !== null && !selectedExists) {
      setSelectedKey(null);
      return;
    }
    if (selectedKey === null) {
      clearTrailingRefresh();
      breakdownRequestKeyRef.current = null;
      breakdownRefreshDueAtRef.current = 0;
      breakdownRequestSeqRef.current += 1;
      breakdownRef.current = null;
      setBreakdown(null);
      setBreakdownError(null);
      setLoading(false);
      return;
    }

    const requestKey = `${grain}|${selectedKey}`;
    const isNewRequestKey = breakdownRequestKeyRef.current !== requestKey;
    const now = Date.now();
    const showLoading = isNewRequestKey || breakdown === null;
    if (!isNewRequestKey && now < breakdownRefreshDueAtRef.current) {
      const delayMs = Math.max(0, breakdownRefreshDueAtRef.current - now);
      clearTrailingRefresh();
      breakdownTrailingTimerRef.current = window.setTimeout(() => {
        breakdownTrailingTimerRef.current = null;
        refreshBreakdown(requestKey, selectedKey, breakdownRef.current === null);
      }, delayMs);
      return clearTrailingRefresh;
    }

    if (isNewRequestKey) {
      breakdownRef.current = null;
      setBreakdown(null);
    }
    refreshBreakdown(requestKey, selectedKey, showLoading);
    return clearTrailingRefresh;
  }, [selectedKey, selectedSignature, grain, selectedExists, lastUpdated]);

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

  function handleChartClick(e: React.MouseEvent<SVGRectElement>) {
    if (rows.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = CHART.width / Math.max(rect.width, 1);
    const rawX = (e.clientX - rect.left) * scaleX;
    const index = hoverIndexForX(rawX, rows.length, CHART.width);
    const row = rows[index];
    if (row) setSelectedKey(prev => nextSelection(prev, row.key));
  }

  function selectActiveBucket() {
    if (rows.length === 0) return;
    const row = rows[activeIndex] ?? rows[rows.length - 1];
    if (row) setSelectedKey(prev => nextSelection(prev, row.key));
  }

  function handleChartKeyDown(e: React.KeyboardEvent<SVGSVGElement>) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    selectActiveBucket();
  }

  function handleMouseLeave() {
    setHoverIndex(prev => prev === null ? prev : null);
  }

  function handleGrainSelect(nextGrain: Grain) {
    if (nextGrain !== grain) setSelectedKey(selectionAfterGrainChange);
    setGrain(nextGrain);
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
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <div style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 5 }}>
            <ControlGroupLabel C={C}>Metric</ControlGroupLabel>
            <SegmentedControl items={METRICS} active={metric} onSelect={setMetric} C={C} />
            {metric === 'tokens' && (
              <div
                className="cacheModifier"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  marginLeft: 2,
                  paddingLeft: 6,
                  borderLeft: `1px solid ${C.borderSub}`,
                  transform: 'translateY(1px)',
                }}
              >
                <span style={{ width: 3, height: 3, borderRadius: 999, background: C.textMuted, opacity: 0.75 }} />
                <ControlGroupLabel C={C}>Cache</ControlGroupLabel>
                <SegmentedControl items={CACHE_VIEWS} active={cacheView} onSelect={setCacheView} C={C} compact labels={CACHE_VIEW_LABELS} />
              </div>
            )}
          </div>
          <div style={{ width: 1, alignSelf: 'stretch', minHeight: 18, background: C.borderSub, opacity: 0.9 }} />
          <div style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 5 }}>
            <ControlGroupLabel C={C}>Range</ControlGroupLabel>
            <SegmentedControl items={GRAINS} active={grain} onSelect={handleGrainSelect} C={C} />
          </div>
        </div>
      </div>

      <div style={{ position: 'relative', padding: '8px 12px 6px' }}>
        <div style={{ position: 'relative' }}>
          <svg
            viewBox={`0 0 ${CHART.width} ${CHART.height}`}
            width={CHART.width}
            height={CHART.height}
            preserveAspectRatio="none"
            role="button"
            aria-label="Trend bucket breakdown"
            aria-pressed={selectedKey !== null}
            tabIndex={0}
            onKeyDown={handleChartKeyDown}
            style={{ width: '100%', display: 'block', overflow: 'visible', cursor: rows.length > 0 ? 'pointer' : 'default' }}
          >
            <title>Select a trend bucket for breakdown</title>
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
                {index === selectedIndex && <circle cx={point.x} cy={rows[index].hasUsage ? point.primaryY : point.outputY} r={5.5} fill="none" stroke={C.accent} strokeWidth={1.5} />}
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
              style={{ pointerEvents: 'all', cursor: rows.length > 0 ? 'pointer' : 'default' }}
              onMouseMove={handleMouseMove}
              onClick={handleChartClick}
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
              {activeRow.hasUsage && <div><span style={{ color: primaryColor }}>{formatPrimary(trendPrimaryValue(activeRow, metric, cacheView), metric, currency, usdToKrw)}</span> / {activeRow.requestCount} requests</div>}
              {activeRow.hasOutput && <div style={{ color: outputColor }}>{fmtSignedCompact(activeRow.netLines)} net lines</div>}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 3px 0', fontSize: 10, fontFamily: C.fontMono, color: C.textMuted }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, opacity: hasUsageSeries ? 1 : 0.45 }}>
            <span style={{ width: 16, height: 2, background: primaryColor, display: 'inline-block', borderRadius: 999 }} />
            <span>{metric === 'tokens' ? `${cacheView} tokens` : metric}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, opacity: hasOutputSeries ? 1 : 0.45 }}>
            <span style={{ width: 16, height: 2, background: outputColor, display: 'inline-block', borderRadius: 999 }} />
            <span>net lines</span>
          </span>
        </div>
      </div>

      {selectedKey !== null && <TrendBreakdownCard breakdown={breakdown} loading={loading} error={breakdownError} />}
    </div>
  );
}

export default React.memo(TrendCard);

function ControlGroupLabel({
  children,
  C,
}: {
  children: React.ReactNode;
  C: ReturnType<typeof useTheme>;
}) {
  return (
    <span style={{
      fontSize: 8,
      lineHeight: '16px',
      color: C.textMuted,
      fontFamily: C.fontMono,
      opacity: 0.78,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function SegmentedControl<T extends string>({
  items,
  active,
  onSelect,
  C,
  compact = false,
  labels,
}: {
  items: readonly T[];
  active: T;
  onSelect: (value: T) => void;
  C: ReturnType<typeof useTheme>;
  compact?: boolean;
  labels?: Partial<Record<T, string>>;
}) {
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {items.map(item => (
        <button
          key={item}
          onClick={() => onSelect(item)}
          style={{
            padding: compact ? '1px 5px' : '2px 6px',
            fontSize: compact ? 9 : 10,
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
          {labels?.[item] ?? item}
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
        noCacheTokens: point?.noCacheTokens ?? 0,
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

function trendPrimaryValue(row: TrendRow, metric: Metric, cacheView: CacheView): number {
  return metric === 'cost' ? row.costUSD : cacheView === 'work' ? row.noCacheTokens : row.tokens;
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
  return weekKey(dateKey);
}

function dateFromKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
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
