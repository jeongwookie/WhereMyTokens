import React, { useState } from 'react';
import { Hash, Activity, Signal, GitBranch, Code } from 'lucide-react';
import { useTheme } from '../ThemeContext';
import ViewHeader from '../components/ViewHeader';

interface Props { onBack: () => void }
type Lang = 'en' | 'ko' | 'ja';

function B({ children }: { children: React.ReactNode }) {
  const C = useTheme();
  return <span style={{ color: C.text, fontWeight: 600 }}>{children}</span>;
}

function Note({ children }: { children: React.ReactNode }) {
  const C = useTheme();
  return (
    <div style={{
      fontSize: 11, color: C.textMuted, marginTop: 6,
      padding: '6px 9px', background: C.bgRow, borderRadius: 5,
      lineHeight: 1.65,
    }}>
      {children}
    </div>
  );
}

function Section({ icon, title, children }: {
  icon: React.ReactNode; title: string; children: React.ReactNode;
}) {
  const C = useTheme();
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <span style={{ display: 'flex', alignItems: 'center', color: C.accent }}>{icon}</span>
        <span style={{
          fontSize: 11.5, fontWeight: 700, color: C.accent,
          letterSpacing: '0.06em', textTransform: 'uppercase' as const,
        }}>{title}</span>
      </div>
      <div style={{ fontSize: 12.5, color: C.textDim, lineHeight: 1.75 }}>{children}</div>
    </div>
  );
}

function Divider() {
  const C = useTheme();
  return <div style={{ height: 1, background: C.border, margin: '18px 0' }} />;
}

function InfoRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  const C = useTheme();
  return (
    <div style={{
      display: 'flex', gap: 8, alignItems: 'flex-start',
      padding: '5px 8px', background: C.bgRow, borderRadius: 5,
    }}>
      <span style={{ fontWeight: 700, color: C.text, whiteSpace: 'nowrap' as const, flexShrink: 0 }}>{label}</span>
      <span style={{ color: C.textDim }}>{children}</span>
    </div>
  );
}

function SrcRow({ badge, children }: { badge: '1st' | '2nd' | 'FB'; children: React.ReactNode }) {
  const C = useTheme();
  const colors = {
    '1st': { bg: C.accent + '14', color: C.accent },
    '2nd': { bg: C.waiting + '14', color: C.waiting },
    'FB':  { bg: C.textMuted + '20', color: C.textMuted },
  };
  const s = colors[badge];
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 7, alignItems: 'flex-start' }}>
      <span style={{
        fontSize: 11, fontWeight: 700, padding: '2px 6px',
        borderRadius: 3, whiteSpace: 'nowrap' as const, marginTop: 1, flexShrink: 0,
        background: s.bg, color: s.color,
      }}>{badge}</span>
      <span>{children}</span>
    </div>
  );
}

function CatRow({ icon, label, color, children }: {
  icon: string; label: string; color: string; children: React.ReactNode;
}) {
  const C = useTheme();
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 5, alignItems: 'flex-start' }}>
      <span style={{
        fontSize: 10.5, fontWeight: 700, padding: '2px 6px',
        borderRadius: 3, whiteSpace: 'nowrap' as const, flexShrink: 0,
        background: color + '20', color, border: `1px solid ${color}44`,
        display: 'inline-flex', alignItems: 'center', gap: 3,
      }}>
        {icon} {label}
      </span>
      <span style={{ fontSize: 11, color: C.textMuted }}>{children}</span>
    </div>
  );
}

function UsageTable({ rows, headers }: {
  headers: [string, string, string, string];
  rows: [string, string, string, string][];
}) {
  const C = useTheme();
  const TH: React.CSSProperties = {
    textAlign: 'left', fontSize: 11.5, fontWeight: 600,
    color: C.textMuted, paddingBottom: 5, paddingRight: 8,
    borderBottom: `1px solid ${C.borderSub}`,
  };
  const TD: React.CSSProperties = {
    fontSize: 11.5, color: C.textDim,
    padding: '4px 8px 4px 0', verticalAlign: 'top',
  };
  const TD_LABEL: React.CSSProperties = { ...TD, fontWeight: 600, color: C.text };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', margin: '8px 0 6px' }}>
      <thead><tr>{headers.map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            <td style={{ ...TD_LABEL, borderBottom: i < rows.length - 1 ? `1px solid ${C.borderSub}` : 'none' }}>{row[0]}</td>
            {row.slice(1).map((cell, j) => (
              <td key={j} style={{ ...TD, borderBottom: i < rows.length - 1 ? `1px solid ${C.borderSub}` : 'none' }}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── English ─────────────────────────────────────────────────────────────────
function ContentEN() {
  return (
    <>
      <Section icon={<Signal size={15} />} title="Provider Tracking">
        <div style={{ marginBottom: 6 }}>
          WhereMyTokens can track <B>Claude Code</B>, <B>Codex</B>, and <B>Antigravity</B>. Use Settings → Providers to choose enabled providers with checkboxes.
        </div>
        <div style={{ marginBottom: 5 }}><B>Claude</B> reads local Claude session/JSONL files and uses the Anthropic API or statusLine bridge for 5h/1w limits.</div>
        <div><B>Codex</B> prefers live Codex usage for 5h/1w limits and reset-credit checks for available resets. Limit windows can fall back to cached data and local <code>~/.codex/sessions/**/*.jsonl</code>, <code>~/.codex/archived_sessions/**/*.jsonl</code>, and <code>~/.codex/session-cleanup-archive/**/*.jsonl</code> rate-limit events; reset credits fall back only to auth-bound cache or count-only live usage payloads. Local logs still power model usage, token counts, cached input, tool events, and reset events.</div>
        <div style={{ marginTop: 5 }}><B>Antigravity</B> reads only the running Antigravity IDE language server on <code>127.0.0.1</code> for sessions, model quota percentages, and token metadata. It does not use Google OAuth, refresh tokens, or cloud fallback requests.</div>
      </Section>

      <Divider />

      <Section icon={<Hash size={15} />} title="Numbers & Cost">
        <div style={{ marginBottom: 6 }}>
          <B>tok</B> = input + output + cache creation + cache reads. Claude includes cache creation/read tokens; Codex reports uncached input, cached input, and output from local token_count events.
        </div>
        <div style={{ marginBottom: 6 }}>
          <B>Cache Efficiency</B> uses provider-specific math: Claude = cache read ÷ (cache read + cache creation); Codex and Antigravity = cache read ÷ prompt tokens.
        </div>
        <UsageTable
          headers={['Display', 'Scope', 'tok', '$']}
          rows={[
            ['Header (today)', 'Today since midnight', 'In/Out/Cache + calls, sessions', 'API-equiv + cache savings'],
            ['Header (all)', 'All time', 'In/Out/Cache + calls, sessions', 'API-equiv + cache savings'],
            ['Plan Usage', 'Current billing window', 'All types', 'API-equiv'],
            ['Code Output', 'Today / All time', 'Git stats', '$/100 added'],
            ['Model Usage', 'All time, top 4 models', 'All types', 'API-equiv'],
          ]}
        />
        <Note>
          <B>$</B> is an API-equivalent estimate — not your actual bill. Max/Pro subscriptions are flat monthly fees.
        </Note>
      </Section>

      <Divider />

      <Section icon={<Code size={15} />} title="Code Output">
        <div style={{ marginBottom: 5 }}><B>Commits</B> — number of git commits in the period.</div>
        <div style={{ marginBottom: 5 }}><B>Net Lines</B> — lines added minus lines removed (net change).</div>
        <div style={{ marginBottom: 5 }}><B>$/100 Added</B> — cost per 100 lines of code added. <B>today</B> tab shows today's actual cost-per-added-line with the all-time average for comparison. <B>all</B> tab shows the all-time average $/100 added. Lower = more efficient.</div>
        <div style={{ marginBottom: 5 }}><B>Output Growth</B> — all-time cumulative net line progress with today's commit count.</div>
        <div style={{ marginBottom: 5 }}><B>today / all</B> — toggle between today and all-time stats. All-time session counts come from usage-bearing history logs.</div>
        <div style={{ marginBottom: 5 }}><B>Current session repo scope</B> — git totals follow repos linked to the sessions currently tracked in the dashboard, so they can differ from just the repo you are viewing.</div>
        <div style={{ marginBottom: 5 }}><B>All-time scope</B> — counts commits and line changes across local branches, not only the current HEAD.</div>
        <div><B>Author filter</B> — only your own commits are counted, filtered by your local <code>git config user.email</code>.</div>
      </Section>

      <Divider />

      <Section icon={<GitBranch size={15} />} title="Sessions">
        <div style={{ marginBottom: 5 }}><B>Project → Branch → Session</B> — sessions are grouped by git project, then by branch.</div>
        <div style={{ marginBottom: 5 }}><B>Provider chips</B> — Claude and Codex sessions can appear in the same project/branch list, with distinct model colors.</div>
        <div style={{ marginBottom: 5 }}><B>Recent + active scope</B> — the popup keeps the session list focused on active sessions plus recently touched work instead of expanding to the full local archive on every refresh.</div>
        <div style={{ marginBottom: 5 }}><B>Stack rows</B> — repeated sessions with the same provider/source/model/state are grouped to keep scrolling light. Expand a stack to inspect each session.</div>
        <div style={{ marginBottom: 5 }}><B>Branch limit</B> — each branch shows the first 3 rows by default; use "Show N more" for the rest.</div>
        <div style={{ marginBottom: 5 }}><B>Cache efficiency</B> — Claude and Codex use different local metrics but share the same green/yellow/red header style.</div>
        <div style={{ marginBottom: 5 }}><B>Context bar</B> — amber at 70%, orange at 85%, red at 95%. "⚠ near limit" at 95-99%, "⚠ at limit" at 100%.</div>
        <div style={{ marginBottom: 7 }}><B>Activity Breakdown</B> — click <B>Details</B> on a session row. Claude shows per-category output-token breakdown. Codex shows per-category tool event counts because Codex logs expose tool calls rather than per-tool output tokens.</div>
        <CatRow icon="💭" label="Thinking" color="#2dd4bf">Extended thinking blocks</CatRow>
        <CatRow icon="💬" label="Response" color="#94a3b8">Text blocks — the final answer text</CatRow>
        <CatRow icon="📄" label="Read" color="#60a5fa">Read tool</CatRow>
        <CatRow icon="✏️" label="Edit/Write" color="#a78bfa">Edit · Write · MultiEdit · NotebookEdit</CatRow>
        <CatRow icon="🔍" label="Search" color="#38bdf8">Grep · Glob · LS · TodoRead · TodoWrite</CatRow>
        <CatRow icon="🌿" label="Git" color="#4ade80">Bash — commands starting with git</CatRow>
        <CatRow icon="⚙️" label="Build/Test" color="#fb923c">Bash — npm, tsc, jest, cargo, python, go build…</CatRow>
        <CatRow icon="💻" label="Terminal" color="#fbbf24">Other Bash commands · mcp__* tools</CatRow>
        <CatRow icon="🤖" label="Subagents" color="#f472b6">Agent tool</CatRow>
        <CatRow icon="🌐" label="Web" color="#c084fc">WebFetch · WebSearch</CatRow>
        <Note>Attribution: each turn's output tokens are split across content blocks by character proportion (block chars ÷ total chars × output tokens). Zero-value categories are hidden.</Note>
      </Section>

      <Divider />

      <Section icon={<Activity size={15} />} title="Activity">
        <div style={{ marginBottom: 5 }}><B>Trend</B> — daily, weekly, or monthly cost/token history with git net-line output. Click a bucket to open provider input/output, thinking/response/tool usage, cache work/billing tokens, and git net-line categories.</div>
        <div style={{ marginBottom: 5 }}><B>7d</B> — 7-day × 24-hour heatmap grid.</div>
        <div style={{ marginBottom: 5 }}><B>5mo</B> — 5-month GitHub-style calendar. Hover for date + tokens.</div>
        <div style={{ marginBottom: 5 }}><B>Hourly</B> — Token distribution by hour across the last 30 days.</div>
        <div style={{ marginBottom: 5 }}><B>Weekly</B> — Last 4 weeks horizontal bar chart.</div>
        <div><B>Rhythm</B> — Time-of-day cost distribution (Morning/Afternoon/Evening/Night) over the last 30 days with gradient bars, peak detail stats (tokens, cost, requests %), and local timezone.</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="Startup & Status">
        <div style={{ marginBottom: 5 }}><B>Partial History</B> — on startup the dashboard shows current sessions and recent usage first. Older history syncs in budgeted background slices so the tray app and hotkey popup stay responsive.</div>
        <div style={{ marginBottom: 5 }}><B>Header metadata</B> — Claude and Codex details in the top bar are read-only labels, not action buttons. Enabled providers decide which details appear.</div>
        <div style={{ marginBottom: 5 }}><B>Header widget toggle</B> — the small PiP button in the top bar shows or hides the floating Quota Pace widget without opening Settings.</div>
        <div style={{ marginBottom: 5 }}><B>Header status pill</B> — one pill in the top bar summarizes the most important provider health state and names the affected provider. Claude may show refresh/login/failed states while OAuth usage data recovers. Quota Pace Health shows separate chips such as <B>Claude OK</B> and <B>Codex OK</B>.</div>
        <div style={{ marginBottom: 5 }}><B>Source chips</B> — <B>API</B> means provider account usage, <B>Bridge</B> means Claude statusLine fallback, <B>RPC</B> means a local provider runtime snapshot, <B>Cache</B> means the last trusted snapshot, and <B>Log</B> means a local session-log estimate.</div>
        <div style={{ marginBottom: 5 }}><B>Waiting / Syncing</B> — a limit card shows a soft loading state while provider data is still arriving instead of showing an empty dash.</div>
        <div><B>Ledger Needs Rebuild</B> — historical totals fall back to recent data when the local aggregate ledger cannot safely repair itself. Open Settings → Data → Rebuild ledger to replay local history.</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="Data Sources">
        <SrcRow badge="1st">
          <B>Local sources</B> — Enabled Claude JSONL and Codex JSONL providers are parsed locally. Antigravity reads the running IDE language server over local RPC only.
        </SrcRow>
        <SrcRow badge="2nd">
          <B>Limit sources</B> — Claude uses Anthropic API first, then Bridge/Cache fallback. If the local Claude access token expires, the app can refresh it with Anthropic and write updated credentials back atomically. Codex uses live usage for 5h/1w limits and a reset-credit request for reset availability; 5h/1w can fall back to Cache/Log, while reset credits fall back only to auth-bound Cache or count-only live usage payloads. Antigravity uses local RPC model quotas only. Live requests run only for enabled providers and are spaced by a few minutes.
        </SrcRow>
        <SrcRow badge="FB">
          <B>Last cached value</B> — kept when live limit data is unavailable. Claude API cache is tied to the current Claude login, and stale data past its reset window is auto-cleared on startup. Codex reset-credit cache is tied to the current Codex auth file and stores counts, expiry times, fetch status, source labels, a hashed auth marker, and the auth file modified time.
        </SrcRow>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <InfoRow label="Provider">Settings → Tracking uses provider checkboxes. Disabled providers are not scanned locally and do not make live usage requests.</InfoRow>
          <InfoRow label="Quota display">Settings → Quota display controls Rich, Simple, or hidden presentation per provider window or model target. It changes Plan Usage and the floating widget; Codex Resets is Plan Usage only.</InfoRow>
          <InfoRow label="Claude OAuth">Expired Claude access tokens may be refreshed through Anthropic for usage polling. WhereMyTokens does not keep a separate credential backup.</InfoRow>
          <InfoRow label="Bridge">Settings → Claude Code Integration → Setup.</InfoRow>
          <InfoRow label="Widget">Settings → Floating usage widget or the main header PiP button opens the always-on-top compact Quota Pace window. It compares used % with elapsed %, and yellow/red means usage is ahead of the reset window. Waiting animations are off by default; enable Settings → Waiting animation if you want them.</InfoRow>
        </div>
      </Section>
    </>
  );
}

// ─── Korean ──────────────────────────────────────────────────────────────────
function ContentKO() {
  return (
    <>
      <Section icon={<Signal size={15} />} title="Provider 추적">
        <div style={{ marginBottom: 6 }}>
          WhereMyTokens는 <B>Claude Code</B>, <B>Codex</B>, <B>Antigravity</B>를 추적할 수 있습니다. Settings → Providers에서 provider 체크박스로 켜고 끕니다.
        </div>
        <div style={{ marginBottom: 5 }}><B>Claude</B>는 로컬 Claude 세션/JSONL 파일을 읽고, 5h/1w 한도는 Anthropic API 또는 statusLine 브리지를 사용합니다.</div>
        <div><B>Codex</B>는 5h/1w 한도에는 live Codex usage를, reset credit 표시는 reset-credit 조회를 우선 사용합니다. 5h/1w 한도는 캐시와 로컬 <code>~/.codex/sessions/**/*.jsonl</code>, <code>~/.codex/archived_sessions/**/*.jsonl</code>, <code>~/.codex/session-cleanup-archive/**/*.jsonl</code> 로그의 rate-limit 이벤트로 폴백할 수 있지만, reset credit은 auth-bound 캐시나 live usage payload의 count-only 값이 있을 때만 폴백합니다. 로컬 로그는 모델 사용량, 토큰 수, cached input, 툴 이벤트, reset 이벤트 계산에도 쓰입니다.</div>
        <div style={{ marginTop: 5 }}><B>Antigravity</B>는 실행 중인 Antigravity IDE language server를 <code>127.0.0.1</code> local RPC로만 읽어 세션, 모델 quota %, token metadata를 가져옵니다. Google OAuth, refresh token, cloud fallback 요청은 사용하지 않습니다.</div>
      </Section>

      <Divider />

      <Section icon={<Hash size={15} />} title="수치 & 비용">
        <div style={{ marginBottom: 6 }}>
          <B>tok</B> = input + output + 캐시 생성 + 캐시 읽기. Claude는 cache creation/read를 포함하고, Codex는 로컬 token_count 이벤트의 uncached input, cached input, output을 사용합니다.
        </div>
        <div style={{ marginBottom: 6 }}>
          <B>Cache Efficiency</B> 계산식은 provider별로 다릅니다. Claude = cache read ÷ (cache read + cache creation), Codex/Antigravity = cache read ÷ prompt tokens.
        </div>
        <UsageTable
          headers={['표시 위치', '범위', 'tok', '$']}
          rows={[
            ['헤더 (today)', '오늘 자정 이후', 'In/Out/Cache + 호출·세션', 'API 환산 + 캐시 절약'],
            ['헤더 (all)', '전체 기간', 'In/Out/Cache + 호출·세션', 'API 환산 + 캐시 절약'],
            ['Plan Usage', '현재 빌링 창', '전체', 'API 환산'],
            ['Code Output', '오늘 / 전체 기간', 'Git 통계', '$/100 added'],
            ['Model Usage', '전체 기간, 상위 4개 모델', '전체', 'API 환산'],
          ]}
        />
        <Note>
          <B>$</B>는 API 환산 추정값입니다 — 실제 청구액이 아닙니다. Max/Pro 구독은 월정액.
        </Note>
      </Section>

      <Divider />

      <Section icon={<Code size={15} />} title="Code Output">
        <div style={{ marginBottom: 5 }}><B>Commits</B> — 해당 기간의 git 커밋 수.</div>
        <div style={{ marginBottom: 5 }}><B>Net Lines</B> — 추가 라인 - 삭제 라인 (순 변경량).</div>
        <div style={{ marginBottom: 5 }}><B>$/100 Added</B> — 100 라인 추가당 비용. <B>today</B> 탭은 오늘의 실제 추가 라인당 비용과 전체 평균을 비교 표시. <B>all</B> 탭은 전체 기간 평균 $/100 added. 값이 낮을수록 효율적.</div>
        <div style={{ marginBottom: 5 }}><B>Output Growth</B> — 전체 기간 순 라인 누적 성장과 오늘 커밋 수를 보여줍니다.</div>
        <div style={{ marginBottom: 5 }}><B>today / all</B> — 오늘과 전체 기간 통계 전환. 전체 기간 세션 수는 사용량이 있는 전체 기록 로그 기준입니다.</div>
        <div style={{ marginBottom: 5 }}><B>현재 세션 repo 범위</B> — git 합계는 대시보드에서 현재 추적 중인 세션에 연결된 repo 기준으로 잡히므로, 지금 보고 있는 단일 저장소 값과 다를 수 있습니다.</div>
        <div style={{ marginBottom: 5 }}><B>전체 기간 범위</B> — 현재 HEAD만이 아니라 로컬 브랜치 전체의 커밋과 라인 변경을 집계합니다.</div>
        <div><B>작성자 필터</B> — 본인 커밋만 집계됩니다. 로컬 <code>git config user.email</code> 기준으로 자동 필터링.</div>
      </Section>

      <Divider />

      <Section icon={<GitBranch size={15} />} title="세션">
        <div style={{ marginBottom: 5 }}><B>프로젝트 → 브랜치 → 세션</B> — git 프로젝트별, 브랜치별로 그루핑.</div>
        <div style={{ marginBottom: 5 }}><B>Provider 칩</B> — Claude와 Codex 세션이 같은 프로젝트/브랜치 목록에 함께 표시되며, 모델별 색상이 구분됩니다.</div>
        <div style={{ marginBottom: 5 }}><B>Stack row</B> — provider/source/model/state가 같은 반복 세션은 묶어서 스크롤을 가볍게 유지합니다. stack을 펼치면 개별 세션을 볼 수 있습니다.</div>
        <div style={{ marginBottom: 5 }}><B>브랜치 제한</B> — 각 브랜치는 기본 3개 행만 표시하고, 나머지는 "Show N more"로 펼칩니다.</div>
        <div style={{ marginBottom: 5 }}><B>캐시 효율</B> — Claude와 Codex는 계산식은 다르지만 헤더에서는 동일한 green/yellow/red 스타일로 표시됩니다.</div>
        <div style={{ marginBottom: 5 }}><B>컨텍스트 바</B> — 70%에서 황색, 85%에서 주황, 95%에서 적색. 95-99% "⚠ near limit", 100% "⚠ at limit".</div>
        <div style={{ marginBottom: 7 }}><B>Activity Breakdown</B> — 세션 행의 <B>Details</B>를 누르면 열립니다. Claude는 카테고리별 output token 분석을 표시합니다. Codex는 per-tool output token이 아니라 tool call 로그가 있으므로 카테고리별 tool event count로 표시합니다.</div>
        <CatRow icon="💭" label="Thinking" color="#2dd4bf">확장 사고 블록</CatRow>
        <CatRow icon="💬" label="Response" color="#94a3b8">텍스트 블록 — 최종 응답 텍스트</CatRow>
        <CatRow icon="📄" label="Read" color="#60a5fa">Read 툴</CatRow>
        <CatRow icon="✏️" label="Edit/Write" color="#a78bfa">Edit · Write · MultiEdit · NotebookEdit</CatRow>
        <CatRow icon="🔍" label="Search" color="#38bdf8">Grep · Glob · LS · TodoRead · TodoWrite</CatRow>
        <CatRow icon="🌿" label="Git" color="#4ade80">Bash — git 명령</CatRow>
        <CatRow icon="⚙️" label="Build/Test" color="#fb923c">Bash — npm, tsc, jest, cargo, python 등</CatRow>
        <CatRow icon="💻" label="Terminal" color="#fbbf24">기타 Bash 명령 · mcp__* 툴</CatRow>
        <CatRow icon="🤖" label="Subagents" color="#f472b6">Agent 툴</CatRow>
        <CatRow icon="🌐" label="Web" color="#c084fc">WebFetch · WebSearch</CatRow>
        <Note>토큰 배분: 각 턴의 output 토큰을 컨텐츠 블록별 문자 수 비율로 분배합니다 (블록 문자 수 ÷ 전체 문자 수 × output 토큰). 값이 0인 카테고리는 표시되지 않습니다.</Note>
      </Section>

      <Divider />

      <Section icon={<Activity size={15} />} title="활동 탭">
        <div style={{ marginBottom: 5 }}><B>Trend</B> — 일/주/월 cost/token 히스토리와 git 순 라인 산출을 함께 보여줍니다. 버킷을 클릭하면 provider별 input/output, thinking/response/tool 사용량, cache work/billing 토큰, git 순 라인 카테고리를 확인할 수 있습니다.</div>
        <div style={{ marginBottom: 5 }}><B>7d</B> — 7일 × 24시간 히트맵 그리드.</div>
        <div style={{ marginBottom: 5 }}><B>5mo</B> — 5개월 GitHub 스타일 캘린더. 날짜+토큰 호버.</div>
        <div style={{ marginBottom: 5 }}><B>Hourly</B> — 시간대별 토큰 분포 (최근 30일).</div>
        <div style={{ marginBottom: 5 }}><B>Weekly</B> — 최근 4주 가로 바 차트.</div>
        <div><B>Rhythm</B> — 시간대별 비용 분포 (Morning/Afternoon/Evening/Night), 최근 30일, 그라데이션 바, 피크 상세 통계 (토큰, 비용, 요청 %), 로컬 타임존.</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="시작 상태 & 헤더 표시">
        <div style={{ marginBottom: 5 }}><B>Partial History</B> — 시작 직후에는 현재 세션과 최근 사용량을 먼저 보여주고, 오래된 히스토리는 budgeted background slice로 동기화합니다. 그래서 트레이 앱과 hotkey popup이 계속 빠르게 반응합니다.</div>
        <div style={{ marginBottom: 5 }}><B>헤더 메타데이터</B> — 상단의 Claude/Codex 정보는 클릭 버튼이 아니라 읽기 전용 라벨입니다. 켜진 provider에 따라 Claude만, Codex만, 또는 둘 다 표시됩니다.</div>
        <div style={{ marginBottom: 5 }}><B>헤더 상태 pill</B> — 상단 한 개의 pill이 핵심 provider health를 요약하고, 문제가 있는 provider 이름을 함께 표시합니다. Claude OAuth 사용량 데이터가 복구되는 동안 refresh/login/failed 상태가 표시될 수 있습니다. Quota Pace Health는 <B>Claude OK</B>, <B>Codex OK</B>처럼 provider별 칩을 따로 보여줍니다.</div>
        <div style={{ marginBottom: 5 }}><B>Source 칩</B> — <B>API</B>는 provider 계정 사용량, <B>Bridge</B>는 Claude statusLine 폴백, <B>RPC</B>는 로컬 provider runtime snapshot, <B>Cache</B>는 마지막 신뢰 snapshot, <B>Log</B>는 로컬 세션 로그 추정값입니다.</div>
        <div style={{ marginBottom: 5 }}><B>Waiting / Syncing</B> — provider 데이터가 아직 도착하지 않았을 때 한도 카드가 빈 dash 대신 부드러운 대기 상태를 보여줍니다.</div>
        <div><B>Ledger Needs Rebuild</B> — 로컬 aggregate ledger가 안전하게 복구할 수 없으면 historical totals는 최근 데이터 fallback을 사용합니다. Settings → Data → Rebuild ledger에서 로컬 히스토리를 다시 재생할 수 있습니다.</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="데이터 소스">
        <SrcRow badge="1st">
          <B>로컬 소스</B> — 켜진 Claude JSONL과 Codex JSONL provider는 로컬에서 파싱합니다. Antigravity는 실행 중인 IDE language server를 local RPC로만 읽습니다.
        </SrcRow>
        <SrcRow badge="2nd">
          <B>한도 소스</B> — Claude는 Anthropic API를 우선 사용하고 Bridge/Cache로 폴백합니다. 로컬 Claude access token이 만료되면 Anthropic을 통해 refresh하고 갱신된 credentials를 원자적으로 다시 쓸 수 있습니다. Codex는 5h/1w 한도에는 live usage를, reset 가능 수량에는 reset-credit 요청을 사용합니다. 5h/1w는 Cache/Log로 폴백할 수 있지만 reset credit은 auth-bound Cache 또는 live usage payload의 count-only 값으로만 폴백합니다. Antigravity는 local RPC model quota만 사용합니다. Live 요청은 켜진 provider에만 수행되며 몇 분 간격을 둡니다.
        </SrcRow>
        <SrcRow badge="FB">
          <B>마지막 캐시값</B> — 실시간 한도 데이터를 사용할 수 없을 때 직전 값을 유지합니다. Claude API 캐시는 현재 Claude 로그인에 묶이며, 리셋 시각이 지난 stale 데이터는 시작 시 자동 초기화합니다. Codex reset-credit 캐시는 현재 Codex auth file에 묶이며 count, 만료 시각, fetch 상태, source label, hashed auth marker, auth file modified time만 저장합니다.
        </SrcRow>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <InfoRow label="Provider">Settings → Tracking의 provider 체크박스로 선택합니다. 꺼진 provider는 로컬 스캔과 live usage 요청을 모두 하지 않습니다.</InfoRow>
          <InfoRow label="Quota display">Settings → Quota display에서 provider window 또는 model target별 Rich, Simple, 숨김 표시를 선택합니다. Plan Usage와 Floating widget 표시를 바꾸며, Codex Resets는 Plan Usage에만 표시됩니다.</InfoRow>
          <InfoRow label="Claude OAuth">만료된 Claude access token은 사용량 조회를 위해 Anthropic을 통해 refresh될 수 있습니다. WhereMyTokens는 별도 credentials 백업을 보관하지 않습니다.</InfoRow>
          <InfoRow label="Bridge">Settings → Claude Code Integration → Setup.</InfoRow>
          <InfoRow label="Widget">Settings → Floating usage widget 또는 메인 헤더 PiP 버튼으로 항상 위에 표시되는 작은 Quota Pace 창을 열고 닫을 수 있습니다. 사용률 %와 경과 시간 %를 비교하며, 노랑/빨강은 리셋 전 사용 속도가 빠르다는 뜻입니다. Waiting 애니메이션은 기본 꺼짐이며 Settings → Waiting animation에서 켤 수 있습니다.</InfoRow>
        </div>
      </Section>
    </>
  );
}

// ─── Japanese ────────────────────────────────────────────────────────────────
function ContentJA() {
  return (
    <>
      <Section icon={<Signal size={15} />} title="Provider 追跡">
        <div style={{ marginBottom: 6 }}>
          WhereMyTokens は <B>Claude Code</B>、<B>Codex</B>、<B>Antigravity</B> を追跡できます。Settings → Providers の provider チェックボックスで有効化します。
        </div>
        <div style={{ marginBottom: 5 }}><B>Claude</B> はローカルの Claude セッション/JSONL ファイルを読み取り、5h/1w 制限は Anthropic API または statusLine ブリッジを使います。</div>
        <div><B>Codex</B> は 5h/1w 制限では live Codex usage、reset credit 表示では reset-credit request を優先します。5h/1w 制限はキャッシュとローカルの <code>~/.codex/sessions/**/*.jsonl</code>、<code>~/.codex/archived_sessions/**/*.jsonl</code>、<code>~/.codex/session-cleanup-archive/**/*.jsonl</code> ログ内の rate-limit イベントへフォールバックできますが、reset credit は auth-bound cache または live usage payload の count-only 値がある場合だけフォールバックします。ローカルログはモデル使用量、トークン数、cached input、ツールイベント、reset イベント計算にも使います。</div>
        <div style={{ marginTop: 5 }}><B>Antigravity</B> は実行中の Antigravity IDE language server を <code>127.0.0.1</code> local RPC でのみ読み取り、セッション、モデル quota %、token metadata を取得します。Google OAuth、refresh token、cloud fallback request は使いません。</div>
      </Section>

      <Divider />

      <Section icon={<Hash size={15} />} title="数値とコスト">
        <div style={{ marginBottom: 6 }}>
          <B>tok</B> = input + output + キャッシュ生成 + キャッシュ読み取り。Claude は cache creation/read を含み、Codex はローカル token_count イベントの uncached input、cached input、output を使います。
        </div>
        <div style={{ marginBottom: 6 }}>
          <B>Cache Efficiency</B> は provider ごとに計算式が異なります。Claude = cache read ÷ (cache read + cache creation)、Codex/Antigravity = cache read ÷ prompt tokens。
        </div>
        <UsageTable
          headers={['表示場所', '集計期間', 'tok', '$']}
          rows={[
            ['ヘッダー (today)', '当日 0:00 以降', 'In/Out/Cache + 呼出数・セッション', 'API換算 + キャッシュ節約'],
            ['ヘッダー (all)', '全期間', 'In/Out/Cache + 呼出数・セッション', 'API換算 + キャッシュ節約'],
            ['Plan Usage', '現在の請求ウィンドウ', '全種別', 'API換算'],
            ['Code Output', '今日 / 全期間', 'Git統計', '$/100 added'],
            ['Model Usage', '全期間・上位4モデル', '全種別', 'API換算'],
          ]}
        />
        <Note>
          <B>$</B> は API 換算の概算値です — 実際の請求額とは異なります。Max/Pro は月額固定料金。
        </Note>
      </Section>

      <Divider />

      <Section icon={<Code size={15} />} title="Code Output">
        <div style={{ marginBottom: 5 }}><B>Commits</B> — 期間内の git コミット数。</div>
        <div style={{ marginBottom: 5 }}><B>Net Lines</B> — 追加行数 − 削除行数（純変更量）。</div>
        <div style={{ marginBottom: 5 }}><B>$/100 Added</B> — 100 行追加あたりのコスト。<B>today</B> タブは今日の実際の追加行あたりコストと全期間平均を比較表示。<B>all</B> タブは全期間平均の $/100 added。値が低いほど効率的。</div>
        <div style={{ marginBottom: 5 }}><B>Output Growth</B> — 全期間の純変更の累積成長と今日のコミット数を表示します。</div>
        <div style={{ marginBottom: 5 }}><B>today / all</B> — 今日と全期間の統計を切り替え。全期間のセッション数は使用量を含む履歴ログに基づきます。</div>
        <div style={{ marginBottom: 5 }}><B>現在のセッション repo 範囲</B> — git 合計はダッシュボードで現在追跡中のセッションに結び付いた repo を基準にするため、いま見ている単一リポジトリの値とは異なる場合があります。</div>
        <div style={{ marginBottom: 5 }}><B>全期間の範囲</B> — 現在の HEAD だけでなく、ローカルブランチ全体のコミットと行変更を集計します。</div>
        <div><B>作者フィルター</B> — 自分のコミットのみカウント。ローカルの <code>git config user.email</code> で自動フィルタリング。</div>
      </Section>

      <Divider />

      <Section icon={<GitBranch size={15} />} title="セッション">
        <div style={{ marginBottom: 5 }}><B>プロジェクト → ブランチ → セッション</B> — git プロジェクト別、ブランチ別にグループ化。</div>
        <div style={{ marginBottom: 5 }}><B>Provider チップ</B> — Claude と Codex のセッションを同じプロジェクト/ブランチ一覧に表示し、モデル色も区別します。</div>
        <div style={{ marginBottom: 5 }}><B>Stack row</B> — provider/source/model/state が同じ繰り返しセッションをまとめ、スクロールを軽くします。stack を展開すると個別セッションを確認できます。</div>
        <div style={{ marginBottom: 5 }}><B>ブランチ制限</B> — 各ブランチは最初の 3 行だけ表示し、残りは "Show N more" で展開します。</div>
        <div style={{ marginBottom: 5 }}><B>キャッシュ効率</B> — Claude と Codex は計算式が異なりますが、ヘッダーでは同じ green/yellow/red スタイルで表示します。</div>
        <div style={{ marginBottom: 5 }}><B>コンテキストバー</B> — 70% で琥珀色、85% でオレンジ、95% で赤。95-99% "⚠ near limit"、100% "⚠ at limit"。</div>
        <div style={{ marginBottom: 7 }}><B>Activity Breakdown</B> — セッション行の <B>Details</B> をクリックすると開きます。Claude はカテゴリ別 output token 内訳を表示します。Codex は per-tool output token ではなく tool call ログを持つため、カテゴリ別 tool event count として表示します。</div>
        <CatRow icon="💭" label="Thinking" color="#2dd4bf">拡張思考ブロック</CatRow>
        <CatRow icon="💬" label="Response" color="#94a3b8">テキストブロック — 最終回答テキスト</CatRow>
        <CatRow icon="📄" label="Read" color="#60a5fa">Read ツール</CatRow>
        <CatRow icon="✏️" label="Edit/Write" color="#a78bfa">Edit · Write · MultiEdit · NotebookEdit</CatRow>
        <CatRow icon="🔍" label="Search" color="#38bdf8">Grep · Glob · LS · TodoRead · TodoWrite</CatRow>
        <CatRow icon="🌿" label="Git" color="#4ade80">Bash — git コマンド</CatRow>
        <CatRow icon="⚙️" label="Build/Test" color="#fb923c">Bash — npm, tsc, jest, cargo, python など</CatRow>
        <CatRow icon="💻" label="Terminal" color="#fbbf24">その他の Bash コマンド · mcp__* ツール</CatRow>
        <CatRow icon="🤖" label="Subagents" color="#f472b6">Agent ツール</CatRow>
        <CatRow icon="🌐" label="Web" color="#c084fc">WebFetch · WebSearch</CatRow>
        <Note>トークン配分：各ターンの output トークン数をコンテンツブロックの文字数比率で分配します（ブロック文字数 ÷ 総文字数 × output トークン数）。値が 0 のカテゴリは非表示。</Note>
      </Section>

      <Divider />

      <Section icon={<Activity size={15} />} title="アクティビティ">
        <div style={{ marginBottom: 5 }}><B>Trend</B> — 日/週/月の cost/token 履歴と git net-line output を表示します。bucket をクリックすると provider 別 input/output、thinking/response/tool 使用量、cache work/billing token、git net-line category を確認できます。</div>
        <div style={{ marginBottom: 5 }}><B>7d</B> — 7日間 × 24時間のヒートマップ。</div>
        <div style={{ marginBottom: 5 }}><B>5mo</B> — 5ヶ月分の GitHub スタイルカレンダー。ホバーで日付とトークン数を確認。</div>
        <div style={{ marginBottom: 5 }}><B>Hourly</B> — 直近 30 日の時間帯別トークン分布。</div>
        <div style={{ marginBottom: 5 }}><B>Weekly</B> — 直近 4 週間の横棒グラフ。</div>
        <div><B>Rhythm</B> — 時間帯別コスト分布（Morning/Afternoon/Evening/Night）、直近 30 日間、グラデーションバー、ピーク詳細統計（トークン、コスト、リクエスト %）、ローカルタイムゾーン。</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="起動状態とヘッダーステータス">
        <div style={{ marginBottom: 5 }}><B>Partial History</B> — 起動直後は現在のセッションと最近の使用量を先に表示し、古い履歴は budgeted background slice で同期します。これによりトレイアプリと hotkey popup の応答性を保ちます。</div>
        <div style={{ marginBottom: 5 }}><B>ヘッダーメタデータ</B> — 上部の Claude/Codex 情報はクリック用ボタンではなく読み取り専用ラベルです。有効な provider に応じて Claude のみ、Codex のみ、または両方を表示します。</div>
        <div style={{ marginBottom: 5 }}><B>ヘッダーステータス pill</B> — 上部の 1 つの pill が重要な provider health をまとめ、影響を受ける provider 名も表示します。Claude OAuth 使用量データの復旧中は refresh/login/failed 状態が表示されることがあります。Quota Pace Health は <B>Claude OK</B>、<B>Codex OK</B> のように provider 別チップを表示します。</div>
        <div style={{ marginBottom: 5 }}><B>Source チップ</B> — <B>API</B> は provider アカウント使用量、<B>Bridge</B> は Claude statusLine フォールバック、<B>RPC</B> はローカル provider runtime snapshot、<B>Cache</B> は最後に信頼できた snapshot、<B>Log</B> はローカルセッションログ推定です。</div>
        <div style={{ marginBottom: 5 }}><B>Waiting / Syncing</B> — provider データがまだ届いていない場合、制限カードは空の dash ではなく柔らかい待機状態を表示します。</div>
        <div><B>Ledger Needs Rebuild</B> — ローカル aggregate ledger が安全に修復できない場合、historical totals は最近のデータ fallback を使います。Settings → Data → Rebuild ledger からローカル履歴を再生できます。</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="データソース">
        <SrcRow badge="1st">
          <B>ローカルソース</B> — 有効な Claude JSONL と Codex JSONL provider はローカルで解析します。Antigravity は実行中の IDE language server を local RPC でのみ読み取ります。
        </SrcRow>
        <SrcRow badge="2nd">
          <B>制限ソース</B> — Claude は Anthropic API を優先し、Bridge/Cache にフォールバックします。ローカル Claude access token が期限切れの場合、Anthropic で refresh し、更新された credentials を原子的に書き戻せます。Codex は 5h/1w 制限に live usage、reset 可能数に reset-credit request を使います。5h/1w は Cache/Log にフォールバックできますが、reset credit は auth-bound Cache または live usage payload の count-only 値にだけフォールバックします。Antigravity は local RPC model quota だけを使います。Live request は有効な provider のみに行われ、数分間隔を空けます。
        </SrcRow>
        <SrcRow badge="FB">
          <B>最後のキャッシュ値</B> — ライブ制限データが利用できない場合に直近の値を保持。Claude API キャッシュは現在の Claude ログインに紐づき、リセット済みの古いデータは起動時に自動削除。Codex reset-credit cache は現在の Codex auth file に紐づき、count、有効期限、fetch status、source label、hashed auth marker、auth file modified time だけを保存します。
        </SrcRow>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <InfoRow label="Provider">Settings → Tracking の provider チェックボックスで選択します。無効な provider はローカルスキャンも live usage request も行いません。</InfoRow>
          <InfoRow label="Quota display">Settings → Quota display で provider window または model target ごとの Rich、Simple、非表示を選択します。Plan Usage と Floating widget の表示に影響し、Codex Resets は Plan Usage のみです。</InfoRow>
          <InfoRow label="Claude OAuth">期限切れの Claude access token は、使用量 polling のため Anthropic で refresh されることがあります。WhereMyTokens は別の credentials backup を保持しません。</InfoRow>
          <InfoRow label="Bridge">Settings → Claude Code Integration → Setup。</InfoRow>
          <InfoRow label="Widget">Settings → Floating usage widget またはメインヘッダーの PiP ボタンで、常に最前面のコンパクトな Quota Pace ウィンドウを開閉できます。使用率 % と経過時間 % を比較し、黄色/赤はリセット前に使い切るペースであることを示します。Waiting animation はデフォルトでオフで、Settings → Waiting animation から有効にできます。</InfoRow>
        </div>
      </Section>
    </>
  );
}

export default function HelpView({ onBack }: Props) {
  const C = useTheme();
  const [lang, setLang] = useState<Lang>('en');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
      <ViewHeader title="Help" onBack={onBack} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 16px 0', gap: 4, flexShrink: 0 }}>
        {(['en', 'ko', 'ja'] as Lang[]).map(l => (
          <button key={l} onClick={() => setLang(l)} style={{
            padding: '2px 8px', fontSize: 11, border: 'none', borderRadius: 10, cursor: 'pointer',
            background: lang === l ? C.accent : C.bgRow,
            color: lang === l ? '#fff' : C.textDim,
            fontWeight: lang === l ? 700 : 400,
          }}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px 18px' }}>
        {lang === 'en' && <ContentEN />}
        {lang === 'ko' && <ContentKO />}
        {lang === 'ja' && <ContentJA />}
      </div>
    </div>
  );
}
