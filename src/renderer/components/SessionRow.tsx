import React, { useMemo } from 'react';
import { SessionInfo } from '../types';
import { useTheme } from '../ThemeContext';
import { stateLabel, modelColor, fmtRelative, fmtTokens } from '../theme';
import ActivityBreakdown from './ActivityBreakdown';

// idle 시간(분) 계산
function idleMinutes(session: SessionInfo): number {
  if (session.state === 'active' || session.state === 'waiting') return 0;
  if (!session.lastModified) return Infinity;
  return (Date.now() - new Date(session.lastModified).getTime()) / 60000;
}

function compactToolLabel(name: string): string {
  const map: Record<string, string> = {
    shell_command: 'shell',
    request_user_input: 'ask',
    list_mcp_resources: 'mcp:list',
    read_mcp_resource: 'mcp:read',
    apply_patch: 'patch',
  };
  return map[name] ?? name.replace(/^functions\./, '').replace(/^multi_tool_use\./, '');
}

function SessionRow({ session, expanded, onToggle }: {
  session: SessionInfo;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const C = useTheme();
  const TOOL_COLORS = [C.input, C.output, C.cacheW, C.cacheR, C.sonnet, C.idle];
  const mc = modelColor(session.modelName, C);

  const toolEntries = useMemo(() => (
    Object.entries(session.toolCounts).sort((a, b) => b[1] - a[1])
  ), [session.toolCounts]);
  const visibleToolEntries = useMemo(() => toolEntries.slice(0, 6), [toolEntries]);
  const totalTools = useMemo(() => toolEntries.reduce((s, [, n]) => s + n, 0), [toolEntries]);

  const ctxPct = session.contextMax > 0
    ? Math.min(100, (session.contextUsed / session.contextMax) * 100)
    : 0;
  const showCtx = session.contextUsed > 0 && session.contextMax > 0;
  const ctxColor = ctxPct >= 90 ? C.barRed : ctxPct >= 80 ? C.barOrange : ctxPct >= 50 ? C.barYellow : C.accent;
  const ctxRemaining = session.contextMax - session.contextUsed;
  let ctxLabel = '';
  if (ctxPct >= 100) ctxLabel = 'at limit';
  else if (ctxPct >= 95) ctxLabel = 'near limit';
  else if (ctxPct >= 80) ctxLabel = 'compact soon';
  else ctxLabel = `${fmtTokens(ctxRemaining)} left`;

  const idle = useMemo(() => idleMinutes(session), [session]);
  const isCompact = idle >= 60;
  const hasBreakdown = !!session.activityBreakdown &&
    Object.values(session.activityBreakdown).some(v => v > 0);
  const isExpanded = expanded && hasBreakdown;

  if (idle >= 360) {
    return (
      <div style={{
        padding: '5px 10px', marginLeft: 8, marginRight: 8, marginTop: 3,
        background: C.bgRow, border: `1px solid ${C.border}`, borderRadius: 6,
        opacity: 0.45,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        contain: 'layout paint style', overflowAnchor: 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          {session.modelName && (
            <span title={session.modelName} style={{ fontSize: 8, background: mc + '18', color: mc, border: `1px solid ${mc}33`, borderRadius: 3, padding: '1px 5px', fontWeight: 700, maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {session.modelName}
            </span>
          )}
          <span style={{ fontSize: 8, background: session.provider === 'codex' ? C.output + '16' : C.accentDim, color: session.provider === 'codex' ? C.output : C.textMuted, border: `1px solid ${C.border}`, borderRadius: 3, padding: '1px 5px', fontWeight: 700 }}>
            {session.provider === 'codex' ? 'Codex' : 'Claude'}
          </span>
          <span title={session.source} style={{ fontSize: 10, color: C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.source}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
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
          contain: 'layout paint style',
          overflowAnchor: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            {session.modelName && (
              <span title={session.modelName} style={{ fontSize: 8, background: mc + '18', color: mc, border: `1px solid ${mc}33`, borderRadius: 3, padding: '1px 5px', fontWeight: 700, maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {session.modelName}
              </span>
            )}
            <span style={{ fontSize: 8, background: session.provider === 'codex' ? C.output + '16' : C.accentDim, color: session.provider === 'codex' ? C.output : C.textMuted, border: `1px solid ${C.border}`, borderRadius: 3, padding: '1px 5px', fontWeight: 700 }}>
              {session.provider === 'codex' ? 'Codex' : 'Claude'}
            </span>
            <span title={session.source} style={{ fontSize: 10, color: C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.source}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            {hasBreakdown && (
              <button
                onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
                title="Breakdown"
                style={{
                  width: 22, height: 18,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: 4,
                  background: isExpanded ? C.accent + '20' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${isExpanded ? C.accent + '55' : C.border}`,
                  color: isExpanded ? C.accent : C.textMuted,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <span style={{ display: 'inline-flex', gap: 1, alignItems: 'flex-end', height: 8 }} aria-hidden="true">
                  {[3, 6, 4].map((h, i) => (
                    <span key={i} style={{ display: 'inline-block', width: 2, height: h, background: 'currentColor', borderRadius: '1px 1px 0 0' }} />
                  ))}
                </span>
              </button>
            )}
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
            <span style={{ fontSize: 8, color: C.textMuted, fontFamily: C.fontMono }}>{fmtRelative(session.lastModified)}</span>
          </div>
        </div>

        {showCtx && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 9, color: ctxPct >= 95 ? C.barRed : C.textMuted, fontFamily: C.fontMono }}>
              {Math.round(ctxPct)}% ctx
            </span>
            <span style={{ fontSize: 9, color: C.textMuted, fontFamily: C.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ctxLabel}
            </span>
          </div>
        )}

        {isExpanded && showCtx && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
            <div style={{ flex: 1, height: 3, background: C.accentDim, borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                width: `${ctxPct}%`, height: '100%',
                background: `linear-gradient(90deg, ${ctxColor}, ${ctxColor}cc)`,
                borderRadius: 2,
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

        {isExpanded && !isCompact && totalTools > 0 && (() => {
          const isIdle = session.state === 'idle';
          const displayEntries = isIdle ? visibleToolEntries.slice(0, 3) : visibleToolEntries;
          return (
          <>
            {!isIdle && (
            <div style={{ display: 'flex', height: 3, borderRadius: 2, overflow: 'hidden', marginTop: 3, gap: 0 }}>
              {visibleToolEntries.map(([name, count], i) => (
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
                  maxWidth: 132, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {compactToolLabel(name)}×<span style={{ color: C.textDim }}>{count}</span>
                </span>
              ))}
            </div>
          </>
          );
        })()}
      </div>

      {isExpanded && <ActivityBreakdown session={session} />}
    </>
  );
}

export default React.memo(SessionRow);
