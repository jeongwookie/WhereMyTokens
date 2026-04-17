import React from 'react';
import { SessionInfo } from '../types';
import { useTheme } from '../ThemeContext';
import { stateColor, stateLabel, modelColor, fmtRelative, fmtTokens } from '../theme';
import ActivityBreakdown from './ActivityBreakdown';

// idle 시간(분) 계산
function idleMinutes(session: SessionInfo): number {
  if (session.state === 'active' || session.state === 'waiting') return 0;
  if (!session.lastModified) return Infinity;
  return (Date.now() - new Date(session.lastModified).getTime()) / 60000;
}

export default function SessionRow({ session, expanded, onToggle }: {
  session: SessionInfo;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const C = useTheme();
  const TOOL_COLORS = [C.input, C.output, C.cacheW, C.cacheR, C.sonnet, C.idle];

  const sc = stateColor(session.state, C);
  const mc = modelColor(session.modelName, C);

  const toolEntries = Object.entries(session.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const totalTools = toolEntries.reduce((s, [, n]) => s + n, 0);

  // Context usage
  const ctxPct = session.contextMax > 0
    ? Math.min(100, (session.contextUsed / session.contextMax) * 100)
    : 0;
  const showCtx = session.contextUsed > 0 && session.contextMax > 0;
  const ctxColor = ctxPct >= 90 ? C.barRed : ctxPct >= 80 ? C.barOrange : ctxPct >= 50 ? C.barYellow : C.accent;
  const ctxRemaining = session.contextMax - session.contextUsed;
  let ctxLabel = '';
  if (ctxPct >= 100) ctxLabel = '⚠ at limit';
  else if (ctxPct >= 95) ctxLabel = '⚠ near limit';
  else if (ctxPct >= 80) ctxLabel = 'compact soon';
  else ctxLabel = `${fmtTokens(ctxRemaining)} left`;

  const idle = idleMinutes(session);

  // ── idle 6h+ → 한 줄 인라인 ──
  if (idle >= 360) {
    return (
      <div style={{
        padding: '5px 10px', marginLeft: 8, marginRight: 8, marginTop: 3,
        background: C.bgRow, border: `1px solid ${C.border}`, borderRadius: 6,
        opacity: 0.45,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {session.modelName && (
            <span style={{ fontSize: 8, background: mc + '22', color: mc, border: `1px solid ${mc}44`, borderRadius: 3, padding: '1px 5px', fontWeight: 700 }}>
              {session.modelName}
            </span>
          )}
          <span style={{ fontSize: 10, color: C.textMuted }}>{session.source}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {showCtx && (
            <span style={{ fontSize: 8, color: C.textMuted, fontFamily: C.fontMono }}>{Math.round(ctxPct)}% ctx</span>
          )}
          <span style={{ fontSize: 8, background: 'rgba(255,255,255,0.04)', color: C.textMuted, borderRadius: 3, padding: '1px 5px', border: `1px solid rgba(255,255,255,0.04)` }}>
            {stateLabel(session.state)}
          </span>
          <span style={{ fontSize: 8, color: C.textMuted, fontFamily: C.fontMono }}>{fmtRelative(session.lastModified)}</span>
        </div>
      </div>
    );
  }

  // ── idle 1-6h → 축소 표시 (ctx만, tool bar 숨김) ──
  const isCompact = idle >= 60;
  // 활동 분석 패널 표시 가능 여부 (데이터 있을 때만)
  const hasBreakdown = !!session.activityBreakdown &&
    Object.values(session.activityBreakdown).some(v => v > 0);
  const isExpanded = expanded && hasBreakdown;

  return (
    <>
      <div
        onClick={hasBreakdown ? onToggle : undefined}
        style={{
          padding: isCompact ? '6px 10px' : '7px 10px',
          marginLeft: 8, marginRight: 8, marginTop: 3,
          background: C.bgRow,
          border: `1px solid ${isExpanded ? 'rgba(13,148,136,0.35)' : C.border}`,
          borderRadius: isExpanded ? '6px 6px 0 0' : 6,
          borderBottom: isExpanded ? `1px solid ${C.border}` : undefined,
          opacity: isCompact ? 0.65 : 1,
          cursor: hasBreakdown ? 'pointer' : 'default',
          transition: 'border-color 0.15s',
        }}
      >
        {/* 헤더: 모델 + 환경 ... 상태 + 시간 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {session.modelName && (
              <span style={{ fontSize: 8, background: mc + '22', color: mc, border: `1px solid ${mc}44`, borderRadius: 3, padding: '1px 5px', fontWeight: 700 }}>
                {session.modelName}
              </span>
            )}
            <span style={{ fontSize: 10, color: C.textMuted }}>{session.source}</span>
          </div>
          <div style={{ textAlign: 'right' }}>
              <span style={{
                fontSize: 8, padding: '1px 5px', borderRadius: 3, fontWeight: 600,
                fontFamily: C.fontMono,
                background: session.state === 'active' ? C.active + '1a' :
                            session.state === 'waiting' ? C.waiting + '1a' : 'rgba(255,255,255,0.04)',
                color: session.state === 'active' ? C.active :
                       session.state === 'waiting' ? C.waiting : C.textMuted,
              }}>
                {stateLabel(session.state)}
              </span>
              <div style={{ fontSize: 8, color: C.textMuted, marginTop: 1 }}>{fmtRelative(session.lastModified)}</div>
          </div>
        </div>

        {/* Context bar */}
        {showCtx && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <div style={{ flex: 1, height: 3, background: C.accentDim, borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                width: `${ctxPct}%`, height: '100%',
                background: `linear-gradient(90deg, ${ctxColor}, ${ctxColor}cc)`,
                borderRadius: 2, transition: 'width 0.4s',
              }} />
            </div>
            <span style={{
              fontSize: 9, fontFamily: C.fontMono, flexShrink: 0,
              color: ctxPct >= 95 ? C.barRed : C.textMuted,
              fontWeight: ctxPct >= 95 ? 600 : 400,
            }}>
              {Math.round(ctxPct)}% {ctxLabel}
            </span>
          </div>
        )}

        {/* Tool bar + chips */}
        {!isCompact && totalTools > 0 && (() => {
          const isIdle = session.state === 'idle';
          const displayEntries = isIdle ? toolEntries.slice(0, 3) : toolEntries;
          return (
          <>
            {!isIdle && (
            <div style={{ display: 'flex', height: 3, borderRadius: 2, overflow: 'hidden', marginTop: 3, gap: 0 }}>
              {toolEntries.map(([name, count], i) => (
                <div key={name} title={`${name}: ${count}`}
                  style={{ flex: count, background: TOOL_COLORS[i % TOOL_COLORS.length], minWidth: 2 }} />
              ))}
            </div>
            )}
            <div style={{ display: 'flex', gap: 3, marginTop: 3, flexWrap: 'wrap', width: '100%' }}>
              {displayEntries.map(([name, count]) => (
                <span key={name} style={{
                  fontSize: 10, fontFamily: C.fontMono, padding: '2px 5px', borderRadius: 3,
                  background: 'rgba(255,255,255,0.04)', color: C.textMuted,
                  border: '1px solid rgba(255,255,255,0.05)',
                }}>
                  {name}×<span style={{ color: C.textDim }}>{count}</span>
                </span>
              ))}
            </div>
          </>
          );
        })()}
        {/* Activity Breakdown 토글 버튼 — 데이터 있을 때만 표시 */}
        {hasBreakdown && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 5 }}>
            <button
              onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 9, padding: '2px 8px 2px 6px',
                borderRadius: 10,
                background: isExpanded ? C.accent + '20' : C.accentDim,
                border: `1px solid ${isExpanded ? C.accent + '55' : C.accent + '30'}`,
                color: isExpanded ? C.accent : C.textDim,
                cursor: 'pointer',
                fontWeight: isExpanded ? 600 : 400,
                fontFamily: C.fontSans,
                transition: 'all 0.15s',
              }}
            >
              {/* CSS 미니 바 차트 아이콘 */}
              <span style={{ display: 'inline-flex', gap: 1.5, alignItems: 'flex-end', height: 8 }}>
                {[3, 6, 4, 7, 5].map((h, i) => (
                  <span key={i} style={{ display: 'inline-block', width: 2, height: h, background: 'currentColor', borderRadius: '1px 1px 0 0' }} />
                ))}
              </span>
              Breakdown
              <span style={{ fontSize: 7, opacity: 0.75 }}>{isExpanded ? '▲' : '▼'}</span>
            </button>
          </div>
        )}
      </div>

      {/* 활동 분석 패널 — 클릭 토글 */}
      {isExpanded && <ActivityBreakdown session={session} />}
    </>
  );
}
