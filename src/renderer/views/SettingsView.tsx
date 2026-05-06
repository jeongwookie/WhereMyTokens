import React, { useState, useEffect, useMemo } from 'react';
import { AppSettings } from '../types';
import { useTheme } from '../ThemeContext';
import ViewHeader from '../components/ViewHeader';
import { DEFAULT_MAIN_SECTION_ORDER, MAIN_SECTION_LABELS, MainSectionId, normalizeMainSectionOrder } from '../mainSections';

interface Props { settings: AppSettings; onSave: (s: Partial<AppSettings>) => void; onBack: () => void; }

const KEY_NAME_BY_CODE: Record<string, string> = {
  Backspace: 'Backspace',
  Delete: 'Delete',
  End: 'End',
  Enter: 'Return',
  Escape: 'Escape',
  Home: 'Home',
  Insert: 'Insert',
  Minus: '-',
  PageDown: 'PageDown',
  PageUp: 'PageUp',
  Space: 'Space',
  Tab: 'Tab',
};

const KEY_NAME_BY_KEY: Record<string, string> = {
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
};

function keyNameFromEvent(event: React.KeyboardEvent<HTMLInputElement>): string | null {
  const { code, key } = event;
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (KEY_NAME_BY_CODE[code]) return KEY_NAME_BY_CODE[code];
  if (KEY_NAME_BY_KEY[key]) return KEY_NAME_BY_KEY[key];
  if (key.length === 1 && /^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  return null;
}

function formatShortcutDisplay(accelerator: string): string {
  if (!accelerator) return '';
  return accelerator.replace(/CommandOrControl/g, 'Ctrl');
}

function shortcutFromEvent(event: React.KeyboardEvent<HTMLInputElement>): string | null {
  const key = keyNameFromEvent(event);
  if (!key || ['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null;

  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push('CommandOrControl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');

  const hasSafePair = modifiers.includes('CommandOrControl')
    && (modifiers.includes('Shift') || modifiers.includes('Alt'));
  if (!hasSafePair) return null;
  return [...modifiers, key].join('+');
}

type EditableSettingKey = Exclude<keyof AppSettings, 'compactWidgetBounds'>;

const EDITABLE_SETTING_KEYS: EditableSettingKey[] = [
  'usageLimits',
  'provider',
  'alertThresholds',
  'currency',
  'usdToKrw',
  'plan',
  'globalHotkey',
  'openAtLogin',
  'alwaysOnTop',
  'enableAlerts',
  'trayDisplay',
  'mainSectionOrder',
  'hiddenProjects',
  'excludedProjects',
  'compactWidgetEnabled',
  'theme',
];

function normalizeSettingsDraft(settings: AppSettings): AppSettings {
  return { ...settings, mainSectionOrder: normalizeMainSectionOrder(settings.mainSectionOrder) };
}

function settingValue(settings: AppSettings, key: EditableSettingKey): unknown {
  if (key === 'mainSectionOrder') return normalizeMainSectionOrder(settings.mainSectionOrder);
  return settings[key];
}

function sameSettingValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildSettingsPatch(current: AppSettings, base: AppSettings, latest: AppSettings): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {};
  for (const key of EDITABLE_SETTING_KEYS) {
    const currentValue = settingValue(current, key);
    if (sameSettingValue(currentValue, settingValue(base, key))) continue;
    if (sameSettingValue(currentValue, settingValue(latest, key))) continue;
    (patch as Record<EditableSettingKey, unknown>)[key] = currentValue;
  }
  return patch;
}

export default function SettingsView({ settings, onSave, onBack }: Props) {
  const C = useTheme();
  const [baseSettings] = useState(() => normalizeSettingsDraft(settings));
  const [s, setS] = useState(() => normalizeSettingsDraft(settings));
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const [integrationConfigured, setIntegrationConfigured] = useState<boolean | null>(null);
  const [integrationMsg, setIntegrationMsg] = useState('');
  const latestSettings = useMemo(() => normalizeSettingsDraft(settings), [settings]);
  const settingsToSave = useMemo(() => buildSettingsPatch(s, baseSettings, latestSettings), [s, baseSettings, latestSettings]);

  const isDirty = useMemo(() => Object.keys(settingsToSave).length > 0, [settingsToSave]);

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
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, padding: '10px 0 4px', borderBottom: `1px solid ${C.border}` }}>
        {label}
      </div>
    );
  }

  function handleHotkeyKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      setRecordingHotkey(false);
      event.currentTarget.blur();
      return;
    }

    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      setS({ ...s, globalHotkey: '' });
      setRecordingHotkey(false);
      event.currentTarget.blur();
      return;
    }

    const nextHotkey = shortcutFromEvent(event);
    if (!nextHotkey) return;
    setS({ ...s, globalHotkey: nextHotkey });
    setRecordingHotkey(false);
    event.currentTarget.blur();
  }

  function moveMainSection(id: MainSectionId, direction: -1 | 1) {
    const order = normalizeMainSectionOrder(s.mainSectionOrder);
    const index = order.indexOf(id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
    const next = [...order];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    setS({ ...s, mainSectionOrder: next });
  }

  const mainSectionOrder = normalizeMainSectionOrder(s.mainSectionOrder);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
      <ViewHeader title="Settings" onBack={onBack} />
      <div style={{ overflowY: 'auto', flex: 1, padding: '4px 16px' }}>

        <SectionHeader label="Claude Code Integration" />
        <div style={{ padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, color: C.text }}>Real-time data via statusLine</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                Registers WhereMyTokens as a Claude Code plugin for live rate limits
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {integrationConfigured !== null && (
                <span style={{ fontSize: 10, color: integrationConfigured ? '#4a9a4a' : C.textMuted }}>
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
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{integrationMsg}</div>
          )}
        </div>

        <SectionHeader label="General" />
        <div style={row}>
          <span style={labelStyle}>Start with Windows</span>
          <input type="checkbox" style={chk} checked={s.openAtLogin} onChange={e => setS({ ...s, openAtLogin: e.target.checked })} />
        </div>
        <div style={row}>
          <div>
            <div style={labelStyle}>Dashboard always on top</div>
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
              Applies to the dashboard only
            </div>
          </div>
          <input type="checkbox" style={chk} checked={s.alwaysOnTop} onChange={e => setS({ ...s, alwaysOnTop: e.target.checked })} />
        </div>
        <div style={row}>
          <div>
            <div style={labelStyle}>Floating usage widget</div>
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
              Always stays on top; shows quota pace at a glance
            </div>
          </div>
          <input type="checkbox" style={chk} checked={s.compactWidgetEnabled} onChange={e => setS({ ...s, compactWidgetEnabled: e.target.checked })} />
        </div>
        <div style={row}>
          <span style={labelStyle}>Global shortcut</span>
          <input
            readOnly
            aria-label="Global shortcut"
            title="Click, then press a shortcut. Esc cancels, Backspace clears."
            placeholder={recordingHotkey ? 'Press shortcut...' : 'Click to record'}
            style={{
              ...inp,
              width: 176,
              cursor: 'pointer',
              borderColor: recordingHotkey ? C.accent : C.border,
              color: recordingHotkey ? C.accent : C.text,
              outline: recordingHotkey ? `1px solid ${C.accent}55` : 'none',
            }}
            value={recordingHotkey ? '' : formatShortcutDisplay(s.globalHotkey)}
            onFocus={() => setRecordingHotkey(true)}
            onClick={() => setRecordingHotkey(true)}
            onBlur={() => setRecordingHotkey(false)}
            onKeyDown={handleHotkeyKeyDown}
          />
          {recordingHotkey && (
            <span style={{ fontSize: 10, color: C.textMuted, marginLeft: 8 }}>
              Use Ctrl+Shift or Ctrl+Alt
            </span>
          )}
        </div>

        <SectionHeader label="Tracking" />
        <div style={row}>
          <span style={labelStyle}>Provider</span>
          <div style={{ display: 'flex', gap: 2 }}>
            {([
              ['both', 'Claude + Codex'],
              ['claude', 'Claude'],
              ['codex', 'Codex'],
            ] as Array<[AppSettings['provider'], string]>).map(([value, label]) => (
              <button key={value} onClick={() => setS({ ...s, provider: value })} style={{
                padding: '3px 8px', fontSize: 11, border: `1px solid ${(s.provider ?? 'both') === value ? C.accent + '88' : C.border}`,
                borderRadius: 4, cursor: 'pointer', fontWeight: (s.provider ?? 'both') === value ? 700 : 400,
                background: (s.provider ?? 'both') === value ? C.accent + '22' : 'transparent',
                color: (s.provider ?? 'both') === value ? C.accent : C.textDim,
              }}>
                {label}
              </button>
            ))}
          </div>
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

        <SectionHeader label="Main Layout" />
        <div style={{ padding: '7px 0', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: 'grid', gap: 4 }}>
            {mainSectionOrder.map((id, index) => (
              <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '5px 0' }}>
                <span style={{ fontSize: 12, color: C.textDim, minWidth: 0 }}>{MAIN_SECTION_LABELS[id]}</span>
                <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    title="Move up"
                    disabled={index === 0}
                    onClick={() => moveMainSection(id, -1)}
                    style={{
                      background: C.bgRow,
                      border: `1px solid ${C.border}`,
                      color: index === 0 ? C.textMuted : C.textDim,
                      opacity: index === 0 ? 0.45 : 1,
                      cursor: index === 0 ? 'default' : 'pointer',
                      borderRadius: 4,
                      width: 26,
                      height: 22,
                      fontSize: 12,
                    }}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    disabled={index === mainSectionOrder.length - 1}
                    onClick={() => moveMainSection(id, 1)}
                    style={{
                      background: C.bgRow,
                      border: `1px solid ${C.border}`,
                      color: index === mainSectionOrder.length - 1 ? C.textMuted : C.textDim,
                      opacity: index === mainSectionOrder.length - 1 ? 0.45 : 1,
                      cursor: index === mainSectionOrder.length - 1 ? 'default' : 'pointer',
                      borderRadius: 4,
                      width: 26,
                      height: 22,
                      fontSize: 12,
                    }}
                  >
                    ▼
                  </button>
                </span>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setS({ ...s, mainSectionOrder: DEFAULT_MAIN_SECTION_ORDER })}
            style={{ marginTop: 6, background: 'none', border: `1px solid ${C.border}`, color: C.textMuted, cursor: 'pointer', fontSize: 11, padding: '3px 8px', borderRadius: 4 }}
          >
            Reset order
          </button>
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
        disabled={!isDirty}
        onClick={() => {
          if (!isDirty) return;
          onSave(settingsToSave);
          onBack();
        }}
        style={{ margin: '12px 16px', background: C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '8px 0', fontSize: 13, cursor: isDirty ? 'pointer' : 'default', fontWeight: 700, flexShrink: 0, opacity: isDirty ? 1 : 0.4, pointerEvents: isDirty ? 'auto' : 'none' }}
      >
        Save
      </button>
    </div>
  );
}
