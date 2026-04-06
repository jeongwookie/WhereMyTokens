import React, { useState } from 'react';
import { Hash, Activity, Signal } from 'lucide-react';
import { C } from '../theme';
import ViewHeader from '../components/ViewHeader';

interface Props { onBack: () => void }
type Lang = 'en' | 'ko' | 'ja';

const B = ({ children }: { children: React.ReactNode }) => (
  <span style={{ color: C.text, fontWeight: 600 }}>{children}</span>
);

const Note = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    fontSize: 11, color: C.textMuted, marginTop: 6,
    padding: '6px 9px', background: C.bgRow, borderRadius: 5,
    lineHeight: 1.65,
  }}>
    {children}
  </div>
);

function Section({ icon, title, children }: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <span style={{ display: 'flex', alignItems: 'center', color: C.accent }}>{icon}</span>
        <span style={{
          fontSize: 11.5, fontWeight: 700, color: C.accent,
          letterSpacing: '0.06em', textTransform: 'uppercase' as const,
        }}>
          {title}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: C.textDim, lineHeight: 1.75 }}>
        {children}
      </div>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: C.border, margin: '18px 0' }} />;
}

const SRC_BADGE_STYLES: Record<string, { bg: string; color: string }> = {
  '1st': { bg: C.accent + '14', color: C.accent },
  '2nd': { bg: C.waiting + '14', color: C.waiting },
  'FB':  { bg: C.textMuted + '20', color: C.textMuted },
};

function InfoRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
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
  const s = SRC_BADGE_STYLES[badge];
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 7, alignItems: 'flex-start' }}>
      <span style={{
        fontSize: 10, fontWeight: 700, padding: '2px 6px',
        borderRadius: 3, whiteSpace: 'nowrap' as const, marginTop: 1, flexShrink: 0,
        background: s.bg, color: s.color,
      }}>
        {badge}
      </span>
      <span>{children}</span>
    </div>
  );
}

const TH: React.CSSProperties = {
  textAlign: 'left', fontSize: 10.5, fontWeight: 600,
  color: C.textMuted, paddingBottom: 5, paddingRight: 8,
  borderBottom: `1px solid ${C.borderSub}`,
};

const TD_LABEL: React.CSSProperties = {
  fontSize: 11.5, fontWeight: 600, color: C.text,
  padding: '4px 8px 4px 0', verticalAlign: 'top',
};

const TD: React.CSSProperties = {
  fontSize: 11.5, color: C.textDim,
  padding: '4px 8px 4px 0', verticalAlign: 'top',
};

function UsageTable({ rows, headers }: {
  headers: [string, string, string, string];
  rows: [string, string, string, string][];
}) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', margin: '8px 0 6px' }}>
      <thead>
        <tr>
          {headers.map(h => <th key={h} style={TH}>{h}</th>)}
        </tr>
      </thead>
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
            ['Model Usage', 'All time, per model', 'All types', 'API-equiv'],
          ]}
        />
        <Note>
          <B>$</B> is an API-equivalent estimate — not your actual bill. Max/Pro subscriptions are flat monthly fees.
        </Note>
      </Section>

      <Divider />

      <Section icon={<Activity size={15} />} title="Activity">
        <div style={{ marginBottom: 5 }}><B>7d</B> — 7-day × 24-hour heatmap grid.</div>
        <div style={{ marginBottom: 5 }}><B>5mo</B> — 5-month GitHub-style calendar. Hover for date + tokens.</div>
        <div style={{ marginBottom: 5 }}><B>Hourly</B> — Token distribution by hour across the last 30 days.</div>
        <div><B>Weekly</B> — Last 4 weeks horizontal bar chart.</div>
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
          <InfoRow label={<><span style={{ color: C.active }}>●</span> / <span style={{ color: C.barRed }}>●</span></>}>
            Header dot — green: connected, red: unreachable. Hover for error message.
          </InfoRow>
          <InfoRow label="(cached)">
            Shown on rate limit bar when API is temporarily down but a prior value exists.
          </InfoRow>
          <InfoRow label="—">
            No successful API response yet (first launch or after a 429).
          </InfoRow>
          <InfoRow label="Bridge">
            Settings → Claude Code Integration → Setup.
          </InfoRow>
        </div>
      </Section>
    </>
  );
}

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
            ['Model Usage', '전체 기간, 모델별', '전체', 'API 환산'],
          ]}
        />
        <Note>
          <B>$</B>는 API 환산 추정값입니다 — 실제 청구액이 아닙니다. Max/Pro 구독은 월정액.
        </Note>
      </Section>

      <Divider />

      <Section icon={<Activity size={15} />} title="활동 탭">
        <div style={{ marginBottom: 5 }}><B>7d</B> — 7일 × 24시간 히트맵 그리드.</div>
        <div style={{ marginBottom: 5 }}><B>5mo</B> — 5개월 GitHub 스타일 캘린더. 날짜+토큰 호버.</div>
        <div style={{ marginBottom: 5 }}><B>Hourly</B> — 시간대별 토큰 분포 (최근 30일).</div>
        <div><B>Weekly</B> — 최근 4주 가로 바 차트.</div>
      </Section>

      <Divider />

      <Section icon={<Signal size={15} />} title="데이터 소스">
        <SrcRow badge="1st">
          <B>Anthropic API</B> — 웹 대시보드와 동일한 권위 있는 수치. 3분마다 갱신, 429 발생 시 지수 백오프.
        </SrcRow>
        <SrcRow badge="2nd">
          <B>Bridge</B> — Claude Code가 stdin으로 실시간 데이터 전달 (statusLine 플러그인). API 불가 시 폴백.
        </SrcRow>
        <SrcRow badge="FB">
          <B>마지막 캐시값</B> — API 실패 시 직전 성공값 유지. 리셋 시각이 지난 stale 데이터는 시작 시 자동 초기화.
        </SrcRow>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <InfoRow label={<><span style={{ color: C.active }}>●</span> / <span style={{ color: C.barRed }}>●</span></>}>
            헤더 점 — 초록: 연결됨, 빨강: 연결 불가. 호버 시 오류 메시지 표시.
          </InfoRow>
          <InfoRow label="(cached)">
            API 임시 불가지만 이전 값이 있을 때 속도 제한 바에 표시.
          </InfoRow>
          <InfoRow label="—">
            아직 성공한 API 응답 없음 (첫 실행 또는 429 직후).
          </InfoRow>
          <InfoRow label="Bridge">
            Settings → Claude Code Integration → Setup.
          </InfoRow>
        </div>
      </Section>
    </>
  );
}

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
            ['Model Usage', '全期間・モデル別', '全種別', 'API換算'],
          ]}
        />
        <Note>
          <B>$</B> は API 換算の概算値です — 実際の請求額とは異なります。Max/Pro は月額固定料金。
        </Note>
      </Section>

      <Divider />

      <Section icon={<Activity size={15} />} title="アクティビティ">
        <div style={{ marginBottom: 5 }}><B>7d</B> — 7日間 × 24時間のヒートマップ。</div>
        <div style={{ marginBottom: 5 }}><B>5mo</B> — 5ヶ月分の GitHub スタイルカレンダー。ホバーで日付とトークン数を確認。</div>
        <div style={{ marginBottom: 5 }}><B>Hourly</B> — 直近 30 日の時間帯別トークン分布。</div>
        <div><B>Weekly</B> — 直近 4 週間の横棒グラフ。</div>
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
          <InfoRow label={<><span style={{ color: C.active }}>●</span> / <span style={{ color: C.barRed }}>●</span></>}>
            ヘッダーのドット — 緑: 接続中、赤: 到達不可。ホバーでエラー詳細を表示。
          </InfoRow>
          <InfoRow label="(cached)">
            API が一時的に利用不可だが、以前の値がある場合にレート制限バーへ表示。
          </InfoRow>
          <InfoRow label="—">
            まだ API レスポンスなし（初回起動または 429 直後）。
          </InfoRow>
          <InfoRow label="Bridge">
            Settings → Claude Code Integration → Setup。
          </InfoRow>
        </div>
      </Section>
    </>
  );
}

export default function HelpView({ onBack }: Props) {
  const [lang, setLang] = useState<Lang>('en');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
      <ViewHeader title="Help" onBack={onBack} />

      {/* 언어 토글 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 16px 0', gap: 4, flexShrink: 0 }}>
        {(['en', 'ko', 'ja'] as Lang[]).map(l => (
          <button key={l} onClick={() => setLang(l)} style={{
            padding: '2px 8px', fontSize: 10, border: 'none', borderRadius: 10, cursor: 'pointer',
            background: lang === l ? C.accent : '#0000000a',
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
