import React from 'react';
import { SessionInfo } from '../types';
import { useTheme } from '../ThemeContext';
import { stateColor, stateLabel, modelColor, fmtRelative, fmtTokens } from '../theme';

export default function SessionRow({ session }: { session: SessionInfo }) {
  const C = useTheme();
  const TOOL_COLORS = [C.input, C.output, C.cacheW, C.cacheR, C.sonnet, C.idle];

  const sc = stateColor(session.state, C);
  const mc = modelColor(session.modelName, C);

  const toolEntries = Object.entries(session.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const totalTools = toolEntries.reduce((s, [, n]) => s + n, 0);

  // Context usage percentage
  const ctxPct = session.contextMax > 0
    ? Math.min(100, (session.contextUsed / session.contextMax) * 100)
    : 0;
  const showCtx = session.contextUsed > 0 && session.contextMax > 0;
  const ctxColor = ctxPct >= 90 ? C.barRed : ctxPct >= 80 ? C.barOrange : ctxPct >= 50 ? C.barYellow : C.accent;
  const ctxRemaining = session.contextMax - session.contextUsed;

  let ctxLabel = '';
  if (ctxPct >= 95) ctxLabel = '⚠ near limit';
  else if (ctxPct >= 80) ctxLabel = 'compact soon';
  else ctxLabel = `${fmtTokens(ctxRemaining)} left`;

  return (
    <div style={{ padding: '7px 14px', borderBottom: `1px solid ${C.borderSub}` }}>
      {/* Row header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: sc, flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>
            {session.projectName}
          </span>
          {session.modelName && (
            <span style={{ fontSize: 9, background: mc + '22', color: mc, border: `1px solid ${mc}44`, borderRadius: 3, padding: '1px 5px', fontWeight: 700, flexShrink: 0 }}>
              {session.modelName}
            </span>
          )}
          {session.isWorktree && session.worktreeBranch && (
            <span style={{ fontSize: 8, background: C.input + '22', color: C.input, border: `1px solid ${C.input}44`, borderRadius: 3, padding: '1px 5px', flexShrink: 0 }}>
              ⎇ {session.worktreeBranch}
            </span>
          )}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: sc }}>{stateLabel(session.state)}</div>
          <div style={{ fontSize: 9, color: C.textMuted }}>{fmtRelative(session.lastModified)}</div>
        </div>
      </div>

      {/* Source */}
      <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2, marginLeft: 14 }}>
        {session.source}
      </div>

      {/* Context usage */}
      {showCtx && (
        <div style={{ marginTop: 5, marginLeft: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ flex: 1, height: 3, background: C.accentDim, borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                width: `${ctxPct}%`, height: '100%',
                background: ctxColor, borderRadius: 2,
                transition: 'width 0.4s',
              }} />
            </div>
            <span style={{ fontSize: 9, color: ctxColor, fontWeight: ctxPct >= 80 ? 700 : 400, flexShrink: 0 }}>
              {Math.round(ctxPct)}%
            </span>
            {ctxLabel && (
              <span style={{ fontSize: 9, color: ctxColor, fontWeight: ctxPct >= 80 ? 700 : 400, flexShrink: 0 }}>
                {ctxLabel}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Tool usage */}
      {totalTools > 0 && (
        <div style={{ marginTop: 5, marginLeft: 14 }}>
          {/* Color bar + total count */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ display: 'flex', height: 3, borderRadius: 2, overflow: 'hidden', flex: 1, gap: 1 }}>
              {toolEntries.map(([name, count], i) => (
                <div key={name} title={`${name}: ${count}`}
                  style={{ flex: count, background: TOOL_COLORS[i % TOOL_COLORS.length], minWidth: 2 }} />
              ))}
            </div>
            <span style={{ fontSize: 9, color: C.textMuted, flexShrink: 0 }}>{totalTools}×</span>
          </div>
          {/* 전체 툴 이름 + 횟수 */}
          <div style={{ display: 'flex', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
            {toolEntries.map(([name, count], i) => (
              <span key={name} style={{ fontSize: 9, color: TOOL_COLORS[i % TOOL_COLORS.length] }}>
                {name} {count}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
