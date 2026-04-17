import React, { useState, useEffect, useMemo } from 'react';
import { AppSettings } from '../types';
import { useTheme } from '../ThemeContext';
import ViewHeader from '../components/ViewHeader';

interface Props { settings: AppSettings; onSave: (s: Partial<AppSettings>) => void; onBack: () => void; }

export default function SettingsView({ settings, onSave, onBack }: Props) {
  const C = useTheme();
  const [s, setS] = useState({ ...settings });
  const [integrationConfigured, setIntegrationConfigured] = useState<boolean | null>(null);
  const [integrationMsg, setIntegrationMsg] = useState('');

  const row: React.CSSProperties = useMemo(() => ({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: `1px solid ${C.border}` }), [C]);
  const labelStyle: React.CSSProperties = useMemo(() => ({ fontSize: 12, color: C.textDim }), [C]);
  const sel: React.CSSProperties = useMemo(() => ({ background: C.bgRow, color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: '3px 6px', fontSize: 12 }), [C]);
  const inp: React.CSSProperties = useMemo(() => ({ ...sel, width: 80 }), [sel]);
  const chk: React.CSSProperties = useMemo(() => ({ accentColor: C.accent }), [C]);

  useEffect(() => {
    window.wmt.getIntegrationStatus().then(r => setIntegrationConfigured(r.configured)).catch(() => {});
  }, []);

  async function handleSetupIntegration() {
    setIntegrationMsg('Setting up...');
    try {
      const r = await window.wmt.setupIntegration();
      if (r.ok) {
        setIntegrationConfigured(true);
        setIntegrationMsg('Done! Restart Claude Code to activate.');
      } else {
        setIntegrationMsg(`Failed: ${r.error ?? 'unknown error'}`);
      }
    } catch (e) {
      setIntegrationMsg(`Error: ${String(e)}`);
    }
    setTimeout(() => setIntegrationMsg(''), 4000);
  }

  function SectionHeader({ label }: { label: string }) {
    return (
      <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, padding: '10px 0 4px', borderBottom: `1px solid ${C.border}` }}>
        {label}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
      <ViewHeader title="Settings" onBack={onBack} />
      <div style={{ overflowY: 'auto', flex: 1, padding: '4px 16px' }}>

        <SectionHeader label="Claude Code Integration" />
        <div style={{ padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, color: C.text }}>Real-time data via statusLine</div>
              <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
                Registers WhereMyTokens as a Claude Code plugin for live rate limits
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {integrationConfigured !== null && (
                <span style={{ fontSize: 9, color: integrationConfigured ? '#4a9a4a' : C.textMuted }}>
                  {integrationConfigured ? '● Connected' : '○ Not configured'}
                </span>
              )}
              <button
                onClick={handleSetupIntegration}
                style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
              >
                Setup
              </button>
            </div>
          </div>
          {integrationMsg && (
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 4 }}>{integrationMsg}</div>
          )}
        </div>

        <SectionHeader label="General" />
        <div style={row}>
          <span style={labelStyle}>Start with Windows</span>
          <input type="checkbox" style={chk} checked={s.openAtLogin} onChange={e => setS({ ...s, openAtLogin: e.target.checked })} />
        </div>
        <div style={row}>
          <span style={labelStyle}>Global shortcut</span>
          <input style={{ ...inp, width: 160 }} value={s.globalHotkey} onChange={e => setS({ ...s, globalHotkey: e.target.value })} />
        </div>

        <SectionHeader label="Currency" />
        <div style={row}>
          <span style={labelStyle}>Currency</span>
          <select style={sel} value={s.currency} onChange={e => setS({ ...s, currency: e.target.value as 'USD' | 'KRW' })}>
            <option value="USD">USD ($)</option>
            <option value="KRW">KRW (₩)</option>
          </select>
        </div>
        {s.currency === 'KRW' && (
          <div style={row}>
            <span style={labelStyle}>Exchange rate (1 USD)</span>
            <input style={inp} type="number" value={s.usdToKrw} onChange={e => setS({ ...s, usdToKrw: Number(e.target.value) })} />
          </div>
        )}

        <SectionHeader label="Tray" />
        <div style={row}>
          <span style={labelStyle}>Tray label</span>
          <select style={sel} value={s.trayDisplay ?? 'h5pct'} onChange={e => setS({ ...s, trayDisplay: e.target.value as AppSettings['trayDisplay'] })}>
            <option value="none">None</option>
            <option value="h5pct">5h usage %</option>
            <option value="tokens">5h tokens</option>
            <option value="cost">5h cost</option>
          </select>
        </div>

        <SectionHeader label="Appearance" />
        <div style={row}>
          <span style={labelStyle}>Theme</span>
          <div style={{ display: 'flex', gap: 2 }}>
            {(['auto', 'light', 'dark'] as const).map(t => (
              <button key={t} onClick={() => setS({ ...s, theme: t })} style={{
                padding: '3px 10px', fontSize: 11, border: `1px solid ${(s.theme ?? 'auto') === t ? C.accent + '88' : C.border}`,
                borderRadius: 4, cursor: 'pointer', fontWeight: (s.theme ?? 'auto') === t ? 700 : 400,
                background: (s.theme ?? 'auto') === t ? C.accent + '22' : 'transparent',
                color: (s.theme ?? 'auto') === t ? C.accent : C.textDim,
              }}>
                {t === 'auto' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>

      </div>
      <button
        onClick={() => { onSave(s); onBack(); }}
        style={{ margin: '12px 16px', background: C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '8px 0', fontSize: 13, cursor: 'pointer', fontWeight: 700, flexShrink: 0 }}
      >
        Save
      </button>
    </div>
  );
}
