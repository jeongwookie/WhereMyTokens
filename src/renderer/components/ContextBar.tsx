import React from 'react';
import { SessionInfo } from '../types';
import { C, fmtTokens, pctColor } from '../theme';

interface Props { sessions: SessionInfo[]; }

export default function ContextBar({ sessions }: Props) {
  const active = sessions.find(s => s.state === 'active' || s.state === 'waiting');
  if (!active || active.contextMax === 0) return null;

  const pct = Math.min(100, (active.contextUsed / active.contextMax) * 100);
  const color = pctColor(pct);

  return (
    <div style={{ padding: '8px 14px', borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: C.textDim }}>
          Context
          <span style={{ fontSize: 9, color: C.textMuted, marginLeft: 5 }}>{active.projectName}</span>
        </span>
        <span style={{ fontSize: 11, color: C.textDim }}>
          {fmtTokens(active.contextUsed)} / {fmtTokens(active.contextMax)}
        </span>
      </div>
      <div style={{ height: 5, background: '#ffffff0a', borderRadius: 3 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.4s' }} />
      </div>
    </div>
  );
}
