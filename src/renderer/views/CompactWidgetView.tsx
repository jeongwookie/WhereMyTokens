import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import { AppState } from '../types';
import { useTheme } from '../ThemeContext';
import { hasLimitData, limitDataState, limitSourceDisplay, LimitWindow } from '../limitDisplay';

interface Props {
  state: AppState;
  onRefresh: () => Promise<void>;
}

type WidgetAgent = {
  key: 'claude' | 'codex';
  label: string;
  color: string;
  scanning?: boolean;
  scanningTitle?: string;
  rows: Array<{
    key: string;
    label: string;
    quotaPct: number;
    resetMs: number | null;
    pending?: boolean;
    pendingTitle?: string;
    unknown?: boolean;
    unknownLabel?: string;
    unknownBadge?: string;
    unknownTitle?: string;
  }>;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
};

type HealthTone = 'claudeGood' | 'codexGood' | 'neutral' | 'warning' | 'danger';

interface HealthItem {
  key: string;
  label: string;
  tone: HealthTone;
  title: string;
}

function formatRefreshLabel(lastUpdated: number): string {
  if (!lastUpdated) return 'refresh';
  const elapsed = Math.round((Date.now() - lastUpdated) / 1000);
  if (elapsed < 60) return 'now';
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`;
  return `${Math.floor(elapsed / 3600)}h`;
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

function windowDurationMs(label: string): number | null {
  if (label === '5h') return 5 * 60 * 60 * 1000;
  if (label === '1w') return 7 * 24 * 60 * 60 * 1000;
  return null;
}

function timeElapsedPct(label: string, resetMs: number | null): number | null {
  const durationMs = windowDurationMs(label);
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
  return target instanceof HTMLElement && !!target.closest('[data-no-drag="true"]');
}

function missingLimitStatus(
  pct: number,
  resetMs: number | null,
  bootPending: boolean,
  unavailableTitle: string,
  windowLabel: string,
): Pick<WidgetAgent['rows'][number], 'unknown' | 'unknownLabel' | 'unknownBadge' | 'unknownTitle'> {
  if (bootPending) {
    return {
      unknown: true,
      unknownLabel: 'loading',
      unknownBadge: 'wait',
      unknownTitle: 'Startup scan is still loading.',
    };
  }
  if (pct <= 0 && resetMs == null) {
    return {
      unknown: true,
      unknownLabel: 'waiting',
      unknownBadge: '',
      unknownTitle: windowLabel === '5h'
        ? 'No 5h reset data yet. It will appear after local usage or provider data is detected.'
        : unavailableTitle,
    };
  }
  return {};
}

function MiniLimitStatus({ state }: { state: 'syncing' | 'waiting' }) {
  const C = useTheme();
  const label = state === 'syncing' ? 'syncing' : 'waiting';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, color: state === 'syncing' ? C.accent : C.textDim }}>
      <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
        {[0, 1, 2].map(index => (
          <span
            key={index}
            className="wmt-sync-dot"
            style={{ width: 3, height: 3, background: state === 'syncing' ? C.accent : C.textMuted, animationDelay: `${index * 0.16}s` }}
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

function providerOkTone(provider: 'Claude' | 'Codex'): HealthTone {
  return provider === 'Claude' ? 'claudeGood' : 'codexGood';
}

function providerHealth(
  provider: 'Claude' | 'Codex',
  h5: LimitWindow,
  week: LimitWindow,
  syncing: boolean,
  claudeStatusLabel?: string,
  claudeApiConnected = true,
): HealthItem {
  if (provider === 'Claude') {
    switch (claudeStatusLabel) {
      case 'rate limited':
        return { key: 'claude', label: 'Claude limited', tone: 'warning', title: 'Claude API is rate limited; cached or bridge data may be used.' };
      case 'reset partial':
        return { key: 'claude', label: 'Claude partial', tone: 'warning', title: 'Claude usage loaded, but reset timing is unavailable.' };
      case 'local only':
        return { key: 'claude', label: 'Claude local', tone: 'warning', title: 'Claude credentials are unavailable, so local data is being used.' };
      case 'auth failed':
      case 'forbidden':
      case 'api disconnected':
        return { key: 'claude', label: 'Claude offline', tone: 'danger', title: 'Claude API is unavailable.' };
      default:
        break;
    }
  }

  if (syncing || limitDataState(h5, syncing) === 'syncing' || limitDataState(week, syncing) === 'syncing') {
    return { key: provider.toLowerCase(), label: `${provider} syncing`, tone: providerOkTone(provider), title: `${provider} limit data is syncing in the background.` };
  }

  if (!hasLimitData(h5) && !hasLimitData(week)) {
    return { key: provider.toLowerCase(), label: `${provider} waiting`, tone: 'neutral', title: `${provider} limit data has not arrived yet.` };
  }

  if (provider === 'Claude' && !claudeApiConnected) {
    return { key: 'claude', label: 'Claude offline', tone: 'danger', title: 'Claude API is unavailable.' };
  }

  const sources = [healthLabelForSource(h5), healthLabelForSource(week)].filter((label): label is string => !!label);
  if (sources.includes('Log')) {
    return { key: provider.toLowerCase(), label: `${provider} Log`, tone: 'warning', title: `${provider} is using local log estimates for at least one limit window.` };
  }
  if (sources.includes('Cache')) {
    return { key: provider.toLowerCase(), label: `${provider} Cache`, tone: 'neutral', title: `${provider} is using the last trusted cached usage snapshot.` };
  }
  if (sources.includes('Bridge')) {
    return { key: provider.toLowerCase(), label: `${provider} Bridge`, tone: 'neutral', title: `${provider} is using the local status-line bridge.` };
  }
  return {
    key: provider.toLowerCase(),
    label: `${provider} OK`,
    tone: providerOkTone(provider),
    title: `${provider} account limit data is current.`,
  };
}

function ProgressRow({
  label,
  quotaPct,
  resetMs,
  color,
  pending = false,
  pendingTitle,
  unknown = false,
  unknownLabel = 'loading',
  unknownBadge = 'wait',
  unknownTitle,
}: {
  label: string;
  quotaPct: number;
  resetMs: number | null;
  color: string;
  pending?: boolean;
  pendingTitle?: string;
  unknown?: boolean;
  unknownLabel?: string;
  unknownBadge?: string;
  unknownTitle?: string;
}) {
  const C = useTheme();
  const quota = clampPct(quotaPct);
  const visualState: 'syncing' | 'waiting' | null = pending ? 'syncing' : unknown ? (unknownLabel === 'loading' ? 'syncing' : 'waiting') : null;
  const elapsed = visualState ? null : timeElapsedPct(label, resetMs);
  const elapsedWidth = elapsed ?? 0;
  const resetLabel = pending ? '' : unknown ? unknownBadge : formatResetShort(resetMs);
  const quotaColor = visualState ? (visualState === 'syncing' ? C.accent : C.textMuted) : color;
  // pace 색상: 사용량이 경과 시간보다 빠르면 경고
  const paceColor = (elapsed != null && elapsed >= 5 && quota > 0)
    ? (quota / elapsed > 1.5 ? C.barRed : quota / elapsed > 1.0 ? C.barYellow : color)
    : color;
  const trackColor = C.bgCard === '#ffffff' ? '#e7e9f2' : '#131d30';
  const elapsedColor = C.bgCard === '#ffffff' ? '#cbd5e1' : '#334155';
  const rowTitle = pending ? pendingTitle : unknown ? unknownTitle : undefined;

  return (
    <div
      title={rowTitle}
      style={{ display: 'grid', gridTemplateColumns: '24px minmax(0, 1fr) 38px 64px', alignItems: 'center', gap: 6 }}
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
            }}
          />
        ) : null}
      </div>
      <div
        title={resetLabel ? `Time until reset: ${resetLabel}` : undefined}
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
      <div
        title="Used / Time elapsed"
        style={{ textAlign: 'right', color: C.textDim, fontSize: 10, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}
      >
        {visualState ? (
          <MiniLimitStatus state={visualState} />
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

function AgentBlock({ agent }: { agent: WidgetAgent }) {
  const C = useTheme();
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: agent.color, boxShadow: `0 0 8px ${agent.color}88` }} />
        <span style={{ fontSize: 11, fontWeight: 800, color: C.text, lineHeight: 1 }}>
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
            scanning
          </span>
        ) : null}
      </div>
      <div style={{ display: 'grid', gap: 5 }}>
        {agent.rows.map(row => (
          <ProgressRow
            key={row.key}
            label={row.label}
            quotaPct={row.quotaPct}
            resetMs={row.resetMs}
            color={agent.color}
            pending={row.pending}
            pendingTitle={row.pendingTitle}
            unknown={row.unknown}
            unknownLabel={row.unknownLabel}
            unknownBadge={row.unknownBadge}
            unknownTitle={row.unknownTitle}
          />
        ))}
      </div>
    </div>
  );
}

export default function CompactWidgetView({ state, onRefresh }: Props) {
  const C = useTheme();
  const [refreshLabel, setRefreshLabel] = useState(() => formatRefreshLabel(state.lastUpdated));
  const [refreshing, setRefreshing] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const dragSeqRef = useRef(0);
  const movedRef = useRef(false);

  useEffect(() => {
    setRefreshLabel(formatRefreshLabel(state.lastUpdated));
    const timer = window.setInterval(() => setRefreshLabel(formatRefreshLabel(state.lastUpdated)), 30_000);
    return () => window.clearInterval(timer);
  }, [state.lastUpdated]);

  const agents = useMemo<WidgetAgent[]>(() => {
    const provider = state.settings.provider ?? 'both';
    const next: WidgetAgent[] = [];
    const bootPending = !state.initialRefreshComplete;
    const codexH5HasLimit = hasLimitData(state.limits.codexH5);
    const codexWeekHasLimit = hasLimitData(state.limits.codexWeek);
    const codexH5Pending = state.historyWarmupPending && (state.limits.codexH5.source === 'localLog' || !codexH5HasLimit);
    const codexWeekPending = state.historyWarmupPending && (state.limits.codexWeek.source === 'localLog' || !codexWeekHasLimit);
    const codexPendingTitle = 'Full Codex history is still scanning; local-log limits may update.';
    const claudeUnavailableTitle = 'Claude limit data is unavailable until API or statusLine data is connected.';
    const codexUnavailableTitle = 'Codex limit data has not arrived from API, cache, or local logs yet.';
    if (provider !== 'codex') {
      next.push({
        key: 'claude',
        label: 'Claude',
        color: C.sonnet,
        rows: [
          { key: 'claude-5h', label: '5h', quotaPct: state.limits.h5.pct, resetMs: state.limits.h5.resetMs, ...missingLimitStatus(state.limits.h5.pct, state.limits.h5.resetMs, bootPending, claudeUnavailableTitle, '5h') },
          { key: 'claude-1w', label: '1w', quotaPct: state.limits.week.pct, resetMs: state.limits.week.resetMs, ...missingLimitStatus(state.limits.week.pct, state.limits.week.resetMs, bootPending, claudeUnavailableTitle, '1w') },
        ],
      });
    }
    if (provider !== 'claude') {
      next.push({
        key: 'codex',
        label: 'Codex',
        color: C.active,
        scanning: codexH5Pending || codexWeekPending,
        scanningTitle: codexPendingTitle,
        rows: [
          { key: 'codex-5h', label: '5h', quotaPct: state.limits.codexH5.pct, resetMs: state.limits.codexH5.resetMs, pending: codexH5Pending, pendingTitle: codexPendingTitle, ...(!codexH5Pending ? missingLimitStatus(state.limits.codexH5.pct, state.limits.codexH5.resetMs, bootPending, codexUnavailableTitle, '5h') : {}) },
          { key: 'codex-1w', label: '1w', quotaPct: state.limits.codexWeek.pct, resetMs: state.limits.codexWeek.resetMs, pending: codexWeekPending, pendingTitle: codexPendingTitle, ...(!codexWeekPending ? missingLimitStatus(state.limits.codexWeek.pct, state.limits.codexWeek.resetMs, bootPending, codexUnavailableTitle, '1w') : {}) },
        ],
      });
    }
    return next;
  }, [C.active, C.sonnet, state.historyWarmupPending, state.initialRefreshComplete, state.limits.codexH5.pct, state.limits.codexH5.resetLabel, state.limits.codexH5.resetMs, state.limits.codexH5.source, state.limits.codexWeek.pct, state.limits.codexWeek.resetLabel, state.limits.codexWeek.resetMs, state.limits.codexWeek.source, state.limits.h5.pct, state.limits.h5.resetLabel, state.limits.h5.resetMs, state.limits.h5.source, state.limits.week.pct, state.limits.week.resetLabel, state.limits.week.resetMs, state.limits.week.source, state.settings.provider]);

  const healthItems = useMemo<HealthItem[]>(() => {
    const provider = state.settings.provider ?? 'both';
    const items: HealthItem[] = [];
    if (provider !== 'codex') {
      const claudeHealth = providerHealth(
        'Claude',
        state.limits.h5,
        state.limits.week,
        !state.initialRefreshComplete,
        state.apiStatusLabel,
        state.apiConnected,
      );
      items.push(claudeHealth);
    }
    if (provider !== 'claude') {
      const codexSyncing = state.historyWarmupPending && (!hasLimitData(state.limits.codexH5) || !hasLimitData(state.limits.codexWeek));
      const codexHealth = providerHealth('Codex', state.limits.codexH5, state.limits.codexWeek, codexSyncing);
      items.push(codexHealth);
    }
    return items;
  }, [state.apiConnected, state.apiStatusLabel, state.historyWarmupPending, state.initialRefreshComplete, state.limits.codexH5, state.limits.codexWeek, state.limits.h5, state.limits.week, state.settings.provider]);

  const healthToneStyle = useCallback((tone: HealthTone): React.CSSProperties => {
    if (tone === 'claudeGood') return { color: C.sonnet, background: `${C.sonnet}14`, border: `1px solid ${C.sonnet}33` };
    if (tone === 'codexGood') return { color: C.active, background: `${C.active}14`, border: `1px solid ${C.active}33` };
    if (tone === 'warning') return { color: C.waiting, background: `${C.waiting}14`, border: `1px solid ${C.waiting}33` };
    if (tone === 'danger') return { color: C.barRed, background: `${C.barRed}12`, border: `1px solid ${C.barRed}33` };
    return { color: C.textMuted, background: C.bgRow, border: `1px solid ${C.borderSub}` };
  }, [C.active, C.barRed, C.bgRow, C.borderSub, C.sonnet, C.waiting, C.textMuted]);

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
          Quota Pace
        </span>
        <span style={{ fontSize: 8, color: C.textMuted, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}>
          used / elapsed
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <button
            data-no-drag="true"
            onClick={handleRefresh}
            title="Refresh now"
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
            title="Open dashboard"
            style={{ ...toolbarButtonStyle, width: 20, minWidth: 20, fontSize: 11 }}
          >
            <ArrowUpRight size={11} strokeWidth={2} />
          </button>
          <button
            data-no-drag="true"
            onClick={() => window.wmt.hideCompactWidget().catch(() => {})}
            title="Hide widget"
            style={{ ...toolbarButtonStyle, width: 20, minWidth: 20, fontSize: 12 }}
          >
            <X size={11} strokeWidth={2} />
          </button>
        </span>
      </div>

      <div style={{ display: 'grid', gap: agents.length > 1 ? 9 : 6 }}>
        {agents.map(agent => <AgentBlock key={agent.key} agent={agent} />)}
      </div>
      {healthItems.length > 0 ? (
        <div
          title="Provider limit-data health"
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
            Health
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
          title="No 5h reset data yet. It will appear after local usage or provider data is detected."
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
          5h limits appear after first usage event
        </div>
      ) : null}
    </div>
  );
}
