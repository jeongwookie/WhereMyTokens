import React, { useState } from 'react';
import { CodeOutputStats } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtCost } from '../theme';

type Period = 'today' | 'all';
const PERIODS: Period[] = ['today', 'all'];

interface Props {
  stats: CodeOutputStats;
  todayCost: number;
  allTimeCost: number;
  currency: string;
  usdToKrw: number;
}

function CodeOutputCard({ stats, todayCost, allTimeCost, currency, usdToKrw }: Props) {
  const C = useTheme();
  const [period, setPeriod] = useState<Period>('today');

  if (stats.all.commits === 0 && stats.today.commits === 0) return null;

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
        <span style={{ fontSize: 10, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Code Output</span>
        <div style={{ display: 'flex', gap: 2 }}>
          {PERIODS.map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              padding: '2px 6px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 0 }}>
        <KPI label="Commits" value={`${data.commits}`} sub={commitsSub} color={C.accent} C={C} borderRight />
        <KPI label="Net Lines" value={`${netLines >= 0 ? '+' : ''}${netLines}`} sub={`+${data.added} / -${data.removed}`} color={C.active} C={C} borderRight />
        <KPI label="$/100 Added"
          value={effInfo.text}
          sub={effSub} color={effInfo.color} C={C} />
      </div>

      {data.commits > 0 && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '6px 14px',
          borderTop: `1px solid ${C.border}`,
        }}>
          <span style={{ fontSize: 9, color: C.textDim, fontFamily: C.fontMono }}>
            {data.commits} commit{data.commits > 1 ? 's' : ''} - {netLines >= 0 ? '+' : ''}{netLines} net lines
            {perLine ? ` - ${fmtCost(perLine, currency, usdToKrw)}/100 added` : ''}
          </span>
        </div>
      )}
    </div>
  );
}

export default React.memo(CodeOutputCard);

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
      <div style={{ fontSize: 8, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color, fontFamily: C.fontMono, lineHeight: 1 }}>{value}</div>
      {sub && (
        <div style={{ fontSize: 9, color: subColor ?? C.textMuted, marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}
