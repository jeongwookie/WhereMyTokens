import React from 'react';
import { ExtraUsage } from '../types';
import { useTheme } from '../ThemeContext';

interface Props {
  extraUsage: ExtraUsage;
  variant?: 'row' | 'banner';
}

// 월간 한도 리셋까지 남은 시간을 간단히 표시한다.
function fmtMonthlyReset(): string {
  const now = new Date();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const ms = nextMonth.getTime() - now.getTime();
  if (ms <= 0) return '';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days > 0) return `in ${days}d ${hours}h`;
  return `in ${hours}h`;
}

function ExtraUsageCard({ extraUsage, variant = 'row' }: Props) {
  const C = useTheme();
  const { monthlyLimit, usedCredits, utilization } = extraUsage;
  const barPct = Math.min(100, utilization);
  const barColor = barPct >= 90 ? C.barRed : barPct >= 75 ? C.barOrange : barPct >= 50 ? C.barYellow : C.barOrange;
  const isHigh = barPct >= 90;
  const isBanner = variant === 'banner';

  const usedUSD = (usedCredits / 100).toFixed(2);
  const limitUSD = (monthlyLimit / 100).toFixed(0);
  const resetStr = fmtMonthlyReset();
  const title = isBanner
    ? (barPct >= 100 ? 'Extra Usage over monthly cap' : 'Extra Usage near monthly cap')
    : 'Extra Usage - monthly';

  return (
    <div style={{
      padding: isBanner ? '9px 14px' : '7px 14px',
      background: isHigh ? `${C.barRed}${isBanner ? '18' : '12'}` : 'transparent',
      border: isBanner ? `1px solid ${C.barRed}55` : 'none',
      borderRadius: isBanner ? 8 : 0,
      boxShadow: isBanner ? '0 8px 22px rgba(0,0,0,0.18)' : 'none',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
        <span style={{ fontSize: isBanner ? 12 : 11, color: isHigh ? C.barRed : C.textMuted, fontWeight: isHigh ? 800 : 400 }}>{title}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ fontSize: 10, color: C.textMuted, fontFamily: C.fontMono }}>${usedUSD} / ${limitUSD}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: barPct >= 99 ? C.barRed : barColor, fontFamily: C.fontMono }}>{Math.round(barPct)}%</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ flex: 1, height: isBanner ? 6 : 5, background: C.accentDim, borderRadius: 3, overflow: 'hidden' }}>
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

export default React.memo(ExtraUsageCard);
