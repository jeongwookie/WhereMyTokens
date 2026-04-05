import React, { useState, useEffect } from 'react';
import { AppState } from '../types';
import { C, fmtTokens, fmtCost } from '../theme';
import SessionRow from '../components/SessionRow';
import TokenStatsCard from '../components/TokenStatsCard';
import ActivityChart from '../components/ActivityChart';
import ModelBreakdown from '../components/ModelBreakdown';
import ContextBar from '../components/ContextBar';
import ExtraUsageCard from '../components/ExtraUsageCard';

interface Props {
  state: AppState;
  onNav: (view: 'settings' | 'notifications' | 'help') => void;
  onQuit: () => void;
  onRefresh: () => void;
}

const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

export default function MainView({ state, onNav, onQuit, onRefresh }: Props) {
  const { sessions, usage, limits, settings, apiConnected, apiError, extraUsage } = state;
  const { currency, usdToKrw } = settings;
  const hiddenProjects: string[] = settings.hiddenProjects ?? [];
  const excludedProjects: string[] = settings.excludedProjects ?? [];
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshLabel, setLastRefreshLabel] = useState('');
  const [showHiddenManager, setShowHiddenManager] = useState(false);
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<'all' | 'active'>('all');

  useEffect(() => {
    if (state.lastUpdated === 0) return;
    setLastRefreshLabel('just now');
    const t = setTimeout(() => {
      const ago = Math.round((Date.now() - state.lastUpdated) / 1000);
      setLastRefreshLabel(`${ago}s ago`);
    }, 3000);
    return () => clearTimeout(t);
  }, [state.lastUpdated]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setLastRefreshLabel('refreshing...');
    try {
      await window.wmt.forceRefresh();
      onRefresh();
    } catch {
      onRefresh();
    }
    setRefreshing(false);
  }

  function hideProject(name: string) {
    const next = [...hiddenProjects, name];
    window.wmt.setSettings({ hiddenProjects: next }).catch(() => {});
  }

  function unhideProject(name: string) {
    const next = hiddenProjects.filter(p => p !== name);
    window.wmt.setSettings({ hiddenProjects: next }).catch(() => {});
  }

  function excludeProject(name: string) {
    const next = [...excludedProjects, name];
    window.wmt.setSettings({ excludedProjects: next }).catch(() => {});
  }

  function unexcludeProject(name: string) {
    const next = excludedProjects.filter(p => p !== name);
    window.wmt.setSettings({ excludedProjects: next }).catch(() => {});
  }

  const filteredSessions = activeFilter === 'active'
    ? sessions.filter(s => s.state === 'active' || s.state === 'waiting')
    : sessions;
  const filteredGroups = (() => {
    const groups: Record<string, typeof sessions> = {};
    for (const s of filteredSessions) {
      const key = s.mainRepoName ?? s.projectName;
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    }
    return Object.entries(groups);
  })();
  const visibleGroups = filteredGroups.filter(([name]) => !hiddenProjects.includes(name));

  // all known project names (for unhide UI, include ones not currently in sessions)
  const allHidden = hiddenProjects;

  const showSonnet = settings.provider !== 'codex' &&
    (limits.so.pct > 0 || usage.sonnetWeekTokens > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, color: C.text, overflow: 'hidden' }}>

      {/* draggable header */}
      <div style={{ ...drag, padding: '10px 14px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: C.accent, letterSpacing: -0.5 }}>WhereMyTokens</span>
          {state.autoLimits && (
            <span style={{ fontSize: 9, color: C.accent, background: C.accent + '22', borderRadius: 3, padding: '1px 5px', fontWeight: 600 }}>
              {state.autoLimits.plan}
            </span>
          )}
        </div>
        <div style={{ ...noDrag, display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: C.textMuted }}>Today</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{fmtTokens(usage.todayTokens)}<span style={{ fontSize: 9, color: C.textMuted, marginLeft: 2 }}>tok</span></div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: C.textMuted }}>Cost</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.accent }}>{fmtCost(usage.todayCost, currency, usdToKrw)}</div>
          </div>

          {/* API 상태 dot */}
          <span
            title={apiConnected ? 'API connected' : `API disconnected${apiError ? ` — ${apiError}` : ''}`}
            style={{
              width: 6, height: 6, borderRadius: '50%',
              background: apiConnected ? '#4ade80' : '#f87171',
              display: 'inline-block', flexShrink: 0,
            }}
          />

          {/* 윈도우 컨트롤 */}
          <div style={{ display: 'flex', gap: 2, marginLeft: 2 }}>
            <button
              onClick={() => window.wmt.minimize().catch(() => {})}
              title="최소화"
              style={{
                ...noDrag,
                width: 28, height: 22,
                background: 'none', border: 'none',
                color: C.textDim, cursor: 'pointer',
                fontSize: 16, borderRadius: 4, lineHeight: 1,
                fontWeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >−</button>
            <button
              onClick={onQuit}
              title="종료"
              style={{
                ...noDrag,
                width: 28, height: 22,
                background: 'none', border: 'none',
                color: C.textDim, cursor: 'pointer',
                fontSize: 14, borderRadius: 4, lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >×</button>
          </div>
        </div>
      </div>

      {/* scroll area */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>

        {/* session filter toggle */}
        <div style={{ display: 'flex', gap: 4, padding: '6px 14px 2px', borderBottom: `1px solid ${C.border}` }}>
          {(['all', 'active'] as const).map(f => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              style={{
                background: activeFilter === f ? C.accent + '22' : 'none',
                border: `1px solid ${activeFilter === f ? C.accent + '66' : C.border}`,
                color: activeFilter === f ? C.accent : C.textMuted,
                borderRadius: 3, padding: '2px 8px', fontSize: 10, cursor: 'pointer', fontWeight: activeFilter === f ? 700 : 400,
              }}
            >
              {f === 'all' ? 'All' : 'Active'}
            </button>
          ))}
        </div>

        {/* sessions */}
        {visibleGroups.length > 0
          ? visibleGroups.map(([groupName, groupSessions]) => (
            <div key={groupName}
              onMouseEnter={() => setHoveredGroup(groupName)}
              onMouseLeave={() => setHoveredGroup(null)}
            >
              <div style={{ display: 'flex', alignItems: 'center', padding: '4px 14px 2px', background: C.bgCard }}>
                <span style={{ fontSize: 9, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
                  {groupName}
                </span>
                {hoveredGroup === groupName && (
                  <div style={{ display: 'flex', gap: 2 }}>
                    <button
                      onClick={() => hideProject(groupName)}
                      title={`Hide "${groupName}" (still tracked)`}
                      style={{
                        background: 'none', border: 'none', color: C.textMuted,
                        cursor: 'pointer', fontSize: 11, padding: '0 2px', lineHeight: 1,
                      }}
                    >✕</button>
                    <button
                      onClick={() => excludeProject(groupName)}
                      title={`Exclude "${groupName}" from tracking`}
                      style={{
                        background: 'none', border: 'none', color: C.textMuted,
                        cursor: 'pointer', fontSize: 11, padding: '0 2px', lineHeight: 1,
                      }}
                    >⊘</button>
                  </div>
                )}
              </div>
              {groupSessions.map(s => <SessionRow key={s.sessionId} session={s} />)}
            </div>
          ))
          : sessions.length === 0
            ? <div style={{ padding: '10px 14px', fontSize: 12, color: C.textMuted }}>No active Claude Code sessions</div>
            : null
        }

        {/* hidden projects indicator */}
        {allHidden.length > 0 && (
          <div style={{ padding: '4px 14px', borderBottom: `1px solid ${C.border}` }}>
            <button
              onClick={() => setShowHiddenManager(v => !v)}
              style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: 10, padding: 0 }}
            >
              {showHiddenManager ? '▲' : '▼'} {allHidden.length} hidden project{allHidden.length > 1 ? 's' : ''}
            </button>
            {showHiddenManager && (
              <div style={{ marginTop: 4 }}>
                {allHidden.map(name => (
                  <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
                    <span style={{ fontSize: 11, color: C.textDim, flex: 1 }}>{name}</span>
                    <button
                      onClick={() => unhideProject(name)}
                      style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textDim, cursor: 'pointer', fontSize: 10, padding: '1px 6px', borderRadius: 3 }}
                    >show</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Claude 5h / Codex 5h */}
        <TokenStatsCard provider="Claude" period="5h" stats={usage.h5} currency={currency} usdToKrw={usdToKrw}
          limitPct={limits.h5.pct} resetMs={limits.h5.resetMs} apiConnected={apiConnected} />
        <TokenStatsCard provider="Codex" period="5h" stats={usage.h5Codex} currency={currency} usdToKrw={usdToKrw} />

        {/* Claude 1w / Sonnet 1w / Codex 1w */}
        <TokenStatsCard provider="Claude" period="1w" stats={usage.week} currency={currency} usdToKrw={usdToKrw}
          limitPct={limits.week.pct} resetMs={limits.week.resetMs} apiConnected={apiConnected} />
        {showSonnet && (
          <TokenStatsCard provider="Sonnet" period="1w" stats={{
            inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
            totalTokens: usage.sonnetWeekTokens, costUSD: 0, requestCount: 0, cacheEfficiency: 0,
          }} currency={currency} usdToKrw={usdToKrw}
            limitPct={limits.so.pct} resetMs={limits.so.resetMs} apiConnected={apiConnected} hideCost />
        )}
        {extraUsage?.isEnabled && (
          <ExtraUsageCard extraUsage={extraUsage} />
        )}
        <TokenStatsCard provider="Codex" period="1w" stats={usage.weekCodex} currency={currency} usdToKrw={usdToKrw} />

        {/* activity chart */}
        <ActivityChart
          heatmap={usage.heatmap}
          heatmap30={usage.heatmap30}
          heatmap90={usage.heatmap90}
          weeklyTimeline={usage.weeklyTimeline}
          currency={currency}
          usdToKrw={usdToKrw}
        />

        {/* model breakdown */}
        <ModelBreakdown models={usage.models} currency={currency} usdToKrw={usdToKrw} />

        {/* context bar */}
        <ContextBar sessions={sessions} />

      </div>

      {/* bottom tabs */}
      <div style={{ display: 'flex', borderTop: `1px solid ${C.border}`, flexShrink: 0, background: C.bgCard }}>
        {[
          { key: 'settings',      icon: '⚙',  label: 'Settings' },
          { key: 'notifications', icon: '🔔', label: 'Alerts' },
          { key: 'help',          icon: '?',  label: 'Help' },
          { key: 'refresh',       icon: '↺',  label: lastRefreshLabel || 'Refresh' },
        ].map(({ key, icon, label }) => (
          <button
            key={key}
            onClick={() => key === 'refresh' ? handleRefresh() : onNav(key as 'settings' | 'notifications' | 'help')}
            style={{
              flex: 1, padding: '7px 0', background: 'none', border: 'none',
              color: key === 'refresh' && refreshing ? C.accent : C.textDim,
              cursor: key === 'refresh' && refreshing ? 'wait' : 'pointer',
              fontSize: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            }}
          >
            <span style={{
              fontSize: 13,
              display: 'inline-block',
              transition: 'transform 0.4s',
              transform: key === 'refresh' && refreshing ? 'rotate(360deg)' : 'none',
            }}>{icon}</span>
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
