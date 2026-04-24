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
        fontSize: 10, fontWeight: 700, padding: '2px 6px',
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
        fontSize: 9.5, fontWeight: 700, padding: '2px 6px',
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
    textAlign: 'left', fontSize: 10.5, fontWeight: 600,
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
      <Section icon={<Signal size={15} />} title="Claude + Codex Tracking">
        <div style={{ marginBottom: 6 }}>
          WhereMyTokens can track <B>Claude Code only</B>, <B>Codex only</B>, or <B>Claude + Codex together</B>. Choose the provider mode in Settings.
        </div>
        <div style={{ marginBottom: 5 }}><B>Claude</B> reads local Claude session/JSONL files and uses the Anthropic API or statusLine bridge for 5h/1w limits.</div>
        <div><B>Codex</B> reads local <code>~/.codex/sessions/**/*.jsonl</code> logs, including model usage, token counts, cached input, tool events, and Codex rate-limit reset events when present.</div>
      </Section>

      <Divider />

      <Section icon={<Hash size={15} />} title="Numbers & Cost">
        <div style={{ marginBottom: 6 }}>
          <B>tok</B> = input + output + cache creation + cache reads. Claude includes cache creation/read tokens; Codex reports uncached input, cached input, and output from local token_count events.
        </div>
        <div style={{ marginBottom: 6 }}>
          <B>Cache Efficiency</B> uses provider-specific math: Claude = cache read ÷ (cache read + cache creation), Codex = cached input ÷ total input.
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
        <div style={{ marginBottom: 5 }}><B>today / all</B> — toggle between today and all-time stats.</div>
        <div style={{ marginBottom: 5 }}><B>Current session repo scope</B> — git totals follow repos linked to the sessions currently tracked in the dashboard, so they can differ from just the repo you are viewing.</div>
        <div style={{ marginBottom: 5 }}><B>All-time scope</B> — counts commits and line changes across local branches, not only the current HEAD.</div>
        <div><B>Author filter</B> — only your own commits are counted, filtered by your local <code>git config user.email</code>.</div>
      </Section>

      <Divider />

      <Section icon={<GitBranch size={15} />} title="Sessions">
        <div style={{ marginBottom: 5 }}><B>Project → Branch → Session</B> — sessions are grouped by git project, then by branch.</div>
        <div style={{ marginBottom: 5 }}><B>Provider chips</B> — Claude and Codex sessions can appear in the same project/branch list, with distinct model colors.</div>
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
        <div style={{ marginBottom: 5 }}><B>7d</B> — 7-day × 24-hour heatmap grid.</div>
        <div style={{ marginBottom: 5 }}><B>5mo</B> — 5-month GitHub-style calendar. Hover for date + tokens.</div>
        <div style={{ marginBottom: 5 }}><B>Hourly</B> — Token distribution by hour across the last 30 days.</div>
        <div style={{ marginBottom: 5 }}><B>Weekly</B> — Last 4 weeks horizontal bar chart.</div>
        <div><B>Rhythm</B> — Time-of-day cost distribution (Morning/Afternoon/Evening/Night) over the last 30 days with gradient bars, peak detail stats (tokens, cost, requests %), and local timezone.</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="Startup & Status">
        <div style={{ marginBottom: 5 }}><B>Partial History</B> — on startup the dashboard shows current sessions and recent usage first. Older history keeps syncing in the background so the tray app can open quickly.</div>
        <div style={{ marginBottom: 5 }}><B>Header metadata</B> — Claude and Codex details in the top bar are read-only labels, not action buttons. Provider mode decides whether Claude, Codex, or both appear.</div>
        <div style={{ marginBottom: 5 }}><B>Header status pill</B> — one pill in the top bar summarizes the most important Claude/API state instead of showing multiple warning chips.</div>
        <div style={{ marginBottom: 5 }}><B>Local estimate</B> — Claude API is unavailable, so the app is temporarily using local status-line or cached limit data.</div>
        <div><B>Reset unavailable</B> — Claude API returned current usage without a reset timestamp. Usage % may still be current, but the reset countdown stays hidden until the API provides it again.</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="Data Sources">
        <SrcRow badge="1st">
          <B>Local logs</B> — Claude JSONL and Codex JSONL are parsed locally for tokens, models, cost estimates, sessions, and tool activity.
        </SrcRow>
        <SrcRow badge="2nd">
          <B>Limit sources</B> — Claude uses Anthropic API first, then statusLine/cache fallback. Codex uses rate-limit events found in local Codex JSONL logs.
        </SrcRow>
        <SrcRow badge="FB">
          <B>Last cached value</B> — kept when live limit data is unavailable. Stale data past its reset window is auto-cleared on startup.
        </SrcRow>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <InfoRow label="Provider">Settings → Tracking Provider: Claude / Codex / Both.</InfoRow>
          <InfoRow label="Bridge">Settings → Claude Code Integration → Setup.</InfoRow>
        </div>
      </Section>
    </>
  );
}

// ─── Korean ──────────────────────────────────────────────────────────────────
function ContentKO() {
  return (
    <>
      <Section icon={<Signal size={15} />} title="Claude + Codex 추적">
        <div style={{ marginBottom: 6 }}>
          WhereMyTokens는 <B>Claude Code만</B>, <B>Codex만</B>, 또는 <B>Claude + Codex 동시 추적</B>을 지원합니다. Settings에서 provider 모드를 선택합니다.
        </div>
        <div style={{ marginBottom: 5 }}><B>Claude</B>는 로컬 Claude 세션/JSONL 파일을 읽고, 5h/1w 한도는 Anthropic API 또는 statusLine 브리지를 사용합니다.</div>
        <div><B>Codex</B>는 로컬 <code>~/.codex/sessions/**/*.jsonl</code> 로그에서 모델 사용량, 토큰 수, cached input, 툴 이벤트, Codex rate-limit reset 이벤트를 읽습니다.</div>
      </Section>

      <Divider />

      <Section icon={<Hash size={15} />} title="수치 & 비용">
        <div style={{ marginBottom: 6 }}>
          <B>tok</B> = input + output + 캐시 생성 + 캐시 읽기. Claude는 cache creation/read를 포함하고, Codex는 로컬 token_count 이벤트의 uncached input, cached input, output을 사용합니다.
        </div>
        <div style={{ marginBottom: 6 }}>
          <B>Cache Efficiency</B> 계산식은 provider별로 다릅니다. Claude = cache read ÷ (cache read + cache creation), Codex = cached input ÷ total input.
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
        <div style={{ marginBottom: 5 }}><B>today / all</B> — 오늘과 전체 기간 통계 전환.</div>
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
        <div style={{ marginBottom: 5 }}><B>7d</B> — 7일 × 24시간 히트맵 그리드.</div>
        <div style={{ marginBottom: 5 }}><B>5mo</B> — 5개월 GitHub 스타일 캘린더. 날짜+토큰 호버.</div>
        <div style={{ marginBottom: 5 }}><B>Hourly</B> — 시간대별 토큰 분포 (최근 30일).</div>
        <div style={{ marginBottom: 5 }}><B>Weekly</B> — 최근 4주 가로 바 차트.</div>
        <div><B>Rhythm</B> — 시간대별 비용 분포 (Morning/Afternoon/Evening/Night), 최근 30일, 그라데이션 바, 피크 상세 통계 (토큰, 비용, 요청 %), 로컬 타임존.</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="시작 상태 & 헤더 표시">
        <div style={{ marginBottom: 5 }}><B>Partial History</B> — 시작 직후에는 현재 세션과 최근 사용량을 먼저 보여주고, 오래된 히스토리는 백그라운드에서 계속 동기화합니다. 그래서 트레이 앱이 더 빨리 열립니다.</div>
        <div style={{ marginBottom: 5 }}><B>헤더 메타데이터</B> — 상단의 Claude/Codex 정보는 클릭 버튼이 아니라 읽기 전용 라벨입니다. provider 모드에 따라 Claude만, Codex만, 또는 둘 다 표시됩니다.</div>
        <div style={{ marginBottom: 5 }}><B>헤더 상태 pill</B> — 상단 한 개의 pill이 Claude/API 관련 핵심 상태를 요약해서 보여줍니다. 여러 경고 칩을 한 줄로 합친 개념입니다.</div>
        <div style={{ marginBottom: 5 }}><B>Local estimate</B> — Claude API를 지금 사용할 수 없어서, 로컬 status-line 또는 캐시된 한도 데이터를 임시로 표시 중입니다.</div>
        <div><B>Reset unavailable</B> — Claude API가 현재 사용량은 반환했지만 reset 시각은 주지 않은 상태입니다. 사용률 %는 최신일 수 있지만 reset 카운트다운은 API가 다시 제공할 때까지 숨겨집니다.</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="데이터 소스">
        <SrcRow badge="1st">
          <B>로컬 로그</B> — Claude JSONL과 Codex JSONL을 로컬에서 파싱해 토큰, 모델, 비용 추정, 세션, 툴 활동을 계산합니다.
        </SrcRow>
        <SrcRow badge="2nd">
          <B>한도 소스</B> — Claude는 Anthropic API를 우선 사용하고 statusLine/cache로 폴백합니다. Codex는 로컬 Codex JSONL의 rate-limit 이벤트를 사용합니다.
        </SrcRow>
        <SrcRow badge="FB">
          <B>마지막 캐시값</B> — 실시간 한도 데이터를 사용할 수 없을 때 직전 값을 유지합니다. 리셋 시각이 지난 stale 데이터는 시작 시 자동 초기화.
        </SrcRow>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <InfoRow label="Provider">Settings → Tracking Provider: Claude / Codex / Both.</InfoRow>
          <InfoRow label="Bridge">Settings → Claude Code Integration → Setup.</InfoRow>
        </div>
      </Section>
    </>
  );
}

// ─── Japanese ────────────────────────────────────────────────────────────────
function ContentJA() {
  return (
    <>
      <Section icon={<Signal size={15} />} title="Claude + Codex 追跡">
        <div style={{ marginBottom: 6 }}>
          WhereMyTokens は <B>Claude Code のみ</B>、<B>Codex のみ</B>、または <B>Claude + Codex の同時追跡</B>に対応しています。Settings で provider モードを選択します。
        </div>
        <div style={{ marginBottom: 5 }}><B>Claude</B> はローカルの Claude セッション/JSONL ファイルを読み取り、5h/1w 制限は Anthropic API または statusLine ブリッジを使います。</div>
        <div><B>Codex</B> はローカルの <code>~/.codex/sessions/**/*.jsonl</code> ログから、モデル使用量、トークン数、cached input、ツールイベント、Codex の rate-limit reset イベントを読み取ります。</div>
      </Section>

      <Divider />

      <Section icon={<Hash size={15} />} title="数値とコスト">
        <div style={{ marginBottom: 6 }}>
          <B>tok</B> = input + output + キャッシュ生成 + キャッシュ読み取り。Claude は cache creation/read を含み、Codex はローカル token_count イベントの uncached input、cached input、output を使います。
        </div>
        <div style={{ marginBottom: 6 }}>
          <B>Cache Efficiency</B> は provider ごとに計算式が異なります。Claude = cache read ÷ (cache read + cache creation)、Codex = cached input ÷ total input。
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
        <div style={{ marginBottom: 5 }}><B>today / all</B> — 今日と全期間の統計を切り替え。</div>
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
        <div style={{ marginBottom: 5 }}><B>7d</B> — 7日間 × 24時間のヒートマップ。</div>
        <div style={{ marginBottom: 5 }}><B>5mo</B> — 5ヶ月分の GitHub スタイルカレンダー。ホバーで日付とトークン数を確認。</div>
        <div style={{ marginBottom: 5 }}><B>Hourly</B> — 直近 30 日の時間帯別トークン分布。</div>
        <div style={{ marginBottom: 5 }}><B>Weekly</B> — 直近 4 週間の横棒グラフ。</div>
        <div><B>Rhythm</B> — 時間帯別コスト分布（Morning/Afternoon/Evening/Night）、直近 30 日間、グラデーションバー、ピーク詳細統計（トークン、コスト、リクエスト %）、ローカルタイムゾーン。</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="起動状態とヘッダーステータス">
        <div style={{ marginBottom: 5 }}><B>Partial History</B> — 起動直後は現在のセッションと最近の使用量を先に表示し、古い履歴はバックグラウンドで同期を続けます。これによりトレイアプリを素早く開けます。</div>
        <div style={{ marginBottom: 5 }}><B>ヘッダーメタデータ</B> — 上部の Claude/Codex 情報はクリック用ボタンではなく読み取り専用ラベルです。provider モードに応じて Claude のみ、Codex のみ、または両方を表示します。</div>
        <div style={{ marginBottom: 5 }}><B>ヘッダーステータス pill</B> — 上部の 1 つの pill が Claude/API の重要な状態をまとめて表示します。複数の警告チップを 1 つに整理したものです。</div>
        <div style={{ marginBottom: 5 }}><B>Local estimate</B> — Claude API が利用できないため、ローカルの status-line またはキャッシュ済み制限データを一時的に表示しています。</div>
        <div><B>Reset unavailable</B> — Claude API は現在の使用量を返しましたが、reset 時刻は返していません。使用率 % は最新でも、reset カウントダウンは API が再び返すまで非表示になります。</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="データソース">
        <SrcRow badge="1st">
          <B>ローカルログ</B> — Claude JSONL と Codex JSONL をローカルで解析し、トークン、モデル、コスト推定、セッション、ツール活動を計算します。
        </SrcRow>
        <SrcRow badge="2nd">
          <B>制限ソース</B> — Claude は Anthropic API を優先し、statusLine/cache にフォールバックします。Codex はローカル Codex JSONL 内の rate-limit イベントを使います。
        </SrcRow>
        <SrcRow badge="FB">
          <B>最後のキャッシュ値</B> — ライブ制限データが利用できない場合に直近の値を保持。リセット済みの古いデータは起動時に自動削除。
        </SrcRow>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <InfoRow label="Provider">Settings → Tracking Provider: Claude / Codex / Both。</InfoRow>
          <InfoRow label="Bridge">Settings → Claude Code Integration → Setup。</InfoRow>
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
            padding: '2px 8px', fontSize: 10, border: 'none', borderRadius: 10, cursor: 'pointer',
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
