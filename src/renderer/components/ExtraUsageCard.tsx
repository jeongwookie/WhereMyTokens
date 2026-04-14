import React from 'react';
import { ExtraUsage } from '../types';
import { useTheme } from '../ThemeContext';

interface Props {
  extraUsage: ExtraUsage;
}

// 월 단위 남은 시간 포맷 (최대 31일)
function fmtMonthlyReset(): string {
  const now = new Date();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const ms = nextMonth.getTime() - now.getTime();
  if (ms <= 0) return '';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days > 0) return `↻ ${days}d ${hours}h`;
  return `↻ ${hours}h`;
}

export default function ExtraUsageCard({ extraUsage }: Props) {
  const C = useTheme();
  const { monthlyLimit, usedCredits, utilization } = extraUsage;
  const barPct = Math.min(100, utilization);
  const barColor = barPct >= 90 ? C.barRed : barPct >= 75 ? C.barOrange : barPct >= 50 ? C.barYellow : C.barOrange;

  // cent → USD 변환
  const usedUSD = (usedCredits / 100).toFixed(2);
  const limitUSD = (monthlyLimit / 100).toFixed(0);
  const resetStr = fmtMonthlyReset();

  return (
    <div style={{ padding: '7px 14px' }}>
      {/* 헤더: 레이블 왼쪽, 금액+% 오른쪽 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
        <span style={{ fontSize: 11, color: C.textMuted }}>Extra Usage · monthly</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ fontSize: 10, color: C.textMuted, fontFamily: C.fontMono }}>${usedUSD} / ${limitUSD}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: barPct >= 99 ? C.barRed : barColor, fontFamily: C.fontMono }}>{Math.round(barPct)}%</span>
        </div>
      </div>

      {/* 프로그레스 바 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ flex: 1, height: 5, background: C.accentDim, borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            width: `${barPct}%`, height: '100%',
            background: barColor, borderRadius: 3,
            transition: 'width 0.4s',
          }} />
        </div>
        {resetStr && (
          <span style={{ fontSize: 9, color: C.textMuted, flexShrink: 0 }}>{resetStr}</span>
        )}
      </div>
    </div>
  );
}
