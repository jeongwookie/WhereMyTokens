import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { AppState, SessionInfo } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtTokens, fmtCost, fmtRelative } from '../theme';
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

type SessionListItem =
  | { type: 'session'; session: SessionInfo }
  | {
      type: 'stack';
      key: string;
      sessions: SessionInfo[];
      provider: SessionInfo['provider'];
      source: string;
      state: SessionInfo['state'];
      latest: string | null;
      maxCtxPct: number;
    };

function sourceLabel(source?: string) {
  if (source === 'api') return 'API';
  if (source === 'statusLine') return 'statusLine';
  if (source === 'localLog') return 'Local log';
  if (source === 'cache') return 'cache';
  return undefined;
}

function joinedSourceLabel(...sources: (string | undefined)[]) {
  const labels = Array.from(new Set(sources.map(sourceLabel).filter(Boolean))) as string[];
  return labels.length > 0 ? labels.join(' / ') : undefined;
}

function formatRefreshLabel(lastUpdated: number): string {
  if (!lastUpdated) return 'Refresh';
  const elapsed = Math.round((Date.now() - lastUpdated) / 1000);
  if (elapsed < 5) return 'just now';
  if (elapsed < 60) return `${elapsed}s ago`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  return `${Math.floor(elapsed / 3600)}h ago`;
}

const RefreshStatus = React.memo(function RefreshStatus({ lastUpdated, refreshing }: { lastUpdated: number; refreshing: boolean }) {
  const [label, setLabel] = useState(() => formatRefreshLabel(lastUpdated));

  useEffect(() => {
    if (refreshing) {
      setLabel('refreshing...');
      return;
    }
    setLabel(formatRefreshLabel(lastUpdated));
    const t = setInterval(() => setLabel(formatRefreshLabel(lastUpdated)), 1000);
    return () => clearInterval(t);
  }, [lastUpdated, refreshing]);

  return <>{label}</>;
});

const LimitSectionHeader = React.memo(function LimitSectionHeader({ title, source }: { title: string; source?: string }) {
  const C = useTheme();
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 14px 4px', background: C.bgCard, borderBottom: `1px solid ${C.border}` }}>
      <span style={{ fontSize: 9, color: C.textMuted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8 }}>{title}</span>
      {source && (
        <span title="Limit source" style={{ fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: C.bgRow, color: C.textMuted, border: `1px solid ${C.border}` }}>
          {source}
        </span>
      )}
    </div>
  );
});

const LazySection = React.memo(function LazySection({ minHeight, children }: { minHeight: number; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { root: null, rootMargin: '280px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div ref={ref} style={{ minHeight: visible ? undefined : minHeight }}>
      {visible ? children : null}
    </div>
  );
});

function latestTime(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function sessionCtxPct(s: SessionInfo): number {
  return s.contextMax > 0 ? Math.min(100, (s.contextUsed / s.contextMax) * 100) : 0;
}

function buildSessionItems(branch: string, sessions: SessionInfo[]): SessionListItem[] {
  const items: SessionListItem[] = [];
  const stackable = new Map<string, SessionInfo[]>();

  for (const session of sessions) {
    if (session.state === 'waiting' || session.state === 'idle') {
      const key = `${branch}|${session.provider}|${session.source}|${session.state}`;
      if (!stackable.has(key)) stackable.set(key, []);
      stackable.get(key)!.push(session);
    } else {
      items.push({ type: 'session', session });
    }
  }

  for (const [key, grouped] of stackable) {
    if (grouped.length < 3) {
      for (const session of grouped) items.push({ type: 'session', session });
      continue;
    }
    const first = grouped[0];
    items.push({
      type: 'stack',
      key,
      sessions: grouped,
      provider: first.provider,
      source: first.source,
      state: first.state,
      latest: grouped.reduce<string | null>((acc, s) => latestTime(acc, s.lastModified), null),
      maxCtxPct: Math.max(...grouped.map(sessionCtxPct)),
    });
  }

  return items.sort((a, b) => {
    const aTime = a.type === 'session' ? a.session.lastModified : a.latest;
    const bTime = b.type === 'session' ? b.session.lastModified : b.latest;
    return (bTime ? new Date(bTime).getTime() : 0) - (aTime ? new Date(aTime).getTime() : 0);
  });
}

const SessionStackRow = React.memo(function SessionStackRow({ item, expanded, onToggle }: {
  item: Extract<SessionListItem, { type: 'stack' }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const C = useTheme();
  const provider = item.provider === 'codex' ? 'Codex' : 'Claude';
  const chipColor = item.state === 'waiting' ? C.waiting : C.textMuted;
  return (
    <button
      onClick={onToggle}
      style={{
        width: 'calc(100% - 16px)',
        margin: '3px 8px 0',
        padding: '7px 10px',
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: C.bgRow,
        color: C.text,
        cursor: 'pointer',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        textAlign: 'left',
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>
          {item.sessions.length} {provider} {item.state} sessions
        </span>
        <span style={{ display: 'block', fontSize: 9, color: C.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.source} - latest {fmtRelative(item.latest)} - max ctx {Math.round(item.maxCtxPct)}%
        </span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: `${chipColor}1a`, color: chipColor, fontWeight: 700 }}>
          {expanded ? 'open' : 'stack'}
        </span>
        <span style={{ fontSize: 12, color: C.textMuted }}>{expanded ? '^' : 'v'}</span>
      </span>
    </button>
  );
});

export default function MainView({ state, onNav, onQuit, onRefresh }: Props) {
  const C = useTheme();
  const { sessions, usage, limits, settings, apiConnected, apiError, extraUsage } = state;
  const { currency, usdToKrw } = settings;
  const providerMode = settings.provider ?? 'both';
  const showClaudeUsage = providerMode !== 'codex';
  const showCodexUsage = providerMode !== 'claude';
  const cacheHeaderLabel = providerMode === 'codex' ? 'Cached Input' : providerMode === 'both' ? 'Cache Share' : 'Cache Efficiency';
  const cacheHeroColor = providerMode === 'claude' ? C.active : C.headerText;
  const cacheSavedColor = providerMode === 'claude' ? C.active : C.headerSub;
  const trackedH5 = useMemo(() => {
    if (providerMode === 'codex') return usage.h5Codex;
    if (providerMode === 'claude') return usage.h5;
    const cacheTokens = usage.h5.cacheReadTokens + usage.h5.cacheCreationTokens + usage.h5Codex.inputTokens + usage.h5Codex.cacheReadTokens;
    const cacheRead = usage.h5.cacheReadTokens + usage.h5Codex.cacheReadTokens;
    return {
      ...usage.h5,
      inputTokens: usage.h5.inputTokens + usage.h5Codex.inputTokens,
      outputTokens: usage.h5.outputTokens + usage.h5Codex.outputTokens,
      cacheCreationTokens: usage.h5.cacheCreationTokens + usage.h5Codex.cacheCreationTokens,
      cacheReadTokens: usage.h5.cacheReadTokens + usage.h5Codex.cacheReadTokens,
      totalTokens: usage.h5.totalTokens + usage.h5Codex.totalTokens,
      costUSD: usage.h5.costUSD + usage.h5Codex.costUSD,
      requestCount: usage.h5.requestCount + usage.h5Codex.requestCount,
      cacheEfficiency: cacheTokens > 0 ? (cacheRead / cacheTokens) * 100 : 0,
      cacheSavingsUSD: usage.h5.cacheSavingsUSD + usage.h5Codex.cacheSavingsUSD,
    };
  }, [providerMode, usage.h5, usage.h5Codex]);
  const hiddenProjects: string[] = settings.hiddenProjects ?? [];
  const excludedProjects: string[] = settings.excludedProjects ?? [];
  const [refreshing, setRefreshing] = useState(false);
  const [showHiddenManager, setShowHiddenManager] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<'all' | 'active'>('active');
  // 확장된 세션 ID (한 번에 하나만 — 새 세션 클릭 시 이전 자동 닫힘)
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(() => new Set());
  const [showStale, setShowStale] = useState(false);
  const [headerPeriod, setHeaderPeriod] = useState<'today' | 'all'>('today');

  const claudeLimitSource = useMemo(() => joinedSourceLabel(limits.h5.source, limits.week.source), [limits.h5.source, limits.week.source]);
  const codexLimitSource = useMemo(() => joinedSourceLabel(limits.codexH5.source, limits.codexWeek.source), [limits.codexH5.source, limits.codexWeek.source]);
  const allTimeCost = useMemo(() => usage.models.reduce((sum, model) => sum + model.costUSD, 0), [usage.models]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await window.wmt.forceRefresh();
      onRefresh();
    } catch {
      onRefresh();
    }
    setRefreshing(false);
  }

  const hideProject = useCallback((name: string) => {
    const next = [...hiddenProjects, name];
    setProjectMenuOpen(null);
    window.wmt.setSettings({ hiddenProjects: next }).catch(() => {});
  }, [hiddenProjects]);

  const unhideProject = useCallback((name: string) => {
    const next = hiddenProjects.filter(p => p !== name);
    window.wmt.setSettings({ hiddenProjects: next }).catch(() => {});
  }, [hiddenProjects]);

  const excludeProject = useCallback((name: string) => {
    const next = [...excludedProjects, name];
    setProjectMenuOpen(null);
    window.wmt.setSettings({ excludedProjects: next }).catch(() => {});
  }, [excludedProjects]);

  const unexcludeProject = useCallback((name: string) => {
    const next = excludedProjects.filter(p => p !== name);
    window.wmt.setSettings({ excludedProjects: next }).catch(() => {});
  }, [excludedProjects]);

  const toggleSession = useCallback((sessionId: string) => {
    setExpandedSession(prev => prev === sessionId ? null : sessionId);
  }, []);

  const toggleStack = useCallback((key: string) => {
    setExpandedStacks(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // idle 6h+ 세션 자동 숨김 (active 필터 시에도 적용)
  const STALE_MS = 6 * 60 * 60 * 1000; // 6시간
  const nowForSessions = state.lastUpdated || Date.now();
  const isStale = useCallback((s: typeof sessions[number]) => {
    if (s.state === 'active' || s.state === 'waiting') return false;
    if (!s.lastModified) return true;
    return nowForSessions - new Date(s.lastModified).getTime() > STALE_MS;
  }, [nowForSessions]);
  const staleSessions = useMemo(() => sessions.filter(isStale), [sessions, isStale]);
  const freshSessions = useMemo(() => sessions.filter(s => !isStale(s)), [sessions, isStale]);

  const filteredSessions = useMemo(() => activeFilter === 'active'
    ? freshSessions.filter(s => s.state === 'active' || s.state === 'waiting')
    : showStale ? sessions : freshSessions, [activeFilter, freshSessions, sessions, showStale]);

  // 2단계 그루핑: Project → Branch → Sessions
  // toplevel(git root)이 같으면 같은 프로젝트로 합치기 (worktree 통합)
  type BranchGroup = { branch: string; sessions: SessionInfo[]; items: SessionListItem[]; commits: number; added: number; removed: number };
  type ProjectGroup = { name: string; branches: BranchGroup[]; totalCommits: number; totalAdded: number; totalRemoved: number };
  const projectGroups: ProjectGroup[] = useMemo(() => {
    // gitCommonDir → 대표 프로젝트명 매핑
    // gitCommonDir은 같은 저장소의 모든 워크트리에서 동일한 값을 가짐
    const repoNames = new Map<string, string>();
    for (const s of filteredSessions) {
      const repoId = s.gitStats?.gitCommonDir ?? s.gitStats?.toplevel;
      if (repoId && !repoNames.has(repoId)) {
        // mainRepoName 우선, 없으면 gitCommonDir에서 .git 제거 후 마지막 폴더명 추출
        const nameFromCommonDir = s.gitStats?.gitCommonDir
          ?.replace(/[/\\]\.git$/, '').split(/[/\\]/).filter(Boolean).pop();
        repoNames.set(repoId, s.mainRepoName ?? nameFromCommonDir ?? s.gitStats?.toplevel?.split(/[\\/]/).filter(Boolean).pop() ?? s.projectName);
      }
    }
    const projMap: Record<string, typeof sessions> = {};
    for (const s of filteredSessions) {
      const repoId = s.gitStats?.gitCommonDir ?? s.gitStats?.toplevel;
      const key = repoId ? (repoNames.get(repoId) ?? s.projectName) : (s.mainRepoName ?? s.projectName);
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
            items: buildSessionItems(branch, bSess),
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
  }, [filteredSessions, hiddenProjects]);

  // all known project names (for unhide UI, include ones not currently in sessions)
  const allHidden = hiddenProjects;

  const showSonnet = settings.provider !== 'codex' &&
    (limits.so.pct > 0 || usage.sonnetWeekTokens > 0);
  const showExtraUsage = showClaudeUsage && !!extraUsage?.isEnabled;
  const extraUsageHigh = showExtraUsage && (extraUsage?.utilization ?? 0) >= 90;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, color: C.text, overflow: 'hidden' }}>

      {/* ── 헤더 — today/all 토글 + 2열 hero ─────────────────────── */}
      <div style={{ background: C.headerBg, flexShrink: 0, borderBottom: `1px solid ${C.headerBorder}` }}>

        {/* 행1: 로고 + [today][all] 토글 + 플랜 뱃지 + API 점 + 윈도우 컨트롤 */}
        <div style={{ ...drag, padding: '8px 12px 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: C.headerAccent, letterSpacing: -0.3, flexShrink: 0 }}>
            ⚡ WhereMyTokens
          </span>
          {/* today/all 토글 */}
          <div style={{ ...noDrag, display: 'flex', gap: 2, marginLeft: 6 }}>
            {(['today', 'all'] as const).map(p => (
              <button key={p} onClick={() => setHeaderPeriod(p)} style={{
                ...noDrag, padding: '2px 7px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
                fontFamily: C.fontMono, border: headerPeriod === p ? `1px solid ${C.accent}44` : '1px solid transparent',
                background: headerPeriod === p ? `${C.accent}22` : 'none',
                color: headerPeriod === p ? C.accent : C.headerSub, fontWeight: headerPeriod === p ? 700 : 400,
              }}>{p}</button>
            ))}
          </div>
          <div style={{ ...noDrag, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            {showClaudeUsage && state.autoLimits && (
              <span style={{ fontSize: 9, color: C.headerSub, background: 'rgba(255,255,255,0.1)', borderRadius: 3, padding: '1px 6px', fontWeight: 600, border: '1px solid rgba(255,255,255,0.15)' }}>
                {state.autoLimits.plan}
              </span>
            )}
            <span
              title={apiConnected ? 'API connected' : `API disconnected${apiError ? ` — ${apiError}` : ''}`}
              style={{ width: 6, height: 6, borderRadius: '50%', background: apiConnected ? '#4ade80' : '#f87171', display: showClaudeUsage ? 'inline-block' : 'none', flexShrink: 0 }}
            />
            <button onClick={() => window.wmt.minimize().catch(() => {})} title="Minimize" style={{ ...noDrag, width: 24, height: 20, background: 'none', border: 'none', color: C.headerSub, cursor: 'pointer', fontSize: 16, borderRadius: 4, lineHeight: 1, fontWeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
            <button onClick={onQuit} title="Quit" style={{ ...noDrag, width: 24, height: 20, background: 'none', border: 'none', color: C.headerSub, cursor: 'pointer', fontSize: 14, borderRadius: 4, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
          </div>
        </div>

        {/* 행2: Cost (좌) + Cache % (우) — 2열 hero */}
        {(() => {
          const isAll = headerPeriod === 'all';
          const cost = isAll ? usage.allTimeCost : usage.todayCost;
          const calls = isAll ? usage.allTimeRequestCount : usage.todayRequestCount;
          const sess = isAll ? state.allTimeSessions : sessions.length;
          const cacheEff = isAll ? usage.allTimeAvgCacheEfficiency : trackedH5.cacheEfficiency;
          const saved = isAll ? usage.allTimeSavedUSD : trackedH5.cacheSavingsUSD;
          const inTok = isAll ? usage.allTimeInputTokens : usage.todayInputTokens;
          const outTok = isAll ? usage.allTimeOutputTokens : usage.todayOutputTokens;
          const cacheTok = isAll ? usage.allTimeCacheTokens : usage.todayCacheTokens;

          return (<>
            <div style={{ ...drag, display: 'grid', gridTemplateColumns: '1fr 1fr', padding: '2px 14px 7px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              {/* 좌: 비용 */}
              <div>
                <div style={{ fontSize: 8, color: C.headerSub, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 2 }}>
                  {isAll ? 'All-time Cost' : 'Today Cost'}
                </div>
                <div style={{ fontSize: 26, fontWeight: 800, color: C.headerText, lineHeight: 1, fontFamily: C.fontMono }}>
                  {fmtCost(cost, currency, usdToKrw)}
                </div>
                <div style={{ fontSize: 9, color: C.headerSub, marginTop: 3 }}>
                  <span style={{ fontFamily: C.fontMono, fontWeight: 700, color: C.headerText }}>{fmtTokens(calls)}</span> calls · <span style={{ fontFamily: C.fontMono, fontWeight: 700, color: C.headerText }}>{sess}</span> sessions
                </div>
              </div>
              {/* 우: 캐시 효율 */}
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 8, color: C.headerSub, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 2 }}>
                  {isAll ? `Avg ${cacheHeaderLabel}` : cacheHeaderLabel}
                </div>
                <div style={{ fontSize: 26, fontWeight: 800, color: cacheHeroColor, lineHeight: 1, fontFamily: C.fontMono }}>
                  {Math.round(cacheEff)}%
                </div>
                <div style={{ fontSize: 9, color: cacheSavedColor, marginTop: 3 }}>
                  ✦ {fmtCost(saved, currency, usdToKrw)} saved{isAll ? ' total' : ' today'}
                </div>
              </div>
            </div>

            {/* 행3: 토큰 breakdown (In / Out / Cache) */}
            <div style={{ ...drag, padding: '6px 14px 8px', display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: C.headerSub }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.input, flexShrink: 0 }} />
                In <span style={{ fontFamily: C.fontMono, fontWeight: 600, color: C.input }}>{fmtTokens(inTok)}</span>
              </div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: C.headerSub }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.output, flexShrink: 0 }} />
                Out <span style={{ fontFamily: C.fontMono, fontWeight: 600, color: C.output }}>{fmtTokens(outTok)}</span>
              </div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: C.headerSub }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.cacheR, flexShrink: 0 }} />
                Cache <span style={{ fontFamily: C.fontMono, fontWeight: 600, color: C.cacheR }}>{fmtTokens(cacheTok)}</span>
              </div>
            </div>
          </>);
        })()}

      </div>

      {/* scroll area */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 8 }}>

        {/* ── Plan Usage 카드 ───────────────────────────────────────────── */}
        {extraUsageHigh && extraUsage && (
          <div style={{ margin: '10px 8px 0' }}>
            <ExtraUsageCard extraUsage={extraUsage} variant="banner" />
          </div>
        )}

        <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
          {/* 헤더 */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '6px 14px 5px 12px', background: C.bgRow, borderBottom: `1px solid ${C.border}` }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Plan Usage</span>
          </div>

          {/* Claude: 5h | 1w 나란히 (CSS Grid 2열, 동일 폭) */}
          {showClaudeUsage && (
            <>
              <LimitSectionHeader title="Claude limits" source={claudeLimitSource} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: `1px solid ${C.border}` }}>
              <TokenStatsCard provider="Claude" period="5h" stats={usage.h5} currency={currency} usdToKrw={usdToKrw}
                limitPct={limits.h5.pct} resetMs={limits.h5.resetMs} apiConnected={apiConnected} burnRate={usage.burnRate}
                hero borderRight />
              <TokenStatsCard provider="Claude" period="1w" stats={usage.week} currency={currency} usdToKrw={usdToKrw}
                limitPct={limits.week.pct} resetMs={limits.week.resetMs} apiConnected={apiConnected}
                hero />
              </div>
            </>
          )}

          {/* Codex: 5h | 1w (데이터 있을 때만) */}
          {showCodexUsage && (providerMode === 'codex' || usage.h5Codex.totalTokens > 0 || usage.weekCodex.totalTokens > 0 || limits.codexH5.pct > 0 || limits.codexWeek.pct > 0) && (
            <>
              <LimitSectionHeader title="Codex local limits" source={codexLimitSource} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: `1px solid ${C.border}` }}>
              <TokenStatsCard provider="Codex" period="5h" stats={usage.h5Codex} currency={currency} usdToKrw={usdToKrw}
                limitPct={limits.codexH5.pct} resetMs={limits.codexH5.resetMs} apiConnected={true}
                cacheMetricMode="cachedInput" hero borderRight />
              <TokenStatsCard provider="Codex" period="1w" stats={usage.weekCodex} currency={currency} usdToKrw={usdToKrw}
                limitPct={limits.codexWeek.pct} resetMs={limits.codexWeek.resetMs} apiConnected={true}
                cacheMetricMode="cachedInput" hero />
              </div>
            </>
          )}

          {/* Sonnet 1w (Plan Usage 내부, 동일 행 패턴) */}
          {showSonnet && (
            <div style={{ borderBottom: `1px solid ${C.border}` }}>
              <TokenStatsCard provider="Sonnet" period="1w" stats={{
                inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
                totalTokens: usage.sonnetWeekTokens, costUSD: 0, requestCount: 0, cacheEfficiency: 0, cacheSavingsUSD: 0,
              }} currency={currency} usdToKrw={usdToKrw}
                limitPct={limits.so.pct} resetMs={limits.so.resetMs} apiConnected={apiConnected}
                hideCost />
            </div>
          )}

          {/* Extra Usage (Plan Usage 내부, 동일 행 패턴) */}
          {showExtraUsage && !extraUsageHigh && extraUsage && (
            <div>
              <ExtraUsageCard extraUsage={extraUsage} />
            </div>
          )}
        </div>

        {/* ── Code Output 카드 ────────────────────────────────────────── */}
        <CodeOutputCard sessions={sessions} repoGitStats={state.repoGitStats} todayCost={usage.todayCost} allTimeCost={allTimeCost} currency={currency} usdToKrw={usdToKrw} />

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
              <div key={proj.name}>
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
                    <div style={{ position: 'relative' }}>
                      <button
                        onClick={() => setProjectMenuOpen(open => open === proj.name ? null : proj.name)}
                        title="Project actions"
                        style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textMuted, cursor: 'pointer', fontSize: 11, padding: '0 6px', lineHeight: 1.4, borderRadius: 4 }}
                      >
                        ...
                      </button>
                      {projectMenuOpen === proj.name && (
                        <div style={{ position: 'absolute', right: 0, top: 20, zIndex: 5, display: 'grid', gap: 2, padding: 4, background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 6, boxShadow: '0 8px 20px rgba(0,0,0,0.25)' }}>
                          <button onClick={() => hideProject(proj.name)} style={{ background: C.bgRow, border: `1px solid ${C.border}`, color: C.textDim, cursor: 'pointer', fontSize: 10, padding: '3px 8px', borderRadius: 3, textAlign: 'left' }}>Hide</button>
                          <button onClick={() => excludeProject(proj.name)} style={{ background: C.bgRow, border: `1px solid ${C.border}`, color: C.textDim, cursor: 'pointer', fontSize: 10, padding: '3px 8px', borderRadius: 3, textAlign: 'left' }}>Exclude</button>
                        </div>
                      )}
                    </div>
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
                    {br.items.map(item => item.type === 'stack' ? (
                      <React.Fragment key={item.key}>
                        <SessionStackRow
                          item={item}
                          expanded={expandedStacks.has(item.key)}
                          onToggle={() => toggleStack(item.key)}
                        />
                        {expandedStacks.has(item.key) && item.sessions.map(s => (
                          <SessionRow
                            key={s.sessionId}
                            session={s}
                            expanded={expandedSession === s.sessionId}
                            onToggle={() => toggleSession(s.sessionId)}
                          />
                        ))}
                      </React.Fragment>
                    ) : (
                      <SessionRow
                        key={item.session.sessionId}
                        session={item.session}
                        expanded={expandedSession === item.session.sessionId}
                        onToggle={() => toggleSession(item.session.sessionId)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ))
            : sessions.length === 0
              ? <div style={{ padding: '10px 14px', fontSize: 12, color: C.textMuted }}>No active {providerMode === 'codex' ? 'Codex' : providerMode === 'claude' ? 'Claude Code' : 'Claude Code or Codex'} sessions</div>
              : null
          }

          {/* idle 6h+ 숨겨진 세션 토글 */}
          {staleSessions.length > 0 && activeFilter === 'all' && (
            <div style={{ padding: '6px 14px', display: 'flex', justifyContent: 'center' }}>
              <button
                onClick={() => setShowStale(v => !v)}
                style={{
                  background: 'none', border: `1px solid ${C.border}`, borderRadius: 10,
                  color: C.textMuted, cursor: 'pointer', fontSize: 9, padding: '3px 12px',
                  fontFamily: C.fontMono,
                }}
              >
                {showStale ? '▲ Hide' : '▼ Show'} {staleSessions.length} idle session{staleSessions.length > 1 ? 's' : ''}
              </button>
            </div>
          )}

          {/* 숨긴 프로젝트 관리 */}
          {allHidden.length > 0 && (
            <div style={{ padding: '4px 14px', marginTop: 8, borderTop: `1px solid ${C.border}` }}>
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
        <LazySection minHeight={220}>
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
        </LazySection>

        {/* ── Model Usage 카드 ──────────────────────────────────────────── */}
        <LazySection minHeight={130}>
          <div style={{ margin: '10px 8px 0', background: C.bgCard, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
            <ModelBreakdown models={usage.models} currency={currency} usdToKrw={usdToKrw} />
          </div>
        </LazySection>

      </div>

      {/* bottom tabs */}
      <div style={{ display: 'flex', borderTop: `1px solid ${C.border}`, flexShrink: 0, background: C.bgCard }}>
        {[
          { key: 'settings',      icon: '⚙',  label: 'Settings' },
          { key: 'notifications', icon: '🔔', label: 'Alerts' },
          { key: 'help',          icon: '?',  label: 'Help' },
          { key: 'refresh',       icon: '↺',  label: <RefreshStatus lastUpdated={state.lastUpdated} refreshing={refreshing} /> },
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
