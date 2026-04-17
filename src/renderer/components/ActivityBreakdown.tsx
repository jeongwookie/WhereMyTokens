import React from 'react';
import { SessionInfo } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtTokens } from '../theme';

// 활동 카테고리 메타데이터 (색상·아이콘·레이블)
const CATEGORIES = [
  { key: 'read',      label: 'Read',        icon: '📄', color: '#60a5fa' },
  { key: 'editWrite', label: 'Edit / Write', icon: '✏️', color: '#34d399' },
  { key: 'search',    label: 'Search',       icon: '🔍', color: '#22d3ee' },
  { key: 'git',       label: 'Git',          icon: '🌿', color: '#f59e0b' },
  { key: 'buildTest', label: 'Build / Test', icon: '⚙️', color: '#fb923c' },
  { key: 'terminal',  label: 'Terminal',     icon: '💻', color: '#fbbf24' },
  { key: 'subagents', label: 'Subagents',    icon: '🤖', color: '#f472b6' },
  { key: 'thinking',  label: 'Thinking',     icon: '💭', color: '#2dd4bf' },
  { key: 'response',  label: 'Response',     icon: '💬', color: '#8b90a0' },
  { key: 'web',       label: 'Web',          icon: '🌐', color: '#38bdf8' },
] as const;

type CatKey = typeof CATEGORIES[number]['key'];

interface Props {
  session: SessionInfo;
}

export default function ActivityBreakdown({ session }: Props) {
  const C = useTheme();
  const bd = session.activityBreakdown;
  if (!bd) return null;

  // 총계 계산 및 값이 있는 카테고리만 필터링
  const total = CATEGORIES.reduce((s, c) => s + (bd[c.key] ?? 0), 0);
  if (total === 0) return null;

  const active = CATEGORIES.filter(c => (bd[c.key] ?? 0) > 0)
    .sort((a, b) => (bd[b.key] ?? 0) - (bd[a.key] ?? 0));

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
          {fmtTokens(total)}
        </span>
        <span style={{ fontSize: 9, color: C.textMuted }}>output tokens this session</span>
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
                  {fmtTokens(tokens)}
                </span>
                <span style={{ fontSize: 9, fontFamily: C.fontMono, color: C.textMuted, width: 26, textAlign: 'right', flexShrink: 0 }}>
                  {Math.round(pct)}%
                </span>
              </div>
              <div style={{ marginLeft: 19, height: 3, background: `${cat.color}18`, borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: cat.color, borderRadius: 2, transition: 'width 0.4s' }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
