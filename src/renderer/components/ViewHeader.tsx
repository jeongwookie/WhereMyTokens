import React, { useState } from 'react';
import { useTheme } from '../ThemeContext';

interface Props {
  title: string;
  onBack: () => void;
}

const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

export default function ViewHeader({ title, onBack }: Props) {
  const C = useTheme();
  const [hover, setHover] = useState(false);

  return (
    <div style={{
      ...drag,
      display: 'flex', alignItems: 'center',
      padding: '10px 14px', borderBottom: `1px solid ${C.border}`,
      flexShrink: 0, background: C.bgCard,
    }}>
      <button
        onClick={onBack}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          ...noDrag,
          background: hover ? C.bgHover : 'transparent',
          border: 'none', color: C.textDim, cursor: 'pointer',
          fontSize: 18, width: 28, height: 28, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 0.15s', flexShrink: 0,
          lineHeight: 1, paddingBottom: 1,
        }}
      >‹</button>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: C.text, textAlign: 'center' }}>{title}</span>
      <div style={{ width: 28, flexShrink: 0 }} />
    </div>
  );
}
