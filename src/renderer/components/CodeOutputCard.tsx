import React, { useEffect, useRef, useState } from 'react';
import { CodeOutputStats, GitDailyStats } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtCost } from '../theme';

type Period = 'today' | 'all';
const PERIODS: Period[] = ['today', 'all'];

interface Props {
  stats: CodeOutputStats;
  loading?: boolean;
  todayCost: number;
  allTimeCost: number;
  currency: string;
  usdToKrw: number;
}

function CodeOutputCard({ stats, loading = false, todayCost, allTimeCost, currency, usdToKrw }: Props) {
  const C = useTheme();
  const [period, setPeriod] = useState<Period>('today');

  if (!loading && stats.all.commits === 0 && stats.today.commits === 0) return null;

  const data = period === 'today' ? stats.today : stats.all;
  const periodCost = period === 'today' ? todayCost : allTimeCost;
  const netLines = data.added - data.removed;

  const todayPerLine = stats.today.added > 0 && todayCost > 0 ? todayCost / stats.today.added : null;
  const avgPerLine = stats.all.added > 0 && allTimeCost > 0 ? allTimeCost / stats.all.added : null;

  const effInfo: { text: string; color: string } = (() => {
    if (period === 'all') return { text: avgPerLine ? fmtCost(avgPerLine * 100, currency, usdToKrw) : '-', color: C.accent };
    if (stats.today.added === 0 || todayPerLine === null) return { text: '-', color: C.textDim };
    return { text: fmtCost(todayPerLine * 100, currency, usdToKrw), color: C.text };
  })();

  const totalLinesFormatted = stats.all.added >= 1000
    ? `+${(stats.all.added / 1000).toFixed(0)}K lines`
    : `+${stats.all.added} lines`;

  const effSub = (() => {
    if (period === 'all') return totalLinesFormatted;
    if (avgPerLine === null) return '';
    return `avg ${fmtCost(avgPerLine * 100, currency, usdToKrw)}`;
  })();

  const perLine = data.added > 0 && periodCost > 0 ? (periodCost / data.added) * 100 : null;
  const commitsSub = period === 'today' ? `${stats.all.commits} total` : 'all time';

  return (
    <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px 5px 12px', background: C.bgRow, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ minWidth: 0, marginRight: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Code Output</div>
          <div style={{ fontSize: 10, color: C.textMuted, fontFamily: C.fontMono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {stats.scopeLabel}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          {PERIODS.map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              padding: '2px 6px', fontSize: 10, borderRadius: 3, cursor: 'pointer',
              fontFamily: "'JetBrains Mono', monospace",
              border: period === p ? '1px solid rgba(13,148,136,0.15)' : '1px solid transparent',
              background: period === p ? C.accent + '22' : 'none',
              color: period === p ? C.accent : C.textMuted,
              fontWeight: period === p ? 700 : 400,
            }}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {loading && stats.all.commits === 0 ? (
        <CodeOutputLoading C={C} />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 0 }}>
            <KPI label="Commits" value={`${data.commits}`} sub={commitsSub} color={C.accent} C={C} borderRight />
            <KPI label="Net Lines" value={`${netLines >= 0 ? '+' : ''}${netLines}`} sub={`+${data.added} / -${data.removed}`} color={C.active} C={C} borderRight />
            <KPI label="$/100 Added"
              value={effInfo.text}
              sub={effSub} color={effInfo.color} C={C} />
          </div>

          <OutputGrowth data={stats.daily7d ?? []} total={stats.all} C={C} />

          {data.commits > 0 && (
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '6px 14px',
              borderTop: `1px solid ${C.border}`,
            }}>
              <span style={{ fontSize: 10, color: C.textDim, fontFamily: C.fontMono }}>
                {data.commits} commit{data.commits > 1 ? 's' : ''} - {netLines >= 0 ? '+' : ''}{netLines} net lines
                {perLine ? ` - ${fmtCost(perLine, currency, usdToKrw)}/100 added` : ''}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default React.memo(CodeOutputCard);

function CodeOutputLoading({ C }: { C: ReturnType<typeof useTheme> }) {
  return (
    <div style={{ padding: '18px 14px 16px', borderTop: `1px solid ${C.border}`, color: C.textMuted }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 700, marginBottom: 8 }}>
        Scanning git history
      </div>
      <div style={{ height: 4, background: C.bgRow, borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ width: '44%', height: '100%', background: C.accent, opacity: 0.7, borderRadius: 999 }} />
      </div>
      <div style={{ marginTop: 8, fontSize: 10, fontFamily: C.fontMono }}>Code Output will appear after local repo stats finish.</div>
    </div>
  );
}

function fmtSigned(n: number): string {
  const sign = n >= 0 ? '+' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}${(n / 1_000).toFixed(1)}K`;
  return `${sign}${n}`;
}

function OutputGrowth({
  data,
  total,
  C,
}: {
  data: GitDailyStats[];
  total: CodeOutputStats['all'];
  C: ReturnType<typeof useTheme>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ point: GrowthPoint } | null>(null);
  const points = buildGrowthPoints(data, total);
  const totalNet = points[points.length - 1]?.totalNet ?? (total.added - total.removed);
  const progressColor = totalNet >= 0 ? C.active : C.barRed;
  const hasData = points.length > 0 && total.commits > 0;
  const detailPoint = hover?.point ?? points[points.length - 1] ?? null;

  useEffect(() => {
    if (!hasData) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = 74;
    canvas.height = H;
    ctx.clearRect(0, 0, W, H);

    const left = 12;
    const right = 52;
    const top = 8;
    const lineBottom = 44;
    const labelY = 68;
    const plotW = W - left - right;
    const pointValues = points.map(point => point.totalNet);
    const rawMin = Math.min(...pointValues);
    const rawMax = Math.max(...pointValues);
    const rawRange = Math.max(rawMax - rawMin, 1);
    const padding = Math.max(rawRange * 0.18, Math.max(Math.abs(totalNet) * 0.01, 1));
    const minCum = rawMin - padding;
    const maxCum = rawMax + padding;
    const cumRange = Math.max(maxCum - minCum, 1);
    const xFor = (index: number) => left + (points.length <= 1 ? plotW : (index / (points.length - 1)) * plotW);
    const yFor = (value: number) => lineBottom - ((value - minCum) / cumRange) * (lineBottom - top);

    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, lineBottom + 0.5);
    ctx.lineTo(W - right, lineBottom + 0.5);
    ctx.stroke();

    if (points.length > 1) {
      ctx.beginPath();
      points.forEach((point, i) => {
        const x = xFor(i);
        const y = yFor(point.totalNet);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = progressColor;
      ctx.lineWidth = 2.4;
      ctx.stroke();

      points.forEach((point, index) => {
        const x = xFor(index);
        const y = yFor(point.totalNet);
        const isToday = index === points.length - 1;
        ctx.fillStyle = isToday ? progressColor : C.bgCard;
        ctx.strokeStyle = progressColor;
        ctx.lineWidth = isToday ? 1.5 : 1;
        ctx.beginPath();
        ctx.arc(x, y, isToday ? 3.4 : 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });

      const finalValue = points[points.length - 1].totalNet;
      const finalX = xFor(points.length - 1);
      const finalY = yFor(finalValue);
      ctx.fillStyle = progressColor;
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(fmtSigned(finalValue), Math.min(finalX + 7, W - right + 2), Math.max(10, finalY + 3));
    }

    ctx.fillStyle = C.textMuted;
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'left';
    points.forEach((point, index) => {
      const x = xFor(index);
      ctx.fillStyle = index === points.length - 1 ? C.accent : C.textMuted;
      ctx.font = index === points.length - 1 ? 'bold 8px sans-serif' : '8px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(point.label, x, labelY);
    });
  }, [C, hasData, points, progressColor]);

  if (!hasData) return null;

  function handleMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const W = canvas.clientWidth || rect.width;
    const left = 12;
    const right = 52;
    const plotW = W - left - right;
    const index = Math.max(0, Math.min(points.length - 1, Math.round(((x - left) / Math.max(plotW, 1)) * (points.length - 1))));
    setHover({ point: points[index] });
  }

  return (
    <div style={{ borderTop: `1px solid ${C.border}`, padding: '6px 12px 5px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
        <span style={{ fontSize: 10, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 700 }}>Output Growth</span>
        <span style={{ fontSize: 10, color: C.textMuted, fontFamily: C.fontMono }}>
          <span style={{ color: progressColor, fontWeight: 700 }}>{fmtSigned(totalNet)}</span> total net
          <span> - {total.commits} commits</span>
        </span>
      </div>
      <div style={{ fontSize: 10, color: C.textMuted, fontFamily: C.fontMono, marginBottom: 1 }}>
        Last 7 days on all-time baseline
      </div>
      <div style={{ position: 'relative' }}>
        <canvas
          ref={canvasRef}
          width={330}
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
          style={{ width: '100%', display: 'block' }}
        />
      </div>
      <div style={{
        minHeight: 16,
        marginTop: 2,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        overflow: 'hidden',
        color: C.textDim,
        fontFamily: C.fontMono,
        fontSize: 9,
        whiteSpace: 'nowrap',
      }}>
        {detailPoint && (
          <>
            <span style={{ color: C.textMuted }}>{detailPoint.label}</span>
            <span style={{ color: progressColor, fontWeight: 700 }}>{fmtSigned(detailPoint.totalNet)} total</span>
            <span>
              {fmtSigned(detailPoint.dayNet)} day · {detailPoint.commits} commit{detailPoint.commits === 1 ? '' : 's'}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

interface GrowthPoint {
  date: string;
  label: string;
  commits: number;
  dayNet: number;
  totalNet: number;
}

function buildGrowthPoints(data: GitDailyStats[], total: CodeOutputStats['all']): GrowthPoint[] {
  const days = data.slice(-7);
  if (days.length === 0) return [];
  const totalNet = total.added - total.removed;
  const weekNet = days.reduce((sum, day) => sum + day.added - day.removed, 0);
  let running = totalNet - weekNet;
  return days.map((day, index) => {
    const dayNet = day.added - day.removed;
    running += dayNet;
    return {
      date: day.date,
      label: index === days.length - 1 ? 'Today' : shortDateLabel(day.date),
      commits: day.commits,
      dayNet,
      totalNet: running,
    };
  });
}

function shortDateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
}

function KPI({ label, value, sub, subColor, color, C, borderRight }: {
  label: string; value: string; sub: string; subColor?: string; color: string;
  C: ReturnType<typeof useTheme>; borderRight?: boolean;
}) {
  return (
    <div style={{
      padding: '8px 10px',
      borderRight: borderRight ? `1px solid ${C.border}` : 'none',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 9, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color, fontFamily: C.fontMono, lineHeight: 1 }}>{value}</div>
      {sub && (
        <div style={{ fontSize: 10, color: subColor ?? C.textMuted, marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}
