import React from 'react';
import { ModelUsage } from '../types';
import { useTheme } from '../ThemeContext';
import { modelColor, fmtTokens, fmtCost } from '../theme';

function displayModelName(model: string): string {
  return model
    .replace(/^GPT-5\.3-CODEX$/i, 'GPT-5.3 Codex')
    .replace(/^GPT-5\.2-CODEX$/i, 'GPT-5.2 Codex')
    .replace(/^GPT-5\.1-CODEX-MAX$/i, 'GPT-5.1 Codex Max')
    .replace(/^GPT-5\.1-CODEX-MINI$/i, 'GPT-5.1 Codex Mini')
    .replace(/^GPT-5\.1-CODEX$/i, 'GPT-5.1 Codex')
    .replace(/^GPT-5-CODEX$/i, 'GPT-5 Codex');
}

function providerLabel(provider: ModelUsage['provider']): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return 'Other';
}

function ModelBreakdown({ models, currency, usdToKrw }: { models: ModelUsage[]; currency: string; usdToKrw: number }) {
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
        const provider = providerLabel(m.provider);
        return (
          <div key={`${m.provider}:${m.model}`} style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, flex: 1, marginRight: 8 }}>
                <span style={{ fontSize: 8, color: C.textMuted, background: C.bgRow, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 4px', flexShrink: 0 }}>
                  {provider}
                </span>
                <span title={m.model} style={{ fontSize: 11, color, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {displayModelName(m.model)}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ fontSize: 10, color: C.textMuted, fontFamily: C.fontMono }}>{fmtTokens(m.tokens)}</span>
                <span style={{ fontSize: 11, color: C.textDim, fontFamily: C.fontMono }}>{fmtCost(m.costUSD, currency, usdToKrw)}</span>
              </div>
            </div>
            <div style={{ height: 3, background: C.accentDim, borderRadius: 2 }}>
              <div style={{ width: `${(m.tokens / maxT) * 100}%`, height: '100%', background: `linear-gradient(90deg, ${color}, ${color}88)`, borderRadius: 2 }} />
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}

export default React.memo(ModelBreakdown);
