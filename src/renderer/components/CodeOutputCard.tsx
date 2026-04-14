import React, { useState } from 'react';
import { SessionInfo } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtCost } from '../theme';

type Period = 'today' | 'all';
const PERIODS: Period[] = ['today', 'all'];

interface Props {
  sessions: SessionInfo[];
  todayCost: number;
  allTimeCost: number;
  currency: string;
  usdToKrw: number;
}

export default function CodeOutputCard({ sessions, todayCost, allTimeCost, currency, usdToKrw }: Props) {
  const C = useTheme();
  const [period, setPeriod] = useState<Period>('today');

  // cwd 기준 중복 제거 후 git stats 합산
  const seen = new Set<string>();
  let commitsToday = 0, linesAdded = 0, linesRemoved = 0;
  let totalCommits = 0, totalLinesAdded = 0, totalLinesRemoved = 0;

  for (const s of sessions) {
    if (!s.gitStats || seen.has(s.cwd)) continue;
    seen.add(s.cwd);
    commitsToday += s.gitStats.commitsToday;
    linesAdded += s.gitStats.linesAdded;
    linesRemoved += s.gitStats.linesRemoved;
    totalCommits += s.gitStats.totalCommits;
    totalLinesAdded += s.gitStats.totalLinesAdded;
    totalLinesRemoved += s.gitStats.totalLinesRemoved ?? 0;
  }

  if (totalCommits === 0 && commitsToday === 0) return null;

  // 기간별 데이터 선택
  const data = period === 'today'
    ? { commits: commitsToday, added: linesAdded, removed: linesRemoved }
    : { commits: totalCommits, added: totalLinesAdded, removed: totalLinesRemoved };

  // 기간별 비용
  const periodCost = period === 'today' ? todayCost : allTimeCost;
  const costPerCommit = data.commits > 0 && periodCost > 0 ? periodCost / data.commits : 0;
  const netLines = data.added - data.removed;

  // all time 평균 $/commit (today 서브텍스트용)
  const allTimeAvgCpc = totalCommits > 0 && allTimeCost > 0 ? allTimeCost / totalCommits : 0;

  // COMMITS 서브텍스트
  const commitsSub = period === 'today' ? `${totalCommits} total` : 'all time';

  // $/COMMIT 서브텍스트
  const cpcSub = period === 'today' && allTimeAvgCpc > 0
    ? `avg ${fmtCost(allTimeAvgCpc, currency, usdToKrw)}`
    : period === 'all' ? `${totalCommits} commits` : '';

  return (
    <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px 5px 12px', background: C.bgRow, borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Code Output</span>
        <div style={{ display: 'flex', gap: 2 }}>
          {PERIODS.map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              padding: '2px 6px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
              fontFamily: "'JetBrains Mono', monospace",
              border: period === p ? '1px solid rgba(167,139,250,0.15)' : '1px solid transparent',
              background: period === p ? C.accent + '22' : 'none',
              color: period === p ? C.accent : C.textMuted,
              fontWeight: period === p ? 700 : 400,
            }}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* 3 KPI 카드 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 0 }}>
        <KPI label="Commits" value={`${data.commits}`} sub={commitsSub} color={C.accent} C={C} borderRight />
        <KPI label="Net Lines" value={`${netLines >= 0 ? '+' : ''}${netLines}`} sub={`+${data.added} / -${data.removed}`} color={C.active} C={C} borderRight />
        <KPI label="$/Commit"
          value={costPerCommit > 0 ? fmtCost(costPerCommit, currency, usdToKrw) : '—'}
          sub={cpcSub} color={C.textDim} C={C} />
      </div>

      {/* 한 줄 요약 */}
      {data.commits > 0 && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '6px 14px',
          borderTop: `1px solid ${C.border}`,
        }}>
          <span style={{ fontSize: 9, color: C.textDim, fontFamily: C.fontMono }}>
            {data.commits} commit{data.commits > 1 ? 's' : ''} · {netLines >= 0 ? '+' : ''}{netLines} net lines
          </span>
        </div>
      )}
    </div>
  );
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
      <div style={{ fontSize: 8, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color, fontFamily: C.fontMono, lineHeight: 1 }}>{value}</div>
      {sub && (
        <div style={{ fontSize: 9, color: subColor ?? C.textMuted, marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}
