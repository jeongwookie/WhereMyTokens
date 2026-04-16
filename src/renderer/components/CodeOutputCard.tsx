import React, { useState } from 'react';
import { SessionInfo, GitStats } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtCost } from '../theme';

type Period = 'today' | 'all';
const PERIODS: Period[] = ['today', 'all'];

interface Props {
  sessions: SessionInfo[];
  repoGitStats: Record<string, GitStats>;  // gitCommonDir → GitStats (전체 repo, 세션 무관)
  todayCost: number;
  allTimeCost: number;
  currency: string;
  usdToKrw: number;
}

export default function CodeOutputCard({ sessions, repoGitStats, todayCost, allTimeCost, currency, usdToKrw }: Props) {
  const C = useTheme();
  const [period, setPeriod] = useState<Period>('today');

  // today: sessions 기반, (repo, branch)별 중복제거 — 활성 브랜치마다 카운트
  const seenToday = new Set<string>();
  let commitsToday = 0, linesAdded = 0, linesRemoved = 0;
  for (const s of sessions) {
    if (!s.gitStats) continue;
    const repoKey = s.gitStats.gitCommonDir ?? s.gitStats.toplevel ?? s.cwd;
    const branchKey = `${repoKey}::${s.gitStats.branch ?? ''}`;
    if (!seenToday.has(branchKey)) {
      seenToday.add(branchKey);
      commitsToday += s.gitStats.commitsToday;
      linesAdded += s.gitStats.linesAdded;
      linesRemoved += s.gitStats.linesRemoved;
    }
  }

  // all-time: repoGitStats 기반 — ~/.claude/projects/ 전체에서 발견된 모든 repo 포함
  let totalCommits = 0, totalLinesAdded = 0, totalLinesRemoved = 0;
  for (const stats of Object.values(repoGitStats)) {
    totalCommits += stats.totalCommits;
    totalLinesAdded += stats.totalLinesAdded;
    totalLinesRemoved += stats.totalLinesRemoved ?? 0;
  }

  if (totalCommits === 0 && commitsToday === 0) return null;

  // 기간별 데이터 선택
  const data = period === 'today'
    ? { commits: commitsToday, added: linesAdded, removed: linesRemoved }
    : { commits: totalCommits, added: totalLinesAdded, removed: totalLinesRemoved };

  const periodCost = period === 'today' ? todayCost : allTimeCost;
  const netLines = data.added - data.removed;

  // $/line 효율 계산 (today 기준 vs all-time 평균)
  const todayPerLine = linesAdded > 0 && todayCost > 0 ? todayCost / linesAdded : null;
  const avgPerLine   = totalLinesAdded > 0 && allTimeCost > 0 ? allTimeCost / totalLinesAdded : null;
  const effRatio     = todayPerLine != null && avgPerLine != null ? todayPerLine / avgPerLine : null;

  // 효율 레이블 (ratio = today$/line ÷ avg$/line, 낮을수록 효율적)
  const effInfo: { text: string; color: string } = (() => {
    if (period === 'all') return { text: avgPerLine ? fmtCost(avgPerLine * 1000, currency, usdToKrw) : '—', color: C.textDim };
    if (linesAdded === 0 || effRatio === null) return { text: 'Exploring', color: C.textDim };
    if (effRatio < 0.5)  return { text: 'Excellent', color: C.active };
    if (effRatio < 0.8)  return { text: 'Good',      color: C.active };
    if (effRatio < 1.2)  return { text: 'Normal',    color: '#f59e0b' };
    if (effRatio < 2.0)  return { text: 'Low',       color: '#f97316' };
    return { text: 'Exploring', color: C.textDim };
  })();

  // all 탭 서브텍스트용 라인 수 포맷 (+247K lines)
  const totalLinesFormatted = totalLinesAdded >= 1000
    ? `+${(totalLinesAdded / 1000).toFixed(0)}K lines`
    : `+${totalLinesAdded} lines`;

  // KPI 서브텍스트: ×N.N vs avg (today) / +247K lines (all)
  const effSub = (() => {
    if (period === 'all') return totalLinesFormatted;
    if (effRatio === null) return '';
    if (effRatio < 1) return `×${(1 / effRatio).toFixed(1)} vs avg`;
    return `${effRatio.toFixed(1)}x avg cost`;
  })();

  // 하단 바용 $/1K lines (기간별, ×1000으로 환산)
  const perLine = data.added > 0 && periodCost > 0 ? (periodCost / data.added) * 1000 : null;

  // COMMITS 서브텍스트
  const commitsSub = period === 'today' ? `${totalCommits} total` : 'all time';

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
        <KPI label="Claude ROI"
          value={effInfo.text}
          sub={effSub} color={effInfo.color} C={C} />
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
            {perLine ? ` · ${fmtCost(perLine, currency, usdToKrw)}/1K lines` : ''}
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
