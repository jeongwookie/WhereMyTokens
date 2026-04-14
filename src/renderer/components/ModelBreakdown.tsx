import React from 'react';
import { ModelUsage } from '../types';
import { useTheme } from '../ThemeContext';
import { modelColor, fmtTokens, fmtCost } from '../theme';

export default function ModelBreakdown({ models, currency, usdToKrw }: { models: ModelUsage[]; currency: string; usdToKrw: number }) {
  const C = useTheme();
  if (models.length === 0) return null;
  const maxT = Math.max(...models.map(m => m.tokens), 1);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 14px 5px 12px', background: C.bgRow, borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Model Usage</span>
        <span style={{ fontSize: 9, color: C.textMuted }}>All time</span>
      </div>
      <div style={{ padding: '6px 14px 8px' }}>
      {models.slice(0, 4).map(m => {
        const color = modelColor(m.model, C);
        return (
          <div key={m.model} style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ fontSize: 11, color, fontWeight: 600 }}>{m.model}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ fontSize: 10, color: C.textMuted }}>{fmtTokens(m.tokens)}</span>
                <span style={{ fontSize: 11, color: C.textDim }}>{fmtCost(m.costUSD, currency, usdToKrw)}</span>
              </div>
            </div>
            <div style={{ height: 3, background: C.accentDim, borderRadius: 2 }}>
              <div style={{ width: `${(m.tokens / maxT) * 100}%`, height: '100%', background: color, borderRadius: 2 }} />
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
