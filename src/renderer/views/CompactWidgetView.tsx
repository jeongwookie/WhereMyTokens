import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from '../types';
import { useTheme } from '../ThemeContext';

interface Props {
  state: AppState;
  onRefresh: () => Promise<void>;
}

type WidgetAgent = {
  key: 'claude' | 'codex';
  label: string;
  color: string;
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
      unknownLabel: 'no data',
      unknownBadge: 'n/a',
      unknownTitle: unavailableTitle,
    };
  }
  return {};
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
  const elapsed = pending || unknown ? null : timeElapsedPct(label, resetMs);
  const elapsedWidth = elapsed ?? 0;
  const resetLabel = pending ? '' : unknown ? unknownBadge : formatResetShort(resetMs);
  const quotaColor = unknown ? C.textMuted : color;
  // pace 색상: 사용량이 경과 시간보다 빠르면 경고
  const paceColor = (elapsed != null && elapsed >= 5 && quota > 0)
    ? (quota / elapsed > 1.5 ? C.barRed : quota / elapsed > 1.0 ? C.barYellow : color)
    : color;
  const elapsedColor = C.bgCard === '#ffffff' ? '#cbd5e1' : '#334155';
  const rowTitle = pending ? pendingTitle : unknown ? unknownTitle : undefined;

  return (
    <div
      title={rowTitle}
      style={{ display: 'grid', gridTemplateColumns: '22px minmax(44px, 1fr) 38px 62px', alignItems: 'center', gap: 5 }}
    >
      <div style={{ color: C.textMuted, fontSize: 10, fontFamily: C.fontMono, fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ position: 'relative', height: 8, background: C.bgRow, borderRadius: 4, overflow: 'hidden' }}>
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
            width: `${unknown ? 0 : quota}%`,
            height: 3,
            background: quotaColor,
            borderRadius: 3,
            boxShadow: `0 0 8px ${quotaColor}66`,
          }}
        />
      </div>
      <div
        title={resetLabel ? `Time until reset: ${resetLabel}` : undefined}
        style={{
          color: C.textMuted,
          fontSize: 8,
          fontFamily: C.fontMono,
          lineHeight: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: 'left',
        }}
      >
        {resetLabel}
      </div>
      <div
        title="Used / Time elapsed"
        style={{ textAlign: 'right', color: C.textDim, fontSize: 10, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}
      >
        {pending ? (
          quota > 0 ? (
            <>
              <span style={{ color }}>{formatPct(quota)}</span>
              <span style={{ color: C.textMuted }}> / </span>
              <span style={{ color: C.accent }}>scan</span>
            </>
          ) : (
            <span style={{ color: C.accent }}>scanning</span>
          )
        ) : unknown ? (
          <span style={{ color: C.textDim }}>{unknownLabel}</span>
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
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: agent.color, boxShadow: `0 0 8px ${agent.color}88` }} />
        <span style={{ fontSize: 11, fontWeight: 800, color: C.text, lineHeight: 1 }}>
          {agent.label}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
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
    const codexH5HasLimit = state.limits.codexH5.source === 'localLog' || state.limits.codexH5.pct > 0 || (state.limits.codexH5.resetMs ?? 0) > 0;
    const codexWeekHasLimit = state.limits.codexWeek.source === 'localLog' || state.limits.codexWeek.pct > 0 || (state.limits.codexWeek.resetMs ?? 0) > 0;
    const codexH5Pending = state.historyWarmupPending && (state.limits.codexH5.source === 'localLog' || !codexH5HasLimit);
    const codexWeekPending = state.historyWarmupPending && (state.limits.codexWeek.source === 'localLog' || !codexWeekHasLimit);
    const codexPendingTitle = 'Full Codex history is still scanning; local-log limits may update.';
    const claudeUnavailableTitle = 'Claude limit data is unavailable until API or statusLine data is connected.';
    const codexUnavailableTitle = 'No Codex rate-limit event has been found in local logs yet.';
    if (provider !== 'codex') {
      next.push({
        key: 'claude',
        label: 'Claude',
        color: C.sonnet,
        rows: [
          { key: 'claude-5h', label: '5h', quotaPct: state.limits.h5.pct, resetMs: state.limits.h5.resetMs, ...missingLimitStatus(state.limits.h5.pct, state.limits.h5.resetMs, bootPending, claudeUnavailableTitle) },
          { key: 'claude-1w', label: '1w', quotaPct: state.limits.week.pct, resetMs: state.limits.week.resetMs, ...missingLimitStatus(state.limits.week.pct, state.limits.week.resetMs, bootPending, claudeUnavailableTitle) },
        ],
      });
    }
    if (provider !== 'claude') {
      next.push({
        key: 'codex',
        label: 'Codex',
        color: C.active,
        rows: [
          { key: 'codex-5h', label: '5h', quotaPct: state.limits.codexH5.pct, resetMs: state.limits.codexH5.resetMs, pending: codexH5Pending, pendingTitle: codexPendingTitle, ...(!codexH5Pending ? missingLimitStatus(state.limits.codexH5.pct, state.limits.codexH5.resetMs, bootPending, codexUnavailableTitle) : {}) },
          { key: 'codex-1w', label: '1w', quotaPct: state.limits.codexWeek.pct, resetMs: state.limits.codexWeek.resetMs, pending: codexWeekPending, pendingTitle: codexPendingTitle, ...(!codexWeekPending ? missingLimitStatus(state.limits.codexWeek.pct, state.limits.codexWeek.resetMs, bootPending, codexUnavailableTitle) : {}) },
        ],
      });
    }
    return next;
  }, [C.active, C.sonnet, state.historyWarmupPending, state.initialRefreshComplete, state.limits.codexH5.pct, state.limits.codexH5.resetMs, state.limits.codexH5.source, state.limits.codexWeek.pct, state.limits.codexWeek.resetMs, state.limits.codexWeek.source, state.limits.h5.pct, state.limits.h5.resetMs, state.limits.week.pct, state.limits.week.resetMs, state.settings.provider]);

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
        gap: 6,
        padding: '8px 9px',
        background: C.bgCard,
        color: C.text,
        fontFamily: C.fontSans,
        overflow: 'hidden',
        cursor: 'move',
        userSelect: 'none',
        borderRadius: 8,
        boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 13 }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 900, color: C.textDim, letterSpacing: 0, lineHeight: 1 }}>
          Quota Pace
        </span>
        <span style={{ fontSize: 8, color: C.textMuted, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}>
          used / elapsed
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <button
            data-no-drag="true"
            onClick={handleRefresh}
            title="Refresh now"
            style={{
              background: C.bgRow,
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              color: refreshing ? C.accent : C.textDim,
              cursor: refreshing ? 'wait' : 'pointer',
              fontSize: 10,
              fontFamily: C.fontMono,
              padding: '1px 4px',
              lineHeight: 1,
              minWidth: 26,
            }}
          >
            {refreshLabel}
          </button>
          <button
            data-no-drag="true"
            onClick={() => window.wmt.openDashboard().catch(() => {})}
            title="Open dashboard"
            style={{ background: C.bgRow, border: `1px solid ${C.border}`, borderRadius: 4, color: C.textDim, cursor: 'pointer', fontSize: 11, minWidth: 20, minHeight: 20, padding: '0 4px', lineHeight: 1.3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          >
            ↗
          </button>
          <button
            data-no-drag="true"
            onClick={() => window.wmt.hideCompactWidget().catch(() => {})}
            title="Hide widget"
            style={{ background: C.bgRow, border: `1px solid ${C.border}`, borderRadius: 4, color: C.textDim, cursor: 'pointer', fontSize: 12, minWidth: 20, minHeight: 20, padding: '0 4px', lineHeight: 1.3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          >
            ×
          </button>
        </span>
      </div>

      <div style={{ display: 'grid', gap: agents.length > 1 ? 7 : 6 }}>
        {agents.map(agent => <AgentBlock key={agent.key} agent={agent} />)}
      </div>
    </div>
  );
}
