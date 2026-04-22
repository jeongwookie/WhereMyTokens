import React, { useEffect, useMemo, useState } from 'react';
import { AppSettings } from '../types';
import { useTheme } from '../ThemeContext';
import ViewHeader from '../components/ViewHeader';

interface Props { onBack: () => void }

export default function NotificationsView({ onBack }: Props) {
  const C = useTheme();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);

  const row: React.CSSProperties = useMemo(() => ({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 0',
    borderBottom: `1px solid ${C.border}`,
  }), [C]);
  const labelStyle: React.CSSProperties = useMemo(() => ({ fontSize: 12, color: C.text }), [C]);
  const sub: React.CSSProperties = useMemo(() => ({ fontSize: 10, color: C.textMuted, marginTop: 2 }), [C]);
  const chk: React.CSSProperties = useMemo(() => ({ accentColor: C.accent, width: 16, height: 16, cursor: 'pointer' }), [C]);

  useEffect(() => {
    window.wmt.getSettings().then(setSettings).catch(() => {});
  }, []);

  if (!settings) return null;

  const thresholds = settings.alertThresholds ?? [50, 80, 90];
  const showClaudeTargets = settings.provider === 'claude' || settings.provider === 'both';
  const showCodexTargets = settings.provider === 'codex' || settings.provider === 'both';

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

  function SectionHeader({ text }: { text: string }) {
    return (
      <div style={{
        fontSize: 10,
        color: C.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        padding: '10px 0 4px',
        borderBottom: `1px solid ${C.border}`,
      }}>
        {text}
      </div>
    );
  }

  function TargetLine({ label, detail }: { label: string; detail: string }) {
    return (
      <div>- <span style={{ color: C.text }}>{label}</span> - {detail}</div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
      <ViewHeader title="Alerts" onBack={onBack} />

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px' }}>
        <SectionHeader text="Usage Alerts" />

        <div style={row}>
          <div>
            <div style={labelStyle}>Enable usage alerts</div>
            <div style={sub}>Send Windows notifications when a tracked limit reaches a threshold</div>
          </div>
          <input
            type="checkbox"
            style={chk}
            checked={settings.enableAlerts}
            onChange={e => setSettings({ ...settings, enableAlerts: e.target.checked })}
          />
        </div>

        <div style={{
          padding: '10px 0',
          borderBottom: `1px solid ${C.border}`,
          opacity: settings.enableAlerts ? 1 : 0.4,
          pointerEvents: settings.enableAlerts ? 'auto' : 'none',
        }}>
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 8 }}>Alert thresholds - notify when usage reaches:</div>
          <div style={{ display: 'flex', gap: 16 }}>
            {[50, 80, 90].map(v => (
              <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, color: C.text }}>
                <input
                  type="checkbox"
                  style={chk}
                  checked={thresholds.includes(v)}
                  onChange={() => toggleThreshold(v)}
                />
                {v}%
              </label>
            ))}
          </div>
        </div>

        <SectionHeader text="Alert Targets" />
        <div style={{ padding: '8px 0', fontSize: 11, color: C.textDim, lineHeight: 1.8 }}>
          {showClaudeTargets && (
            <>
              <TargetLine label="Claude 5h limit" detail="Claude usage in the current 5-hour window" />
              <TargetLine label="Claude weekly limit" detail="Claude usage in the weekly window" />
              <TargetLine label="Claude Sonnet weekly" detail="Sonnet-specific weekly usage" />
            </>
          )}
          {showCodexTargets && (
            <>
              <TargetLine label="Codex 5h limit" detail="Codex local JSONL rate-limit window" />
              <TargetLine label="Codex weekly limit" detail="Codex local JSONL weekly rate-limit window" />
            </>
          )}
          <div style={{ marginTop: 8, color: C.textMuted }}>
            Alerts follow the current tracking mode. Auto-refreshed every 60s, 1-hour cooldown per alert.
          </div>
        </div>
      </div>

      <button
        onClick={handleSave}
        style={{
          margin: '12px 16px',
          background: saved ? C.active : C.accent,
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          padding: '8px 0',
          fontSize: 13,
          cursor: 'pointer',
          fontWeight: 700,
          flexShrink: 0,
          transition: 'background 0.3s',
        }}
      >
        {saved ? 'Saved' : 'Save'}
      </button>
    </div>
  );
}
