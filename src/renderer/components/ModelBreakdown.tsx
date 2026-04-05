import React from 'react';
import { ModelUsage } from '../types';
import { C, modelColor, fmtTokens, fmtCost } from '../theme';

export default function ModelBreakdown({ models, currency, usdToKrw }: { models: ModelUsage[]; currency: string; usdToKrw: number }) {
  if (models.length === 0) return null;
  const maxT = Math.max(...models.map(m => m.tokens), 1);

  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, padding: '8px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Model Usage</span>
        <span style={{ fontSize: 9, color: C.textMuted }}>All time</span>
      </div>
      {models.slice(0, 4).map(m => {
        const color = modelColor(m.model);
        return (
          <div key={m.model} style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ fontSize: 11, color, fontWeight: 600 }}>{m.model}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ fontSize: 10, color: C.textMuted }}>{fmtTokens(m.tokens)}</span>
                <span style={{ fontSize: 11, color: C.textDim }}>{fmtCost(m.costUSD, currency, usdToKrw)}</span>
              </div>
            </div>
            <div style={{ height: 3, background: '#ffffff08', borderRadius: 2 }}>
              <div style={{ width: `${(m.tokens / maxT) * 100}%`, height: '100%', background: color, borderRadius: 2 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
