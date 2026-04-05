import React from 'react';
import { ExtraUsage } from '../types';
import { C } from '../theme';

interface Props {
  extraUsage: ExtraUsage;
}

function pctBarColor(pct: number): string {
  if (pct >= 90) return '#c0392b';
  if (pct >= 75) return '#e67e22';
  if (pct >= 50) return '#d4a017';
  return C.accent;
}

// 월 단위 남은 시간 포맷 (최대 31일)
function fmtMonthlyReset(): string {
  const now = new Date();
  // 다음 달 1일 자정(UTC)까지 남은 시간 계산
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const ms = nextMonth.getTime() - now.getTime();
  if (ms <= 0) return '';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days > 0) return `↻ ${days}d ${hours}h`;
  return `↻ ${hours}h`;
}

export default function ExtraUsageCard({ extraUsage }: Props) {
  const { monthlyLimit, usedCredits, utilization } = extraUsage;
  const barPct = Math.min(100, utilization);
  const barColor = pctBarColor(barPct);

  // cent → USD 변환
  const usedUSD = (usedCredits / 100).toFixed(2);
  const limitUSD = (monthlyLimit / 100).toFixed(0);
  const resetStr = fmtMonthlyReset();

  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, padding: '7px 14px' }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
        <span style={{ fontSize: 11, color: C.textMuted }}>Extra Usage · monthly</span>
        <span style={{ fontSize: 10, color: C.textMuted }}>${usedUSD} / ${limitUSD}</span>
      </div>

      {/* 프로그레스 바 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ flex: 1, height: 5, background: '#0000000a', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            width: `${barPct}%`, height: '100%',
            background: barColor, borderRadius: 3,
            transition: 'width 0.4s',
          }} />
        </div>
        <span style={{ fontSize: 10, fontWeight: 600, color: barColor, width: 28, textAlign: 'right', flexShrink: 0 }}>
          {barPct.toFixed(1)}%
        </span>
        {resetStr && (
          <span style={{ fontSize: 9, color: C.textMuted, flexShrink: 0 }}>{resetStr}</span>
        )}
      </div>
    </div>
  );
}
