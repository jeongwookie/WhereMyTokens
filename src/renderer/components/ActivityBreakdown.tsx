import React, { useMemo } from 'react';
import { SessionInfo } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtTokens } from '../theme';

// 활동 카테고리 메타데이터 — 인접 색상 간 색상환 거리를 최대화하여 구분성 확보
const CATEGORIES = [
  { key: 'read',      label: 'Read',        icon: '📄', color: '#60a5fa' },  // blue
  { key: 'editWrite', label: 'Edit / Write', icon: '✏️', color: '#a78bfa' },  // violet (was green, too close to thinking)
  { key: 'search',    label: 'Search',       icon: '🔍', color: '#38bdf8' },  // sky blue
  { key: 'git',       label: 'Git',          icon: '🌿', color: '#4ade80' },  // green (moved from amber)
  { key: 'buildTest', label: 'Build / Test', icon: '⚙️', color: '#fb923c' },  // orange
  { key: 'terminal',  label: 'Terminal',     icon: '💻', color: '#fbbf24' },  // amber
  { key: 'subagents', label: 'Subagents',    icon: '🤖', color: '#f472b6' },  // pink
  { key: 'thinking',  label: 'Thinking',     icon: '💭', color: '#2dd4bf' },  // teal (앱 accent와 연계)
  { key: 'response',  label: 'Response',     icon: '💬', color: '#94a3b8' },  // slate (neutral)
  { key: 'web',       label: 'Web',          icon: '🌐', color: '#c084fc' },  // purple
] as const;

type CatKey = typeof CATEGORIES[number]['key'];

interface Props {
  session: SessionInfo;
}

function ActivityBreakdown({ session }: Props) {
  const C = useTheme();
  const bd = session.activityBreakdown;
  const kind = session.activityBreakdownKind ?? 'tokens';

  // 총계 계산 및 값이 있는 카테고리만 필터링
  const { total, active } = useMemo(() => {
    if (!bd) return { total: 0, active: [] as typeof CATEGORIES[number][] };
    const nextTotal = CATEGORIES.reduce((s, c) => s + (bd[c.key] ?? 0), 0);
    const nextActive = CATEGORIES
      .filter(c => (bd[c.key] ?? 0) > 0)
      .sort((a, b) => (bd[b.key] ?? 0) - (bd[a.key] ?? 0));
    return { total: nextTotal, active: nextActive };
  }, [bd]);
  if (!bd) return null;
  if (total === 0) return null;

  const fmtValue = (value: number) => kind === 'events' ? String(Math.round(value)) : fmtTokens(value);
  const totalLabel = kind === 'events' ? 'tool events this session' : 'output tokens this session';

  return (
    <div style={{
      marginLeft: 8, marginRight: 8,
      background: C.bgCard,
      border: `1px solid rgba(13,148,136,0.3)`,
      borderTop: 'none',
      borderRadius: '0 0 6px 6px',
      padding: '8px 10px 10px',
    }}>
      {/* 총계 */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 15, fontWeight: 800, color: C.text, fontFamily: C.fontMono, lineHeight: 1 }}>
          {fmtValue(total)}
        </span>
        <span style={{ fontSize: 9, color: C.textMuted }}>{totalLabel}</span>
      </div>

      {/* 스택 바 */}
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', gap: 1, marginBottom: 8 }}>
        {active.map(cat => {
          const pct = (bd[cat.key] ?? 0) / total * 100;
          return (
            <div
              key={cat.key}
              title={`${cat.label}: ${Math.round(pct)}%`}
              style={{ flex: bd[cat.key] ?? 0, background: cat.color, minWidth: pct > 2 ? 2 : 0 }}
            />
          );
        })}
      </div>

      {/* 카테고리별 바 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {active.map(cat => {
          const tokens = bd[cat.key] ?? 0;
          const pct = tokens / total * 100;
          return (
            <div key={cat.key}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                <span style={{ fontSize: 10, width: 14, textAlign: 'center', flexShrink: 0 }}>{cat.icon}</span>
                <span style={{ fontSize: 10, color: C.textDim, flex: 1 }}>{cat.label}</span>
                <span style={{ fontSize: 9, fontFamily: C.fontMono, color: C.textMuted, width: 42, textAlign: 'right', flexShrink: 0 }}>
                  {fmtValue(tokens)}
                </span>
                <span style={{ fontSize: 9, fontFamily: C.fontMono, color: C.textMuted, width: 26, textAlign: 'right', flexShrink: 0 }}>
                  {Math.round(pct)}%
                </span>
              </div>
              <div style={{ marginLeft: 19, height: 3, background: `${cat.color}18`, borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: cat.color, borderRadius: 2 }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default React.memo(ActivityBreakdown);
