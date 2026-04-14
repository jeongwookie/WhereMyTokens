import React, { useState, useEffect } from 'react';
import { AppState } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtTokens, fmtCost, fmtCostShort, fmtDuration } from '../theme';
import SessionRow from '../components/SessionRow';
import TokenStatsCard from '../components/TokenStatsCard';
import ActivityChart from '../components/ActivityChart';
import ModelBreakdown from '../components/ModelBreakdown';
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
  const C = useTheme();
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

    function tick() {
      const elapsed = Math.round((Date.now() - state.lastUpdated) / 1000);
      if (elapsed < 5) setLastRefreshLabel('just now');
      else if (elapsed < 60) setLastRefreshLabel(`${elapsed}s ago`);
      else if (elapsed < 3600) setLastRefreshLabel(`${Math.floor(elapsed / 60)}m ago`);
      else setLastRefreshLabel(`${Math.floor(elapsed / 3600)}h ago`);
    }

    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
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

      {/* 헤더 — 다크 퍼플 배경, 2행 구조 */}
      <div style={{ background: C.headerBg, flexShrink: 0, borderBottom: `1px solid ${C.headerBorder}` }}>
        {/* 행1: 로고 + 플랜 뱃지 + API 점 + 윈도우 컨트롤 */}
        <div style={{ ...drag, padding: '8px 12px 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: C.headerAccent, letterSpacing: -0.3, flexShrink: 0 }}>
            ⚡ WhereMyTokens
          </span>
          <div style={{ ...noDrag, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            {state.autoLimits && (
              <span style={{ fontSize: 9, color: C.headerSub, background: 'rgba(255,255,255,0.1)', borderRadius: 3, padding: '1px 6px', fontWeight: 600, border: '1px solid rgba(255,255,255,0.15)' }}>
                {state.autoLimits.plan}
              </span>
            )}
            <span
              title={apiConnected ? 'API connected' : `API disconnected${apiError ? ` — ${apiError}` : ''}`}
              style={{ width: 6, height: 6, borderRadius: '50%', background: apiConnected ? '#4ade80' : '#f87171', display: 'inline-block', flexShrink: 0 }}
            />
            <button onClick={() => window.wmt.minimize().catch(() => {})} title="최소화" style={{ ...noDrag, width: 24, height: 20, background: 'none', border: 'none', color: C.headerSub, cursor: 'pointer', fontSize: 16, borderRadius: 4, lineHeight: 1, fontWeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
            <button onClick={onQuit} title="종료" style={{ ...noDrag, width: 24, height: 20, background: 'none', border: 'none', color: C.headerSub, cursor: 'pointer', fontSize: 14, borderRadius: 4, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
          </div>
        </div>

        {/* 행2: 대형 비용 + 오늘 토큰 */}
        <div style={{ ...drag, padding: '0 14px 8px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 26, fontWeight: 800, color: C.headerText, lineHeight: 1 }}>
            {fmtCost(usage.todayCost, currency, usdToKrw)}
          </span>
          <span style={{ fontSize: 11, color: C.headerSub, whiteSpace: 'nowrap' }}>
            {fmtTokens(usage.todayTokens)} tok · today
          </span>
        </div>

        {/* 5h 전역 진행 바 */}
        {(() => {
          const pct = Math.min(100, limits.h5.pct ?? 0);
          const noData = apiConnected === false && pct === 0;
          const barColor = pct >= 90 ? C.barRed : pct >= 75 ? C.barOrange : pct >= 50 ? C.barYellow : C.accent;
          const resetMs = limits.h5.resetMs;
          const etaMs = usage.burnRate?.h5EtaMs;
          const showEta = etaMs !== null && etaMs !== undefined && etaMs < (resetMs ?? Infinity);
          return (
            <div style={{ padding: '0 14px 8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 9, color: C.headerSub, flexShrink: 0 }}>5h limit</span>
                <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.15)', borderRadius: 2, overflow: 'hidden' }}>
                  {!noData && (
                    <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 2, transition: 'width 0.4s' }} />
                  )}
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, color: noData ? C.headerSub : '#fff', flexShrink: 0, width: 30, textAlign: 'right' }}>
                  {noData ? '—' : `${Math.round(pct)}%`}
                </span>
                {!noData && resetMs && resetMs > 0 && (
                  <span style={{ fontSize: 9, color: C.headerSub, flexShrink: 0, whiteSpace: 'nowrap' }}>
                    ↻ {apiConnected === false ? '~' : ''}{fmtDuration(resetMs)}
                  </span>
                )}
              </div>
              {showEta && (
                <div style={{ fontSize: 9, color: C.etaWarning, marginTop: 2 }}>
                  ⚡ ~{fmtDuration(etaMs!)} to limit at current rate
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* scroll area */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>

        {/* Sessions 섹션 헤더 + 필터 inline */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px 5px 12px', background: C.bgRow, borderTop: `2px solid ${C.accent}` }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Sessions</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['all', 'active'] as const).map(f => (
              <button
                key={f}
                onClick={() => setActiveFilter(f)}
                style={{
                  background: activeFilter === f ? C.accent + '22' : 'none',
                  border: `1px solid ${activeFilter === f ? C.accent + '66' : C.border}`,
                  color: activeFilter === f ? C.accent : C.textMuted,
                  borderRadius: 3, padding: '1px 7px', fontSize: 9, cursor: 'pointer', fontWeight: activeFilter === f ? 700 : 400,
                }}
              >
                {f === 'all' ? 'All' : 'Active'}
              </button>
            ))}
          </div>
        </div>

        {/* sessions */}
        {visibleGroups.length > 0
          ? visibleGroups.map(([groupName, groupSessions]) => (
            <div key={groupName}
              onMouseEnter={() => setHoveredGroup(groupName)}
              onMouseLeave={() => setHoveredGroup(null)}
            >
              <div style={{ display: 'flex', alignItems: 'center', padding: '3px 14px 2px', background: C.bg, borderTop: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 9, fontWeight: 400, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1.0, flex: 1 }}>
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

        {/* Plan Usage 섹션 헤더 */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '6px 14px 5px 12px', background: C.bgRow, borderTop: `2px solid ${C.accent}` }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Plan Usage</span>
        </div>

        {/* 5h 행: Claude 5h | Codex 5h (2열 그리드) */}
        <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <TokenStatsCard provider="Claude" period="5h" stats={usage.h5} currency={currency} usdToKrw={usdToKrw}
              limitPct={limits.h5.pct} resetMs={limits.h5.resetMs} apiConnected={apiConnected} burnRate={usage.burnRate}
              borderRight />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <TokenStatsCard provider="Codex" period="5h" stats={usage.h5Codex} currency={currency} usdToKrw={usdToKrw} />
          </div>
        </div>

        {/* 1w 행: Claude 1w | Codex 1w (2열 그리드) */}
        <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <TokenStatsCard provider="Claude" period="1w" stats={usage.week} currency={currency} usdToKrw={usdToKrw}
              limitPct={limits.week.pct} resetMs={limits.week.resetMs} apiConnected={apiConnected}
              borderRight />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <TokenStatsCard provider="Codex" period="1w" stats={usage.weekCodex} currency={currency} usdToKrw={usdToKrw} />
          </div>
        </div>

        {/* Sonnet 1w / Extra Usage (전체 폭) */}
        {showSonnet && (
          <TokenStatsCard provider="Sonnet" period="1w" stats={{
            inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
            totalTokens: usage.sonnetWeekTokens, costUSD: 0, requestCount: 0, cacheEfficiency: 0, cacheSavingsUSD: 0,
          }} currency={currency} usdToKrw={usdToKrw}
            limitPct={limits.so.pct} resetMs={limits.so.resetMs} apiConnected={apiConnected} hideCost />
        )}
        {extraUsage?.isEnabled && (
          <ExtraUsageCard extraUsage={extraUsage} />
        )}

        {/* activity chart */}
        <ActivityChart
          heatmap={usage.heatmap}
          heatmap30={usage.heatmap30}
          heatmap90={usage.heatmap90}
          weeklyTimeline={usage.weeklyTimeline}
          todBuckets={usage.todBuckets}
          currency={currency}
          usdToKrw={usdToKrw}
        />

        {/* model breakdown */}
        <ModelBreakdown models={usage.models} currency={currency} usdToKrw={usdToKrw} />

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
