import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AppSettings, AppState, IntegrationStatus, QuotaDisplayMode } from '../types';
import { useTheme } from '../ThemeContext';
import ViewHeader from '../components/ViewHeader';
import { DEFAULT_MAIN_SECTION_ORDER, MainSectionId, normalizeHiddenMainSections, normalizeMainSectionOrder } from '../mainSections';
import { buildQuotaTargetSettingsOptions } from '../quotaDisplayModels';
import { quotaSourceBadgeToneStyle } from '../theme';
import i18n, { getLanguagePreference, LanguagePreference, setLanguagePreference } from '../i18n';

interface Props {
  settings: AppSettings;
  providerQuotas: AppState['providerQuotas'];
  onSave: (s: Partial<AppSettings>) => void;
  onBack: () => void;
}

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
type ProviderId = AppSettings['enabledProviders'][number];

const PROVIDER_OPTIONS: Array<{ id: ProviderId; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'antigravity', label: 'Antigravity' },
];
const ACTIVE_PROVIDER_OPTIONS = PROVIDER_OPTIONS;

const EDITABLE_SETTING_KEYS: EditableSettingKey[] = [
  'enabledProviders',
  'alertThresholds',
  'currency',
  'usdToKrw',
  'globalHotkey',
  'openAtLogin',
  'alwaysOnTop',
  'enableAlerts',
  'trayDisplay',
  'mainSectionOrder',
  'hiddenMainSections',
  'hiddenProjects',
  'excludedProjects',
  'quotaTargetModes',
  'quotaTargetOrder',
  'taskbarQuotaEnabled',
  'taskbarQuotaMaxBlocks',
  'quotaTargetAbbreviations',
  'antigravityQuotaDurationPaceEnabled',
  'compactWidgetEnabled',
  'compactWidgetWaitingAnimationEnabled',
  'theme',
];

function normalizeSettingsDraft(settings: AppSettings): AppSettings {
  const mainSectionOrder = normalizeMainSectionOrder(settings.mainSectionOrder);
  return {
    ...settings,
    quotaTargetModes: settings.quotaTargetModes ?? {},
    quotaTargetOrder: settings.quotaTargetOrder ?? [],
    taskbarQuotaEnabled: settings.taskbarQuotaEnabled === true,
    taskbarQuotaMaxBlocks: Math.max(1, Math.min(3, Math.round(settings.taskbarQuotaMaxBlocks || 2))),
    quotaTargetAbbreviations: settings.quotaTargetAbbreviations ?? {},
    antigravityQuotaDurationPaceEnabled: settings.antigravityQuotaDurationPaceEnabled === true,
    mainSectionOrder,
    hiddenMainSections: normalizeHiddenMainSections(settings.hiddenMainSections, mainSectionOrder),
  };
}

function enabledProvidersFromSettings(settings: AppSettings): ProviderId[] {
  if (Array.isArray(settings.enabledProviders) && settings.enabledProviders.length > 0) {
    return ACTIVE_PROVIDER_OPTIONS
      .map(option => option.id)
      .filter(id => settings.enabledProviders.includes(id));
  }
  return ['claude', 'codex'];
}

function toggleProvider(settings: AppSettings, id: ProviderId): AppSettings {
  if (!ACTIVE_PROVIDER_OPTIONS.some(option => option.id === id)) return settings;
  const current = new Set(enabledProvidersFromSettings(settings));
  if (current.has(id)) {
    if (current.size <= 1) return settings;
    current.delete(id);
  }
  else current.add(id);
  const enabledProviders = ACTIVE_PROVIDER_OPTIONS
    .map(option => option.id)
    .filter(providerId => current.has(providerId));
  return {
    ...settings,
    enabledProviders,
  };
}

function normalizeQuotaTargetAbbreviationInput(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
}

function defaultQuotaTargetAbbreviation(provider: ProviderId, label: string): string {
  const normalizedLabel = label.trim().toLowerCase();
  if (provider === 'claude') return normalizedLabel.includes('sonnet') ? 'S' : 'C';
  if (provider === 'codex') return 'CX';
  if (provider === 'antigravity') return shortQuotaLabelCode(label, 'AG');
  return label.toUpperCase().match(/[A-Z0-9]/)?.[0] ?? '?';
}

function shortQuotaLabelCode(label: string, fallback: string): string {
  const words = label.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const initials = words.map(word => word[0]).join('');
  if (initials.length >= 2) return initials.slice(0, 3);
  const compact = words.join('');
  if (compact.length >= 2) return compact.slice(0, 3);
  return initials || compact || fallback;
}

function isTaskbarEligibleQuotaTarget(target: { taskbarEligible: boolean; rowCount: number }): boolean {
  return target.rowCount > 0 && target.taskbarEligible;
}

function settingValue(settings: AppSettings, key: EditableSettingKey): unknown {
  if (key === 'mainSectionOrder') return normalizeMainSectionOrder(settings.mainSectionOrder);
  if (key === 'hiddenMainSections') return normalizeHiddenMainSections(settings.hiddenMainSections, settings.mainSectionOrder);
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

export default function SettingsView({ settings, providerQuotas, onSave, onBack }: Props) {
  const C = useTheme();
  const { t } = useTranslation();
  const [baseSettings] = useState(() => normalizeSettingsDraft(settings));
  const [s, setS] = useState(() => normalizeSettingsDraft(settings));
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
  const [integrationMsg, setIntegrationMsg] = useState('');
  const [rebuildingLedger, setRebuildingLedger] = useState(false);
  const [ledgerMsg, setLedgerMsg] = useState('');
  const latestSettings = useMemo(() => normalizeSettingsDraft(settings), [settings]);
  const settingsToSave = useMemo(() => buildSettingsPatch(s, baseSettings, latestSettings), [s, baseSettings, latestSettings]);
  const quotaTargetOptions = useMemo(() => buildQuotaTargetSettingsOptions(s, providerQuotas), [s, providerQuotas]);

  const isDirty = useMemo(() => Object.keys(settingsToSave).length > 0, [settingsToSave]);

  const row: React.CSSProperties = useMemo(() => ({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: `1px solid ${C.border}` }), [C]);
  const labelStyle: React.CSSProperties = useMemo(() => ({ fontSize: 12, color: C.textDim }), [C]);
  const sel: React.CSSProperties = useMemo(() => ({ background: C.bgRow, color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: '3px 6px', fontSize: 12 }), [C]);
  const inp: React.CSSProperties = useMemo(() => ({ ...sel, width: 80 }), [sel]);
  const chk: React.CSSProperties = useMemo(() => ({ accentColor: C.accent }), [C]);

  const setQuotaTargetMode = (targetId: string, mode: QuotaDisplayMode) => {
    setS(current => ({
      ...current,
      quotaTargetModes: {
        ...(current.quotaTargetModes ?? {}),
        [targetId]: mode,
      },
    }));
  };

  const setQuotaTargetAbbreviation = (targetId: string, value: string) => {
    const abbreviation = normalizeQuotaTargetAbbreviationInput(value);
    setS(current => {
      const next = { ...(current.quotaTargetAbbreviations ?? {}) };
      if (abbreviation) next[targetId] = abbreviation;
      else delete next[targetId];
      return {
        ...current,
        quotaTargetAbbreviations: next,
      };
    });
  };

  function moveQuotaTarget(targetId: string, direction: -1 | 1) {
    const order = quotaTargetOptions.map(target => target.id);
    const index = order.indexOf(targetId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
    const next = [...order];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    setS(current => ({ ...current, quotaTargetOrder: next }));
  }

  useEffect(() => {
    window.wmt.getIntegrationStatus().then(setIntegrationStatus).catch(() => {});
  }, []);

  function updateIntegrationStatus(result: IntegrationStatus) {
    setIntegrationStatus({
      configured: result.configured,
      owner: result.owner,
      command: result.command,
    });
  }

  async function handleSetupIntegration() {
    setIntegrationMsg(t('settingsView.integration.settingUp'));
    try {
      const r = await window.wmt.setupIntegration();
      updateIntegrationStatus(r);
      if (r.ok) {
        setIntegrationMsg(t('settingsView.integration.setupDone'));
      } else {
        setIntegrationMsg(t('settingsView.integration.setupFailed', { error: r.error ?? 'unknown error' }));
      }
    } catch (e) {
      setIntegrationMsg(t('settingsView.integration.setupError', { error: String(e) }));
    }
    setTimeout(() => setIntegrationMsg(''), 4000);
  }

  async function handleDisableIntegration() {
    setIntegrationMsg(t('settingsView.integration.disabling'));
    try {
      const r = await window.wmt.disableIntegration();
      updateIntegrationStatus(r);
      if (r.ok) {
        setIntegrationMsg(t('settingsView.integration.disableDone'));
      } else {
        setIntegrationMsg(t('settingsView.integration.disableFailed', { error: r.error ?? 'unknown error' }));
      }
    } catch (e) {
      setIntegrationMsg(t('settingsView.integration.disableError', { error: String(e) }));
    }
    setTimeout(() => setIntegrationMsg(''), 4000);
  }

  async function handleRebuildLedger() {
    if (rebuildingLedger) return;
    setRebuildingLedger(true);
    setLedgerMsg(t('settingsView.data.rebuilding'));
    try {
      await window.wmt.rebuildLedger();
      setLedgerMsg(t('settingsView.data.rebuildComplete'));
    } catch (e) {
      setLedgerMsg(t('settingsView.data.rebuildFailed', { error: String(e) }));
    } finally {
      setRebuildingLedger(false);
      setTimeout(() => setLedgerMsg(''), 5000);
    }
  }

  function integrationLabel(status: IntegrationStatus | null): string {
    if (!status) return '';
    if (status.owner === 'wmt') return i18n.t('settingsView.integration.connected');
    if (status.owner === 'other') return i18n.t('settingsView.integration.otherStatusLine');
    return i18n.t('settingsView.integration.notConfigured');
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

  function toggleMainSectionHidden(id: MainSectionId) {
    const order = normalizeMainSectionOrder(s.mainSectionOrder);
    const hidden = normalizeHiddenMainSections(s.hiddenMainSections, order);
    const isHidden = hidden.includes(id);
    const visibleCount = order.length - hidden.length;
    if (!isHidden && visibleCount <= 1) return;
    const nextHidden = isHidden ? hidden.filter(hiddenId => hiddenId !== id) : [...hidden, id];
    setS({ ...s, hiddenMainSections: normalizeHiddenMainSections(nextHidden, order) });
  }

  const mainSectionOrder = normalizeMainSectionOrder(s.mainSectionOrder);
  const hiddenMainSections = normalizeHiddenMainSections(s.hiddenMainSections, mainSectionOrder);
  const visibleSectionCount = mainSectionOrder.length - hiddenMainSections.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
      <ViewHeader title={t('settingsView.title')} onBack={onBack} />
      <div style={{ overflowY: 'auto', flex: 1, padding: '4px 16px' }}>

        <SectionHeader label={t('settingsView.integration.heading')} />
        <div style={{ padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, color: C.text }}>{t('settingsView.integration.realtimeLabel')}</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                {t('settingsView.integration.description')}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {integrationStatus !== null && (
                <span
                  title={integrationStatus.command}
                  style={{
                    fontSize: 10,
                    color: integrationStatus.owner === 'wmt'
                      ? '#4a9a4a'
                      : (integrationStatus.owner === 'other' ? '#b7791f' : C.textMuted),
                  }}
                >
                  {integrationLabel(integrationStatus)}
                </span>
              )}
              <button
                onClick={handleSetupIntegration}
                style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
              >
                {t('settingsView.integration.setupButton')}
              </button>
              <button
                onClick={handleDisableIntegration}
                disabled={integrationStatus?.owner !== 'wmt'}
                style={{
                  background: integrationStatus?.owner === 'wmt' ? C.bgRow : C.bg,
                  color: integrationStatus?.owner === 'wmt' ? C.text : C.textMuted,
                  border: `1px solid ${C.border}`,
                  borderRadius: 4,
                  padding: '4px 10px',
                  fontSize: 11,
                  cursor: integrationStatus?.owner === 'wmt' ? 'pointer' : 'not-allowed',
                  fontWeight: 600,
                }}
              >
                {t('settingsView.integration.disableButton')}
              </button>
            </div>
          </div>
          {integrationMsg && (
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{integrationMsg}</div>
          )}
        </div>

        <SectionHeader label={t('settingsView.general.heading')} />
        <div style={row}>
          <span style={labelStyle}>{t('settingsView.general.language')}</span>
          <select
            value={getLanguagePreference()}
            onChange={e => setLanguagePreference(e.target.value as LanguagePreference)}
            style={{ ...sel, width: 140 }}
          >
            <option value="system">{t('settingsView.general.languageSystem')}</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
        </div>
        <div style={row}>
          <span style={labelStyle}>{t('settingsView.general.startWithWindows')}</span>
          <input type="checkbox" style={chk} checked={s.openAtLogin} onChange={e => setS({ ...s, openAtLogin: e.target.checked })} />
        </div>
        <div style={row}>
          <div>
            <div style={labelStyle}>{t('settingsView.general.alwaysOnTop')}</div>
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
              {t('settingsView.general.alwaysOnTopHint')}
            </div>
          </div>
          <input type="checkbox" style={chk} checked={s.alwaysOnTop} onChange={e => setS({ ...s, alwaysOnTop: e.target.checked })} />
        </div>
        <div style={row}>
          <div>
            <div style={labelStyle}>{t('settingsView.general.floatingWidget')}</div>
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
              {t('settingsView.general.floatingWidgetHint')}
            </div>
          </div>
          <input type="checkbox" style={chk} checked={s.compactWidgetEnabled} onChange={e => setS({ ...s, compactWidgetEnabled: e.target.checked })} />
        </div>
        <div style={row}>
          <div>
            <div style={labelStyle}>{t('settingsView.general.taskbarQuota')}</div>
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
              {t('settingsView.general.taskbarQuotaHint')}
            </div>
          </div>
          <input type="checkbox" style={chk} checked={s.taskbarQuotaEnabled} onChange={e => setS({ ...s, taskbarQuotaEnabled: e.target.checked })} />
        </div>
        {s.taskbarQuotaEnabled && (
          <div style={row}>
            <div>
              <div style={labelStyle}>{t('settingsView.general.taskbarMaxBlocks')}</div>
              <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
                {t('settingsView.general.taskbarMaxBlocksHint')}
              </div>
            </div>
            <select
              style={sel}
              value={s.taskbarQuotaMaxBlocks}
              onChange={e => setS({ ...s, taskbarQuotaMaxBlocks: Number(e.target.value) })}
            >
              <option value={1}>{t('settingsView.general.blocksOption', { count: 1 })}</option>
              <option value={2}>{t('settingsView.general.blocksOption', { count: 2 })}</option>
              <option value={3}>{t('settingsView.general.blocksOption', { count: 3 })}</option>
            </select>
          </div>
        )}
        <div style={row}>
          <div>
            <div style={labelStyle}>{t('settingsView.general.waitingAnimation')}</div>
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
              {t('settingsView.general.waitingAnimationHint')}
            </div>
          </div>
          <input type="checkbox" style={chk} checked={s.compactWidgetWaitingAnimationEnabled} onChange={e => setS({ ...s, compactWidgetWaitingAnimationEnabled: e.target.checked })} />
        </div>
        <div style={row}>
          <span style={labelStyle}>{t('settingsView.general.globalShortcut')}</span>
          <input
            readOnly
            aria-label={t('settingsView.general.globalShortcut')}
            title={t('settingsView.general.globalShortcutTitle')}
            placeholder={recordingHotkey ? t('settingsView.general.pressShortcut') : t('settingsView.general.clickToRecord')}
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
              {t('settingsView.general.shortcutHint')}
            </span>
          )}
        </div>

        <SectionHeader label={t('settingsView.providers.heading')} />
        <div style={{ padding: '7px 0', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: 'grid', gap: 6 }}>
            {PROVIDER_OPTIONS.map(option => {
              const enabledProviders = enabledProvidersFromSettings(s);
              const checked = enabledProviders.includes(option.id);
              const lockedLastProvider = checked && enabledProviders.length <= 1;
              const disabled = lockedLastProvider;
              const title = lockedLastProvider ? t('settingsView.providers.atLeastOneProvider') : undefined;
              return (
                <label
                  key={option.id}
                  title={title}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <span style={labelStyle}>{option.label}</span>
                    {option.id === 'antigravity' && (
                      <span style={{ fontSize: 10, color: C.textMuted }}>
                        {t('settingsView.providers.antigravityDetail')}
                      </span>
                    )}
                    {lockedLastProvider && (
                      <span style={{ fontSize: 10, color: C.textMuted }}>
                        {title}
                      </span>
                    )}
                  </span>
                  <input
                    type="checkbox"
                    style={chk}
                    checked={checked}
                    disabled={disabled}
                    title={title}
                    onChange={() => setS(toggleProvider(s, option.id))}
                  />
                </label>
              );
            })}
          </div>
        </div>
        {enabledProvidersFromSettings(s).includes('antigravity') && (
          <div style={row}>
            <div>
              <div style={labelStyle}>{t('settingsView.providers.antigravityPace')}</div>
              <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
                {t('settingsView.providers.antigravityPaceHint')}
              </div>
            </div>
            <input
              type="checkbox"
              style={chk}
              checked={s.antigravityQuotaDurationPaceEnabled}
              onChange={e => setS({ ...s, antigravityQuotaDurationPaceEnabled: e.target.checked })}
            />
          </div>
        )}
        {quotaTargetOptions.length > 0 && (
          <div style={{ padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ ...labelStyle, marginBottom: 6 }}>{t('settingsView.quotaDisplay.heading')}</div>
            {s.taskbarQuotaEnabled && (
              <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 7 }}>
                {t('settingsView.quotaDisplay.hint')}
              </div>
            )}
            <div style={{ display: 'grid', gap: 6 }}>
              {quotaTargetOptions.map((target, index) => (
                <div key={target.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: C.textDim, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {target.label}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, marginTop: 2 }}>
                      <span style={{ fontSize: 9, color: C.textMuted, fontFamily: C.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {target.period || t('settingsView.quotaDisplay.rowsFallback', { count: target.rowCount })}
                      </span>
                      <span style={{ fontSize: 9, color: C.textMuted, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}>
                        {target.defaultMode}
                      </span>
                      {target.badges.slice(0, 3).map(badge => (
                        <span
                          key={badge.key}
                          title={badge.title}
                          style={{
                            ...quotaSourceBadgeToneStyle(badge.tone, C),
                            borderRadius: 3,
                            padding: '1px 3px',
                            fontSize: 8,
                            fontWeight: 700,
                            fontFamily: C.fontMono,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {badge.label}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    {s.taskbarQuotaEnabled && isTaskbarEligibleQuotaTarget(target) && (
                      <input
                        aria-label={t('settingsView.quotaDisplay.abbreviationLabel', { label: target.label })}
                        title={t('settingsView.quotaDisplay.abbreviationTitle', { abbrev: defaultQuotaTargetAbbreviation(target.provider, target.label) })}
                        placeholder={defaultQuotaTargetAbbreviation(target.provider, target.label)}
                        value={s.quotaTargetAbbreviations?.[target.id] ?? ''}
                        onChange={e => setQuotaTargetAbbreviation(target.id, e.target.value)}
                        style={{ ...inp, width: 42, textTransform: 'uppercase', textAlign: 'center', fontFamily: C.fontMono }}
                      />
                    )}
                    <div style={{ display: 'flex', gap: 2 }}>
                      {(['rich', 'simple', 'none'] as const).map(mode => {
                        const active = target.mode === mode;
                        const label = mode === 'rich' ? t('settingsView.quotaDisplay.modeRich') : mode === 'simple' ? t('settingsView.quotaDisplay.modeSimple') : t('settingsView.quotaDisplay.modeNone');
                        return (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setQuotaTargetMode(target.id, mode)}
                            style={{
                              padding: '3px 7px',
                              minWidth: 42,
                              fontSize: 10,
                              border: `1px solid ${active ? C.accent + '88' : C.border}`,
                              borderRadius: 4,
                              cursor: 'pointer',
                              fontWeight: active ? 700 : 400,
                              background: active ? C.accent + '22' : 'transparent',
                              color: active ? C.accent : C.textDim,
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <div style={{ display: 'flex', gap: 2 }}>
                      <button
                        type="button"
                        title={t('settingsView.quotaDisplay.moveUp')}
                        disabled={index === 0}
                        onClick={() => moveQuotaTarget(target.id, -1)}
                        style={{
                          background: C.bgRow,
                          border: `1px solid ${C.border}`,
                          color: index === 0 ? C.textMuted : C.textDim,
                          opacity: index === 0 ? 0.45 : 1,
                          cursor: index === 0 ? 'default' : 'pointer',
                          borderRadius: 4,
                          width: 24,
                          height: 22,
                          fontSize: 11,
                          lineHeight: 1,
                        }}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        title={t('settingsView.quotaDisplay.moveDown')}
                        disabled={index === quotaTargetOptions.length - 1}
                        onClick={() => moveQuotaTarget(target.id, 1)}
                        style={{
                          background: C.bgRow,
                          border: `1px solid ${C.border}`,
                          color: index === quotaTargetOptions.length - 1 ? C.textMuted : C.textDim,
                          opacity: index === quotaTargetOptions.length - 1 ? 0.45 : 1,
                          cursor: index === quotaTargetOptions.length - 1 ? 'default' : 'pointer',
                          borderRadius: 4,
                          width: 24,
                          height: 22,
                          fontSize: 11,
                          lineHeight: 1,
                        }}
                      >
                        ▼
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setS({ ...s, quotaTargetOrder: [] })}
              style={{ marginTop: 6, background: 'none', border: `1px solid ${C.border}`, color: C.textMuted, cursor: 'pointer', fontSize: 11, padding: '3px 8px', borderRadius: 4 }}
            >
              {t('settingsView.quotaDisplay.resetOrder')}
            </button>
          </div>
        )}

        <SectionHeader label={t('settingsView.data.heading')} />
        <div style={row}>
          <div>
            <div style={labelStyle}>{t('settingsView.data.usageLedger')}</div>
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
              {t('settingsView.data.usageLedgerHint')}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0, justifyContent: 'flex-end' }}>
            {ledgerMsg && <span title={ledgerMsg} style={{ fontSize: 10, color: C.textMuted, minWidth: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ledgerMsg}</span>}
            <button
              type="button"
              disabled={rebuildingLedger}
              onClick={handleRebuildLedger}
              style={{
                background: rebuildingLedger ? C.bgRow : C.accent,
                color: rebuildingLedger ? C.textMuted : '#fff',
                border: `1px solid ${rebuildingLedger ? C.border : C.accent}`,
                borderRadius: 4,
                padding: '4px 10px',
                fontSize: 11,
                cursor: rebuildingLedger ? 'wait' : 'pointer',
                fontWeight: 600,
              }}
            >
              {t('settingsView.data.rebuildButton')}
            </button>
          </div>
        </div>

        <SectionHeader label={t('settingsView.currency.heading')} />
        <div style={row}>
          <span style={labelStyle}>{t('settingsView.currency.label')}</span>
          <select style={sel} value={s.currency} onChange={e => setS({ ...s, currency: e.target.value as 'USD' | 'KRW' })}>
            <option value="USD">{t('settingsView.currency.usd')}</option>
            <option value="KRW">{t('settingsView.currency.krw')}</option>
          </select>
        </div>
        {s.currency === 'KRW' && (
          <div style={row}>
            <span style={labelStyle}>{t('settingsView.currency.exchangeRate')}</span>
            <input style={inp} type="number" value={s.usdToKrw} onChange={e => setS({ ...s, usdToKrw: Number(e.target.value) })} />
          </div>
        )}

        <SectionHeader label={t('settingsView.tray.heading')} />
        <div style={row}>
          <span style={labelStyle}>{t('settingsView.tray.label')}</span>
          <select style={sel} value={s.trayDisplay ?? 'h5pct'} onChange={e => setS({ ...s, trayDisplay: e.target.value as AppSettings['trayDisplay'] })}>
            <option value="none">{t('settingsView.tray.none')}</option>
            <option value="h5pct">{t('settingsView.tray.h5pct')}</option>
            <option value="tokens">{t('settingsView.tray.tokens')}</option>
            <option value="cost">{t('settingsView.tray.cost')}</option>
          </select>
        </div>

        <SectionHeader label={t('settingsView.mainLayout.heading')} />
        <div style={{ padding: '7px 0', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: 'grid', gap: 4 }}>
            {mainSectionOrder.map((id, index) => (
              <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '5px 0' }}>
                <span style={{ fontSize: 12, color: hiddenMainSections.includes(id) ? C.textMuted : C.textDim, minWidth: 0 }}>{t(`common.mainSections.${id}`)}</span>
                <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    title={hiddenMainSections.includes(id) ? t('settingsView.mainLayout.showCardTitle') : t('settingsView.mainLayout.hideCardTitle')}
                    disabled={!hiddenMainSections.includes(id) && visibleSectionCount <= 1}
                    onClick={() => toggleMainSectionHidden(id)}
                    style={{
                      background: hiddenMainSections.includes(id) ? `${C.accent}22` : C.bgRow,
                      border: `1px solid ${hiddenMainSections.includes(id) ? C.accent + '55' : C.border}`,
                      color: hiddenMainSections.includes(id) ? C.accent : (!hiddenMainSections.includes(id) && visibleSectionCount <= 1 ? C.textMuted : C.textDim),
                      opacity: !hiddenMainSections.includes(id) && visibleSectionCount <= 1 ? 0.45 : 1,
                      cursor: !hiddenMainSections.includes(id) && visibleSectionCount <= 1 ? 'default' : 'pointer',
                      borderRadius: 4,
                      width: 42,
                      height: 22,
                      fontSize: 11,
                      fontFamily: C.fontMono,
                    }}
                  >
                    {hiddenMainSections.includes(id) ? t('settingsView.mainLayout.show') : t('settingsView.mainLayout.hide')}
                  </button>
                  <button
                    type="button"
                    title={t('settingsView.mainLayout.moveUp')}
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
                    title={t('settingsView.mainLayout.moveDown')}
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
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              type="button"
              onClick={() => setS({ ...s, mainSectionOrder: DEFAULT_MAIN_SECTION_ORDER })}
              style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textMuted, cursor: 'pointer', fontSize: 11, padding: '3px 8px', borderRadius: 4 }}
            >
              {t('settingsView.mainLayout.resetOrder')}
            </button>
            <button
              type="button"
              onClick={() => setS({ ...s, hiddenMainSections: [] })}
              style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textMuted, cursor: 'pointer', fontSize: 11, padding: '3px 8px', borderRadius: 4 }}
            >
              {t('settingsView.mainLayout.showAll')}
            </button>
          </div>
        </div>

        <SectionHeader label={t('settingsView.appearance.heading')} />
        <div style={row}>
          <span style={labelStyle}>{t('settingsView.appearance.theme')}</span>
          <div style={{ display: 'flex', gap: 2 }}>
            {(['auto', 'light', 'dark'] as const).map(themeOption => (
              <button key={themeOption} onClick={() => setS({ ...s, theme: themeOption })} style={{
                padding: '3px 10px', fontSize: 11, border: `1px solid ${(s.theme ?? 'auto') === themeOption ? C.accent + '88' : C.border}`,
                borderRadius: 4, cursor: 'pointer', fontWeight: (s.theme ?? 'auto') === themeOption ? 700 : 400,
                background: (s.theme ?? 'auto') === themeOption ? C.accent + '22' : 'transparent',
                color: (s.theme ?? 'auto') === themeOption ? C.accent : C.textDim,
              }}>
                {themeOption === 'auto' ? t('settingsView.appearance.auto') : themeOption === 'light' ? t('settingsView.appearance.light') : t('settingsView.appearance.dark')}
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
        {t('settingsView.save')}
      </button>
    </div>
  );
}
