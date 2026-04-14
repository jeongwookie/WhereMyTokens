import React, { useState, useEffect } from 'react';
import { AppState } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtTokens, fmtCost } from '../theme';
import SessionRow from '../components/SessionRow';
import TokenStatsCard from '../components/TokenStatsCard';
import ActivityChart from '../components/ActivityChart';
import ModelBreakdown from '../components/ModelBreakdown';
import ExtraUsageCard from '../components/ExtraUsageCard';
import CodeOutputCard from '../components/CodeOutputCard';

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

  // 2단계 그루핑: Project → Branch → Sessions
  type BranchGroup = { branch: string; sessions: typeof sessions; commits: number; added: number; removed: number };
  type ProjectGroup = { name: string; branches: BranchGroup[]; totalCommits: number; totalAdded: number; totalRemoved: number };
  const projectGroups: ProjectGroup[] = (() => {
    const projMap: Record<string, typeof sessions> = {};
    for (const s of filteredSessions) {
      const key = s.mainRepoName ?? s.projectName;
      if (!projMap[key]) projMap[key] = [];
      projMap[key].push(s);
    }
    return Object.entries(projMap)
      .filter(([name]) => !hiddenProjects.includes(name))
      .map(([name, sess]) => {
        // 브랜치 그루핑
        const branchMap: Record<string, typeof sessions> = {};
        for (const s of sess) {
          const br = s.gitStats?.branch ?? '(unknown)';
          if (!branchMap[br]) branchMap[br] = [];
          branchMap[br].push(s);
        }
        // 브랜치별 커밋 (같은 브랜치의 첫 세션 gitStats 사용, 중복 방지)
        const branches: BranchGroup[] = Object.entries(branchMap).map(([branch, bSess]) => {
          const first = bSess.find(s => s.gitStats)?.gitStats;
          return {
            branch,
            sessions: bSess,
            commits: first?.commitsToday ?? 0,
            added: first?.linesAdded ?? 0,
            removed: first?.linesRemoved ?? 0,
          };
        });
        const totalCommits = branches.reduce((s, b) => s + b.commits, 0);
        const totalAdded = branches.reduce((s, b) => s + b.added, 0);
        const totalRemoved = branches.reduce((s, b) => s + b.removed, 0);
        return { name, branches, totalCommits, totalAdded, totalRemoved };
      });
  })();

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
          <span style={{ fontSize: 26, fontWeight: 800, color: C.headerText, lineHeight: 1, fontFamily: C.fontMono }}>
            {fmtCost(usage.todayCost, currency, usdToKrw)}
          </span>
          <span style={{ fontSize: 11, color: C.headerSub, whiteSpace: 'nowrap' }}>
            {fmtTokens(usage.todayTokens)} tok · today
          </span>
        </div>

      </div>

      {/* scroll area */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 8 }}>

        {/* ── Plan Usage 카드 ───────────────────────────────────────────── */}
        <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
          {/* 헤더 */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '6px 14px 5px 12px', background: C.bgRow, borderBottom: `1px solid ${C.border}` }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Plan Usage</span>
          </div>

          {/* Claude: 5h | 1w 나란히 (CSS Grid 2열, 동일 폭) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: `1px solid ${C.border}` }}>
            <TokenStatsCard provider="Claude" period="5h" stats={usage.h5} currency={currency} usdToKrw={usdToKrw}
              limitPct={limits.h5.pct} resetMs={limits.h5.resetMs} apiConnected={apiConnected} burnRate={usage.burnRate}
              hero borderRight />
            <TokenStatsCard provider="Claude" period="1w" stats={usage.week} currency={currency} usdToKrw={usdToKrw}
              limitPct={limits.week.pct} resetMs={limits.week.resetMs} apiConnected={apiConnected}
              hero />
          </div>

          {/* Codex: 5h | 1w (데이터 있을 때만) */}
          {(usage.h5Codex.totalTokens > 0 || usage.weekCodex.totalTokens > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: `1px solid ${C.border}` }}>
              <TokenStatsCard provider="Codex" period="5h" stats={usage.h5Codex} currency={currency} usdToKrw={usdToKrw} borderRight />
              <TokenStatsCard provider="Codex" period="1w" stats={usage.weekCodex} currency={currency} usdToKrw={usdToKrw} />
            </div>
          )}

          {/* Sonnet 1w (Plan Usage 내부, 동일 행 패턴) */}
          {showSonnet && (
            <div style={{ borderBottom: `1px solid ${C.border}` }}>
              <TokenStatsCard provider="Sonnet" period="1w" stats={{
                inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
                totalTokens: usage.sonnetWeekTokens, costUSD: 0, requestCount: 0, cacheEfficiency: 0, cacheSavingsUSD: 0,
              }} currency={currency} usdToKrw={usdToKrw}
                limitPct={limits.so.pct} resetMs={limits.so.resetMs} apiConnected={apiConnected} hideCost />
            </div>
          )}

          {/* Extra Usage (Plan Usage 내부, 동일 행 패턴) */}
          {extraUsage?.isEnabled && (
            <div>
              <ExtraUsageCard extraUsage={extraUsage} />
            </div>
          )}
        </div>

        {/* ── Code Output 카드 ────────────────────────────────────────── */}
        <CodeOutputCard sessions={sessions} todayCost={usage.todayCost} allTimeCost={usage.models.reduce((s, m) => s + m.costUSD, 0)} currency={currency} usdToKrw={usdToKrw} />

        {/* ── Sessions 카드 ─────────────────────────────────────────────── */}
        <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}`, paddingBottom: 16 }}>
          {/* 헤더 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px 5px 12px', background: C.bgRow, borderBottom: `1px solid ${C.border}` }}>
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

          {/* 세션 목록 — 2단계 그루핑 */}
          {projectGroups.length > 0
            ? projectGroups.map(proj => (
              <div key={proj.name}
                onMouseEnter={() => setHoveredGroup(proj.name)}
                onMouseLeave={() => setHoveredGroup(null)}
              >
                {/* 프로젝트 헤더 */}
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 10px', margin: '10px 8px 0',
                  background: `${C.accent}08`, borderRadius: 4, border: `1px solid ${C.accent}14`,
                }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.text, fontFamily: C.fontSans }}>{proj.name}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {proj.totalCommits > 0 && (
                      <span style={{ fontSize: 9, color: C.textMuted, fontFamily: C.fontMono }}>
                        {proj.totalCommits} commit{proj.totalCommits > 1 ? 's' : ''} · +{proj.totalAdded} / -{proj.totalRemoved}
                      </span>
                    )}
                    {hoveredGroup === proj.name && (
                      <div style={{ display: 'flex', gap: 2 }}>
                        <button onClick={() => hideProject(proj.name)} title="Hide"
                          style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: 11, padding: '0 2px', lineHeight: 1 }}>✕</button>
                        <button onClick={() => excludeProject(proj.name)} title="Exclude"
                          style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: 11, padding: '0 2px', lineHeight: 1 }}>⊘</button>
                      </div>
                    )}
                  </div>
                </div>

                {/* 브랜치별 그루핑 */}
                {proj.branches.map(br => (
                  <div key={br.branch} style={{ margin: '6px 8px 0 14px' }}>
                    {/* 브랜치 줄 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 0', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11 }}>🌿</span>
                      <span title={br.branch} style={{
                        fontSize: 10, color: C.textDim, fontWeight: 500, fontFamily: C.fontMono,
                        maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{br.branch}</span>
                      {br.commits > 0 && (
                        <>
                          <span style={{ fontSize: 8, background: '#60a5fa1a', color: '#60a5fa', borderRadius: 3, padding: '1px 5px', fontFamily: C.fontMono, fontWeight: 600 }}>
                            {br.commits} commit{br.commits > 1 ? 's' : ''}
                          </span>
                          <span style={{ fontSize: 8, background: '#34d3991a', color: '#34d399', borderRadius: 3, padding: '1px 5px', fontFamily: C.fontMono, fontWeight: 600 }}>+{br.added}</span>
                          <span style={{ fontSize: 8, background: '#f871711a', color: '#f87171', borderRadius: 3, padding: '1px 5px', fontFamily: C.fontMono, fontWeight: 600 }}>-{br.removed}</span>
                        </>
                      )}
                    </div>

                    {/* 세션 카드들 */}
                    {br.sessions.map(s => <SessionRow key={s.sessionId} session={s} />)}
                  </div>
                ))}
              </div>
            ))
            : sessions.length === 0
              ? <div style={{ padding: '10px 14px', fontSize: 12, color: C.textMuted }}>No active Claude Code sessions</div>
              : null
          }

          {/* 숨긴 프로젝트 관리 */}
          {allHidden.length > 0 && (
            <div style={{ padding: '4px 14px', borderTop: `1px solid ${C.border}` }}>
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
        </div>

        {/* ── Activity 카드 (Rhythm 탭 통합) ──────────────────────────── */}
        <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
          <ActivityChart
            heatmap={usage.heatmap}
            heatmap30={usage.heatmap30}
            heatmap90={usage.heatmap90}
            weeklyTimeline={usage.weeklyTimeline}
            todBuckets={usage.todBuckets}
            currency={currency}
            usdToKrw={usdToKrw}
          />
        </div>

        {/* ── Model Usage 카드 ──────────────────────────────────────────── */}
        <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
          <ModelBreakdown models={usage.models} currency={currency} usdToKrw={usdToKrw} />
        </div>

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
