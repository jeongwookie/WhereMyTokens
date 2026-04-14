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
      <Section icon={<Hash size={15} />} title="Numbers & Cost">
        <div style={{ marginBottom: 6 }}>
          <B>tok</B> = input + output + cache creation + cache reads — every token type Anthropic charges for.
        </div>
        <UsageTable
          headers={['Display', 'Scope', 'tok', '$']}
          rows={[
            ['Header', 'Today since midnight', 'All types', 'API-equiv'],
            ['Plan Usage', 'Current billing window', 'All types', 'API-equiv'],
            ['Code Output', 'Today / All time', 'Git stats', '$/commit'],
            ['Model Usage', 'All time, per model', 'All types', 'API-equiv'],
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
        <div style={{ marginBottom: 5 }}><B>$/Commit</B> — cost per commit (today uses today's cost; all uses all-time model cost sum).</div>
        <div style={{ marginBottom: 5 }}><B>today / all</B> — toggle between today and all-time stats.</div>
        <div><B>Author filter</B> — only your own commits are counted, filtered by your local <code>git config user.email</code>.</div>
      </Section>

      <Divider />

      <Section icon={<GitBranch size={15} />} title="Sessions">
        <div style={{ marginBottom: 5 }}><B>Project → Branch → Session</B> — sessions are grouped by git project, then by branch.</div>
        <div style={{ marginBottom: 5 }}><B>Idle collapse</B> — active/waiting sessions show full details. Idle sessions progressively collapse: &lt;1h shows top-3 tools, 1-6h shows context bar only, 6h+ shows a single-line summary.</div>
        <div style={{ marginBottom: 5 }}><B>Cache efficiency</B> — Excellent (80%+), Good (60%+), Fair (40%+), Poor (&lt;40%). Shows how well prompt caching is being utilized.</div>
        <div><B>Context bar</B> — amber at 50%, orange at 80%, red at 95%. "⚠ near limit" at 95-99%, "⚠ at limit" at 100%.</div>
      </Section>

      <Divider />

      <Section icon={<Activity size={15} />} title="Activity">
        <div style={{ marginBottom: 5 }}><B>7d</B> — 7-day × 24-hour heatmap grid.</div>
        <div style={{ marginBottom: 5 }}><B>5mo</B> — 5-month GitHub-style calendar. Hover for date + tokens.</div>
        <div style={{ marginBottom: 5 }}><B>Hourly</B> — Token distribution by hour across the last 30 days.</div>
        <div style={{ marginBottom: 5 }}><B>Weekly</B> — Last 4 weeks horizontal bar chart.</div>
        <div><B>Rhythm</B> — Time-of-day coding patterns (Morning/Afternoon/Evening/Night) over the last 7 days, local timezone.</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="Data Sources">
        <SrcRow badge="1st">
          <B>Anthropic API</B> — authoritative %, same source as the web dashboard. Fetched every 3 min; exponential backoff on 429.
        </SrcRow>
        <SrcRow badge="2nd">
          <B>Bridge</B> — Claude Code pipes rate limit data via stdin (statusLine plugin). Used as fallback when the API is unavailable.
        </SrcRow>
        <SrcRow badge="FB">
          <B>Last cached value</B> — kept on API failure. Stale data past its reset window is auto-cleared on startup.
        </SrcRow>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
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
      <Section icon={<Hash size={15} />} title="수치 & 비용">
        <div style={{ marginBottom: 6 }}>
          <B>tok</B> = input + output + 캐시 생성 + 캐시 읽기 — Anthropic이 과금하는 모든 토큰 유형.
        </div>
        <UsageTable
          headers={['표시 위치', '범위', 'tok', '$']}
          rows={[
            ['헤더', '오늘 자정 이후', '전체', 'API 환산'],
            ['Plan Usage', '현재 빌링 창', '전체', 'API 환산'],
            ['Code Output', '오늘 / 전체 기간', 'Git 통계', '$/커밋'],
            ['Model Usage', '전체 기간, 모델별', '전체', 'API 환산'],
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
        <div style={{ marginBottom: 5 }}><B>$/Commit</B> — 커밋당 비용 (today는 오늘 비용, all은 전체 모델 비용 합산 기준).</div>
        <div style={{ marginBottom: 5 }}><B>today / all</B> — 오늘과 전체 기간 통계 전환.</div>
        <div><B>작성자 필터</B> — 본인 커밋만 집계됩니다. 로컬 <code>git config user.email</code> 기준으로 자동 필터링.</div>
      </Section>

      <Divider />

      <Section icon={<GitBranch size={15} />} title="세션">
        <div style={{ marginBottom: 5 }}><B>프로젝트 → 브랜치 → 세션</B> — git 프로젝트별, 브랜치별로 그루핑.</div>
        <div style={{ marginBottom: 5 }}><B>Idle 축소</B> — active/waiting은 전체 표시. idle 세션은 단계별 축소: 1시간 미만은 상위 3개 툴, 1-6시간은 컨텍스트 바만, 6시간 이상은 한 줄 요약.</div>
        <div style={{ marginBottom: 5 }}><B>캐시 효율</B> — Excellent (80%+), Good (60%+), Fair (40%+), Poor (&lt;40%). 프롬프트 캐싱 활용도.</div>
        <div><B>컨텍스트 바</B> — 50%에서 황색, 80%에서 주황, 95%에서 적색. 95-99% "⚠ near limit", 100% "⚠ at limit".</div>
      </Section>

      <Divider />

      <Section icon={<Activity size={15} />} title="활동 탭">
        <div style={{ marginBottom: 5 }}><B>7d</B> — 7일 × 24시간 히트맵 그리드.</div>
        <div style={{ marginBottom: 5 }}><B>5mo</B> — 5개월 GitHub 스타일 캘린더. 날짜+토큰 호버.</div>
        <div style={{ marginBottom: 5 }}><B>Hourly</B> — 시간대별 토큰 분포 (최근 30일).</div>
        <div style={{ marginBottom: 5 }}><B>Weekly</B> — 최근 4주 가로 바 차트.</div>
        <div><B>Rhythm</B> — 시간대별 코딩 패턴 (Morning/Afternoon/Evening/Night), 최근 7일, 로컬 타임존.</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="데이터 소스">
        <SrcRow badge="1st">
          <B>Anthropic API</B> — 웹 대시보드와 동일한 권위 있는 수치. 3분마다 갱신, 429 시 지수 백오프.
        </SrcRow>
        <SrcRow badge="2nd">
          <B>Bridge</B> — Claude Code가 stdin으로 실시간 데이터 전달 (statusLine 플러그인). API 불가 시 폴백.
        </SrcRow>
        <SrcRow badge="FB">
          <B>마지막 캐시값</B> — API 실패 시 직전 성공값 유지. 리셋 시각이 지난 stale 데이터는 시작 시 자동 초기화.
        </SrcRow>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
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
      <Section icon={<Hash size={15} />} title="数値とコスト">
        <div style={{ marginBottom: 6 }}>
          <B>tok</B> = input + output + キャッシュ生成 + キャッシュ読み取り — Anthropic が課金するすべてのトークン種別。
        </div>
        <UsageTable
          headers={['表示場所', '集計期間', 'tok', '$']}
          rows={[
            ['ヘッダー', '当日 0:00 以降', '全種別', 'API換算'],
            ['Plan Usage', '現在の請求ウィンドウ', '全種別', 'API換算'],
            ['Code Output', '今日 / 全期間', 'Git統計', '$/コミット'],
            ['Model Usage', '全期間・モデル別', '全種別', 'API換算'],
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
        <div style={{ marginBottom: 5 }}><B>$/Commit</B> — コミットあたりのコスト（today は今日のコスト、all は全期間のモデルコスト合計基準）。</div>
        <div style={{ marginBottom: 5 }}><B>today / all</B> — 今日と全期間の統計を切り替え。</div>
        <div><B>作者フィルター</B> — 自分のコミットのみカウント。ローカルの <code>git config user.email</code> で自動フィルタリング。</div>
      </Section>

      <Divider />

      <Section icon={<GitBranch size={15} />} title="セッション">
        <div style={{ marginBottom: 5 }}><B>プロジェクト → ブランチ → セッション</B> — git プロジェクト別、ブランチ別にグループ化。</div>
        <div style={{ marginBottom: 5 }}><B>Idle 折りたたみ</B> — active/waiting は完全表示。idle セッションは段階的に折りたたみ：1 時間未満はトップ 3 ツール、1-6 時間はコンテキストバーのみ、6 時間以上は 1 行サマリー。</div>
        <div style={{ marginBottom: 5 }}><B>キャッシュ効率</B> — Excellent (80%+)、Good (60%+)、Fair (40%+)、Poor (&lt;40%)。プロンプトキャッシングの活用度。</div>
        <div><B>コンテキストバー</B> — 50% で琥珀色、80% でオレンジ、95% で赤。95-99% "⚠ near limit"、100% "⚠ at limit"。</div>
      </Section>

      <Divider />

      <Section icon={<Activity size={15} />} title="アクティビティ">
        <div style={{ marginBottom: 5 }}><B>7d</B> — 7日間 × 24時間のヒートマップ。</div>
        <div style={{ marginBottom: 5 }}><B>5mo</B> — 5ヶ月分の GitHub スタイルカレンダー。ホバーで日付とトークン数を確認。</div>
        <div style={{ marginBottom: 5 }}><B>Hourly</B> — 直近 30 日の時間帯別トークン分布。</div>
        <div style={{ marginBottom: 5 }}><B>Weekly</B> — 直近 4 週間の横棒グラフ。</div>
        <div><B>Rhythm</B> — 時間帯別コーディングパターン（Morning/Afternoon/Evening/Night）、直近 7 日間、ローカルタイムゾーン。</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="データソース">
        <SrcRow badge="1st">
          <B>Anthropic API</B> — ウェブダッシュボードと同じ権威ある数値。3 分ごとに更新、429 発生時は指数バックオフ。
        </SrcRow>
        <SrcRow badge="2nd">
          <B>Bridge</B> — Claude Code が stdin 経由でリアルタイムデータを送信（statusLine プラグイン）。API 利用不可時のフォールバック。
        </SrcRow>
        <SrcRow badge="FB">
          <B>最後のキャッシュ値</B> — API 障害時も直近の成功値を保持。リセット済みの古いデータは起動時に自動削除。
        </SrcRow>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
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
