import React, { useState, useEffect } from 'react';
import { AppSettings } from '../types';
import { C } from '../theme';
import ViewHeader from '../components/ViewHeader';

interface Props { settings: AppSettings; onSave: (s: Partial<AppSettings>) => void; onBack: () => void; }

const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: `1px solid ${C.border}` };
const label: React.CSSProperties = { fontSize: 12, color: C.textDim };
const sel: React.CSSProperties = { background: C.bgRow, color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: '3px 6px', fontSize: 12 };
const inp: React.CSSProperties = { ...sel, width: 80 };
const chk: React.CSSProperties = { accentColor: C.accent };

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, padding: '10px 0 4px', borderBottom: `1px solid ${C.border}` }}>
      {label}
    </div>
  );
}

export default function SettingsView({ settings, onSave, onBack }: Props) {
  const [s, setS] = useState({ ...settings });
  const [integrationConfigured, setIntegrationConfigured] = useState<boolean | null>(null);
  const [integrationMsg, setIntegrationMsg] = useState('');

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
          <span style={label}>Launch at login</span>
          <input type="checkbox" style={chk} checked={s.openAtLogin} onChange={e => setS({ ...s, openAtLogin: e.target.checked })} />
        </div>
        <div style={row}>
          <span style={label}>Global shortcut</span>
          <input style={{ ...inp, width: 160 }} value={s.globalHotkey} onChange={e => setS({ ...s, globalHotkey: e.target.value })} />
        </div>

        <SectionHeader label="Data" />
        <div style={row}>
          <span style={label}>Show provider</span>
          <select style={sel} value={s.provider ?? 'both'} onChange={e => setS({ ...s, provider: e.target.value as AppSettings['provider'] })}>
            <option value="both">Claude + Codex</option>
            <option value="claude">Claude only</option>
            <option value="codex">Codex only</option>
          </select>
        </div>

        <SectionHeader label="Currency" />
        <div style={row}>
          <span style={label}>Currency</span>
          <select style={sel} value={s.currency} onChange={e => setS({ ...s, currency: e.target.value as 'USD' | 'KRW' })}>
            <option value="USD">USD ($)</option>
            <option value="KRW">KRW (₩)</option>
          </select>
        </div>
        {s.currency === 'KRW' && (
          <div style={row}>
            <span style={label}>Exchange rate (1 USD)</span>
            <input style={inp} type="number" value={s.usdToKrw} onChange={e => setS({ ...s, usdToKrw: Number(e.target.value) })} />
          </div>
        )}

        <SectionHeader label="Tray" />
        <div style={row}>
          <span style={label}>Tray label</span>
          <select style={sel} value={s.trayDisplay ?? 'h5pct'} onChange={e => setS({ ...s, trayDisplay: e.target.value as AppSettings['trayDisplay'] })}>
            <option value="none">None</option>
            <option value="h5pct">5h usage %</option>
            <option value="tokens">5h tokens</option>
            <option value="cost">5h cost</option>
          </select>
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
