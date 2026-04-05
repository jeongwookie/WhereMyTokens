import React, { useEffect, useState } from 'react';
import { AppSettings } from '../types';
import { C } from '../theme';
import ViewHeader from '../components/ViewHeader';

interface Props { onBack: () => void }

const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${C.border}` };
const label: React.CSSProperties = { fontSize: 12, color: C.text };
const sub: React.CSSProperties = { fontSize: 10, color: C.textMuted, marginTop: 2 };
const chk: React.CSSProperties = { accentColor: C.accent, width: 16, height: 16, cursor: 'pointer' };

function SectionHeader({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, padding: '10px 0 4px', borderBottom: `1px solid ${C.border}` }}>
      {text}
    </div>
  );
}

export default function NotificationsView({ onBack }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.wmt.getSettings().then(setSettings).catch(() => {});
  }, []);

  if (!settings) return null;

  const thresholds = settings.alertThresholds ?? [50, 80, 90];

  function toggleThreshold(v: number) {
    if (!settings) return;
    const next = thresholds.includes(v)
      ? thresholds.filter(t => t !== v)
      : [...thresholds, v].sort((a, b) => a - b);
    setSettings({ ...settings, alertThresholds: next });
  }

  async function handleSave() {
    if (!settings) return;
    await window.wmt.setSettings({
      enableAlerts: settings.enableAlerts,
      alertThresholds: settings.alertThresholds,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
      <ViewHeader title="Alerts" onBack={onBack} />

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px' }}>
        <SectionHeader text="Usage Alerts" />

        <div style={row}>
          <div>
            <div style={label}>Enable usage alerts</div>
            <div style={sub}>Send Windows notification when a limit threshold is reached</div>
          </div>
          <input type="checkbox" style={chk}
            checked={settings.enableAlerts}
            onChange={e => setSettings({ ...settings, enableAlerts: e.target.checked })} />
        </div>

        <div style={{ padding: '10px 0', borderBottom: `1px solid ${C.border}`, opacity: settings.enableAlerts ? 1 : 0.4, pointerEvents: settings.enableAlerts ? 'auto' : 'none' }}>
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 8 }}>Alert thresholds — notify when usage reaches:</div>
          <div style={{ display: 'flex', gap: 16 }}>
            {[50, 80, 90].map(v => (
              <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, color: C.text }}>
                <input type="checkbox" style={chk}
                  checked={thresholds.includes(v)}
                  onChange={() => toggleThreshold(v)} />
                {v}%
              </label>
            ))}
          </div>
        </div>

        <SectionHeader text="Alert Targets" />
        <div style={{ padding: '8px 0', fontSize: 11, color: C.textDim, lineHeight: 1.8 }}>
          <div>· <span style={{ color: C.text }}>5h limit</span> — current 5-hour window usage</div>
          <div>· <span style={{ color: C.text }}>Weekly limit</span> — this week's total usage</div>
          <div>· <span style={{ color: C.text }}>Sonnet limit</span> — Sonnet weekly usage</div>
          <div style={{ marginTop: 8, color: C.textMuted }}>Auto-refreshed every 60s, 1-hour cooldown per alert</div>
        </div>
      </div>

      <button
        onClick={handleSave}
        style={{ margin: '12px 16px', background: saved ? C.active : C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '8px 0', fontSize: 13, cursor: 'pointer', fontWeight: 700, flexShrink: 0, transition: 'background 0.3s' }}
      >
        {saved ? 'Saved ✓' : 'Save'}
      </button>
    </div>
  );
}
