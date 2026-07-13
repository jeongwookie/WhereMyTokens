import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, X } from 'lucide-react';
import { AppState, ProviderId, ProviderQuotaDisplayBadge, ProviderQuotaSnapshot, ProviderQuotaStatus, ProviderQuotaWindow } from '../types';
import { useTheme } from '../ThemeContext';
import { hasLimitData, limitDataState, limitSourceDisplay, LimitWindow, providerDisplayName } from '../limitDisplay';
import { buildQuotaDisplayModels, QuotaDisplayGroupViewModel, QuotaDisplayRowViewModel } from '../quotaDisplayModels';
import { quotaPctBarColor, quotaSourceBadgeToneStyle } from '../theme';
// This module mixes plain (non-React) builder functions with React components. The plain
// functions below (formatRefreshAge, formatRefreshLabel, missingLimitStatus, providerHealth,
// buildWidgetAgents) cannot call the useTranslation() hook, so — following the same pattern
// as limitDisplay.ts — they use the i18next singleton's `.t()` directly. Callers that memoize
// results built from them (agents/healthItems below) include i18n.language in their deps.
import i18n from '../i18n';

interface Props {
  state: AppState;
  onRefresh: () => Promise<void>;
}

type WidgetAgent = {
  key: string;
  provider: ProviderId;
  label: string;
  color: string;
  badges: ProviderQuotaDisplayBadge[];
  scanning?: boolean;
  scanningTitle?: string;
  rows: Array<{
    key: string;
    label: string;
    visualKind: QuotaDisplayRowViewModel['visualKind'];
    quotaPct: number;
    resetMs: number | null;
    durationMs?: number;
    pending?: boolean;
    pendingTitle?: string;
    unknown?: boolean;
    unknownLabel?: string;
    unknownBadge?: string;
    unknownTitle?: string;
  }>;
};

const EMPTY_QUOTA_WINDOW: ProviderQuotaWindow = { pct: 0, resetMs: null };

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
};

type HealthTone = 'good' | 'neutral' | 'warning' | 'danger';

interface HealthItem {
  key: string;
  label: string;
  tone: HealthTone;
  title: string;
}

function formatRefreshAge(lastUpdated: number): string {
  if (!lastUpdated) return i18n.t('compactWidgetView.refresh.default');
  const elapsed = Math.round((Date.now() - lastUpdated) / 1000);
  if (elapsed < 60) return i18n.t('compactWidgetView.refresh.now');
  if (elapsed < 3600) return i18n.t('compactWidgetView.refresh.ageMinutes', { n: Math.floor(elapsed / 60) });
  return i18n.t('compactWidgetView.refresh.ageHours', { n: Math.floor(elapsed / 3600) });
}

function formatRefreshLabel(lastUpdated: number, stateFreshness: AppState['stateFreshness']): string {
  const age = formatRefreshAge(lastUpdated);
  if (stateFreshness === 'restored' && lastUpdated) return i18n.t('compactWidgetView.refresh.lastRun', { age });
  return age;
}

function formatPct(pct: number | null): string {
  if (pct == null) return '--';
  if (pct <= 0) return '0%';
  if (pct < 1) return '<1%';
  if (pct < 10) return `${Math.round(pct * 10) / 10}%`;
  return `${Math.round(pct)}%`;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function timeElapsedPct(durationMs: number | null | undefined, resetMs: number | null): number | null {
  if (!durationMs || resetMs == null || resetMs < 0 || resetMs > durationMs) return null;
  return clampPct(((durationMs - resetMs) / durationMs) * 100);
}

function formatResetShort(resetMs: number | null): string {
  if (resetMs == null || resetMs <= 0) return '--';
  if (resetMs > 4 * 24 * 3600 * 1000) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.now() + resetMs).getDay()];
  }
  const totalMinutes = Math.max(1, Math.round(resetMs / 60000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 10 || minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[data-no-drag="true"]');
}

function missingLimitStatus(
  pct: number,
  resetMs: number | null,
  bootPending: boolean,
  unavailableTitle: string,
  windowLabel: string,
  resetLabel: string | undefined,
): Pick<WidgetAgent['rows'][number], 'unknown' | 'unknownLabel' | 'unknownBadge' | 'unknownTitle'> {
  if (bootPending) {
    return {
      unknown: true,
      // NOTE: 'loading' here is an internal state-discriminator code (compared via
      // `unknownLabel === 'loading'` in ProgressRow and `row.unknownLabel === 'waiting'`
      // in CompactWidgetView) — it is never rendered as text, so it must stay untranslated.
      unknownLabel: 'loading',
      unknownBadge: i18n.t('compactWidgetView.status.waitBadge'),
      unknownTitle: i18n.t('compactWidgetView.tooltip.startupLoading'),
    };
  }
  if (pct <= 0 && resetMs == null) {
    // The provider explicitly reported "no data for this window" (e.g. Codex has no active
    // 5h limit for this account/plan) rather than "haven't heard back yet" — show it as a
    // static, known state instead of the perpetually-animated waiting dots, which otherwise
    // looks identical to "still loading" and never resolves.
    if (resetLabel) {
      return {
        unknown: true,
        // Not 'loading' or 'waiting' — see the ProgressRow visualState mapping below.
        unknownLabel: 'unavailable',
        unknownBadge: '--',
        unknownTitle: resetLabel,
      };
    }
    return {
      unknown: true,
      // Same as above: internal code, not displayed text — keep untranslated.
      unknownLabel: 'waiting',
      unknownBadge: '',
      unknownTitle: windowLabel === '5h'
        ? i18n.t('compactWidgetView.tooltip.noFiveHourData')
        : unavailableTitle,
    };
  }
  return {};
}

function hasSimpleQuotaInput(window: ProviderQuotaWindow | undefined): boolean {
  return !!window && (hasLimitData(window) || !!window.source);
}

function MiniLimitStatus({ state, animate = true }: { state: 'syncing' | 'waiting'; animate?: boolean }) {
  const C = useTheme();
  const { t } = useTranslation();
  const label = state === 'syncing' ? t('compactWidgetView.status.syncing') : t('compactWidgetView.status.waiting');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, color: state === 'syncing' ? C.accent : C.textDim }}>
      <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
        {[0, 1, 2].map(index => (
          <span
            key={index}
            className="wmt-sync-dot"
            style={{
              width: 3,
              height: 3,
              background: state === 'syncing' ? C.accent : C.textMuted,
              animation: animate ? undefined : 'none',
              animationDelay: animate ? `${index * 0.16}s` : undefined,
              opacity: animate ? undefined : 0.55,
              transform: animate ? undefined : 'scale(0.85)',
            }}
          />
        ))}
      </span>
      <span>{label}</span>
    </span>
  );
}

function healthLabelForSource(limit: LimitWindow): string | null {
  return limitSourceDisplay(limit).label ?? null;
}

function quotaStatusTone(status: ProviderQuotaStatus | undefined): HealthTone {
  if (status?.severity === 'warning') return 'warning';
  if (status?.severity === 'danger') return 'danger';
  const text = `${status?.code ?? ''} ${status?.label ?? ''}`.toLowerCase();
  if (/\b(rate|refresh|timeout|local|partial|limited)\b/.test(text)) return 'warning';
  if (/\b(auth|forbidden|login|schema|disconnect|offline|failed|error|unauthorized)\b/.test(text)) return 'danger';
  return 'neutral';
}

function providerLabelFromQuota(provider: ProviderId): string {
  return providerDisplayName(provider);
}

function modelQuotaWindows(quota: ProviderQuotaSnapshot | undefined): ProviderQuotaWindow[] {
  return (quota?.models ?? [])
    .filter(model => Number.isFinite(model.remainingPct))
    .map(model => ({
      pct: clampPct(100 - model.remainingPct),
      resetMs: model.resetMs ?? null,
      source: quota?.source,
    }));
}

function providerHealth(
  provider: ProviderId,
  providerLabel: string,
  primary: LimitWindow,
  secondary: LimitWindow,
  syncing: boolean,
  statusLabel?: string,
  connected = true,
  statusTone: HealthTone = 'neutral',
): HealthItem {
  if (syncing || limitDataState(primary, syncing) === 'syncing' || limitDataState(secondary, syncing) === 'syncing') {
    return {
      key: provider,
      label: i18n.t('compactWidgetView.health.syncing.label', { provider: providerLabel }),
      tone: 'good',
      title: i18n.t('compactWidgetView.health.syncing.title', { provider: providerLabel }),
    };
  }

  if (statusLabel && !connected) {
    return {
      key: provider,
      label: i18n.t('compactWidgetView.health.statusLabel.label', { provider: providerLabel, statusLabel }),
      tone: statusTone === 'neutral' ? 'danger' : statusTone,
      title: i18n.t('compactWidgetView.health.statusLabel.title', { provider: providerLabel, statusLabel }),
    };
  }

  if (!connected) {
    return {
      key: provider,
      label: i18n.t('compactWidgetView.health.offline.label', { provider: providerLabel }),
      tone: 'danger',
      title: i18n.t('compactWidgetView.health.offline.title', { provider: providerLabel }),
    };
  }

  const sources = [healthLabelForSource(primary), healthLabelForSource(secondary)].filter((label): label is string => !!label);
  if (sources.includes('Log')) {
    return {
      key: provider,
      label: i18n.t('compactWidgetView.health.log.label', { provider: providerLabel }),
      tone: 'warning',
      title: i18n.t('compactWidgetView.health.log.title', { provider: providerLabel }),
    };
  }
  if (sources.includes('Cache')) {
    return {
      key: provider,
      label: i18n.t('compactWidgetView.health.cache.label', { provider: providerLabel }),
      tone: 'neutral',
      title: i18n.t('compactWidgetView.health.cache.title', { provider: providerLabel }),
    };
  }
  if (sources.includes('Bridge')) {
    return {
      key: provider,
      label: i18n.t('compactWidgetView.health.bridge.label', { provider: providerLabel }),
      tone: 'neutral',
      title: i18n.t('compactWidgetView.health.bridge.title', { provider: providerLabel }),
    };
  }

  if (!hasLimitData(primary) && !hasLimitData(secondary)) {
    return {
      key: provider,
      label: i18n.t('compactWidgetView.health.waiting.label', { provider: providerLabel }),
      tone: 'neutral',
      title: i18n.t('compactWidgetView.health.waiting.title', { provider: providerLabel }),
    };
  }

  return {
    key: provider,
    label: i18n.t('compactWidgetView.health.ok.label', { provider: providerLabel }),
    tone: 'good',
    title: i18n.t('compactWidgetView.health.ok.title', { provider: providerLabel }),
  };
}

function buildWidgetAgents(state: AppState): WidgetAgent[] {
  const { widgetGroups } = buildQuotaDisplayModels({
    usage: state.usage,
    providerQuotas: state.providerQuotas,
    settings: state.settings,
    historyWarmupPending: state.historyWarmupPending,
    historyWarmupStartsAt: state.historyWarmupStartsAt,
    formatWarmupEta: () => 'syncing',
    simpleIncludesRich: true,
  });
  const bootPending = !state.initialRefreshComplete;
  return widgetGroups.map((group: QuotaDisplayGroupViewModel) => {
    const unavailableTitle = i18n.t('compactWidgetView.tooltip.groupUnavailable', { group: group.label });
    const rowFor = (row: QuotaDisplayRowViewModel) => {
      return {
        key: row.key,
        label: row.label,
        visualKind: row.visualKind,
        quotaPct: row.quotaPct,
        resetMs: row.resetMs,
        durationMs: row.durationMs,
        pending: row.pending,
        pendingTitle: row.pendingTitle,
        ...(!row.pending && row.visualKind === 'pace' ? missingLimitStatus(row.quotaPct, row.resetMs, bootPending, unavailableTitle, row.label, row.resetLabel) : {}),
      };
    };
    const rows: WidgetAgent['rows'] = group.rows.map(rowFor);
    const scanning = rows.some(row => row.pending);
    return {
      key: group.id,
      provider: group.provider,
      label: group.label,
      color: group.accentColor,
      badges: group.badges,
      scanning,
      scanningTitle: group.rows.find(row => row.pending)?.pendingTitle,
      rows,
    };
  });
}

function buildHealthItems(state: AppState): HealthItem[] {
  const items: HealthItem[] = [];
  for (const provider of state.settings.enabledProviders) {
    const providerLabel = providerLabelFromQuota(provider);
    const quota = state.providerQuotas[provider];
    const windows = [...Object.values(quota?.windows ?? {}), ...modelQuotaWindows(quota)];
    const primary = windows[0] ?? EMPTY_QUOTA_WINDOW;
    const secondary = windows[1] ?? EMPTY_QUOTA_WINDOW;
    const syncing = state.historyWarmupPending && windows.some(window => window.source === 'localLog' || !hasLimitData(window));
    const statusLabel = quota?.status?.label;
    const connected = quota?.status?.connected ?? windows.some(hasSimpleQuotaInput);
    items.push(providerHealth(provider, providerLabel, primary, secondary, syncing, statusLabel, connected, quotaStatusTone(quota?.status)));
  }
  return items;
}

function ProgressRow({
  label,
  visualKind,
  quotaPct,
  resetMs,
  durationMs,
  pending = false,
  pendingTitle,
  unknown = false,
  unknownLabel = 'loading',
  unknownBadge = 'wait',
  unknownTitle,
  animateWaiting = false,
}: {
  label: string;
  visualKind: WidgetAgent['rows'][number]['visualKind'];
  quotaPct: number;
  resetMs: number | null;
  durationMs?: number;
  pending?: boolean;
  pendingTitle?: string;
  unknown?: boolean;
  unknownLabel?: string;
  unknownBadge?: string;
  unknownTitle?: string;
  animateWaiting?: boolean;
}) {
  const C = useTheme();
  const { t } = useTranslation();
  const percentOnly = visualKind === 'percentOnly';
  const quota = clampPct(quotaPct);
  // unknownLabel 'unavailable' (provider explicitly has no data for this window) falls through
  // to null here on purpose — it renders as a static row like a known/empty value, not the
  // animated 'waiting' dots reserved for "still expecting data soon".
  const visualState: 'syncing' | 'waiting' | null = pending
    ? 'syncing'
    : unknown ? (unknownLabel === 'loading' ? 'syncing' : unknownLabel === 'waiting' ? 'waiting' : null) : null;
  const suppressWaitingAnimation = visualState === 'waiting' && !animateWaiting;
  const elapsed = visualState || percentOnly ? null : timeElapsedPct(durationMs, resetMs);
  const elapsedWidth = elapsed ?? 0;
  const resetLabel = percentOnly ? '' : pending ? '' : unknown ? unknownBadge : formatResetShort(resetMs);
  const usedColor = visualState ? (visualState === 'syncing' ? C.accent : C.textMuted) : quotaPctBarColor(quota, C);
  const quotaColor = usedColor;
  // pace 색상: 사용량이 경과 시간보다 빠르면 경고
  const paceColor = (elapsed != null && elapsed >= 5 && quota > 0)
    ? (quota / elapsed > 1.5 ? C.barRed : quota / elapsed > 1.0 ? C.barYellow : usedColor)
    : usedColor;
  const trackColor = C.bgCard === '#ffffff' ? '#e7e9f2' : '#131d30';
  const elapsedColor = C.bgCard === '#ffffff' ? '#cbd5e1' : '#334155';
  const rowTitle = pending ? pendingTitle : unknown ? unknownTitle : undefined;

  return (
    <div
      title={rowTitle}
      style={{ display: 'grid', gridTemplateColumns: percentOnly ? '24px minmax(0, 1fr) 64px' : '24px minmax(0, 1fr) 38px 64px', alignItems: 'center', gap: 6 }}
    >
      <div style={{ color: C.textMuted, fontSize: 10, fontFamily: C.fontMono, fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ position: 'relative', height: 8, background: trackColor, borderRadius: 4, overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute',
            inset: '0 auto 0 0',
            width: `${elapsedWidth}%`,
            background: elapsedColor,
            borderRadius: 4,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 2,
            width: `${visualState ? 0 : quota}%`,
            height: 4,
            background: quotaColor,
            borderRadius: 3,
            boxShadow: `0 0 4px ${quotaColor}44`,
          }}
        />
        {visualState ? (
          <span
            className="wmt-sync-sweep"
            style={{
              background: visualState === 'syncing'
                ? `linear-gradient(90deg, transparent, ${C.accent}88, transparent)`
                : `linear-gradient(90deg, transparent, ${C.textMuted}55, transparent)`,
              animation: suppressWaitingAnimation ? 'none' : undefined,
              opacity: suppressWaitingAnimation ? 0.32 : undefined,
            }}
          />
        ) : null}
      </div>
      {!percentOnly && (
        <div
          title={resetLabel ? t('compactWidgetView.tooltip.timeUntilReset', { resetLabel }) : undefined}
          style={{
            color: C.textDim,
            fontSize: 9,
            fontFamily: C.fontMono,
            textAlign: 'right',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {resetLabel}
        </div>
      )}
      <div
        title={percentOnly ? t('compactWidgetView.tooltip.used') : t('compactWidgetView.tooltip.usedElapsed')}
        style={{ textAlign: 'right', color: C.textDim, fontSize: 10, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}
      >
        {visualState ? (
          <MiniLimitStatus state={visualState} animate={!suppressWaitingAnimation} />
        ) : percentOnly ? (
          <span style={{ color: paceColor }}>{formatPct(quota)}</span>
        ) : (
          <>
            <span style={{ color: paceColor }}>{formatPct(quota)}</span>
            <span style={{ color: C.textMuted }}> / </span>
            <span>{formatPct(elapsed)}</span>
          </>
        )}
      </div>
    </div>
  );
}

function AgentBlock({ agent, animateWaiting }: { agent: WidgetAgent; animateWaiting: boolean }) {
  const C = useTheme();
  const { t } = useTranslation();
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: agent.color, boxShadow: `0 0 8px ${agent.color}88` }} />
        <span style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, lineHeight: 1, textTransform: 'uppercase', letterSpacing: 1 }}>
          {agent.label}
        </span>
        {agent.scanning ? (
          <span
            title={agent.scanningTitle}
            style={{
              color: C.textMuted,
              fontSize: 8,
              fontFamily: C.fontMono,
              lineHeight: 1,
              border: `1px solid ${C.borderSub}`,
              borderRadius: 3,
              padding: '1px 4px',
              opacity: 0.8,
            }}
          >
            {t('compactWidgetView.status.scanning')}
          </span>
        ) : null}
        {agent.badges.length > 0 ? (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }}>
            {agent.badges.map(badge => (
              <span
                key={badge.key}
                title={badge.title}
                style={{
                  ...quotaSourceBadgeToneStyle(badge.tone, C),
                  borderRadius: 3,
                  padding: '1px 4px',
                  fontSize: 8,
                  fontWeight: 700,
                  fontFamily: C.fontMono,
                  lineHeight: 1,
                  whiteSpace: 'nowrap',
                }}
              >
                {badge.label}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <div style={{ display: 'grid', gap: 5 }}>
        {agent.rows.map(row => (
          <ProgressRow
            key={row.key}
            label={row.label}
            visualKind={row.visualKind}
            quotaPct={row.quotaPct}
            resetMs={row.resetMs}
            durationMs={row.durationMs}
            pending={row.pending}
            pendingTitle={row.pendingTitle}
            unknown={row.unknown}
            unknownLabel={row.unknownLabel}
            unknownBadge={row.unknownBadge}
            unknownTitle={row.unknownTitle}
            animateWaiting={animateWaiting}
          />
        ))}
      </div>
    </div>
  );
}

export default function CompactWidgetView({ state, onRefresh }: Props) {
  const C = useTheme();
  const { t, i18n } = useTranslation();
  const [refreshLabel, setRefreshLabel] = useState(() => formatRefreshLabel(state.lastUpdated, state.stateFreshness));
  const [refreshing, setRefreshing] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const dragSeqRef = useRef(0);
  const movedRef = useRef(false);

  useEffect(() => {
    setRefreshLabel(formatRefreshLabel(state.lastUpdated, state.stateFreshness));
    const timer = window.setInterval(() => setRefreshLabel(formatRefreshLabel(state.lastUpdated, state.stateFreshness)), 30_000);
    return () => window.clearInterval(timer);
    // i18n.language: formatRefreshLabel/formatRefreshAge build translated text via the
    // i18next singleton, so the label needs to be recomputed right away on language switch.
  }, [state.lastUpdated, state.stateFreshness, i18n.language]);

  const agents = useMemo<WidgetAgent[]>(() => buildWidgetAgents(state), [state, i18n.language]);

  const healthItems = useMemo<HealthItem[]>(() => buildHealthItems(state), [state, i18n.language]);

  const healthToneStyle = useCallback((tone: HealthTone): React.CSSProperties => {
    if (tone === 'good') return { color: C.active, background: `${C.active}14`, border: `1px solid ${C.active}33` };
    if (tone === 'warning') return { color: C.waiting, background: `${C.waiting}14`, border: `1px solid ${C.waiting}33` };
    if (tone === 'danger') return { color: C.barRed, background: `${C.barRed}12`, border: `1px solid ${C.barRed}33` };
    return { color: C.textMuted, background: C.bgRow, border: `1px solid ${C.borderSub}` };
  }, [C.active, C.barRed, C.bgRow, C.borderSub, C.waiting, C.textMuted]);

  const showFiveHourHint = agents.length > 1 && agents.every(agent =>
    agent.rows.some(row => row.label === '5h' && row.unknown && row.unknownLabel === 'waiting')
  );
  const toolbarButtonStyle: React.CSSProperties = {
    background: C.bgCard === '#ffffff' ? 'rgba(245,247,252,0.72)' : 'rgba(30,41,59,0.62)',
    border: `1px solid ${C.bgCard === '#ffffff' ? 'rgba(148,163,184,0.42)' : 'rgba(100,116,139,0.28)'}`,
    borderRadius: 4,
    color: C.textDim,
    cursor: 'pointer',
    height: 20,
    minHeight: 20,
    padding: 0,
    lineHeight: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: C.fontMono,
    boxShadow: C.bgCard === '#ffffff'
      ? 'inset 0 1px 0 rgba(255,255,255,0.7)'
      : 'inset 0 1px 0 rgba(255,255,255,0.06)',
  };

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshLabel('...');
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh, refreshing]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) return;
    movedRef.current = false;
    const startX = event.screenX;
    const startY = event.screenY;
    const pointerId = event.pointerId;
    const dragSeq = ++dragSeqRef.current;
    dragRef.current = null;
    event.currentTarget.setPointerCapture(pointerId);
    window.wmt.getCompactWidgetPosition().then(position => {
      if (dragSeq !== dragSeqRef.current) return;
      if (!position) return;
      dragRef.current = { pointerId, startX, startY, originX: position.x, originY: position.y };
    }).catch(() => {});
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.screenX - drag.startX;
    const dy = event.screenY - drag.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) movedRef.current = true;
    window.wmt.setCompactWidgetPosition({ x: drag.originX + dx, y: drag.originY + dy }).catch(() => {});
  }, []);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragSeqRef.current += 1;
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) dragRef.current = null;
  }, []);

  const handleDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.target) || movedRef.current) return;
    window.wmt.openDashboard().catch(() => {});
  }, []);

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      style={{
        height: '100vh',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '14px 12px 13px',
        background: C.bgCard,
        color: C.text,
        fontFamily: C.fontSans,
        overflow: 'hidden',
        cursor: 'move',
        userSelect: 'none',
        borderRadius: 8,
        border: `1px solid ${C.border}`,
        boxShadow: C.bgCard === '#ffffff'
          ? 'inset 0 0 0 1px rgba(255,255,255,0.65)'
          : 'inset 0 0 0 1px rgba(255,255,255,0.04)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 13 }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 900, color: C.text, letterSpacing: 0, lineHeight: 1 }}>
          {t('compactWidgetView.header.title')}
        </span>
        <span style={{ fontSize: 8, color: C.textMuted, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}>
          {t('compactWidgetView.header.subtitle')}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <button
            data-no-drag="true"
            onClick={handleRefresh}
            title={t('compactWidgetView.button.refreshNow')}
            style={{
              ...toolbarButtonStyle,
              color: refreshing ? C.accent : C.textDim,
              cursor: refreshing ? 'wait' : 'pointer',
              fontSize: 10,
              minWidth: 28,
            }}
          >
            {refreshLabel}
          </button>
          <button
            data-no-drag="true"
            onClick={() => window.wmt.openDashboard().catch(() => {})}
            title={t('compactWidgetView.button.openDashboard')}
            style={{ ...toolbarButtonStyle, width: 20, minWidth: 20, fontSize: 11 }}
          >
            <ArrowUpRight size={11} strokeWidth={2} />
          </button>
          <button
            data-no-drag="true"
            onClick={() => window.wmt.hideCompactWidget().catch(() => {})}
            title={t('compactWidgetView.button.hideWidget')}
            style={{ ...toolbarButtonStyle, width: 20, minWidth: 20, fontSize: 12 }}
          >
            <X size={11} strokeWidth={2} />
          </button>
        </span>
      </div>

      <div style={{ display: 'grid', gap: agents.length > 1 ? 9 : 6 }}>
        {agents.map(agent => <AgentBlock key={agent.key} agent={agent} animateWaiting={state.settings.compactWidgetWaitingAnimationEnabled === true} />)}
      </div>
      {healthItems.length > 0 ? (
        <div
          title={t('compactWidgetView.health.sectionTitle')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            minHeight: 17,
            marginTop: agents.length > 1 ? -2 : 0,
            overflow: 'hidden',
          }}
        >
          <span style={{ fontSize: 8, color: C.textMuted, fontFamily: C.fontMono, flexShrink: 0 }}>
            {t('compactWidgetView.health.label')}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }}>
            {healthItems.map(item => (
              <span
                key={item.key}
                title={item.title}
                style={{
                  ...healthToneStyle(item.tone),
                  minWidth: 0,
                  maxWidth: 92,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  borderRadius: 4,
                  padding: '1px 4px',
                  fontSize: 8,
                  fontWeight: 800,
                  fontFamily: C.fontMono,
                  lineHeight: 1.2,
                }}
              >
                {item.label}
              </span>
            ))}
          </span>
        </div>
      ) : null}
      {showFiveHourHint ? (
        <div
          title={t('compactWidgetView.tooltip.noFiveHourData')}
          style={{
            marginTop: -2,
            color: C.textMuted,
            fontSize: 8,
            fontFamily: C.fontMono,
            lineHeight: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {t('compactWidgetView.hint.fiveHourLimits')}
        </div>
      ) : null}
    </div>
  );
}
