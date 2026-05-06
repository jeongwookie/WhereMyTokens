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
  if (elapsed < 60) return 'just now';
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  return `${Math.floor(elapsed / 3600)}h ago`;
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

function ProgressRow({
  label,
  quotaPct,
  resetMs,
  color,
  pending = false,
  pendingTitle,
  unknown = false,
}: {
  label: string;
  quotaPct: number;
  resetMs: number | null;
  color: string;
  pending?: boolean;
  pendingTitle?: string;
  unknown?: boolean;
}) {
  const C = useTheme();
  const quota = clampPct(quotaPct);
  const elapsed = pending || unknown ? null : timeElapsedPct(label, resetMs);
  const elapsedWidth = elapsed ?? 0;
  const resetLabel = pending ? 'scan' : unknown ? 'wait' : formatResetShort(resetMs);
  const resetBadgeBg = C.bgCard === '#ffffff' ? 'rgba(255,255,255,0.68)' : 'rgba(0,0,0,0.22)';
  const quotaColor = pending || unknown ? C.textMuted : color;
  const elapsedColor = C.bgCard === '#ffffff' ? '#cbd5e1' : '#334155';

  return (
    <div
      title={pending ? pendingTitle : undefined}
      style={{ display: 'grid', gridTemplateColumns: '24px minmax(0, 1fr) 70px', alignItems: 'center', gap: 7 }}
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
            width: `${pending || unknown ? 0 : quota}%`,
            height: 3,
            background: quotaColor,
            borderRadius: 3,
            boxShadow: `0 0 8px ${quotaColor}66`,
          }}
        />
        <span
          title="Time until reset"
          style={{
            position: 'absolute',
            right: 4,
            top: -1,
            maxWidth: 52,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 8,
            lineHeight: '10px',
            fontFamily: C.fontMono,
            color: C.textDim,
            background: resetBadgeBg,
            borderRadius: 3,
            padding: '0 3px',
          }}
        >
          {resetLabel}
        </span>
      </div>
      <div
        title="Usage percent / elapsed window percent"
        style={{ textAlign: 'right', color: C.textDim, fontSize: 10, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}
      >
        {pending ? (
          <span style={{ color: C.accent }}>scanning</span>
        ) : unknown ? (
          <span style={{ color: C.textDim }}>loading</span>
        ) : (
          <>
            <span style={{ color }}>{formatPct(quota)}</span>
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
          <ProgressRow key={row.key} label={row.label} quotaPct={row.quotaPct} resetMs={row.resetMs} color={agent.color} pending={row.pending} pendingTitle={row.pendingTitle} unknown={row.unknown} />
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
    if (provider !== 'codex') {
      next.push({
        key: 'claude',
        label: 'Claude',
        color: C.sonnet,
        rows: [
          { key: 'claude-5h', label: '5h', quotaPct: state.limits.h5.pct, resetMs: state.limits.h5.resetMs, unknown: bootPending || (state.limits.h5.pct <= 0 && state.limits.h5.resetMs == null) },
          { key: 'claude-1w', label: '1w', quotaPct: state.limits.week.pct, resetMs: state.limits.week.resetMs, unknown: bootPending || (state.limits.week.pct <= 0 && state.limits.week.resetMs == null) },
        ],
      });
    }
    if (provider !== 'claude') {
      next.push({
        key: 'codex',
        label: 'Codex',
        color: C.active,
        rows: [
          { key: 'codex-5h', label: '5h', quotaPct: state.limits.codexH5.pct, resetMs: state.limits.codexH5.resetMs, pending: codexH5Pending, pendingTitle: codexPendingTitle, unknown: !codexH5Pending && (bootPending || (state.limits.codexH5.pct <= 0 && state.limits.codexH5.resetMs == null)) },
          { key: 'codex-1w', label: '1w', quotaPct: state.limits.codexWeek.pct, resetMs: state.limits.codexWeek.resetMs, pending: codexWeekPending, pendingTitle: codexPendingTitle, unknown: !codexWeekPending && (bootPending || (state.limits.codexWeek.pct <= 0 && state.limits.codexWeek.resetMs == null)) },
        ],
      });
    }
    return next;
  }, [C.active, C.sonnet, state.historyWarmupPending, state.initialRefreshComplete, state.limits.codexH5.pct, state.limits.codexH5.resetMs, state.limits.codexH5.source, state.limits.codexWeek.pct, state.limits.codexWeek.resetMs, state.limits.codexWeek.source, state.limits.h5.pct, state.limits.h5.resetMs, state.limits.week.pct, state.limits.week.resetMs, state.settings.provider]);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshLabel('refreshing');
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
        gap: 7,
        padding: '8px 10px',
        background: C.bgCard,
        color: C.text,
        fontFamily: C.fontSans,
        overflow: 'hidden',
        cursor: 'move',
        userSelect: 'none',
        boxShadow: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 13 }}>
        <span style={{ fontSize: 10, fontWeight: 900, color: C.textDim, letterSpacing: 0, lineHeight: 1 }}>
          Plan Usage vs Time Elapsed
        </span>
        <span style={{ fontSize: 8, color: C.textMuted, fontFamily: C.fontMono, whiteSpace: 'nowrap' }}>
          usage / time
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
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
              padding: '1px 5px',
              lineHeight: 1,
            }}
          >
            {refreshLabel}
          </button>
          <button
            data-no-drag="true"
            onClick={() => window.wmt.openDashboard().catch(() => {})}
            title="Open dashboard"
            style={{ background: C.bgRow, border: `1px solid ${C.border}`, borderRadius: 4, color: C.textDim, cursor: 'pointer', fontSize: 11, padding: '0 5px', lineHeight: 1.3 }}
          >
            ^
          </button>
          <button
            data-no-drag="true"
            onClick={() => window.wmt.hideCompactWidget().catch(() => {})}
            title="Hide widget"
            style={{ background: C.bgRow, border: `1px solid ${C.border}`, borderRadius: 4, color: C.textDim, cursor: 'pointer', fontSize: 12, padding: '0 5px', lineHeight: 1.3 }}
          >
            x
          </button>
        </span>
      </div>

      <div style={{ display: 'grid', gap: agents.length > 1 ? 9 : 6 }}>
        {agents.map(agent => <AgentBlock key={agent.key} agent={agent} />)}
      </div>
    </div>
  );
}
